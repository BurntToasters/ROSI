import * as path from 'path';
import { fileURLToPath } from 'url';

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function ipv4FromDecimal(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.'
  );
}

// Parse a single IPv4 "part" the way the C resolver (inet_aton) does: a leading
// "0x" means hex, a leading "0" means octal, otherwise decimal.
function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = parseInt(part.slice(2), 16);
    return Number.isInteger(value) ? value : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const value = parseInt(part, 8);
    return Number.isInteger(value) ? value : null;
  }
  if (/^(?:0|[1-9]\d*)$/.test(part)) {
    const value = Number(part);
    return Number.isInteger(value) ? value : null;
  }
  return null;
}

// Canonicalize any IPv4 representation (dotted/decimal/hex/octal/shorthand and
// mixtures, e.g. 0177.0.0.1, 127.1, 0x7f.0.0.1, 2130706433) into dotted-quad,
// matching inet_aton semantics. Returns null if the host is not an IPv4 literal.
function canonicalizeIpv4(host: string): string | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    const parsed = parseIpv4Part(part);
    if (parsed === null || parsed < 0) return null;
    nums.push(parsed);
  }

  // All but the final part must each fit in a single byte.
  for (let i = 0; i < nums.length - 1; i += 1) {
    if ((nums[i] as number) > 0xff) return null;
  }

  const last = nums[nums.length - 1] as number;
  let value: number;
  switch (nums.length) {
    case 1:
      value = last;
      break;
    case 2:
      if (last > 0xffffff) return null;
      value = (((nums[0] as number) << 24) >>> 0) + last;
      break;
    case 3:
      if (last > 0xffff) return null;
      value = ((((nums[0] as number) << 24) | ((nums[1] as number) << 16)) >>> 0) + last;
      break;
    case 4:
      if (last > 0xff) return null;
      value =
        (((nums[0] as number) << 24) |
          ((nums[1] as number) << 16) |
          ((nums[2] as number) << 8) |
          last) >>>
        0;
      break;
    default:
      return null;
  }

  if (value < 0 || value > 0xffffffff) return null;
  return ipv4FromDecimal(value >>> 0);
}

function isPrivateOrLocalIpv4(host: string): boolean {
  const canonical = canonicalizeIpv4(host);
  if (canonical === null) return false;
  const match = canonical.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1, 5).map((value) => Number(value));
  if (octets.some((value) => value > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateOrLocalIpv6(host: string): boolean {
  if (host === '::1') return true;
  if (host === '::') return true;
  const mapped = host.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (mapped?.[1] && isPrivateOrLocalIpv4(mapped[1])) return true;
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1] ?? '0', 16);
    const lo = parseInt(mappedHex[2] ?? '0', 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isPrivateOrLocalIpv4(ipv4)) return true;
  }
  const linkLocal = host.match(/^fe[89ab][0-9a-f]{0,3}:/i);
  if (linkLocal) return true;
  const uniqueLocal = host.match(/^f[cd][0-9a-f]{0,2}:/i);
  if (uniqueLocal) return true;
  return false;
}

function isRebindingHostname(host: string): boolean {
  return (
    host.endsWith('.nip.io') ||
    host.endsWith('.sslip.io') ||
    host.endsWith('.localtest.me') ||
    host.endsWith('.lvh.me') ||
    host.endsWith('.xip.io')
  );
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isRebindingHostname(host)) return true;
  if (isPrivateOrLocalIpv4(host)) return true;
  if (host.includes(':') && isPrivateOrLocalIpv6(host)) return true;
  return false;
}

export function isSafeHttpUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (isPrivateOrLocalHost(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'mailto:') return true;
    if (url.protocol === 'ms-windows-store:') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (isPrivateOrLocalHost(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isAllowedNavigationUrl(value: unknown, allowedFileBase?: string) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return false;
    if (!allowedFileBase) return true;
    const filePath = fileURLToPath(url);
    const base = path.resolve(allowedFileBase);
    const resolved = path.resolve(filePath);
    const relative = path.relative(base, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}
