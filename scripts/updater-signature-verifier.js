import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export function normalizeUpdaterSignature(sigPath) {
  const trimmed = fs.readFileSync(sigPath, "utf8").trim();
  if (!trimmed) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("untrusted comment:")) return trimmed;
  } catch {}
  return trimmed.includes("untrusted comment:")
    ? Buffer.from(trimmed, "utf8").toString("base64")
    : trimmed;
}

export function verifyUpdaterSignatures({
  root,
  releaseDir,
  byName,
  signatureByBaseName,
  resolveUpdaterTargets,
}) {
  const pairs = [];
  const eligibleArtifacts = [];
  const missingSignatures = [];
  for (const [name, artifactPath] of byName) {
    if (name.endsWith(".sig") || resolveUpdaterTargets(name).length === 0) {
      continue;
    }
    eligibleArtifacts.push(name);
    const signaturePath = signatureByBaseName.get(name);
    if (signaturePath) {
      pairs.push([artifactPath, signaturePath]);
    } else {
      missingSignatures.push(`${name}.sig`);
    }
  }
  if (missingSignatures.length > 0) {
    throw new Error(
      `Missing updater signature file(s): ${missingSignatures.sort().join(", ")}.`,
    );
  }
  if (eligibleArtifacts.length === 0) {
    throw new Error(
      "Updater signature verification found no updater-eligible artifacts.",
    );
  }
  if (pairs.length === 0) {
    throw new Error(
      "Updater signature verification found zero eligible pairs.",
    );
  }

  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const encodedPublicKey = tauriConfig.plugins?.updater?.pubkey;
  if (!encodedPublicKey) {
    throw new Error("tauri.conf.json is missing plugins.updater.pubkey.");
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(releaseDir, ".updater-verify-"),
  );
  try {
    const publicKeyPath = path.join(temporaryDirectory, "updater.pub");
    fs.writeFileSync(
      publicKeyPath,
      Buffer.from(encodedPublicKey, "base64").toString("utf8"),
    );
    const verifierArgs = [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
      "--example",
      "verify_updater_signatures",
      "--",
      publicKeyPath,
    ];
    for (const [index, [artifactPath, signaturePath]] of pairs.entries()) {
      const normalizedPath = path.join(
        temporaryDirectory,
        `signature-${index}.minisig`,
      );
      fs.writeFileSync(
        normalizedPath,
        Buffer.from(
          normalizeUpdaterSignature(signaturePath),
          "base64",
        ).toString("utf8"),
      );
      verifierArgs.push(artifactPath, normalizedPath);
    }
    const result = spawnSync("cargo", verifierArgs, {
      cwd: root,
      stdio: "inherit",
      timeout: 180_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Updater artifact signature verification failed (cargo exit ${result.status}).`,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
