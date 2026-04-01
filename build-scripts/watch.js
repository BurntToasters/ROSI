const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tscBin = require.resolve('typescript/bin/tsc');
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

const clean = spawn(process.execPath, [path.join(__dirname, 'dist-tools.js'), 'clean'], {
  cwd: ROOT,
  stdio: 'inherit',
});

clean.on('close', (code) => {
  if (code !== 0) {
    process.exit(code);
  }

  const mainWatcher = spawn(
    process.execPath,
    [tscBin, '--project', 'tsconfig.main.json', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: 'inherit' }
  );

  mainWatcher.on('exit', (exitCode, signal) => {
    if (shuttingDown) return;
    if (signal) {
      shutdown(0);
      return;
    }
    shutdown(exitCode ?? 0);
  });

  const rendererWatcher = spawn(
    process.execPath,
    [tscBin, '--project', 'tsconfig.renderer.json', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: 'inherit' }
  );

  rendererWatcher.on('exit', (exitCode, signal) => {
    if (shuttingDown) return;
    if (signal) {
      shutdown(0);
      return;
    }
    shutdown(exitCode ?? 0);
  });

  children.push(mainWatcher, rendererWatcher);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
