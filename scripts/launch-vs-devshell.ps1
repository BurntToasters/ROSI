#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')]
  [string]$Arch = 'x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'windows-vs-toolchain.ps1')
$launch = Resolve-ROSIVsDevShellLauncher
Write-Host "Launching VS developer environment: $launch"
if ($Arch -eq 'arm64') {
  & $launch -SkipAutomaticLocation -Arch arm64 -HostArch amd64
} else {
  & $launch -SkipAutomaticLocation
}
