$ErrorActionPreference = 'Stop'

function Get-RustFunction([string]$Source, [string]$Signature) {
    $start = $Source.IndexOf($Signature, [StringComparison]::Ordinal)
    if ($start -lt 0) {
        throw "Could not find exact-source function: $Signature"
    }
    $open = $Source.IndexOf('{', $start)
    if ($open -lt 0) {
        throw "Could not find function body: $Signature"
    }
    $depth = 0
    for ($index = $open; $index -lt $Source.Length; $index++) {
        if ($Source[$index] -eq '{') { $depth++ }
        elseif ($Source[$index] -eq '}') {
            $depth--
            if ($depth -eq 0) {
                return $Source.Substring($start, $index - $start + 1)
            }
        }
    }
    throw "Unclosed function body: $Signature"
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$sourcePath = Join-Path $repoRoot 'src-tauri\src\network_security.rs'
$source = [IO.File]::ReadAllText($sourcePath)
$helper = Get-RustFunction $source 'fn configure_proxy_client_socket('
$headerReader = Get-RustFunction $source 'fn read_request_header('
$bodyCopier = Get-RustFunction $source 'fn copy_fixed_body('
$worker = Get-RustFunction $source 'fn proxy_worker('
$relay = Get-RustFunction $source 'fn relay_bidirectional('

if ($helper -notmatch 'set_nonblocking\(false\)\?') {
    throw 'Accepted client setup must propagate failure to restore blocking mode.'
}
if (($helper -notmatch 'set_read_timeout\(Some\(IO_TIMEOUT\)\)\?') -or
    ($helper -notmatch 'set_write_timeout\(Some\(IO_TIMEOUT\)\)\?')) {
    throw 'Accepted client setup must propagate read and write timeout failures.'
}
if (($worker -notmatch 'if\s+configure_proxy_client_socket\(&client\)\.is_err\(\)\s*\{') -or
    ($worker -notmatch 'client\.shutdown\(Shutdown::Both\)') -or
    ($worker -notmatch 'continue;')) {
    throw 'Socket setup failure must close the client and skip request handling.'
}
if (($relay -notmatch 'client\.set_nonblocking\(true\)\?') -or
    ($relay -notmatch 'upstream\.set_nonblocking\(true\)\?')) {
    throw 'CONNECT relay must explicitly keep both sockets nonblocking.'
}

$rustTemplate = @'
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const IO_TIMEOUT: Duration = Duration::from_secs(3);
const RELAY_BUFFER_BYTES: usize = 16 * 1024;
const MAX_PROXY_HEADER_BYTES: usize = 64 * 1024;

struct ProxyShared { stopped: AtomicBool }
struct ActiveSockets { shared: ProxyShared }

@@CONFIGURE@@
@@READ_HEADER@@
@@COPY_BODY@@

fn accept_nonblocking(listener: &TcpListener) -> io::Result<TcpStream> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Ok(stream),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline { return Err(error); }
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    }
}

fn run_delayed_http_header_and_body() -> io::Result<(String, String)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let sender = thread::spawn(move || -> io::Result<()> {
        let mut stream = TcpStream::connect(address)?;
        thread::sleep(Duration::from_millis(120));
        stream.write_all(b"POST http://127.0.0.1/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n")?;
        thread::sleep(Duration::from_millis(40));
        stream.write_all(b"Content-Length: 11\r\n\r\n")?;
        thread::sleep(Duration::from_millis(120));
        stream.write_all(b"hello ")?;
        thread::sleep(Duration::from_millis(40));
        stream.write_all(b"world")?;
        Ok(())
    });

    let mut client = accept_nonblocking(&listener)?;
    // Reproduce the nonblocking mode inherited from the production listener.
    client.set_nonblocking(true)?;
    configure_proxy_client_socket(&client)?;
    let (header, buffered) = read_request_header(&mut client)?;
    let header = String::from_utf8(header)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let origin = TcpListener::bind("127.0.0.1:0")?;
    let origin_address = origin.local_addr()?;
    let origin_thread = thread::spawn(move || -> io::Result<String> {
        let (mut upstream, _) = origin.accept()?;
        upstream.set_read_timeout(Some(IO_TIMEOUT))?;
        let mut body = [0u8; 11];
        upstream.read_exact(&mut body)?;
        String::from_utf8(body.to_vec())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    });
    let mut upstream = TcpStream::connect(origin_address)?;
    let active = ActiveSockets { shared: ProxyShared { stopped: AtomicBool::new(false) } };
    copy_fixed_body(&mut client, &mut upstream, &buffered, 11, &active)?;
    let body = origin_thread.join()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "body fixture thread panicked"))??;
    sender.join()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "client fixture thread panicked"))??;
    Ok((header, body))
}

