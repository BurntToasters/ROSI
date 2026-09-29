/**
 * Isolated tests for the ROSI 5 bridge's trust decisions, written before
 * src/main/v5bridge/. Failure modes: build-scripts/v5-bridge-failure-modes.json.
 * Every "unit" mode id must appear in a test name here (checked below).
 * Signatures in fixtures/v5-bridge were made with `tauri signer sign` and two
 * throwaway keys; only the public keys are committed.
 */
import { afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  parsePublicKey,
  parseSignature,
  verifyFileSignature,
  blake2b512File,
} from '../main/v5bridge/minisign';
import { planBridge, selectRelease, type BridgeHost } from '../main/v5bridge/plan';

const fixtures = path.join(__dirname, 'fixtures', 'v5-bridge');
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8').trim();
const KEY_A = read('key-a.pub');
const SIG_A = read('payload.bin.sig-a');
const SIG_B = read('payload.bin.sig-b');
const PAYLOAD = path.join(fixtures, 'payload.bin');

function decode(base64: string): string[] {
  return Buffer.from(base64, 'base64').toString('utf8').split('\n');
}
function encode(lines: string[]): string {
  return Buffer.from(lines.join('\n')).toString('base64');
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tempCopy(name: string, mutate?: (bytes: Buffer) => Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-bridge-test-'));
  tempDirs.push(dir);
  const target = path.join(dir, name);
  const bytes = fs.readFileSync(path.join(fixtures, name));
  fs.writeFileSync(target, mutate ? mutate(bytes) : bytes);
  return target;
}
/** Replace one field of the base64 signature line (bytes 0-1 alg, 2-9 key id, 10-73 sig). */
function withSigLineBytes(sig: string, edit: (raw: Buffer) => Buffer): string {
  const lines = decode(sig);
  lines[1] = edit(Buffer.from(lines[1] as string, 'base64')).toString('base64');
  return encode(lines);
}

describe('minisign / Tauri signature verification', () => {
  it('accepts a file signed by the trusted key and hashes like OpenSSL BLAKE2b-512', async () => {
    await expect(verifyFileSignature(PAYLOAD, SIG_A, KEY_A)).resolves.toBeUndefined();
    await expect(
      verifyFileSignature(path.join(fixtures, 'empty.bin'), read('empty.bin.sig-a'), KEY_A)
    ).resolves.toBeUndefined();
    const expected = createHash('blake2b512').update(fs.readFileSync(PAYLOAD)).digest();
    expect(Buffer.from(await blake2b512File(PAYLOAD)).equals(expected)).toBe(true);
  });

  it('rejects a signature made with another key (sig-wrong-key, sig-keyid-mismatch)', async () => {
    await expect(verifyFileSignature(PAYLOAD, SIG_B, KEY_A)).rejects.toThrow(/key id/i);
    // Same key id as the trusted key but a signature from key B must still fail.
    const forged = withSigLineBytes(SIG_B, (raw) => {
      const keyIdA = Buffer.from(decode(KEY_A)[1] as string, 'base64').subarray(2, 10);
      keyIdA.copy(raw, 2);
      return raw;
    });
    await expect(verifyFileSignature(PAYLOAD, forged, KEY_A)).rejects.toThrow(/signature/i);
  });

  it('rejects a modified or truncated file (sig-tampered-file)', async () => {
    const flipped = tempCopy('payload.bin', (bytes) => {
      bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] as number) ^ 0x01;
      return bytes;
    });
    await expect(verifyFileSignature(flipped, SIG_A, KEY_A)).rejects.toThrow(/signature/i);
    const truncated = tempCopy('payload.bin', (bytes) => bytes.subarray(0, bytes.length - 1));
    await expect(verifyFileSignature(truncated, SIG_A, KEY_A)).rejects.toThrow(/signature/i);
  });

  it('rejects an edited trusted comment (sig-tampered-comment)', async () => {
    const lines = decode(SIG_A);
    lines[2] = (lines[2] as string).replace('file:payload.bin', 'file:evil.bin');
    await expect(verifyFileSignature(PAYLOAD, encode(lines), KEY_A)).rejects.toThrow(
      /trusted comment/i
    );
  });

  it('rejects legacy unhashed Ed signatures (sig-legacy-unhashed)', async () => {
    const legacy = withSigLineBytes(SIG_A, (raw) => {
      raw.write('Ed', 0, 'latin1');
      return raw;
    });
    await expect(verifyFileSignature(PAYLOAD, legacy, KEY_A)).rejects.toThrow(/algorithm/i);
  });

  it('rejects malformed signatures and keys without crashing (sig-malformed)', async () => {
    const bad = [
      '',
      'not base64 at all!!',
      Buffer.from('untrusted comment: x').toString('base64'),
      encode(decode(SIG_A).slice(0, 2)),
      withSigLineBytes(SIG_A, (raw) => raw.subarray(0, 40)),
      'A'.repeat(20_000),
    ];
    for (const sig of bad) {
      expect(() => parseSignature(sig)).toThrow();
      await expect(verifyFileSignature(PAYLOAD, sig, KEY_A)).rejects.toThrow();
    }
    for (const key of ['', 'garbage', encode(['untrusted comment: k', 'AAAA']), SIG_A]) {
      expect(() => parsePublicKey(key)).toThrow();
    }
    await expect(verifyFileSignature(PAYLOAD, SIG_A, 'garbage')).rejects.toThrow();
    await expect(
      verifyFileSignature(path.join(fixtures, 'missing.bin'), SIG_A, KEY_A)
    ).rejects.toThrow();
  });
});

