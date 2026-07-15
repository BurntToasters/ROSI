Set-StrictMode -Version Latest

function Import-BundledPowerShellSecurityModule {
  $moduleManifest = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
  if (-not (Test-Path -LiteralPath $moduleManifest -PathType Leaf)) {
    throw "The bundled Microsoft.PowerShell.Security module was not found: $moduleManifest"
  }
  Import-Module -Name $moduleManifest -Force -ErrorAction Stop
}

function Get-ArtifactSigningTools {
  $signToolOverride = $env:AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH
  $dlibOverride = $env:AZURE_ARTIFACT_SIGNING_DLIB_PATH
  $signToolPath = $null
  $dlibPath = $null
  if ($signToolOverride) {
    if (-not (Test-Path -LiteralPath $signToolOverride -PathType Leaf)) {
      throw "Configured SignTool was not found: $signToolOverride"
    }
    $signToolOverride = (Resolve-Path -LiteralPath $signToolOverride).Path
  }
  if ($dlibOverride) {
    if (-not (Test-Path -LiteralPath $dlibOverride -PathType Leaf)) {
      throw "Configured Artifact Signing dlib was not found: $dlibOverride"
    }
    $dlibOverride = (Resolve-Path -LiteralPath $dlibOverride).Path
  }

  $clientRoots = @(
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft\ArtifactSigningClientTools' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftArtifactSigningClientTools' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique

  if ($dlibOverride) {
    $dlibPath = $dlibOverride
  } else {
    $dlibCandidates = @(
      foreach ($root in $clientRoots) {
        Get-ChildItem -LiteralPath $root -Filter 'Azure.CodeSigning.Dlib.dll' -File -Recurse -ErrorAction SilentlyContinue
      }
    )
    $dlib = $dlibCandidates |
      Sort-Object @{ Expression = { if ($_.FullName -match '[\\/]x64[\\/]') { 0 } elseif ($_.FullName -match '[\\/]x86[\\/]') { 2 } else { 1 } } }, @{ Expression = { $_.FullName } } |
      Select-Object -First 1
    if ($dlib) { $dlibPath = $dlib.FullName }
  }

  if ($signToolOverride) {
    $signToolPath = $signToolOverride
  } else {
    $signToolCandidates = @(
      foreach ($root in $clientRoots) {
        Get-ChildItem -LiteralPath $root -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue
      }
    )
    if ($signToolCandidates.Count -eq 0 -and ${env:ProgramFiles(x86)}) {
      $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
      if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
        $signToolCandidates = @(
          Get-ChildItem -LiteralPath $kitsRoot -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue
        )
      }
    }
    $preferredArchitecture = if ($dlibPath -and $dlibPath -match '[\\/]x86[\\/]') { 'x86' } else { 'x64' }
    $matchingSignTools = @($signToolCandidates | Where-Object {
      if ($preferredArchitecture -eq 'x86') { $_.FullName -notmatch '[\\/]x64[\\/]' }
      else { $_.FullName -notmatch '[\\/]x86[\\/]' }
    })
    $signTool = $matchingSignTools |
      Sort-Object @{ Expression = { if ($_.FullName -match "[\\/]$preferredArchitecture[\\/]") { 0 } else { 1 } } }, @{ Expression = { $_.FullName }; Descending = $true } |
      Select-Object -First 1
    if ($signTool) { $signToolPath = $signTool.FullName }
  }

  if (-not $signToolPath -or -not $dlibPath) {
    throw 'Artifact Signing Client Tools were not found. Run npm run setup:win:artifact-signing first.'
  }
  if ($signToolPath -match '[\\/]x86[\\/]' -and $dlibPath -match '[\\/]x64[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  if ($signToolPath -match '[\\/]x64[\\/]' -and $dlibPath -match '[\\/]x86[\\/]') {
    throw "SignTool and Artifact Signing dlib architectures do not match: $signToolPath ; $dlibPath"
  }
  return [PSCustomObject]@{
    SignToolPath = $signToolPath
    DlibPath = $dlibPath
  }
}
