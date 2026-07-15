#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Artifact Signing Client Tools setup must run on Windows.' }

. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')

try {
  $tools = Get-ArtifactSigningTools
  Write-Host 'Artifact Signing Client Tools are already installed.'
  Write-Host "SignTool: $($tools.SignToolPath)"
  Write-Host "Dlib: $($tools.DlibPath)"
  exit 0
} catch {
  Write-Host 'Installing official Microsoft Artifact Signing Client Tools...'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Installing Artifact Signing Client Tools requires an elevated PowerShell session. Run this setup command once as Administrator.'
}

$installed = $false
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if ($winget) {
  & $winget.Source install -e --id Microsoft.Azure.ArtifactSigningClientTools --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -eq 0) {
    $installed = $true
  } else {
    Write-Warning "winget failed with exit code $LASTEXITCODE; falling back to Microsoft's MSI."
  }
}

if (-not $installed) {
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) "ArtifactSigningClientTools-$PID.msi"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/70ad2c3b-761f-4aa9-a9de-e7405aa2b4c1/ArtifactSigningClientTools.msi' -OutFile $msiPath
    $process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/i', ('"{0}"' -f $msiPath), '/quiet', '/norestart')
    if ($process.ExitCode -notin @(0, 1641, 3010)) { throw "Artifact Signing Client Tools MSI failed with exit code $($process.ExitCode)" }
    if ($process.ExitCode -in @(1641, 3010)) { Write-Warning 'Installation succeeded and Windows requested a restart.' }
  } finally {
    Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  }
}

$tools = Get-ArtifactSigningTools
Write-Host 'Artifact Signing Client Tools are ready.'
Write-Host "SignTool: $($tools.SignToolPath)"
Write-Host "Dlib: $($tools.DlibPath)"
