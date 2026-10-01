#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetReleaseDir,
  [string[]]$ExtraFiles = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'release-policy.cjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($env:SKIP_WIN_CODESIGN -eq '1') { Write-Host 'SKIP_WIN_CODESIGN=1; skipping Authenticode verification.'; exit 0 }
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode verification must run on Windows.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER is required for Authenticode verification.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER_DN is required for full Authenticode identity verification.' }
. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule
$releaseDir = (Resolve-Path -LiteralPath $TargetReleaseDir).Path
$files = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter '*.exe')
$bundleDir = Join-Path $releaseDir 'bundle'
if (Test-Path -LiteralPath $bundleDir) {
  $files += Get-ChildItem -LiteralPath $bundleDir -File -Recurse | Where-Object {
    $_.Extension.ToLowerInvariant() -in @('.exe', '.msi')
  }
}

foreach ($extra in $ExtraFiles) {
  if ($extra -and (Test-Path -LiteralPath $extra)) {
    $files += Get-Item -LiteralPath $extra
  }
}

$files = @($files | Sort-Object FullName -Unique)
if (-not $files.Count) { throw "No Windows runtime or installer artifacts were found under $releaseDir" }
$expected = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
$expectedSubject = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid or missing Authenticode signature: $($file.FullName) ($($signature.Status))"
  }
  if (-not $signature.SignerCertificate) { throw "Missing signer certificate: $($file.FullName)" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $expected) { throw "Unexpected publisher for $($file.FullName): '$publisher'" }
  $subject = $signature.SignerCertificate.Subject.Trim()
  if ($subject -ne $expectedSubject) { throw "Unexpected certificate Subject for $($file.FullName). Expected '$expectedSubject', got '$subject'." }
  if (-not $signature.TimeStamperCertificate) { throw "Missing RFC3161 timestamp: $($file.FullName)" }
  Write-Host "Verified: $($file.FullName)"
}
Write-Host "Verified $($files.Count) timestamped Windows artifact(s) from '$expectedSubject'."
