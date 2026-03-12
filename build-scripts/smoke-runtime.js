const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronBinary = require('electron');

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

function runRuntimeSmoke(skipCompile = false) {
  if (!skipCompile) {
    runCommand(npmCmd, ['run', 'compile']);
  }

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
    setTimeout(() => process.exit(1), 500);
  }, timeoutMs);

  child.on('error', (error) => {
    clearTimeout(timeout);
    console.error('Failed to start Electron runtime smoke:', error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    if (signal) {
      console.error(`Runtime smoke terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const skipCompile = process.argv.includes('--skip-compile');
runRuntimeSmoke(skipCompile);