fn run_connect_relay_mode_probe() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let connector = thread::spawn(move || TcpStream::connect(address));
    let mut client = accept_nonblocking(&listener)?;
    let _peer = connector.join()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "CONNECT fixture thread panicked"))??;
    client.set_nonblocking(true)?;
    configure_proxy_client_socket(&client)?;
    // relay_bidirectional explicitly returns the client socket to this mode.
    client.set_nonblocking(true)?;
    let mut byte = [0u8; 1];
    match client.read(&mut byte) {
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
        Err(error) => Err(error),
        Ok(count) => Err(io::Error::new(io::ErrorKind::Other, format!("expected no-data WouldBlock, got {count} bytes"))),
    }
}

fn main() -> io::Result<()> {
    let (header, body) = run_delayed_http_header_and_body()?;
    if !header.starts_with("POST http://127.0.0.1/upload HTTP/1.1\r\n") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "delayed header was not read intact"));
    }
    if body != "hello world" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "delayed HTTP body was not copied intact"));
    }
    run_connect_relay_mode_probe()?;
    println!("delayed_header_bytes={} delayed_body={body} connect_no_data=WouldBlock", header.len());
    Ok(())
}
'@

$harness = $rustTemplate.Replace('@@CONFIGURE@@', $helper)
$harness = $harness.Replace('@@READ_HEADER@@', $headerReader)
$harness = $harness.Replace('@@COPY_BODY@@', $bodyCopier)
$tempBase = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$rustPath = "$tempBase.rs"
$exePath = if ($env:OS -eq 'Windows_NT') { "$tempBase.exe" } else { $tempBase }
$artifactDir = Join-Path $repoRoot 'e2e\artifacts\v5-fixes-proxy-sockets'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$reportPath = Join-Path $artifactDir 'proxy-sockets-verification.json'
$reportHashPath = "$reportPath.sha256"

try {
    [IO.File]::WriteAllText($rustPath, $harness, [Text.Encoding]::UTF8)
    $compileOutput = & rustc --edition=2021 $rustPath -o $exePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Exact-source verifier compilation failed: $($compileOutput -join [Environment]::NewLine)"
    }
    $runOutput = & $exePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Exact-source socket exercise failed: $($runOutput -join [Environment]::NewLine)"
    }
    $report = [ordered]@{
        schema = 'rosi.proxy-socket-verification.v2'
        result = 'passed'
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        source = 'src-tauri/src/network_security.rs'
        sourceSha256 = (Get-FileHash -Algorithm SHA256 $sourcePath).Hash.ToLowerInvariant()
        verifier = 'e2e/v5-fixes/proxy-sockets/verify.ps1'
        verifierSha256 = (Get-FileHash -Algorithm SHA256 $PSCommandPath).Hash.ToLowerInvariant()
        sourceAssertions = @(
            'accepted-socket blocking mode and timeout setup errors propagate',
            'proxy worker closes the client and skips handling when setup fails',
            'CONNECT relay explicitly sets both client and upstream sockets nonblocking'
        )
        socketProbes = @(
            'delayed fragmented HTTP header on a real TCP socket',
            'delayed Content-Length body copied by the exact production function',
            'after explicit nonblocking mode is set on a real socket, an idle read returns WouldBlock'
        )
        connectBidirectionalRelayExercised = $false
        output = ($runOutput -join [Environment]::NewLine).Trim()
    }
    $reportHashInput = [ordered]@{
        schema = $report.schema
        result = $report.result
        sourceSha256 = $report.sourceSha256
        verifierSha256 = $report.verifierSha256
        output = $report.output
    }
    $report.reportHashInput = $reportHashInput
    $reportHashBytes = [Text.Encoding]::UTF8.GetBytes(($reportHashInput | ConvertTo-Json -Depth 5 -Compress))
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $report.reportSha256 = [BitConverter]::ToString($sha256.ComputeHash($reportHashBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
    $report.reportHashScope = 'SHA-256 of reportHashInput serialized as compact JSON and encoded as UTF-8.'
    $reportContent = ($report | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    [IO.File]::WriteAllText($reportPath, $reportContent)
    $artifactHash = (Get-FileHash -Algorithm SHA256 $reportPath).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(
        $reportHashPath,
        "$artifactHash  $(Split-Path -Leaf $reportPath)$([Environment]::NewLine)",
        [Text.Encoding]::ASCII
    )
    Write-Output $report.output
    Write-Output "artifact=$reportPath"
    Write-Output "reportSha256=$artifactHash"
}
finally {
    Remove-Item -LiteralPath $rustPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue
}
