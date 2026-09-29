/**
 * Minisign verification for Tauri updater signatures (the `signature` field
 * of ROSI 5's latest-*.json and its `.sig` files).
 *
 * Both inputs are base64 of minisign text files. Tauri only produces prehashed
 * signatures (algorithm "ED"): Ed25519 over BLAKE2b-512 of the file. The global
 * signature covers the signature bytes plus the trusted comment.
 */
import * as fs from 'fs';
import { createPublicKey, verify as verifySignature, type KeyObject } from 'crypto';
import { blake2b } from '@noble/hashes/blake2.js';

const MAX_ENCODED_LENGTH = 4096;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TRUSTED_PREFIX = 'trusted comment: ';

export interface MinisignPublicKey {
  keyId: Buffer;
  key: KeyObject;
}

export interface MinisignSignature {
  algorithm: string;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

function decodeLines(encoded: string, label: string): string[] {
  const compact = typeof encoded === 'string' ? encoded.trim() : '';
  if (!compact || compact.length > MAX_ENCODED_LENGTH || !BASE64.test(compact)) {
    throw new Error(`${label} is not valid base64.`);
  }
  return Buffer.from(compact, 'base64')
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
}

function decodeField(value: string | undefined, length: number, label: string): Buffer {
  const trimmed = (value ?? '').trim();
  if (!trimmed || !BASE64.test(trimmed)) throw new Error(`${label} is not valid base64.`);
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== length) {
    throw new Error(`${label} has ${bytes.length} bytes, expected ${length}.`);
  }
  return bytes;
}

export function parsePublicKey(encoded: string): MinisignPublicKey {
  const lines = decodeLines(encoded, 'Public key');
  if (!lines[0]?.startsWith('untrusted comment:')) {
    throw new Error('Public key is missing its comment line.');
  }
  const raw = decodeField(lines[1], 42, 'Public key');
  if (raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('Public key is not an Ed25519 minisign key.');
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10, 42).toString('base64url') },
    format: 'jwk',
  });
  return { keyId: raw.subarray(2, 10), key };
}

export function parseSignature(encoded: string): MinisignSignature {
  const lines = decodeLines(encoded, 'Signature');
  if (!lines[0]?.startsWith('untrusted comment:')) {
    throw new Error('Signature is missing its comment line.');
  }
  const raw = decodeField(lines[1], 74, 'Signature');
  const trusted = lines[2] ?? '';
  if (!trusted.startsWith(TRUSTED_PREFIX)) {
    throw new Error('Signature is missing its trusted comment.');
  }
  return {
    algorithm: raw.subarray(0, 2).toString('latin1'),
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: trusted.slice(TRUSTED_PREFIX.length),
    globalSignature: decodeField(lines[3], 64, 'Global signature'),
  };
}

/** BLAKE2b-512 of a file, streamed. Electron's BoringSSL has no BLAKE2b-512. */
export async function blake2b512File(filePath: string): Promise<Uint8Array> {
  const hash = blake2b.create({ dkLen: 64 });
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest();
}

/** Resolve if `filePath` carries a valid Tauri signature from `publicKey`; otherwise throw. */
export async function verifyFileSignature(
  filePath: string,
  signature: string,
  publicKey: string
): Promise<void> {
  const key = parsePublicKey(publicKey);
  const sig = parseSignature(signature);
  if (sig.algorithm !== 'ED') {
    throw new Error(`Unsupported signature algorithm "${sig.algorithm}"; expected prehashed ED.`);
  }
  if (!sig.keyId.equals(key.keyId)) {
    throw new Error(
      `Signature key id ${Buffer.from(sig.keyId).reverse().toString('hex').toUpperCase()} does not match the trusted key.`
    );
  }
  const digest = await blake2b512File(filePath);
  if (!verifySignature(null, digest, key.key, sig.signature)) {
    throw new Error('File signature does not match the download.');
  }
  const signed = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!verifySignature(null, signed, key.key, sig.globalSignature)) {
    throw new Error('Signature trusted comment was modified.');
  }
}
