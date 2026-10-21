#!/usr/bin/env node
/**
 * Validate Tauri updater manifest JSON shape (latest-{{target}}-{{arch}}.json).
 * Usage:
 *   node scripts/validate-updater-manifest.js [path...]
 * Defaults to fixtures under testdata/updater/.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveUpdaterTargets } from "./gpg-sign.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const defaultFixturesDir = path.join(root, "testdata", "updater");
const defaultFixtures = fs.existsSync(defaultFixturesDir)
  ? fs
      .readdirSync(defaultFixturesDir)
      .filter((name) => name.startsWith("latest-") && name.endsWith(".json"))
      .sort()
      .map((name) => path.join(defaultFixturesDir, name))
  : [];

function fail(message) {
  console.error(`updater-manifest: ${message}`);
  process.exitCode = 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeStrictBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function hasMinisignEnvelope(value) {
  const outer = decodeStrictBase64(value);
  if (!outer) return false;
  const lines = outer.toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment:") ||
    !lines[2].startsWith("trusted comment:")
  ) {
    return false;
  }
  const signaturePacket = decodeStrictBase64(lines[1]);
  const globalSignature = decodeStrictBase64(lines[3]);
  // Minisign binary alg IDs: "Ed" (legacy) or "ED" (prehashed; Tauri updater).
  const algorithm =
    signaturePacket &&
    signaturePacket.length >= 2 &&
    signaturePacket[0] === 0x45 &&
    (signaturePacket[1] === 0x64 || signaturePacket[1] === 0x44);
  return (
    Boolean(algorithm) &&
    signaturePacket.length === 74 &&
    globalSignature?.length === 64
  );
}

export function validateManifestData(data, filePath) {
  const problems = [];
  const fail = (message) => problems.push(message);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`${filePath}: root must be an object`);
    return problems;
  }
  if (!isNonEmptyString(data.version)) {
    fail(`${filePath}: missing string "version"`);
  } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)) {
    fail(`${filePath}: version must be SemVer without a leading v`);
  }
  if (!isNonEmptyString(data.pub_date)) {
    fail(`${filePath}: missing string "pub_date"`);
  } else if (
    Number.isNaN(Date.parse(data.pub_date)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(data.pub_date)
  ) {
    fail(`${filePath}: pub_date must be a normalized ISO-8601 UTC timestamp`);
  }
  if (
    !data.platforms ||
    typeof data.platforms !== "object" ||
    Array.isArray(data.platforms)
  ) {
    fail(`${filePath}: missing object "platforms"`);
    return problems;
  }

  const entries = Object.entries(data.platforms);
  if (entries.length === 0) {
    fail(`${filePath}: platforms must not be empty`);
  }
  const expectedTarget = path
    .basename(filePath, ".json")
    .replace(/^latest-/, "");
  const betaFallbackTarget = expectedTarget.includes("-beta-")
    ? expectedTarget.replace(/-(?:aarch64|x86_64)$/i, "")
    : null;
  const target = expectedTarget.match(
    /^(darwin|windows|linux)(-beta)?-(x86_64|aarch64)(?:-(app|nsis|msi|appimage))?$/,
  );
  if (!target) {
    fail(`${filePath}: unsupported manifest target ${expectedTarget}`);
    return problems;
  }
  const [, os, channel = "", arch, installer] = target;
  const primary = `${os}${channel}-${arch}`;
  const defaultInstaller = {
    darwin: "app",
    windows: "nsis",
    linux: "appimage",
  }[os];
  if (
    installer &&
    installer !== defaultInstaller &&
    !(os === "windows" && installer === "msi")
  ) {
    fail(`${filePath}: unsupported installer ${installer}`);
  }
  const required = installer
    ? [expectedTarget]
    : [primary, `${primary}-${defaultInstaller}`];
  if (!required.some((key) => Object.hasOwn(data.platforms, key))) {
    fail(`${filePath}: missing required platform ${required.join(" or ")}`);
  }
  for (const [key, platform] of entries) {
    if (
      key !== expectedTarget &&
      !key.startsWith(`${expectedTarget}-`) &&
      key !== betaFallbackTarget
    ) {
      fail(
        `${filePath}: platform key ${key} does not match manifest target ${expectedTarget}`,
      );
    }
    if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
      fail(`${filePath}: platforms.${key} must be an object`);
      continue;
    }
    let parsedUrl = null;
    try {
      parsedUrl = new URL(platform.url);
    } catch {}
    if (
      !isNonEmptyString(platform.url) ||
      parsedUrl?.protocol !== "https:" ||
      parsedUrl.hostname !== "github.com" ||
      !parsedUrl.pathname.includes("/releases/") ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hash
    ) {
      fail(`${filePath}: platforms.${key}.url must be an https URL`);
    }
    if (parsedUrl) {
      let artifact;
      try {
        artifact = decodeURIComponent(
          parsedUrl.pathname.split("/").at(-1) || "",
        );
      } catch {
        fail(`${filePath}: platform ${key} has an invalid artifact filename`);
        continue;
      }
      const keyInstaller = key.slice(primary.length + 1);
      const installerForKey =
        key === primary || key === betaFallbackTarget
          ? installer || defaultInstaller
          : keyInstaller;
      if (
        !resolveUpdaterTargets(artifact).some(
          (target) =>
            target.os === os &&
            target.arch === arch &&
            target.installer === installerForKey,
        )
      ) {
        fail(
          `${filePath}: platform ${key} does not match artifact ${artifact}`,
        );
      }
    }
    if (
      !isNonEmptyString(platform.signature) ||
      !hasMinisignEnvelope(platform.signature)
    ) {
      fail(
        `${filePath}: platforms.${key}.signature must be a base64-encoded minisign envelope`,
      );
    }
  }
  return problems;
}

function validateManifest(filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${filePath}: invalid JSON (${error.message})`);
    return;
  }
  for (const problem of validateManifestData(data, filePath)) fail(problem);
}

function main() {
  const targets = process.argv.slice(2);
  const files =
    targets.length > 0 ? targets : defaultFixtures.filter(fs.existsSync);

  if (files.length === 0) {
    fail("no updater fixtures found; expected testdata/updater/latest-*.json");
    process.exit(1);
  }

  for (const file of files) {
    if (!fs.existsSync(file)) {
      fail(`missing file ${file}`);
      continue;
    }
    validateManifest(file);
  }

  if (!process.exitCode) {
    console.log(
      `updater-manifest: ok (${files.length} file${files.length === 1 ? "" : "s"})`,
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main();
