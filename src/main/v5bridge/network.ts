/**
 * Network steps of the bridge: read ROSI 5's updater manifests and download
 * the chosen artifact, streaming to disk with a size cap and a progress
 * callback. The caller verifies the signature before using the file.
 */
import * as fs from 'fs';
import {
  selectRelease,
  type BridgeChannel,
  type BridgeRelease,
  type ManifestCandidate,
} from './plan';

/** A fetch that follows redirects: Electron's net.fetch or global fetch in tests. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface DiscoveryResult {
  release: BridgeRelease | null;
  manifestUrl: string | null;
  problems: string[];
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response is ${declared} bytes (max ${maxBytes})`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Try each manifest candidate in order; return the first acceptable release. */
export async function discoverRelease(options: {
  candidates: ManifestCandidate[];
  feedBase: string;
  channel: BridgeChannel;
  allowedDownloadPrefixes: string[];
  maxManifestBytes: number;
  fetch: FetchLike;
}): Promise<DiscoveryResult> {
  const problems: string[] = [];
  for (const candidate of options.candidates) {
    const url = new URL(candidate.manifest, options.feedBase).href;
    try {
      const response = await options.fetch(url);
      if (response.status === 404) {
        problems.push(`${candidate.manifest}: not published`);
        continue;
      }
      if (!response.ok) {
        problems.push(`${candidate.manifest}: HTTP ${response.status}`);
        continue;
      }
      const text = await readCapped(response, options.maxManifestBytes);
      const release = selectRelease(JSON.parse(text), candidate, {
        channel: options.channel,
        allowedDownloadPrefixes: options.allowedDownloadPrefixes,
      });
      return { release, manifestUrl: url, problems };
    } catch (error) {
      problems.push(
        `${candidate.manifest}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { release: null, manifestUrl: null, problems };
}

export interface DownloadProgress {
  transferred: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
}

/** Stream `url` to `destination`; removes the partial file on any failure. */
export async function downloadFile(options: {
  url: string;
  destination: string;
  maxBytes: number;
  fetch: FetchLike;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<number> {
  const started = Date.now();
  let lastReport = 0;
  const out = await fs.promises.open(options.destination, 'w', 0o600);
  let transferred = 0;
  try {
    const response = await options.fetch(options.url, { signal: options.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (total > options.maxBytes)
      throw new Error(`Download is ${total} bytes (max ${options.maxBytes}).`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      transferred += value.byteLength;
      if (transferred > options.maxBytes) {
        await reader.cancel();
        throw new Error(`Download is larger than ${options.maxBytes} bytes.`);
      }
      await out.write(value);
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 250 || transferred === total)) {
        lastReport = now;
        const seconds = Math.max((now - started) / 1000, 0.001);
        options.onProgress({
          transferred,
          total,
          percent: total ? Math.min(100, (transferred / total) * 100) : 0,
          bytesPerSecond: transferred / seconds,
        });
      }
    }
    if (total && transferred !== total) {
      throw new Error(`Download ended after ${transferred} of ${total} bytes.`);
    }
    await out.close();
    return transferred;
  } catch (error) {
    await out.close().catch(() => undefined);
    await fs.promises.rm(options.destination, { force: true });
    throw error;
  }
}
