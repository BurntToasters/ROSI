// Test-only minisign signer for the updater E2E. The key is generated at test
// time into the scenario's own directory; no private key is committed. Output
// matches what the vendored tauri-plugin-updater verifies: a prehashed ("ED")
// signature over blake2b-512(data), and a global signature over the signature
// bytes plus the trusted comment, with `version:` in the trusted comment.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ED25519_SPKI_PREFIX_BYTES = 12;

function rawPublicKey(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(ED25519_SPKI_PREFIX_BYTES));
}

/**
 * Generates a minisign key pair. Writes the secret key and public key files
 * into `directory` (the caller's temp profile) and returns the pubkey value
 * that `e2e_configure_updater` expects: base64 of the whole `.pub` file.
 */
export function generateUpdaterSigningKey(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = crypto.randomBytes(8);
  const publicText = [
    "untrusted comment: minisign public key (ROSI E2E)",
    Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey(publicKey)]).toString(
      "base64",
    ),
    "",
  ].join("\n");
  const pubPath = path.join(directory, "updater-e2e.pub");
  fs.writeFileSync(pubPath, publicText, { mode: 0o600 });
  return {
    privateKey,
    keyId,
    publicKeyFile: pubPath,
    pubkey: Buffer.from(publicText, "utf8").toString("base64"),
  };
}

/**
 * Signs `data` and returns the `.sig` file text. `version` goes into the
 * trusted comment, which requireSignedVersion checks against the manifest.
 */
export function signUpdateArtifact(key, data, { fileName, version }) {
  const digest = crypto.createHash("blake2b512").update(data).digest();
  const signature = crypto.sign(null, digest, key.privateKey);
  const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${fileName}\tversion:${version}`;
  const globalSignature = crypto.sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    key.privateKey,
  );
  return [
    "untrusted comment: signature from minisign secret key",
    Buffer.concat([Buffer.from("ED"), key.keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
}

/** The manifest `signature` field: base64 of the `.sig` file text. */
export function manifestSignature(sigText) {
  return Buffer.from(sigText, "utf8").toString("base64");
}
