import * as path from 'path';
import { fileURLToPath } from 'url';

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPrivateOrLocalIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  const linkLocal = host.match(/^fe[89ab][0-9a-f]{0,3}:/i);
  if (linkLocal) return true;
  const uniqueLocal = host.match(/^f[cd][0-9a-f]{0,2}:/i);
  if (uniqueLocal) return true;
  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
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
    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'ms-windows-store:' ||
      url.protocol === 'mailto:'
    );
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
