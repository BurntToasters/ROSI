/**
 * ROSI 4 to ROSI 5 bridge. After the regular update check finds no newer
 * ROSI 4, this looks for a ROSI 5 release, and with the user's consent
 * downloads it, verifies its Tauri signature, installs it, removes ROSI 4,
 * and opens ROSI 5, which imports ROSI 4's settings on its first launch.
 * ROSI 4's data folder is never modified; status lives in <userData>/v5-bridge.
 */
import { app, net } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import log from 'electron-log/main.js';
import { bridgeConfig } from './config';
import { verifyFileSignature } from './minisign';
import {
  candidatesFor,
  planBridge,
  type BridgeChannel,
  type BridgeHost,
  type BridgeRelease,
} from './plan';
import { discoverRelease, downloadFile, type DownloadProgress, type FetchLike } from './network';
import { readStatus, startMacHelper, startWindowsHelper, type BridgeStatus } from './handoff';

const run = promisify(execFile);

export type BridgeOffer =
  | {
      status: 'v5-available';
      mode: 'install' | 'notice';
      version: string;
      isBeta: boolean;
      downloadPage: string;
    }
  | { status: 'v5-unsupported'; version: string; message: string; downloadPage: string };

interface Prepared {
  release: BridgeRelease;
  file: string;
  stagedApp?: string;
}

let lastRelease: BridgeRelease | null = null;
let prepared: Prepared | null = null;
let downloadAbort: AbortController | null = null;

const fetchWithNet: FetchLike = (url, init) =>
  net.fetch(url, { signal: init?.signal, cache: 'no-store', redirect: 'follow' });

function workDir(): string {
  const dir = path.join(app.getPath('userData'), 'v5-bridge');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function statusFile(): string {
  return path.join(workDir(), 'status.json');
}

export function currentHost(channel: BridgeChannel): BridgeHost {
  const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string })
    .getSystemVersion;
  return {
    platform: process.platform,
    arch: process.arch,
    runningUnderArm64Translation: Boolean(app.runningUnderARM64Translation),
    osVersion:
      process.platform === 'darwin' && getSystemVersion ? getSystemVersion() : os.release(),
    channel,
    distribution: process.env.CHANNEL === 'msstore' || process.windowsStore ? 'msstore' : 'github',
  };
}

/** Look for ROSI 5. Resolves null when none is published for this machine. */
export async function checkForV5(channel: BridgeChannel): Promise<BridgeOffer | null> {
  const config = bridgeConfig();
  const host = currentHost(channel);
  const plan = planBridge(host, config);
  let candidates;
  if (plan.kind === 'unsupported') {
    const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[host.platform as string];
    const arch = host.arch === 'arm64' || host.runningUnderArm64Translation ? 'aarch64' : 'x86_64';
    // Only report "unsupported" if ROSI 5 actually exists for this OS.
    if (plan.reason === 'msstore' || !os) return null;
    candidates = candidatesFor(os as 'windows' | 'darwin' | 'linux', arch, channel);
  } else {
    candidates = plan.candidates;
  }
  const found = await discoverRelease({
    candidates,
    feedBase: config.feedBase,
    channel,
    allowedDownloadPrefixes: config.allowedDownloadPrefixes,
    maxManifestBytes: config.maxManifestBytes,
    fetch: (url) => fetchWithNet(url, { signal: AbortSignal.timeout(15_000) }),
  });
  if (found.problems.length) log.info('[v5-bridge] manifest check:', found.problems.join('; '));
  if (!found.release) return null;
  if (plan.kind === 'unsupported') {
    return {
      status: 'v5-unsupported',
      version: found.release.version,
      message: plan.message,
      downloadPage: config.downloadPage,
    };
  }
  lastRelease = plan.kind === 'install' ? found.release : null;
  return {
    status: 'v5-available',
    mode: plan.kind,
    version: found.release.version,
    isBeta: found.release.prerelease,
    downloadPage: config.downloadPage,
  };
}

