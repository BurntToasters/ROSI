#requires -Version 5.1
Set-StrictMode -Version Latest

function Get-ROSIVisualStudioInstallations {
  $installs = New-Object System.Collections.Generic.List[object]
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    # Out-String: vswhere JSON is multi-line; a raw string[] breaks ConvertFrom-Json.
    $raw = (& $vswhere -all -prerelease -products * -format json 2>$null | Out-String).Trim()
    if ($raw) {
      foreach ($entry in @($raw | ConvertFrom-Json)) {
        $path = [string]$entry.installationPath
        if (-not $path -or -not (Test-Path -LiteralPath $path)) { continue }
        $line = ''
        if ($entry.catalog -and $entry.catalog.productLineVersion) {
          $line = [string]$entry.catalog.productLineVersion
        }
        [void]$installs.Add(
          [pscustomobject]@{
            Path    = $path
            Version = [string]$entry.installationVersion
            Line    = $line
          }
        )
      }
    }
  }

  if ($installs.Count -eq 0) {
    foreach ($ver in @('18', '2026', '2022')) {
      $root = Join-Path $env:ProgramFiles "Microsoft Visual Studio\$ver"
      if (-not (Test-Path -LiteralPath $root)) { continue }
      foreach ($edition in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        [void]$installs.Add(
          [pscustomobject]@{
            Path    = $edition.FullName
            Version = if ($ver -eq '2022') { '17.0.0' } else { '18.0.0' }
            Line    = $ver
          }
        )
      }
    }
    if (${env:ProgramFiles(x86)}) {
      $root2022 = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022'
      if (Test-Path -LiteralPath $root2022) {
        foreach ($edition in (Get-ChildItem -LiteralPath $root2022 -Directory -ErrorAction SilentlyContinue)) {
          [void]$installs.Add(
            [pscustomobject]@{
              Path    = $edition.FullName
              Version = '17.0.0'
              Line    = '2022'
            }
          )
        }
      }
    }
  }

  return @(
    $installs |
      Sort-Object {
        try { [version]$_.Version } catch { [version]'0.0.0' }
      } -Descending
  )
}

function Get-ROSICmakePathFromInstallation {
  param([Parameter(Mandatory = $true)][string]$InstallationPath)
  Join-Path $InstallationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
}

function Test-ROSICmakeListsGenerator {
  param(
    [Parameter(Mandatory = $true)][string]$CmakeExe,
    [Parameter(Mandatory = $true)][string]$GeneratorName
  )
  $help = & $CmakeExe --help 2>&1 | Out-String
  return [bool]($help -match [regex]::Escape($GeneratorName))
}

function Resolve-ROSICmakeExecutable {
  $installs = Get-ROSIVisualStudioInstallations
  $needsVs18Generator = $false
  foreach ($install in $installs) {
    if ($install.Version -match '^18\.' -or $install.Line -match '^(18|2026)$' -or
      $install.Path -match '\\Microsoft Visual Studio\\(18|2026)\\') {
      $needsVs18Generator = $true
      break
    }
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  # Prefer VS-bundled CMake first (newest install). PATH/standalone often lag after
  # a VS 2026 upgrade and may lack the "Visual Studio 18 2026" generator.
  foreach ($install in $installs) {
    [void]$candidates.Add((Get-ROSICmakePathFromInstallation -InstallationPath $install.Path))
  }

  $command = Get-Command cmake -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
    [void]$candidates.Add($command.Source)
  }

  [void]$candidates.Add((Join-Path $env:ProgramFiles 'CMake\bin\cmake.exe'))
  if (${env:ProgramFiles(x86)}) {
    [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'CMake\bin\cmake.exe'))
  }

  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if (-not $seen.Add($resolved)) { continue }
    if ($needsVs18Generator -and
      -not (Test-ROSICmakeListsGenerator -CmakeExe $resolved -GeneratorName 'Visual Studio 18 2026')) {
      Write-Host "Skipping CMake without VS 18 generator: $resolved"
      continue
    }
    return $resolved
  }

  $latest = ($installs | Select-Object -First 1)
  $hint = if ($latest) {
    "Latest Visual Studio: $($latest.Path) ($($latest.Line) $($latest.Version))."
  } else {
    'No Visual Studio installation was detected.'
  }

  throw @"
CMake was not found on PATH or under Visual Studio / Program Files.
$hint

After a Visual Studio 2026 update, reopen the Visual Studio Installer and ensure
"Desktop development with C++" includes **C++ CMake tools for Windows** (and the
Windows SDK). Older PATH entries to VS 2022 CMake are removed when 2022 is uninstalled.

You can run from Developer PowerShell for VS, or install standalone CMake 4.2+ for
Visual Studio 18 / 2026 generators. See build-setup.md.
"@
}

function Resolve-ROSICmakeVsGenerator {
  param([Parameter(Mandatory = $true)][string]$CmakeExe)

  $cmakeHelp = & $CmakeExe --help 2>&1 | Out-String
  $installs = Get-ROSIVisualStudioInstallations
  $hasVs18 = $false
  $hasVs2022 = $false
  foreach ($install in $installs) {
    if ($install.Version -match '^18\.' -or $install.Line -match '^(18|2026)$' -or
      $install.Path -match '\\Microsoft Visual Studio\\(18|2026)\\') {
      $hasVs18 = $true
    }
    if ($install.Version -match '^17\.' -or $install.Line -eq '2022' -or
      $install.Path -match '\\Microsoft Visual Studio\\2022\\') {
      $hasVs2022 = $true
    }
  }

  $cmakeListsVs18 = $cmakeHelp -match 'Visual Studio 18 2026'
  $cmakeListsVs17 = $cmakeHelp -match 'Visual Studio 17 2022'

  if ($hasVs18 -and $cmakeListsVs18) { return 'Visual Studio 18 2026' }
  if ($hasVs2022 -and $cmakeListsVs17) { return 'Visual Studio 17 2022' }
  if ($cmakeListsVs18) { return 'Visual Studio 18 2026' }
  if ($cmakeListsVs17) { return 'Visual Studio 17 2022' }

  $cmakeVersion = try {
    (& $CmakeExe --version 2>&1 | Select-Object -First 1) -replace '^cmake version ', ''
  } catch { 'unknown' }

  throw @"
No supported Visual Studio CMake generator found (cmake $cmakeVersion).

Visual Studio 2026 requires CMake **4.2+** with the **Visual Studio 18 2026** generator.
Open Visual Studio Installer → Modify → Desktop development with C++ → enable
**C++ CMake tools for Windows**, or install standalone CMake 4.2+ and retry.
"@
}

function Resolve-ROSIVsDevShellLauncher {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    $path = (& $vswhere -latest -prerelease -products * -property installationPath 2>$null | Out-String).Trim()
    if ($path -and (Test-Path -LiteralPath $path)) {
      $launch = Join-Path $path 'Common7\Tools\Launch-VsDevShell.ps1'
      if (Test-Path -LiteralPath $launch) { return $launch }
    }
  }

  foreach ($install in (Get-ROSIVisualStudioInstallations)) {
    $launch = Join-Path $install.Path 'Common7\Tools\Launch-VsDevShell.ps1'
    if (Test-Path -LiteralPath $launch) { return $launch }
  }

  throw 'Could not find Launch-VsDevShell.ps1. Install Visual Studio 2022 or 2026 with the C++ workload.'
}
