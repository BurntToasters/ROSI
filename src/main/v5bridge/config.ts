/**
 * Bridge settings packaged with ROSI 4. `publicKey` must equal
 * `plugins.updater.pubkey` in ROSI 5's src-tauri/tauri.conf.json.
 * E2E builds replace dist/main/v5bridge/config.json after compiling.
 */
import rawConfig from './config.json';
import { parsePublicKey } from './minisign';

export interface BridgeConfig {
  feedBase: string;
  allowedDownloadPrefixes: string[];
  publicKey: string;
  downloadPage: string;
  minWindowsBuild: number;
  minMacOS: string;
  macBundleId: string;
  /** null accepts any valid code signature (E2E builds only). */
  macTeamId: string | null;
  maxManifestBytes: number;
  maxDownloadBytes: number;
  /** Present only in E2E builds (see build-scripts/check-bridge-config.js). */
  e2e?: {
    remoteDebuggingPort?: number;
    userDataDir?: string;
    useMockKeychain?: boolean;
  };
}

function parseE2e(value: unknown): BridgeConfig['e2e'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('e2e must be an object.');
  const raw = value as Record<string, unknown>;
  const port = raw.remoteDebuggingPort;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535)
  ) {
    throw new Error('e2e.remoteDebuggingPort must be a port number.');
  }
  if (raw.userDataDir !== undefined && (typeof raw.userDataDir !== 'string' || !raw.userDataDir)) {
    throw new Error('e2e.userDataDir must be a path.');
  }
  return {
    remoteDebuggingPort: port as number | undefined,
    userDataDir: raw.userDataDir as string | undefined,
    useMockKeychain: raw.useMockKeychain === true,
  };
}

function httpUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') {
    throw new Error(`${label} must use https (or loopback for tests).`);
  }
  if (!url.href.endsWith('/')) throw new Error(`${label} must end with "/".`);
  return url.href;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function parseBridgeConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== 'object') throw new Error('Bridge config is not an object.');
  const raw = value as Record<string, unknown>;
  const prefixes = raw.allowedDownloadPrefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error('allowedDownloadPrefixes must list at least one prefix.');
  }
  if (typeof raw.publicKey !== 'string') throw new Error('publicKey is missing.');
  parsePublicKey(raw.publicKey);
  if (typeof raw.downloadPage !== 'string' || !raw.downloadPage.startsWith('https://')) {
    throw new Error('downloadPage must be an https URL.');
  }
  if (typeof raw.minMacOS !== 'string' || !/^\d+(\.\d+)*$/.test(raw.minMacOS)) {
    throw new Error('minMacOS must be a version like 26.0.');
  }
  if (typeof raw.macBundleId !== 'string' || !raw.macBundleId) {
    throw new Error('macBundleId is missing.');
  }
  if (
    raw.macTeamId !== null &&
    (typeof raw.macTeamId !== 'string' || !/^[A-Z0-9]{10}$/.test(raw.macTeamId))
  ) {
    throw new Error('macTeamId must be a 10-character team id or null.');
  }
  return {
    feedBase: httpUrl(raw.feedBase, 'feedBase'),
    allowedDownloadPrefixes: prefixes.map((prefix, index) =>
      httpUrl(prefix, `allowedDownloadPrefixes[${index}]`)
    ),
    publicKey: raw.publicKey,
    downloadPage: raw.downloadPage,
    minWindowsBuild: positive(raw.minWindowsBuild, 'minWindowsBuild'),
    minMacOS: raw.minMacOS,
    macBundleId: raw.macBundleId,
    macTeamId: raw.macTeamId as string | null,
    maxManifestBytes: positive(raw.maxManifestBytes, 'maxManifestBytes'),
    maxDownloadBytes: positive(raw.maxDownloadBytes, 'maxDownloadBytes'),
    e2e: parseE2e(raw.e2e),
  };
}

let cached: BridgeConfig | null = null;

export function bridgeConfig(): BridgeConfig {
  cached ??= parseBridgeConfig(rawConfig);
  return cached;
}