async function stageMacApp(archive: string, release: BridgeRelease): Promise<string> {
  const config = bridgeConfig();
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  const parent = path.dirname(bundle);
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) {
    throw new Error(`ROSI 4 is not running from an installed app (${bundle}).`);
  }
  fs.accessSync(parent, fs.constants.W_OK);
  fs.accessSync(bundle, fs.constants.W_OK);
  const { stdout: listing } = await run('/usr/bin/tar', ['-tzf', archive], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries = listing.split('\n').filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !/^ROSI\.app(\/|$)/.test(entry) || entry.includes('..'))
  ) {
    throw new Error('The ROSI 5 archive has unexpected contents.');
  }
  const staging = fs.mkdtempSync(path.join(parent, '.rosi5-staging-'));
  try {
    await run('/usr/bin/tar', ['-xzf', archive, '-C', staging]);
    const staged = path.join(staging, 'ROSI.app');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    const { stderr: details } = await run('/usr/bin/codesign', ['-dv', staged]);
    const plist = path.join(staged, 'Contents', 'Info.plist');
    const read = async (key: string) =>
      (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
    if ((await read('CFBundleIdentifier')) !== config.macBundleId) {
      throw new Error(`ROSI 5 bundle id is not ${config.macBundleId}.`);
    }
    if (!/^([5-9]|\d{2,})\./.test(await read('CFBundleShortVersionString'))) {
      throw new Error('The downloaded app is not ROSI 5.');
    }
    if (config.macTeamId && !details.includes(`TeamIdentifier=${config.macTeamId}`)) {
      throw new Error(`ROSI 5 is not signed by team ${config.macTeamId}.`);
    }
    log.info(`[v5-bridge] staged ROSI ${release.version} at ${staged}`);
    return staged;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Download, verify, and (on macOS) stage the release found by checkForV5. */
export async function downloadV5(
  onProgress: (progress: DownloadProgress) => void
): Promise<string> {
  const release = lastRelease;
  if (!release) throw new Error('No ROSI 5 release has been found yet.');
  if (downloadAbort) throw new Error('A download is already in progress.');
  const config = bridgeConfig();
  discardPrepared();
  downloadAbort = new AbortController();
  const file = path.join(
    workDir(),
    process.platform === 'win32' ? 'ROSI-5-setup.exe' : 'ROSI-5.app.tar.gz'
  );
  try {
    await downloadFile({
      url: release.url,
      destination: file,
      maxBytes: config.maxDownloadBytes,
      fetch: fetchWithNet,
      signal: downloadAbort.signal,
      onProgress,
    });
    try {
      await verifyFileSignature(file, release.signature, config.publicKey);
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw new Error(
        `The download failed its signature check and was deleted. ${error instanceof Error ? error.message : ''}`,
        { cause: error }
      );
    }
    log.info(`[v5-bridge] verified ${release.url}`);
    const stagedApp = process.platform === 'darwin' ? await stageMacApp(file, release) : undefined;
    if (stagedApp) fs.rmSync(file, { force: true });
    prepared = { release, file, stagedApp };
    return release.version;
  } finally {
    downloadAbort = null;
  }
}

export function cancelV5Download(): boolean {
  if (!downloadAbort) return false;
  downloadAbort.abort();
  return true;
}

function discardPrepared(): void {
  if (prepared?.stagedApp)
    fs.rmSync(path.dirname(prepared.stagedApp), { recursive: true, force: true });
  prepared = null;
}

/** Start the detached helper. The caller must then quit ROSI 4 normally. */
export async function startV5Install(): Promise<void> {
  if (!prepared) throw new Error('Download ROSI 5 first.');
  const { release, file, stagedApp } = prepared;
  const status = statusFile();
  if (process.platform === 'win32') {
    const v4Exe = app.getPath('exe');
    await startWindowsHelper({
      installer: file,
      v4Exe,
      v4Uninstaller: path.join(
        path.dirname(v4Exe),
        `Uninstall ${path.basename(v4Exe, '.exe')}.exe`
      ),
      version: release.version,
      statusFile: status,
      workDir: workDir(),
    });
  } else if (process.platform === 'darwin' && stagedApp) {
    const currentApp = path.resolve(app.getPath('exe'), '..', '..', '..');
    await startMacHelper({
      stagedApp,
      currentApp,
      destinationApp: path.join(path.dirname(currentApp), 'ROSI.app'),
      version: release.version,
      statusFile: status,
      workDir: workDir(),
    });
  } else {
    throw new Error('ROSI 5 cannot be installed automatically on this system.');
  }
  prepared = null;
  log.info(`[v5-bridge] helper started for ROSI ${release.version}; quitting ROSI 4.`);
}

/** A failed attempt reported by the helper, shown once on the next launch. */
export function takeFailedResult(): BridgeStatus | null {
  const file = statusFile();
  const status = readStatus(file);
  if (!status || status.stage !== 'failed') return null;
  fs.renameSync(file, path.join(path.dirname(file), 'status.reported.json'));
  return status;
}
