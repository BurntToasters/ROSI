const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = 'com.burnttoasters.rosi.yml';
const APP_ID = 'com.burnttoasters.rosi';
const BUILD_DIR_PREFIX = 'build-dir';
const REPO_DIR = 'repo';
const RELEASE_DIR = 'release';

const ARCH_MAP = {
  x64: 'x86_64',
  arm64: 'aarch64',
  x86_64: 'x86_64',
  aarch64: 'aarch64',
};

const BUNDLE_NAMES = {
  x86_64: 'ROSI-Linux-x86_64.flatpak',
  aarch64: 'ROSI-Linux-aarch64.flatpak',
};

function getSanitizedEnv() {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('SNAP')) {
      delete env[key];
    }
  }

  const snapInjectedKeys = [
    'GDK_PIXBUF_MODULE_FILE',
    'GDK_PIXBUF_MODULEDIR',
    'GSETTINGS_SCHEMA_DIR',
    'GTK_EXE_PREFIX',
    'GTK_PATH',
    'GTK_IM_MODULE_FILE',
    'GIO_MODULE_DIR',
    'LOCPATH',
    'XDG_DATA_HOME',
    'XDG_DATA_DIRS',
    'XDG_DATA_DIRS_VSCODE_SNAP_ORIG',
    'VSCODE_NLS_CONFIG',
  ];
  for (const key of snapInjectedKeys) {
    delete env[key];
  }

  if (typeof env.PATH === 'string') {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((part) => part && !part.includes('/snap/') && !part.includes('/var/lib/snapd'))
      .join(path.delimiter);
  }

  delete env.LD_LIBRARY_PATH;
  return env;
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, env: getSanitizedEnv(), ...opts });
}

function getHostArch() {
  return ARCH_MAP[os.arch()] || os.arch();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = args.slice(1);

  let archs = [];
  for (const flag of flags) {
    if (flag === '--x64' || flag === '--x86_64') archs.push('x86_64');
    if (flag === '--arm64' || flag === '--aarch64') archs.push('aarch64');
  }

  if (archs.length === 0) {
    archs = ['x86_64', 'aarch64'];
  }

  return { command, archs };
}

function clean(archs) {
  console.log('Cleaning Flatpak build artifacts...\n');

  for (const arch of archs) {
    const buildDir = `${BUILD_DIR_PREFIX}-${arch}`;
    if (fs.existsSync(path.join(ROOT, buildDir))) {
      run(`rm -rf ${buildDir}`);
    }
  }

  if (fs.existsSync(path.join(ROOT, BUILD_DIR_PREFIX))) {
    run(`rm -rf ${BUILD_DIR_PREFIX}`);
  }

  if (fs.existsSync(path.join(ROOT, REPO_DIR))) {
    run(`rm -rf ${REPO_DIR}`);
  }

  if (fs.existsSync(path.join(ROOT, '.flatpak-builder'))) {
    run('rm -rf .flatpak-builder');
  }
}

function buildArch(arch) {
  const buildDir = `${BUILD_DIR_PREFIX}-${arch}`;
  const hostArch = getHostArch();
  const isCross = arch !== hostArch;

  console.log(
    `\n=== Building Flatpak for ${arch} ${isCross ? '(cross-compile)' : '(native)'} ===\n`
  );

  try {
    run(`flatpak-builder --arch=${arch} --repo=${REPO_DIR} --force-clean ${buildDir} ${MANIFEST}`);
  } catch (error) {
    const buildFilesPath = path.join(ROOT, buildDir, 'files');
    const buildMetadataPath = path.join(ROOT, buildDir, 'metadata');
    const canRetryExport = fs.existsSync(buildFilesPath) && fs.existsSync(buildMetadataPath);

    if (!canRetryExport) {
      throw error;
    }

    console.log(
      '\nflatpak-builder export failed. Retrying export with --disable-sandbox (icon validator workaround)...\n'
    );
    run(`flatpak build-export --disable-sandbox --arch=${arch} ${REPO_DIR} ${buildDir}`);
  }
}

function bundleArch(arch) {
  const bundleName = BUNDLE_NAMES[arch];
  const outputPath = path.join(RELEASE_DIR, bundleName);

  console.log(`\nCreating bundle: ${bundleName}\n`);

  fs.mkdirSync(path.join(ROOT, RELEASE_DIR), { recursive: true });

  run(`flatpak build-bundle --arch=${arch} ${REPO_DIR} ${outputPath} ${APP_ID}`);

  console.log(`Bundle created: ${outputPath}`);
}

function installArch(arch) {
  const buildDir = `${BUILD_DIR_PREFIX}-${arch}`;

  console.log(`\n=== Installing Flatpak for ${arch} ===\n`);

  run(`flatpak-builder --user --install --arch=${arch} --force-clean ${buildDir} ${MANIFEST}`);
}

function main() {
  const { command, archs } = parseArgs();

  switch (command) {
    case 'build':
      for (const arch of archs) {
        installArch(arch);
      }
      break;

    case 'bundle':
      clean(archs);
      for (const arch of archs) {
        buildArch(arch);
      }
      for (const arch of archs) {
        bundleArch(arch);
      }
      break;

    case 'clean':
      clean(archs);
      break;

    default:
      console.log('ROSI Flatpak Build Script\n');
      console.log('Usage: node build-scripts/flatpak.js <command> [options]\n');
      console.log('Commands:');
      console.log('  build     Build and install locally');
      console.log('  bundle    Build and create .flatpak bundles');
      console.log('  clean     Remove build artifacts\n');
      console.log('Options:');
      console.log('  --x64       Build for x86_64 only');
      console.log('  --arm64     Build for aarch64 only');
      console.log('  (default)   Build for both architectures');
      process.exit(1);
  }
}

main();
