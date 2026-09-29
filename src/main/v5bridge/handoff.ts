/**
 * Detached helpers that finish the bridge after ROSI 4 exits. ROSI 5's
 * installer kills any running rosi.exe, and the app bundle cannot be replaced
 * while it runs, so these wait for this process to exit first.
 *
 * Values reach the helpers as environment variables (Windows) or separate
 * arguments (macOS), never interpolated into script text. Each helper writes
 * a JSON status file; the first write ("started") is the heartbeat ROSI 4
 * waits for before quitting.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface BridgeStatus {
  stage: 'started' | 'succeeded' | 'failed';
  reason?: string;
  detail?: string;
  version?: string;
  v5Path?: string;
  v4Removed?: boolean;
  steps?: string[];
  updatedAt?: string;
}

const WINDOWS_HELPER = String.raw`
$V4Pid = [int]$env:ROSI_BRIDGE_V4_PID
$Installer = $env:ROSI_BRIDGE_INSTALLER
$V4Exe = $env:ROSI_BRIDGE_V4_EXE
$V4Uninstaller = $env:ROSI_BRIDGE_V4_UNINSTALLER
$ExpectedVersion = $env:ROSI_BRIDGE_VERSION
$StatusFile = $env:ROSI_BRIDGE_STATUS
$ErrorActionPreference = 'Stop'
$steps = New-Object System.Collections.Generic.List[string]
function Save-Status([string]$Stage, [hashtable]$Extra = @{}) {
  $status = [ordered]@{ stage = $Stage; version = $ExpectedVersion; steps = $steps; updatedAt = (Get-Date).ToUniversalTime().ToString('o') }
  foreach ($key in $Extra.Keys) { $status[$key] = $Extra[$key] }
  $tmp = "$StatusFile.tmp"
  [IO.File]::WriteAllText($tmp, ($status | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $StatusFile -Force
}
function Step([string]$Text) { $steps.Add("$((Get-Date).ToUniversalTime().ToString('o')) $Text") }
function Fail([string]$Reason, [string]$Detail, [bool]$RelaunchV4) {
  Step "failed: $Reason $Detail"
  Save-Status 'failed' @{ reason = $Reason; detail = $Detail }
  if ($RelaunchV4 -and (Test-Path -LiteralPath $V4Exe)) { Start-Process -FilePath $V4Exe | Out-Null }
  exit 1
}
try {
  Step 'helper started'
  Save-Status 'started'
  $v4Dir = Split-Path -Parent $V4Exe
  try { Wait-Process -Id $V4Pid -Timeout 120 -ErrorAction Stop } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
  if (Get-Process -Id $V4Pid -ErrorAction SilentlyContinue) { Fail 'v4-did-not-exit' 'ROSI 4 was still running after 2 minutes.' $false }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($v4Dir, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  Step 'ROSI 4 exited'
  $install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  Step "ROSI 5 installer exit code $($install.ExitCode)"
  $key = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ROSI' -ErrorAction SilentlyContinue
  $location = if ($key -and $key.InstallLocation) { ([string]$key.InstallLocation).Trim('"') } else { '' }
  $v5Exe = if ($location) { Join-Path $location 'rosi.exe' } else { '' }
  $major = 0
  if ($key -and ([string]$key.DisplayVersion) -match '^(\d+)\.') { $major = [int]$Matches[1] }
  if ($install.ExitCode -ne 0 -or -not $v5Exe -or -not (Test-Path -LiteralPath $v5Exe) -or $major -lt 5) {
    Fail 'install-failed' "Installer exit $($install.ExitCode); registered version '$($key.DisplayVersion)'; rosi.exe '$v5Exe'." $true
  }
  Step "ROSI 5 $($key.DisplayVersion) installed at $location"
  $removed = $false
  if (Test-Path -LiteralPath $V4Uninstaller) {
    Start-Process -FilePath $V4Uninstaller -ArgumentList '/currentuser', '/S', '--keep-shortcuts' -Wait | Out-Null
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $V4Exe)) { Start-Sleep -Milliseconds 500 }
    $removed = -not (Test-Path -LiteralPath $V4Exe)
  }
  Step "ROSI 4 removed: $removed"
  Start-Process -FilePath $v5Exe | Out-Null
  Step 'ROSI 5 launched'
  Save-Status 'succeeded' @{ v5Path = $v5Exe; v4Removed = $removed }
  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
} catch {
  Fail 'helper-error' $_.Exception.Message $true
}
`;

const MAC_HELPER = `#!/bin/sh
# Args: v4-pid staged-app current-app destination-app status-file version
V4_PID="$1"; STAGED="$2"; CURRENT="$3"; DEST="$4"; STATUS="$5"; VERSION="$6"
STEPS=""
json_escape() { printf '%s' "$1" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | /usr/bin/tr -d '\\n'; }
step() { STEPS="$STEPS\\"$(date -u +%Y-%m-%dT%H:%M:%SZ) $(json_escape "$1")\\","; }
save() {
  printf '{"stage":"%s","version":"%s","reason":"%s","detail":"%s","v5Path":"%s","v4Removed":%s,"steps":[%s""]}' \\
    "$1" "$(json_escape "$VERSION")" "$(json_escape "$2")" "$(json_escape "$3")" "$(json_escape "$4")" "$5" "$STEPS" > "$STATUS.tmp" && /bin/mv -f "$STATUS.tmp" "$STATUS"
}
fail() { step "failed: $1 $2"; save failed "$1" "$2" "" false; [ "$3" = relaunch ] && [ -d "$CURRENT" ] && /usr/bin/open "$CURRENT"; exit 1; }
step "helper started"; save started "" "" "" false
i=0
while /bin/kill -0 "$V4_PID" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 240 ] && fail v4-did-not-exit "ROSI 4 was still running after 2 minutes." norelaunch
  /bin/sleep 0.5
done
step "ROSI 4 exited"
BACKUP="$CURRENT.rosi4-backup.$$"
/bin/mv "$CURRENT" "$BACKUP" || fail move-failed "Could not move $CURRENT aside." relaunch
DEST_BACKUP=""
if [ -e "$DEST" ]; then
  DEST_BACKUP="$DEST.rosi5-previous.$$"
  if ! /bin/mv "$DEST" "$DEST_BACKUP"; then /bin/mv "$BACKUP" "$CURRENT"; fail move-failed "Could not move the existing $DEST aside." relaunch; fi
fi
if ! /bin/mv "$STAGED" "$DEST"; then
  [ -n "$DEST_BACKUP" ] && /bin/mv "$DEST_BACKUP" "$DEST"
  /bin/mv "$BACKUP" "$CURRENT"
  fail install-failed "Could not move ROSI 5 into place." relaunch
fi
step "ROSI 5 moved to $DEST"
/bin/rm -rf "$BACKUP"; [ -n "$DEST_BACKUP" ] && /bin/rm -rf "$DEST_BACKUP"
/bin/rmdir "$(/usr/bin/dirname "$STAGED")" 2>/dev/null
step "ROSI 4 removed"
/usr/bin/open "$DEST"
step "ROSI 5 launched"
save succeeded "" "" "$DEST" true
`;

export function readStatus(statusFile: string): BridgeStatus | null {
  try {
    const raw = fs.readFileSync(statusFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as BridgeStatus;
    if (!parsed || typeof parsed.stage !== 'string') return null;
    // The shell helper ends its steps array with an empty sentinel.
    if (Array.isArray(parsed.steps)) parsed.steps = parsed.steps.filter(Boolean);
    return parsed;
  } catch {
    return null;
  }
}

async function waitForHeartbeat(statusFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readStatus(statusFile)?.stage === 'started') return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

// A detached (DETACHED_PROCESS) powershell.exe exits without running anything,
// and a normal child dies with ROSI 4 (libuv's kill-on-close job). The helper
// is therefore a grandchild: a short-lived launcher starts it with Start-Process.
const WINDOWS_LAUNCHER = String.raw`
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $env:ROSI_BRIDGE_SCRIPT + '"'))
Start-Process -FilePath $env:ROSI_BRIDGE_POWERSHELL -ArgumentList $arguments -WindowStyle Hidden
`;

export interface WindowsHandoff {
  installer: string;
  v4Exe: string;
  v4Uninstaller: string;
  version: string;
  statusFile: string;
  workDir: string;
}

/** Start the Windows helper; resolves once it reports "started". */
export async function startWindowsHelper(options: WindowsHandoff): Promise<void> {
  const script = path.join(options.workDir, 'rosi-v5-bridge.ps1');
  fs.writeFileSync(script, `\uFEFF${WINDOWS_HELPER}`, { encoding: 'utf8', mode: 0o600 });
  fs.rmSync(options.statusFile, { force: true });
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const launcher = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_LAUNCHER],
    {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ROSI_BRIDGE_POWERSHELL: powershell,
        ROSI_BRIDGE_SCRIPT: script,
        ROSI_BRIDGE_V4_PID: String(process.pid),
        ROSI_BRIDGE_INSTALLER: options.installer,
        ROSI_BRIDGE_V4_EXE: options.v4Exe,
        ROSI_BRIDGE_V4_UNINSTALLER: options.v4Uninstaller,
        ROSI_BRIDGE_VERSION: options.version,
        ROSI_BRIDGE_STATUS: options.statusFile,
      },
    }
  );
  launcher.on('error', () => undefined);
  if (!(await waitForHeartbeat(options.statusFile, 20_000))) {
    throw new Error('The ROSI 5 installer helper did not start (PowerShell may be blocked).');
  }
}

export interface MacHandoff {
  stagedApp: string;
  currentApp: string;
  destinationApp: string;
  version: string;
  statusFile: string;
  workDir: string;
}

/** Start the macOS helper; resolves once it reports "started". */
export async function startMacHelper(options: MacHandoff): Promise<void> {
  const script = path.join(options.workDir, 'rosi-v5-bridge.sh');
  fs.writeFileSync(script, MAC_HELPER, { mode: 0o700 });
  fs.rmSync(options.statusFile, { force: true });
  launchDetached('/bin/sh', [
    script,
    String(process.pid),
    options.stagedApp,
    options.currentApp,
    options.destinationApp,
    options.statusFile,
    options.version,
  ]);
  if (!(await waitForHeartbeat(options.statusFile, 20_000))) {
    throw new Error('The ROSI 5 installer helper did not start.');
  }
}
