const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

function usage() {
  console.error(
    'Usage: node build-scripts/build-with-restore.js [--prepare <script>] [--env KEY=VALUE] -- <command> [args...]'
  );
  process.exit(1);
}

function run(command, commandArgs, envOverrides) {
  let finalCommand = command;
  let finalArgs = commandArgs;

  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    finalCommand = 'cmd.exe';
    finalArgs = ['/c', `${command}.cmd`, ...commandArgs];
  }

  const result = spawnSync(finalCommand, finalArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

let prepareScript = null;
const envOverrides = {};
const separatorIndex = args.indexOf('--');

if (separatorIndex === -1) {
  usage();
}

const optionArgs = args.slice(0, separatorIndex);
const commandParts = args.slice(separatorIndex + 1);
if (commandParts.length === 0) {
  usage();
}

for (let i = 0; i < optionArgs.length; i++) {
  const current = optionArgs[i];
  if (current === '--prepare') {
    const next = optionArgs[i + 1];
    if (!next) usage();
    prepareScript = next;
    i++;
    continue;
  }

  if (current === '--env') {
    const next = optionArgs[i + 1];
    if (!next || !next.includes('=')) usage();
    const [key, ...valueParts] = next.split('=');
    envOverrides[key] = valueParts.join('=');
    i++;
    continue;
  }

  usage();
}

let exitCode = 0;

try {
  if (prepareScript) {
    exitCode = run(process.execPath, [path.resolve(prepareScript)], envOverrides);
  }

  if (exitCode === 0) {
    const [command, ...commandArgs] = commandParts;
    exitCode = run(command, commandArgs, envOverrides);
  }
} finally {
  if (prepareScript) {
    const restoreCode = run(process.execPath, [path.join(__dirname, 'restore-binaries.js')], {});
    if (exitCode === 0 && restoreCode !== 0) {
      exitCode = restoreCode;
    }
  }
}

process.exit(exitCode);
