const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronBinary = require('electron');
const trackedExecutableAssets = [
  path.join(ROOT, 'assets', 'yt-dlp_macos'),
  path.join(ROOT, 'assets', 'yt-dlp_linux'),
  path.join(ROOT, 'assets', 'yt-dlp_linux_aarch64'),
];

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function snapshotFileModes(paths) {
  return paths
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, mode: stat.mode };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function restoreFileModes(snapshots) {
  for (const snapshot of snapshots) {
    try {
      fs.chmodSync(snapshot.filePath, snapshot.mode);
    } catch {
      // Best effort: smoke cleanup should not hide the real Electron exit code.
    }
  }
}

function runRuntimeSmoke(skipCompile = false) {
  if (!skipCompile) {
    runCommand(npmCmd, ['run', 'compile']);
  }

  const modeSnapshots = snapshotFileModes(trackedExecutableAssets);
  let restoredModes = false;
  const restoreModesOnce = () => {
    if (restoredModes) return;
    restoredModes = true;
    restoreFileModes(modeSnapshots);
  };
  process.on('exit', restoreModesOnce);

  const smokeArgs = ['.', '--dev', '--smoke'];
  const env = {
    ...process.env,
    ROSI_SMOKE: '1',
    NODE_ENV: 'development',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  if ('ELECTRON_RUN_AS_NODE' in env) {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  const child = spawn(electronBinary, smokeArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });

  const timeoutMs = Number(process.env.ROSI_SMOKE_TIMEOUT_MS || 120000);
  const timeout = setTimeout(() => {
    console.error(`Runtime smoke timed out after ${timeoutMs}ms.`);
    if (!child.killed) {
      child.kill();
    }
    setTimeout(() => {
      restoreModesOnce();
      process.exit(1);
    }, 500);
  }, timeoutMs);

  child.on('error', (error) => {
    clearTimeout(timeout);
    console.error('Failed to start Electron runtime smoke:', error);
    restoreModesOnce();
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    restoreModesOnce();
    if (signal) {
      console.error(`Runtime smoke terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const skipCompile = process.argv.includes('--skip-compile');
runRuntimeSmoke(skipCompile);
