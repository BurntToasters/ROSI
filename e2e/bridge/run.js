#!/usr/bin/env node
/**
 * ROSI 4 to ROSI 5 bridge E2E. Builds a ROSI 4 test app whose bridge reads a
 * local feed and trusts a throwaway key, then drives the real UI over the
 * DevTools protocol through each scenario and checks the machine afterwards.
 * Evidence: e2e/artifacts/bridge-e2e-<platform>-<arch>.json.
 *
 * Windows (test VM only: uninstalls ROSI 4 and 5 and deletes their data):
 *   node e2e/bridge/run.js --tauri-cli <tauri.js> --v5-installer <setup.exe>
 *     --v5-version 5.0.0-beta.1 --reset-this-machine
 * macOS (temporary folders only; ROSI 5 is a signed stand-in app):
 *   node e2e/bridge/run.js --tauri-cli <tauri.js>
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const FEED_PORT = 8977;
const CDP_PORT = 9333;
const FEED = `http://127.0.0.1:${FEED_PORT}`;
const IS_WIN = process.platform === 'win32';
const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const OS = IS_WIN ? 'windows' : 'darwin';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args['tauri-cli'])
  throw new Error('--tauri-cli <path to @tauri-apps/cli/tauri.js> is required.');
if (IS_WIN && (!args['v5-installer'] || !args['reset-this-machine'])) {
  throw new Error('Windows needs --v5-installer and --reset-this-machine (it uninstalls ROSI).');
}
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Windows and macOS only.');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-bridge-e2e-'));
const scenarios = [];
const evidence = {
  app: 'ROSI',
  suite: 'v5-bridge',
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  startedAt: new Date().toISOString(),
  work,
};

function check(condition, message, details) {
  if (!condition)
    throw new Error(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}

async function scenario(name, covers, body) {
  const started = Date.now();
  console.log(`\n=== ${name}`);
  try {
    const details = await body();
    scenarios.push({
      ...details,
      name,
      status: 'passed',
      covers,
      durationMs: Date.now() - started,
    });
    console.log(`=== ${name}: passed`);
  } catch (error) {
    scenarios.push({
      name,
      status: 'failed',
      covers,
      error: error instanceof Error ? error.stack : String(error),
    });
    throw error;
  }
}

function npm(script) {
  lib.run(IS_WIN ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: ROOT,
    shell: IS_WIN,
    stdio: 'inherit',
  });
}

function tauri(argsList, env = {}) {
  return lib.run(process.execPath, [args['tauri-cli'], ...argsList], {
    cwd: work,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '', ...env },
  });
}

function generateKey(name) {
  const file = path.join(work, 'keys', `${name}.key`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  tauri(['signer', 'generate', '--ci', '-w', file, '-p', '']);
  return { file, publicKey: fs.readFileSync(`${file}.pub`, 'utf8').trim() };
}

function sign(file, key) {
  tauri(['signer', 'sign', '-f', key.file, '-p', '', file]);
  const signature = fs.readFileSync(`${file}.sig`, 'utf8').trim();
  fs.rmSync(`${file}.sig`);
  return signature;
}

function manifest(version, fileRoute, signature) {
  const key = `${OS}-beta-${ARCH}-${IS_WIN ? 'nsis' : 'app'}`;
  return JSON.stringify({
    version,
    pub_date: new Date().toISOString(),
    platforms: { [key]: { url: `${FEED}${fileRoute}`, signature } },
  });
}

const paths = IS_WIN
  ? {
      v4Dir: path.join(process.env.LOCALAPPDATA, 'Programs', 'Rosi'),
      v4Data: path.join(process.env.APPDATA, 'rosi'),
      v5Dir: path.join(process.env.LOCALAPPDATA, 'ROSI'),
      v5Data: path.join(process.env.APPDATA, 'run.rosie.rosi'),
    }
  : {
      apps: path.join(work, 'Applications'),
      v4Data: path.join(work, 'rosi-userdata'),
      marker: path.join(work, 'rosi5-launched.txt'),
    };
if (IS_WIN) paths.v4Exe = path.join(paths.v4Dir, 'Rosi.exe');
else paths.v4App = path.join(paths.apps, 'Rosi.app');
paths.bridgeDir = path.join(paths.v4Data, 'v5-bridge');

function v4Executable() {
  return IS_WIN ? paths.v4Exe : path.join(paths.v4App, 'Contents', 'MacOS', 'Rosi');
}

async function buildV4(publicKey) {
  npm('compile');
  npm('licenses');
  const production = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'main', 'v5bridge', 'config.json'), 'utf8')
  );
  const config = {
    ...production,
    feedBase: `${FEED}/v5/`,
    allowedDownloadPrefixes: [`${FEED}/v5/`],
    publicKey,
    ...(IS_WIN ? {} : { macTeamId: null }),
    e2e: {
      remoteDebuggingPort: CDP_PORT,
      ...(IS_WIN ? {} : { userDataDir: paths.v4Data, useMockKeychain: true }),
    },
  };
  fs.writeFileSync(
    path.join(ROOT, 'dist', 'main', 'v5bridge', 'config.json'),
    JSON.stringify(config, null, 2)
  );
  const out = path.join(work, 'v4-build');
  lib.run(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
      '-c',
      path.join(__dirname, 'electron-builder.e2e.cjs'),
      IS_WIN ? '--win' : '--mac',
      `--${process.arch}`,
      '--publish',
      'never',
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        SKIP_WIN_CODESIGN: '1',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        ROSI_BRIDGE_E2E_OUT: out,
        ROSI_BRIDGE_E2E_V4_FEED: `${FEED}/v4/`,
      },
    }
  );
  if (IS_WIN) {
    lib.run(process.execPath, [path.join(ROOT, 'build-scripts', 'check-nsis-payload.js'), out], {
      stdio: 'inherit',
    });
    return { installer: path.join(out, `ROSI-Windows-${process.arch}.exe`) };
  }
  // The "dir" target writes no app-update.yml; add the one a DMG/ZIP build gets.
  const app = path.join(out, `mac-${process.arch}`, 'Rosi.app');
  fs.writeFileSync(
    path.join(app, 'Contents', 'Resources', 'app-update.yml'),
    `provider: generic\nurl: ${FEED}/v4/\nupdaterCacheDirName: rosi-updater\n`
  );
  lib.run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return { app };
}

function v4Feed(version) {
  const yml = `version: ${version}\nfiles:\n  - url: Rosi-${version}.bin\n    sha512: ${crypto.createHash('sha512').update('x').digest('base64')}\n    size: 1\npath: Rosi-${version}.bin\nsha512: ${crypto.createHash('sha512').update('x').digest('base64')}\nreleaseDate: '${new Date().toISOString()}'\n`;
  const suffix = IS_WIN ? '' : '-mac';
  return { [`/v4/latest${suffix}.yml`]: yml, [`/v4/beta${suffix}.yml`]: yml };
}

function seedV4Data() {
  fs.mkdirSync(paths.v4Data, { recursive: true });
  const downloads = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const settings = {
    settingsVersion: 7,
    theme: 'purple',
    firstLaunch: false,
    hideSupportModal: true,
    denoReminderDismissed: true,
    checkUpdatesOnStartup: false,
    updateChannel: 'beta',
    notifications: true,
    animateBackground: false,
    downloadFolder: downloads,
  };
  fs.writeFileSync(path.join(paths.v4Data, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(
    path.join(paths.v4Data, 'download-stats.json'),
    JSON.stringify({
      totalDownloads: 42,
      successfulDownloads: 40,
      failedDownloads: 1,
      cancelledDownloads: 1,
      totalBytesDownloaded: 123456789,
      formatCounts: { mp4: 40 },
      firstDownloadAt: 1780000000000,
      lastDownloadAt: 1780000500000,
    })
  );
  fs.writeFileSync(
    path.join(paths.v4Data, 'download-queue.json'),
    JSON.stringify([
      {
        id: 'e2e-pending',
        url: 'https://example.com/watch?v=rosi-bridge-e2e',
        status: 'pending',
        addedAt: 1780000600000,
      },
    ])
  );
  return settings;
}

async function launchV4() {
  const child = spawn(v4Executable(), [], { detached: true, stdio: 'ignore' });
  child.unref();
  await lib.waitFor(
    'ROSI 4 window',
    () =>
      lib.cdpEvaluate(CDP_PORT, "Boolean(window.api && document.getElementById('checkUpdateBtn'))"),
    { timeout: 90_000 }
  );
  await lib.sleep(1500);
}

function v4Pids() {
  return lib.processesUnder(IS_WIN ? paths.v4Dir : paths.v4App).map(([pid]) => pid);
}

async function offerUpgrade() {
  await lib.cdpEvaluate(CDP_PORT, "document.getElementById('checkUpdateBtn').click(), true");
  return lib.waitForModal(CDP_PORT, /^ROSI 5\..* is available$/);
}

function bridgeFiles() {
  return fs.existsSync(paths.bridgeDir) ? fs.readdirSync(paths.bridgeDir).sort() : [];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readStatus() {
  for (const name of ['status.json', 'status.reported.json']) {
    const file = path.join(paths.bridgeDir, name);
    if (fs.existsSync(file)) return { file: name, ...readJson(file) };
  }
  return null;
}

// Windows machine helpers.
function regValue(key, value) {
  const result = lib.run('reg.exe', ['query', key, '/v', value], { check: false });
  const match = result.stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`));
  return match ? match[1].trim() : null;
}
const V5_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ROSI';
function v4UninstallKeys() {
  return lib.powershell(
    "Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -match '^Rosi 4') { $_.PSChildName } }"
  );
}
function shortcuts() {
  return lib
    .powershell(
      '$ws = New-Object -ComObject WScript.Shell; Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:USERPROFILE\\Desktop" -Filter *.lnk | Where-Object Name -match \'^rosi\' | ForEach-Object { "$($_.FullName)|$($ws.CreateShortcut($_.FullName).TargetPath)" }'
    )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [file, target] = line.split('|');
      return { file, target };
    });
}

async function resetWindows() {
  for (const dir of [paths.v4Dir, paths.v5Dir]) {
    for (const [pid] of lib.processesUnder(dir))
      lib.run('taskkill.exe', ['/F', '/PID', pid], { check: false });
  }
  const v5Uninstaller = path.join(paths.v5Dir, 'uninstall.exe');
  if (fs.existsSync(v5Uninstaller)) lib.run(v5Uninstaller, ['/S'], { check: false });
  const v4Uninstaller = path.join(paths.v4Dir, 'Uninstall Rosi.exe');
  if (fs.existsSync(v4Uninstaller))
    lib.run(v4Uninstaller, ['/currentuser', '/S'], { check: false });
  // NSIS uninstallers relaunch themselves from %TEMP% and return at once.
  await lib.waitFor(
    'old installs removed',
    () => !fs.existsSync(v5Uninstaller) && !fs.existsSync(v4Uninstaller),
    { timeout: 120_000 }
  );
  for (const dir of [
    paths.v4Dir,
    paths.v4Data,
    paths.v5Data,
    path.join(process.env.LOCALAPPDATA, 'run.rosie.rosi'),
    path.join(process.env.LOCALAPPDATA, 'rosi-updater'),
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const { file } of shortcuts()) fs.rmSync(file, { force: true });
  check(
    !regValue(V5_KEY, 'DisplayVersion') && !v4UninstallKeys(),
    'machine still has ROSI installed'
  );
}

async function windowsScenarios(v4, keys, feed) {
  const v5Version = args['v5-version'] || '5.0.0';
  await resetWindows();
  lib.run(v4.installer, ['/S', '/currentuser']);
  await lib.waitFor('ROSI 4 installed', () => fs.existsSync(paths.v4Exe), { timeout: 120_000 });
  const seeded = seedV4Data();
  const installer = path.join(work, 'ROSI-5-setup.exe');
  fs.copyFileSync(args['v5-installer'], installer);
  const failing = path.join(work, 'fail-setup.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), failing);
  const signatures = {
    wrong: sign(installer, keys.wrong),
    good: sign(installer, keys.good),
    failing: sign(failing, keys.good),
  };
  const manifestRoute = `/v5/latest-windows-beta-${ARCH}.json`;
  feed.routes.set('/v5/ROSI-5-setup.exe', { file: installer });
  feed.routes.set('/v5/fail-setup.exe', { file: failing });
  await launchV4();

  await scenario('bridge-bad-signature', ['bad-download-rejected', 'no-consent'], async () => {
    feed.routes.set(manifestRoute, {
      body: manifest(v5Version, '/v5/ROSI-5-setup.exe', signatures.wrong),
    });
    const offer = await offerUpgrade();
    const beforeConsent = { requests: feed.count('/v5/ROSI-5-setup.exe'), files: bridgeFiles() };
    check(
      beforeConsent.requests === 0 && !beforeConsent.files.includes('ROSI-5-setup.exe'),
      'downloaded before consent',
      beforeConsent
    );
    await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
    const failed = await lib.waitForModal(CDP_PORT, /^ROSI 5 Download Failed$/, 180_000);
    check(/signature/i.test(failed.message), 'failure does not mention the signature', failed);
    check(feed.count('/v5/ROSI-5-setup.exe') === 1, 'installer was not downloaded once');
    check(
      !bridgeFiles().includes('ROSI-5-setup.exe'),
      'rejected download left on disk',
      bridgeFiles()
    );
    check(!regValue(V5_KEY, 'DisplayVersion'), 'ROSI 5 was installed');
    check(fs.existsSync(paths.v4Exe) && v4Pids().length > 0, 'ROSI 4 is not running');
    await lib.dismissModal(CDP_PORT, 'OK');
    return { offer: offer.title, beforeConsent, failure: failed.message };
  });

  await scenario(
    'bridge-install-fails',
    ['install-fails-v4-removed', 'failure-silent'],
    async () => {
      feed.routes.set(manifestRoute, {
        body: manifest(v5Version, '/v5/fail-setup.exe', signatures.failing),
      });
      await offerUpgrade();
      await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
      await lib.waitForModal(CDP_PORT, /^Ready to Install ROSI 5$/, 180_000);
      const before = v4Pids();
      await lib.clickModalButton(CDP_PORT, 'Install and Restart');
      const status = await lib.waitFor(
        'failed bridge status',
        () => {
          const current = readStatus();
          return current?.stage === 'failed' ? current : null;
        },
        { timeout: 180_000 }
      );
      check(status.reason === 'install-failed', 'unexpected failure reason', status);
      await lib.waitFor(
        'ROSI 4 relaunched',
        () => {
          const pids = v4Pids();
          return pids.length > 0 && !pids.some((pid) => before.includes(pid));
        },
        { timeout: 90_000 }
      );
      const report = await lib.waitForModal(
        CDP_PORT,
        /^The ROSI 5 Upgrade Did Not Finish$/,
        90_000
      );
      check(
        fs.existsSync(path.join(paths.bridgeDir, 'status.reported.json')),
        'failure not marked as reported'
      );
      check(
        fs.existsSync(paths.v4Exe) && v4UninstallKeys(),
        'ROSI 4 was removed after a failed install'
      );
      check(!regValue(V5_KEY, 'DisplayVersion'), 'ROSI 5 is registered after a failed install');
      await lib.dismissModal(CDP_PORT, 'OK');
      return { helper: status, report: report.message };
    }
  );

  await scenario(
    'bridge-success',
    [
      'v4-killed-before-flush',
      'shortcuts-lost',
      'v4-left-behind',
      'data-not-imported',
      'v4-data-deleted',
    ],
    async () => {
      feed.routes.set(manifestRoute, {
        body: manifest(v5Version, '/v5/ROSI-5-setup.exe', signatures.good),
      });
      fs.rmSync(path.join(paths.bridgeDir, 'status.reported.json'), { force: true });
      await offerUpgrade();
      await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
      await lib.waitForModal(CDP_PORT, /^Ready to Install ROSI 5$/, 180_000);
      // Change a setting right before the handoff: it must reach ROSI 5.
      await lib.clickModalButton(
        CDP_PORT,
        'Install and Restart',
        "const t = document.getElementById('notificationsToggle'); t.checked = !t.checked; t.dispatchEvent(new Event('change', { bubbles: true }));"
      );
      const status = await lib.waitFor(
        'successful bridge status',
        () => {
          const current = readStatus();
          if (current?.stage === 'failed')
            throw new Error(`bridge failed: ${JSON.stringify(current)}`);
          return current?.stage === 'succeeded' ? current : null;
        },
        { timeout: 300_000, interval: 1000 }
      );
      const v5Exe = path.join(paths.v5Dir, 'rosi.exe');
      await lib.waitFor('ROSI 5 running', () => lib.processesUnder(paths.v5Dir).length > 0, {
        timeout: 60_000,
      });
      const marker = await lib.waitFor('ROSI 5 import marker', () => {
        const file = path.join(paths.v5Data, 'legacy-v4-import.json');
        return fs.existsSync(file) ? readJson(file) : null;
      });
      const v5Settings = readJson(path.join(paths.v5Data, 'settings.json'));
      const v5Stats = readJson(path.join(paths.v5Data, 'download-stats.json'));
      const v5Queue = readJson(path.join(paths.v5Data, 'download-queue.json'));
      const v4Settings = readJson(path.join(paths.v4Data, 'settings.json'));
      const links = shortcuts();
      const machine = {
        v5DisplayVersion: regValue(V5_KEY, 'DisplayVersion'),
        v4UninstallKeys: v4UninstallKeys(),
        v4ExeExists: fs.existsSync(paths.v4Exe),
        v4DirExists: fs.existsSync(paths.v4Dir),
        links,
      };
      check(/^5\./.test(machine.v5DisplayVersion || ''), 'ROSI 5 not registered', machine);
      check(!machine.v4UninstallKeys && !machine.v4ExeExists, 'ROSI 4 left behind', machine);
      check(status.v4Removed === true, 'helper did not confirm ROSI 4 removal', status);
      check(
        links.length >= 2 &&
          links.every((link) => link.target.toLowerCase() === v5Exe.toLowerCase()),
        'shortcuts missing or not pointing at ROSI 5',
        links
      );
      check(
        v4Settings.notifications === !seeded.notifications,
        'ROSI 4 did not save its last setting',
        v4Settings
      );
      check(marker.outcome === 'imported', 'ROSI 5 did not import', marker);
      check(
        v5Settings.theme === 'purple' && v5Settings.updateChannel === 'beta',
        'settings not imported',
        v5Settings
      );
      check(
        v5Settings.notifications === !seeded.notifications,
        'last ROSI 4 setting missing in ROSI 5',
        v5Settings
      );
      check(v5Stats.totalDownloads === 42, 'stats not imported', v5Stats);
      check(
        v5Queue.some((item) => item.id === 'e2e-pending'),
        'queue not imported',
        v5Queue
      );
      check(
        fs.existsSync(path.join(paths.v4Data, 'settings.json')),
        'ROSI 4 data folder was deleted'
      );
      return {
        helper: status,
        machine,
        import: marker,
        v5: {
          theme: v5Settings.theme,
          notifications: v5Settings.notifications,
          totalDownloads: v5Stats.totalDownloads,
          queue: v5Queue.length,
        },
      };
    }
  );
  for (const [pid] of lib.processesUnder(paths.v5Dir))
    lib.run('taskkill.exe', ['/F', '/PID', pid], { check: false });
}

function makeStandIn(dir, bundleId) {
  const app = path.join(dir, 'ROSI.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  const source = path.join(dir, 'main.c');
  fs.writeFileSync(
    source,
    `#include <stdio.h>\nint main(void) { FILE *f = fopen(${JSON.stringify(paths.marker)}, "a"); if (f) { fputs("${bundleId}\\n", f); fclose(f); } return 0; }\n`
  );
  lib.run('/usr/bin/cc', ['-O2', '-o', path.join(macos, 'ROSI'), source]);
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>${bundleId}</string>\n<key>CFBundleShortVersionString</key><string>5.0.0</string>\n<key>CFBundleVersion</key><string>5.0.0</string>\n<key>CFBundleExecutable</key><string>ROSI</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>LSBackgroundOnly</key><true/>\n</dict></plist>\n`
  );
  lib.run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  const archive = path.join(dir, 'ROSI.app.tar.gz');
  lib.run('/usr/bin/tar', ['-czf', archive, '-C', dir, 'ROSI.app'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return archive;
}

function appsListing() {
  return fs.readdirSync(paths.apps).sort();
}

function bundleId(app) {
  return lib
    .run('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      path.join(app, 'Contents', 'Info.plist'),
    ])
    .stdout.trim();
}

async function macScenarios(v4, keys, feed) {
  fs.mkdirSync(paths.apps, { recursive: true });
  lib.run('/usr/bin/ditto', [v4.app, paths.v4App]);
  const seeded = seedV4Data();
  const good = makeStandIn(fs.mkdtempSync(path.join(work, 'standin-')), 'run.rosie.rosi');
  const wrongId = makeStandIn(fs.mkdtempSync(path.join(work, 'standin-')), 'com.example.not-rosi');
  const signatures = {
    wrong: sign(good, keys.wrong),
    good: sign(good, keys.good),
    wrongId: sign(wrongId, keys.good),
  };
  const manifestRoute = `/v5/latest-darwin-beta-${ARCH}.json`;
  feed.routes.set('/v5/ROSI.app.tar.gz', { file: good });
  feed.routes.set('/v5/wrong-id.app.tar.gz', { file: wrongId });
  await launchV4();

  await scenario('bridge-bad-signature', ['bad-download-rejected', 'no-consent'], async () => {
    feed.routes.set(manifestRoute, {
      body: manifest('5.0.0', '/v5/ROSI.app.tar.gz', signatures.wrong),
    });
    await offerUpgrade();
    check(feed.count('/v5/ROSI.app.tar.gz') === 0, 'downloaded before consent');
    await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
    const failed = await lib.waitForModal(CDP_PORT, /^ROSI 5 Download Failed$/, 120_000);
    check(/signature/i.test(failed.message), 'failure does not mention the signature', failed);
    check(
      JSON.stringify(appsListing()) === JSON.stringify(['Rosi.app']),
      'Applications changed',
      appsListing()
    );
    check(bundleId(paths.v4App) === 'com.burnttoasters.rosi', 'ROSI 4 bundle changed');
    await lib.dismissModal(CDP_PORT, 'OK');
    return { failure: failed.message };
  });

  await scenario('bridge-wrong-bundle', ['bad-download-rejected'], async () => {
    feed.routes.set(manifestRoute, {
      body: manifest('5.0.0', '/v5/wrong-id.app.tar.gz', signatures.wrongId),
    });
    await offerUpgrade();
    await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
    const failed = await lib.waitForModal(CDP_PORT, /^ROSI 5 Download Failed$/, 120_000);
    check(/bundle id/i.test(failed.message), 'failure does not mention the bundle id', failed);
    check(
      JSON.stringify(appsListing()) === JSON.stringify(['Rosi.app']),
      'staging left in Applications',
      appsListing()
    );
    await lib.dismissModal(CDP_PORT, 'OK');
    return { failure: failed.message };
  });

  await scenario(
    'bridge-success',
    ['v4-killed-before-flush', 'v4-left-behind', 'v4-data-deleted'],
    async () => {
      feed.routes.set(manifestRoute, {
        body: manifest('5.0.0', '/v5/ROSI.app.tar.gz', signatures.good),
      });
      await offerUpgrade();
      await lib.clickModalButton(CDP_PORT, 'Upgrade to ROSI 5');
      await lib.waitForModal(CDP_PORT, /^Ready to Install ROSI 5$/, 120_000);
      await lib.clickModalButton(
        CDP_PORT,
        'Install and Restart',
        "const t = document.getElementById('notificationsToggle'); t.checked = !t.checked; t.dispatchEvent(new Event('change', { bubbles: true }));"
      );
      const status = await lib.waitFor(
        'successful bridge status',
        () => {
          const current = readStatus();
          if (current?.stage === 'failed')
            throw new Error(`bridge failed: ${JSON.stringify(current)}`);
          return current?.stage === 'succeeded' ? current : null;
        },
        { timeout: 120_000 }
      );
      await lib.waitFor('ROSI 5 stand-in launched', () => fs.existsSync(paths.marker), {
        timeout: 30_000,
      });
      const listing = appsListing();
      const installed = path.join(paths.apps, 'ROSI.app');
      check(
        listing.length === 1 && listing[0].toLowerCase() === 'rosi.app',
        'Applications not clean',
        listing
      );
      check(
        bundleId(installed) === 'run.rosie.rosi',
        'ROSI 5 not in place of ROSI 4',
        bundleId(installed)
      );
      check(v4Pids().length === 0, 'ROSI 4 still running');
      const v4Settings = readJson(path.join(paths.v4Data, 'settings.json'));
      check(
        v4Settings.notifications === !seeded.notifications,
        'ROSI 4 did not save its last setting',
        v4Settings
      );
      return {
        helper: status,
        applications: listing,
        launched: fs.readFileSync(paths.marker, 'utf8').trim(),
      };
    }
  );
}

async function main() {
  const keys = { good: generateKey('good'), wrong: generateKey('wrong') };
  const v4 = await buildV4(keys.good.publicKey);
  const feed = await lib.startFeed(FEED_PORT);
  for (const [route, body] of Object.entries(v4Feed(evidence.version))) {
    feed.routes.set(route, { body, type: 'text/yaml' });
  }
  let failure = null;
  let feedRequests = [];
  try {
    if (IS_WIN) await windowsScenarios(v4, keys, feed);
    else await macScenarios(v4, keys, feed);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    feedRequests = [...feed.requests];
    await feed.close();
    for (const [pid] of lib.processesUnder(IS_WIN ? paths.v4Dir : paths.apps)) {
      try {
        process.kill(Number(pid));
      } catch {
        // Already gone.
      }
    }
    npm('compile');
  }
  const modes = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'build-scripts', 'v5-bridge-failure-modes.json'), 'utf8')
  ).modes;
  const covered = new Set(scenarios.filter((s) => s.status === 'passed').flatMap((s) => s.covers));
  const uncovered = Object.entries(modes)
    .filter(([id, mode]) => mode.layer === 'e2e' && !covered.has(id))
    .map(([id]) => id);
  // Windows runs every mode; macOS has no shortcuts and uses a stand-in app.
  const required = IS_WIN
    ? uncovered
    : uncovered.filter(
        (id) =>
          ![
            'shortcuts-lost',
            'data-not-imported',
            'install-fails-v4-removed',
            'failure-silent',
          ].includes(id)
      );
  Object.assign(evidence, {
    finishedAt: new Date().toISOString(),
    scenarios,
    feedRequests,
    uncoveredFailureModes: uncovered,
    failure,
    passed: !failure && required.length === 0,
  });
  const body = JSON.stringify(evidence, null, 2);
  evidence.reportSha256 = crypto.createHash('sha256').update(body).digest('hex');
  const artifact = path.join(
    ROOT,
    'e2e',
    'artifacts',
    `bridge-e2e-${process.platform}-${process.arch}.json`
  );
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nBridge E2E evidence: ${artifact} (passed=${evidence.passed})`);
  if (!evidence.passed) {
    console.error(failure || `uncovered failure modes: ${required.join(', ')}`);
    process.exit(1);
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