const WIN_X64: BridgeHost = {
  platform: 'win32',
  arch: 'x64',
  runningUnderArm64Translation: false,
  osVersion: '10.0.26100',
  channel: 'stable',
  distribution: 'github',
};
const MAC: BridgeHost = { ...WIN_X64, platform: 'darwin', arch: 'arm64', osVersion: '26.0.1' };
const LINUX: BridgeHost = { ...WIN_X64, platform: 'linux', osVersion: '6.8.0-40-generic' };
const REQUIREMENTS = { minWindowsBuild: 19041, minMacOS: '26.0' };
const PREFIXES = ['https://github.com/BurntToasters/ROSI/releases/download/'];
const SIGNATURE = SIG_A;

function manifest(version: string, platforms: Record<string, string>) {
  return {
    version,
    pub_date: '2026-10-01T00:00:00Z',
    platforms: Object.fromEntries(
      Object.entries(platforms).map(([key, file]) => [
        key,
        {
          url: `https://github.com/BurntToasters/ROSI/releases/download/v${version}/${file}`,
          signature: SIGNATURE,
        },
      ])
    ),
  };
}

describe('bridge platform planning', () => {
  it('plans a native install on supported Windows and macOS', () => {
    expect(planBridge(WIN_X64, REQUIREMENTS)).toMatchObject({
      kind: 'install',
      os: 'windows',
      arch: 'x86_64',
    });
    expect(planBridge(MAC, REQUIREMENTS)).toMatchObject({
      kind: 'install',
      os: 'darwin',
      arch: 'aarch64',
    });
    const plan = planBridge(WIN_X64, REQUIREMENTS);
    if (plan.kind !== 'install') throw new Error('expected install');
    expect(plan.candidates.map((c) => c.manifest)).toEqual(['latest-windows-x86_64.json']);
    expect(plan.candidates[0]?.keys).toEqual(['windows-x86_64-nsis', 'windows-x86_64']);
  });

  it('uses the native architecture under x64 emulation (platform-emulated-x64)', () => {
    for (const host of [WIN_X64, { ...MAC, arch: 'x64' }]) {
      const plan = planBridge({ ...host, runningUnderArm64Translation: true }, REQUIREMENTS);
      expect(plan).toMatchObject({ kind: 'install', arch: 'aarch64' });
    }
  });

  it('refuses Windows older than build 19041 (platform-old-windows)', () => {
    for (const osVersion of ['10.0.19040', '10.0.18363', '6.3.9600', 'nonsense']) {
      expect(planBridge({ ...WIN_X64, osVersion }, REQUIREMENTS).kind).toBe('unsupported');
    }
    expect(planBridge({ ...WIN_X64, osVersion: '10.0.19041' }, REQUIREMENTS).kind).toBe('install');
  });

  it('refuses macOS older than 26 (platform-old-macos)', () => {
    for (const osVersion of ['15.7.1', '12.0', '25.9.9', '']) {
      expect(planBridge({ ...MAC, osVersion }, REQUIREMENTS).kind).toBe('unsupported');
    }
    expect(planBridge({ ...MAC, osVersion: '26.0' }, REQUIREMENTS).kind).toBe('install');
    expect(planBridge({ ...MAC, osVersion: '27.1' }, REQUIREMENTS).kind).toBe('install');
  });

  it('only notifies on Linux x64 and refuses Linux ARM64 (platform-linux)', () => {
    expect(planBridge(LINUX, REQUIREMENTS)).toMatchObject({ kind: 'notice', arch: 'x86_64' });
    expect(planBridge({ ...LINUX, arch: 'arm64' }, REQUIREMENTS).kind).toBe('unsupported');
  });

  it('leaves the Microsoft Store build to the Store (platform-msstore)', () => {
    expect(planBridge({ ...WIN_X64, distribution: 'msstore' }, REQUIREMENTS).kind).toBe(
      'unsupported'
    );
  });

  it('tries the beta manifest first on the beta channel, then stable', () => {
    const plan = planBridge({ ...WIN_X64, arch: 'arm64', channel: 'beta' }, REQUIREMENTS);
    if (plan.kind !== 'install') throw new Error('expected install');
    expect(plan.candidates).toEqual([
      {
        manifest: 'latest-windows-beta-aarch64.json',
        keys: ['windows-beta-aarch64-nsis', 'windows-beta-aarch64'],
      },
      {
        manifest: 'latest-windows-aarch64.json',
        keys: ['windows-aarch64-nsis', 'windows-aarch64'],
      },
    ]);
  });
});

