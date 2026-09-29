/**
 * Pure decisions for the ROSI 5 bridge: whether this machine can run ROSI 5,
 * which ROSI 5 manifests to read, and whether a manifest entry is trustworthy
 * enough to download. Nothing here touches the network or the file system.
 */
import { parseSignature } from './minisign';

export type BridgeOs = 'windows' | 'darwin' | 'linux';
export type BridgeArch = 'x86_64' | 'aarch64';
export type BridgeChannel = 'stable' | 'beta';

export interface BridgeHost {
  platform: NodeJS.Platform;
  arch: string;
  /** Electron's app.runningUnderARM64Translation. */
  runningUnderArm64Translation: boolean;
  /** os.release() on Windows, process.getSystemVersion() on macOS. */
  osVersion: string;
  channel: BridgeChannel;
  distribution: 'github' | 'msstore';
}

export interface BridgeRequirements {
  minWindowsBuild: number;
  minMacOS: string;
}

export interface ManifestCandidate {
  manifest: string;
  keys: string[];
}

export type UnsupportedReason =
  'msstore' | 'architecture' | 'windows-version' | 'macos-version' | 'linux-arm64' | 'platform';

export type BridgePlan =
  | {
      kind: 'install' | 'notice';
      os: BridgeOs;
      arch: BridgeArch;
      candidates: ManifestCandidate[];
    }
  | { kind: 'unsupported'; reason: UnsupportedReason; message: string };

export interface BridgeRelease {
  version: string;
  prerelease: boolean;
  key: string;
  url: string;
  signature: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

function nativeArch(host: BridgeHost): BridgeArch | null {
  if (host.runningUnderArm64Translation) return 'aarch64';
  if (host.arch === 'arm64') return 'aarch64';
  if (host.arch === 'x64') return 'x86_64';
  return null;
}

function numericParts(version: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(version.trim())) return null;
  return version.trim().split('.').map(Number);
}

function atLeast(version: string, minimum: string): boolean {
  const have = numericParts(version);
  const need = numericParts(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function candidates(os: BridgeOs, arch: BridgeArch, channel: BridgeChannel): ManifestCandidate[] {
  const installer = { windows: 'nsis', darwin: 'app', linux: 'appimage' }[os];
  const target = (suffix: string): ManifestCandidate => ({
    manifest: `latest-${os}${suffix}-${arch}.json`,
    keys: [`${os}${suffix}-${arch}-${installer}`, `${os}${suffix}-${arch}`],
  });
  return channel === 'beta' ? [target('-beta'), target('')] : [target('')];
}

/** Manifests to read for a platform, beta first on the beta channel. */
export const candidatesFor = candidates;

export function planBridge(host: BridgeHost, requirements: BridgeRequirements): BridgePlan {
  if (host.distribution === 'msstore') {
    return {
      kind: 'unsupported',
      reason: 'msstore',
      message: 'The Microsoft Store delivers ROSI updates for this copy.',
    };
  }
  const arch = nativeArch(host);
  if (!arch) {
    return {
      kind: 'unsupported',
      reason: 'architecture',
      message: `ROSI 5 is not built for ${host.arch} processors.`,
    };
  }
  if (host.platform === 'win32') {
    const parts = numericParts(host.osVersion);
    const build = parts && (parts[0] ?? 0) >= 10 ? (parts[2] ?? 0) : 0;
    if (build < requirements.minWindowsBuild) {
      return {
        kind: 'unsupported',
        reason: 'windows-version',
        message: 'ROSI 5 needs Windows 10 version 2004 (build 19041) or later.',
      };
    }
    return {
      kind: 'install',
      os: 'windows',
      arch,
      candidates: candidates('windows', arch, host.channel),
    };
  }
  if (host.platform === 'darwin') {
    if (!atLeast(host.osVersion, requirements.minMacOS)) {
      return {
        kind: 'unsupported',
        reason: 'macos-version',
        message: `ROSI 5 needs macOS ${requirements.minMacOS} or later.`,
      };
    }
    return {
      kind: 'install',
      os: 'darwin',
      arch,
      candidates: candidates('darwin', arch, host.channel),
    };
  }
  if (host.platform === 'linux') {
    if (arch !== 'x86_64') {
      return {
        kind: 'unsupported',
        reason: 'linux-arm64',
        message: 'ROSI 5 is not available for Linux ARM64 yet.',
      };
    }
    return {
      kind: 'notice',
      os: 'linux',
      arch,
      candidates: candidates('linux', arch, host.channel),
    };
  }
  return {
    kind: 'unsupported',
    reason: 'platform',
    message: 'ROSI 5 is not available for this system.',
  };
}

function checkDownloadUrl(value: unknown, allowedPrefixes: string[]): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Manifest download url is missing.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Manifest download url is not a URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Manifest download url has credentials or a query: ${value}`);
  }
  if (!allowedPrefixes.some((prefix) => url.href.startsWith(prefix))) {
    throw new Error(`Manifest download url is outside the ROSI release path: ${url.href}`);
  }
  return url.href;
}

/** Validate a parsed ROSI 5 updater manifest and pick this platform's entry. */
export function selectRelease(
  value: unknown,
  candidate: ManifestCandidate,
  options: { channel: BridgeChannel; allowedDownloadPrefixes: string[] }
): BridgeRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Manifest is not a JSON object.');
  }
  const manifest = value as { version?: unknown; platforms?: unknown };
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const match = VERSION.exec(version);
  if (!match || Number(match[1]) < 5) {
    throw new Error(`Manifest version ${JSON.stringify(manifest.version)} is not ROSI 5.`);
  }
  const prerelease = Boolean(match[4]);
  if (prerelease && options.channel !== 'beta') {
    throw new Error(`Manifest offers beta ${version} on the stable channel.`);
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('Manifest has no platforms.');
  }
  const entries = platforms as Record<string, unknown>;
  const key = candidate.keys.find((name) => Object.prototype.hasOwnProperty.call(entries, name));
  if (!key) {
    throw new Error(`Manifest has no entry for this platform (${candidate.keys.join(', ')}).`);
  }
  const entry = entries[key];
  if (!entry || typeof entry !== 'object') throw new Error(`Manifest entry ${key} is empty.`);
  const { url, signature } = entry as { url?: unknown; signature?: unknown };
  const href = checkDownloadUrl(url, options.allowedDownloadPrefixes);
  if (typeof signature !== 'string') throw new Error(`Manifest entry ${key} has no signature.`);
  parseSignature(signature);
  return { version, prerelease, key, url: href, signature };
}