describe('bridge manifest selection', () => {
  const plan = planBridge(WIN_X64, REQUIREMENTS);
  if (plan.kind !== 'install') throw new Error('expected install');
  const candidate = plan.candidates[0]!;
  const select = (value: unknown, channel: 'stable' | 'beta' = 'stable', prefixes = PREFIXES) =>
    selectRelease(value, candidate, { channel, allowedDownloadPrefixes: prefixes });

  it('picks the installer-specific key for this platform', () => {
    const release = select(
      manifest('5.0.0', {
        'windows-x86_64-nsis': 'ROSI-Windows-x64.exe',
        'windows-aarch64-nsis': 'ROSI-Windows-arm64.exe',
      })
    );
    expect(release).toMatchObject({ version: '5.0.0', key: 'windows-x86_64-nsis' });
    expect(release.url).toMatch(/ROSI-Windows-x64\.exe$/);
  });

  it('refuses versions that are not ROSI 5 or later (manifest-not-v5)', () => {
    for (const version of ['4.4.0', '4.9.99', 'v5.0.0', '5.0', '5', '05.0.0', '5.0.0.1', '']) {
      expect(() => select(manifest(version, { 'windows-x86_64': 'a.exe' }))).toThrow(/version/i);
    }
    expect(select(manifest('5.12.3', { 'windows-x86_64': 'a.exe' })).version).toBe('5.12.3');
  });

  it('refuses a beta on the stable channel (manifest-prerelease-on-stable)', () => {
    const beta = manifest('5.0.0-beta.2', { 'windows-x86_64': 'a.exe' });
    expect(() => select(beta, 'stable')).toThrow(/beta/i);
    expect(select(beta, 'beta').version).toBe('5.0.0-beta.2');
  });

  it('refuses other platforms and architectures (manifest-wrong-platform)', () => {
    for (const key of ['windows-aarch64-nsis', 'darwin-x86_64', 'linux-x86_64', 'windows']) {
      expect(() => select(manifest('5.0.0', { [key]: 'a.exe' }))).toThrow(/platform/i);
    }
  });

  it('refuses download URLs outside the ROSI release path (manifest-foreign-host)', () => {
    const urls = [
      'https://example.com/BurntToasters/ROSI/releases/download/v5.0.0/a.exe',
      'http://github.com/BurntToasters/ROSI/releases/download/v5.0.0/a.exe',
      'https://github.com/Evil/ROSI/releases/download/v5.0.0/a.exe',
      'https://github.com/BurntToasters/ROSI/releases/download/../../../Evil/x/a.exe',
      'https://user:pass@github.com/BurntToasters/ROSI/releases/download/v5.0.0/a.exe',
      'https://github.com.evil.io/BurntToasters/ROSI/releases/download/v5.0.0/a.exe',
      'file:///C:/a.exe',
      'not a url',
    ];
    for (const url of urls) {
      const value = {
        version: '5.0.0',
        platforms: { 'windows-x86_64': { url, signature: SIGNATURE } },
      };
      expect(() => select(value), url).toThrow(/url/i);
    }
    const local = {
      version: '5.0.0',
      platforms: {
        'windows-x86_64': { url: 'http://127.0.0.1:8977/v5/a.exe', signature: SIGNATURE },
      },
    };
    expect(() => select(local)).toThrow(/url/i);
    expect(select(local, 'stable', ['http://127.0.0.1:8977/v5/']).url).toBe(
      'http://127.0.0.1:8977/v5/a.exe'
    );
  });

  it('refuses manifests missing a URL or signature (manifest-missing-fields)', () => {
    const cases: unknown[] = [
      null,
      'text',
      [],
      { version: '5.0.0' },
      { version: '5.0.0', platforms: [] },
      { version: '5.0.0', platforms: { 'windows-x86_64': {} } },
      { version: '5.0.0', platforms: { 'windows-x86_64': { url: PREFIXES[0] + 'v5.0.0/a.exe' } } },
      {
        version: '5.0.0',
        platforms: { 'windows-x86_64': { url: PREFIXES[0] + 'v5.0.0/a.exe', signature: 'junk' } },
      },
    ];
    for (const value of cases) {
      expect(() => select(value)).toThrow();
    }
  });
});

describe('failure-mode coverage', () => {
  it('names every unit failure mode in a test above', () => {
    const modes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'build-scripts', 'v5-bridge-failure-modes.json'),
        'utf8'
      )
    ).modes as Record<string, { layer: string }>;
    const source = fs.readFileSync(__filename, 'utf8');
    const titles = [...source.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1] as string);
    const uncovered = Object.entries(modes)
      .filter(([id, mode]) => mode.layer === 'unit' && !titles.some((t) => t.includes(id)))
      .map(([id]) => id);
    expect(uncovered).toEqual([]);
  });
});
