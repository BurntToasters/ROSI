#!/usr/bin/env node
/**
 * Read-only whole-draft gate. Does not upload, publish, or mutate GitHub.
 *
 * Usage:
 *   npm run release:verify:draft
 *   REQUIRE_LINUX_AARCH64=1 npm run release:verify:draft
 */

import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  normalizeUpdaterSignature,
  verifyUpdaterSignatures,
} from "./updater-signature-verifier.js";
import { resolveUpdaterTargets } from "./gpg-sign.js";
import { validateManifestData } from "./validate-updater-manifest.js";
import {
  LEGACY_FEED_FILES,
  assertLegacyFeedAssets,
  assertLegacySourceRelease,
  readLegacyFeedConfig,
  validateLegacyFeed,
} from "./legacy-v4-feed.js";

const require = createRequire(import.meta.url);
const {
  githubApi,
  githubApiRaw,
  assertGitHubCliAuthenticated,
  githubCliEnvironment,
} = require("./github-cli.cjs");
const { isExplicitTruthy } = require("./release-policy.cjs");
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  assertReleaseTagName,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");
const { assertReleaseTagMatchesHead } = require("./release-git-tag.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED_LINUX_PACKAGE_ASSET =
  /(?:\.(?:deb|rpm)(?:\.(?:asc|sig))?$|^latest-linux(?:-beta)?-[a-z0-9_]+-(?:deb|rpm)\.json$)/i;

function readPackageVersion(repositoryRoot = root) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ).version;
}

function isPrereleaseVersion(version) {
  return /-beta\.\d+$/.test(String(version || ""));
}

export function requiredDraftInstallerNames({
  requireLinuxAarch64 = false,
} = {}) {
  const names = [
    "ROSI-Windows-x64.exe",
    "ROSI-Windows-arm64.exe",
    "ROSI-MacOS-universal.dmg",
    "ROSI-MacOS-universal.zip",
    "ROSI-Linux-x64.AppImage",
    "ROSI-Linux-x64.flatpak",
  ];
  if (requireLinuxAarch64) {
    names.push("ROSI-Linux-arm64.AppImage");
  }
  return names;
}

export function requiredDraftSidecarNames(installers) {
  return installers.flatMap((name) => {
    const names = [`${name}.asc`];
    if (/\.exe$/i.test(name) || /\.AppImage$/i.test(name)) {
      names.unshift(`${name}.sig`);
    }
    return names;
  });
}

export function requiredDraftStableManifestNames({
  requireLinuxAarch64 = false,
} = {}) {
  const keys = [
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
  ];
  if (requireLinuxAarch64) {
    keys.push("linux-aarch64");
  }
  return keys.map((key) => `latest-${key}.json`);
}

export function requiredDraftBetaManifestNames({
  requireLinuxAarch64 = false,
} = {}) {
  const keys = [
    "windows-beta-x86_64",
    "windows-beta-x86_64-nsis",
    "windows-beta-aarch64",
    "windows-beta-aarch64-nsis",
    "darwin-beta-x86_64",
    "darwin-beta-x86_64-app",
    "darwin-beta-aarch64",
    "darwin-beta-aarch64-app",
    "linux-beta-x86_64",
    "linux-beta-x86_64-appimage",
  ];
  if (requireLinuxAarch64) {
    for (const suffix of ["", "-appimage"]) {
      keys.push(`linux-beta-aarch64${suffix}`);
    }
  }
  return keys.map((key) => `latest-${key}.json`);
}

export function requiredDraftChecksumNames({
  requireLinuxAarch64 = false,
} = {}) {
  const manifestNames = [
    ...requiredDraftStableManifestNames({ requireLinuxAarch64 }),
    ...requiredDraftBetaManifestNames({ requireLinuxAarch64 }),
  ];
  const keys = new Set(
    manifestNames.map((name) =>
      name.replace(/^latest-/, "").replace(/\.json$/i, ""),
    ),
  );
  return [...keys].sort().flatMap((key) => {
    const checksumName = "SHA256SUMS-" + key + ".txt";
    return [checksumName, checksumName + ".asc"];
  });
}

function parseSha256Sums(checksumName, text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`${checksumName} is empty.`);
  }
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/iu);
    if (!match) {
      throw new Error(
        `${checksumName}:${index + 1} is not a SHA-256 checksum entry.`,
      );
    }
    const name = match[2];
    if (
      !name ||
      name !== path.posix.basename(name) ||
      name !== path.win32.basename(name) ||
      /[\0\r\n]/u.test(name) ||
      name === "." ||
      name === ".."
    ) {
      throw new Error(`${checksumName}:${index + 1} has an unsafe asset name.`);
    }
    if (seen.has(name)) {
      throw new Error(`${checksumName} repeats checksum entry ${name}.`);
    }
    seen.add(name);
    entries.push({ name, digest: match[1].toLowerCase() });
  }
  if (entries.length === 0) throw new Error(`${checksumName} has no entries.`);
  return entries;
}

export function validateSha256Sums({ checksumName, text, assets }) {
  if (!(assets instanceof Map)) {
    throw new Error("Released asset bytes must be supplied as a Map.");
  }
  const entries = parseSha256Sums(checksumName, text);
  for (const { name, digest } of entries) {
    const contents = assets.get(name);
    if (
      !Buffer.isBuffer(contents) &&
      !(contents instanceof Uint8Array) &&
      typeof contents !== "string"
    ) {
      throw new Error(
        `${checksumName} references missing released asset ${name}.`,
      );
    }
    const actual = sha256Contents(contents);
    if (actual !== digest) {
      throw new Error(
        `${checksumName} has the wrong SHA-256 for ${name}: expected ${digest}, actual ${actual}.`,
      );
    }
  }
  return entries.map((entry) => entry.name);
}

function sha256Contents(contents) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(contents) || contents instanceof Uint8Array) {
    hash.update(contents);
    return hash.digest("hex");
  }
  const descriptor = fs.openSync(contents, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function keyIdentifierMatches(identifier, keyId) {
  const normalized = String(identifier || "").toUpperCase();
  return normalized === keyId || normalized.endsWith(keyId);
}

export function resolveExpectedGpgSigner({
  keyId = process.env.GPG_KEY_ID,
  spawn = spawnSync,
} = {}) {
  const normalizedKeyId = String(keyId || "")
    .trim()
    .replace(/^0X/iu, "")
    .toUpperCase();
  if (
    !/^(?:[0-9A-F]{8,16}|[0-9A-F]{40}|[0-9A-F]{64})$/u.test(normalizedKeyId)
  ) {
    throw new Error(
      "GPG_KEY_ID must identify the trusted release signer; verification fails closed.",
    );
  }
  const result = spawn(
    "gpg",
    [
      "--batch",
      "--with-colons",
      "--fingerprint",
      "--list-keys",
      normalizedKeyId,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG_KEY_ID ${normalizedKeyId} is not present in the trusted GPG keyring.`,
    );
  }
  const matches = new Set();
  let primaryKeyId = "";
  let primaryFingerprint = "";
  let currentRecord = "";
  let selected = false;
  for (const line of String(result.stdout || "").split(/\r?\n/u)) {
    const fields = line.split(":");
    if (fields[0] === "pub") {
      currentRecord = "pub";
      primaryKeyId = fields[4] || "";
      primaryFingerprint = "";
      selected = keyIdentifierMatches(primaryKeyId, normalizedKeyId);
    } else if (fields[0] === "sub") {
      currentRecord = "sub";
      selected = keyIdentifierMatches(fields[4], normalizedKeyId);
    } else if (fields[0] === "fpr") {
      const fingerprint = String(fields[9] || "").toUpperCase();
      if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(fingerprint)) continue;
      if (currentRecord === "pub") {
        primaryFingerprint = fingerprint;
        selected =
          selected || keyIdentifierMatches(fingerprint, normalizedKeyId);
      } else if (currentRecord === "sub") {
        selected =
          selected || keyIdentifierMatches(fingerprint, normalizedKeyId);
      }
      if (selected && primaryFingerprint) matches.add(primaryFingerprint);
    }
  }
  if (matches.size !== 1) {
    throw new Error(
      matches.size === 0
        ? `GPG_KEY_ID ${normalizedKeyId} did not resolve to a trusted primary fingerprint.`
        : `GPG_KEY_ID ${normalizedKeyId} resolves to multiple primary fingerprints.`,
    );
  }
  return [...matches][0];
}

export function assertGpgValidSignature({ statusOutput, expectedFingerprint }) {
  const expected = String(expectedFingerprint || "").toUpperCase();
  if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(expected)) {
    throw new Error(
      "Expected trusted GPG signer fingerprint is missing or invalid.",
    );
  }
  const signatures = String(statusOutput || "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  if (signatures.length !== 1) {
    throw new Error(
      "GPG did not report exactly one cryptographically valid detached signature.",
    );
  }
  const fields = signatures[0].split(/\s+/u).slice(2);
  const signerFingerprint = String(fields[0] || "").toUpperCase();
  const primaryFingerprint = String(
    fields[9] || signerFingerprint,
  ).toUpperCase();
  if (primaryFingerprint !== expected) {
    throw new Error(
      `Detached GPG signature belongs to ${primaryFingerprint}, not trusted signer ${expected}.`,
    );
  }
}

export function verifyGpgDetachedSignature({
  signaturePath,
  signedPath,
  expectedFingerprint,
  spawn = spawnSync,
}) {
  const result = spawn(
    "gpg",
    [
      "--batch",
      "--no-auto-key-retrieve",
      "--status-fd=1",
      "--verify",
      signaturePath,
      signedPath,
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG detached signature verification failed for ${path.basename(signedPath)}.`,
    );
  }
  assertGpgValidSignature({
    statusOutput: result.stdout,
    expectedFingerprint,
  });
}

export function requiredDraftAssetNames(options = {}) {
  const requireLinuxAarch64 = Boolean(options.requireLinuxAarch64);
  const installers = requiredDraftInstallerNames({ requireLinuxAarch64 });
  return Array.from(
    new Set([
      ...installers,
      ...requiredDraftSidecarNames(installers),
      ...requiredDraftChecksumNames({ requireLinuxAarch64 }),
      ...requiredDraftStableManifestNames({ requireLinuxAarch64 }),
      ...requiredDraftBetaManifestNames({ requireLinuxAarch64 }),
      // ROSI 4 reads these from the newest release (npm run release:legacy-v4-feed).
      ...LEGACY_FEED_FILES,
    ]),
  ).sort();
}

export function assertDraftReleaseShape({
  release,
  assetNames,
  version,
  headCommit,
  tagCommit,
  requireLinuxAarch64 = false,
}) {
  const tag = `v${version}`;
  const prerelease = isPrereleaseVersion(version);
  if (!release?.draft) {
    throw new Error(
      `Release ${tag} must still be a draft for release:verify:draft.`,
    );
  }
  if (Boolean(release.prerelease) !== prerelease) {
    throw new Error(
      `Release ${tag} prerelease=${release.prerelease} does not match version ${version}.`,
    );
  }
  if (headCommit && release.target_commitish !== headCommit) {
    throw new Error(
      `Release ${tag} targets ${release.target_commitish || "an unknown commit"}, not HEAD ${headCommit}.`,
    );
  }
  if (
    headCommit &&
    tagCommit &&
    String(tagCommit).toLowerCase() !== String(headCommit).toLowerCase()
  ) {
    throw new Error(
      `Release tag ${tag} resolves to commit ${tagCommit}, not HEAD ${headCommit}.`,
    );
  }
  const present = new Set(assetNames);
  const missing = requiredDraftAssetNames({ requireLinuxAarch64 }).filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Draft ${tag} is missing required assets: ${missing.join(", ")}.`,
    );
  }
  const retired = assetNames.filter((name) =>
    RETIRED_LINUX_PACKAGE_ASSET.test(name),
  );
  if (retired.length > 0) {
    throw new Error(
      `Draft ${tag} contains retired DEB/RPM assets: ${retired.join(", ")}.`,
    );
  }
  return { tag, missing };
}

export function selectDraftRelease(releases, tag) {
  assertNoMisnamedVersionDrafts(releases, tag);
  const expectedName = String(tag || "").replace(/^v/, "");
  const matches = (releases || []).filter((release) =>
    isExpectedRelease(release, tag, expectedName),
  );
  const drafts = matches.filter((release) => release.draft);
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${tag}. Resolve duplicates before verifying.`,
    );
  }
  if (drafts.length === 1) {
    return assertExpectedRelease(
      drafts[0],
      tag,
      expectedName,
      "Draft verification release",
    );
  }
  if (matches.length > 0) {
    throw new Error(`Release ${tag} is already published.`);
  }
  return null;
}

export function assertManifestAssetReferences(
  manifest,
  manifestName,
  assetNames,
  { repoOwner, repoName, tag } = {},
) {
  const problems = validateManifestData(manifest, manifestName);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const present = new Set(assetNames);
  const platforms = manifest?.platforms;
  if (
    !platforms ||
    typeof platforms !== "object" ||
    Object.keys(platforms).length === 0
  ) {
    throw new Error(`${manifestName} has no platform entries.`);
  }
  for (const [key, entry] of Object.entries(platforms)) {
    const url = typeof entry?.url === "string" ? entry.url : "";
    if (!url) {
      throw new Error(`${manifestName} platform ${key} has no download url.`);
    }
    if (typeof entry?.signature !== "string" || entry.signature.length === 0) {
      throw new Error(`${manifestName} platform ${key} has no signature.`);
    }
    let fileName;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new Error(`unsupported scheme in ${url}`);
      }
      if (repoOwner && repoName && tag) {
        const expectedPrefix = `/${repoOwner}/${repoName}/releases/download/${tag}/`;
        if (
          parsed.hostname.toLowerCase() !== "github.com" ||
          parsed.port !== "" ||
          parsed.username ||
          parsed.password ||
          parsed.hash ||
          !parsed.pathname
            .toLowerCase()
            .startsWith(expectedPrefix.toLowerCase())
        ) {
          throw new Error(`download URL is outside ${expectedPrefix}`);
        }
      }
      fileName = decodeURIComponent(
        parsed.pathname.split("/").filter(Boolean).pop() ?? "",
      );
    } catch (error) {
      throw new Error(
        `${manifestName} platform ${key} has an invalid url ${JSON.stringify(url)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!fileName) {
      throw new Error(
        `${manifestName} platform ${key} url has no file name: ${url}`,
      );
    }
    if (
      fileName !== path.posix.basename(fileName) ||
      fileName !== path.win32.basename(fileName) ||
      path.posix.isAbsolute(fileName) ||
      path.win32.isAbsolute(fileName) ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes(":") ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw new Error(
        `${manifestName} platform ${key} has an unsafe artifact filename: ${fileName}`,
      );
    }
    if (!present.has(fileName)) {
      throw new Error(
        `${manifestName} platform ${key} points at ${fileName}, which is not a draft asset.`,
      );
    }
    if (!present.has(`${fileName}.sig`)) {
      throw new Error(
        `${manifestName} platform ${key} points at ${fileName} without its updater signature asset ${fileName}.sig.`,
      );
    }
  }
}

async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

async function loadDraftRelease(repoOwner, repoName, tag) {
  let tagged;
  try {
    tagged = githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/tags/${tag}`,
    );
  } catch (error) {
    if (error?.statusCode !== 404) {
      throw new Error(
        `Could not load draft ${tag}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (tagged) {
    if (tagged.draft) {
      return assertReleaseTagName(tagged, tag, "Draft verification release");
    }
    throw new Error(`Release ${tag} is already published.`);
  }

  const releases = await listAllGithubPages((page, perPage) =>
    githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases?per_page=${perPage}&page=${page}`,
    ),
  );
  const match = selectDraftRelease(releases, tag);
  if (!match) {
    throw new Error(
      `No GitHub draft exists for ${tag}. Create it with npm run release:draft on Windows first.`,
    );
  }
  return match;
}

async function listDraftReleaseAssets(repoOwner, repoName, releaseId) {
  return listAllGithubPages((page, perPage) =>
    githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    ),
  );
}

function currentHeadCommit() {
  const commit = execSync("git rev-parse HEAD", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function githubAuthToken() {
  return execSync("gh auth token --hostname github.com", {
    cwd: root,
    encoding: "utf8",
    env: githubCliEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function downloadDraftAsset(
  repoOwner,
  repoName,
  asset,
  destination,
  token,
) {
  if (typeof asset?.id !== "number") {
    throw new Error(`Draft asset ${asset?.name || "(unknown)"} has no id.`);
  }
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ROSI-Release",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Download ${asset.name} failed with HTTP ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new Error(`Download ${asset.name} returned an empty response body.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination, { flags: "wx" }),
  );
  if (fs.statSync(destination).size === 0) {
    throw new Error(`Download ${asset.name} returned an empty file.`);
  }
}

async function verifyDraftGpgAndChecksums({
  repoOwner,
  repoName,
  listedAssets,
  requireLinuxAarch64 = false,
}) {
  const expectedFingerprint = resolveExpectedGpgSigner({
    keyId: process.env.GPG_KEY_ID,
  });
  const assetsByName = new Map();
  for (const asset of listedAssets) {
    if (!asset || typeof asset.name !== "string") continue;
    if (assetsByName.has(asset.name)) {
      throw new Error(`Draft contains duplicate asset name ${asset.name}.`);
    }
    assetsByName.set(asset.name, asset);
  }
  const installers = requiredDraftInstallerNames({ requireLinuxAarch64 });
  const requiredChecksumNames = requiredDraftChecksumNames({
    requireLinuxAarch64,
  })
    .filter((name) => name.endsWith(".txt"))
    .sort();
  const checksumNames = listedAssets
    .map((asset) => asset?.name)
    .filter(
      (name) =>
        typeof name === "string" &&
        /^SHA256SUMS(?:-[a-z0-9_-]+)?\.txt$/i.test(name),
    )
    .sort();
  const missingChecksums = requiredChecksumNames.filter(
    (name) => !assetsByName.has(name),
  );
  if (missingChecksums.length > 0) {
    throw new Error(
      "Draft is missing required SHA256SUMS asset(s): " +
        missingChecksums.join(", ") +
        ".",
    );
  }
  const expectedSignatureNames = [
    ...requiredDraftSidecarNames(installers).filter((name) =>
      name.endsWith(".asc"),
    ),
    ...checksumNames.map((name) => `${name}.asc`),
  ];
  const signatureNames = listedAssets
    .map((asset) => asset?.name)
    .filter((name) => typeof name === "string" && name.endsWith(".asc"));
  const missingSignatures = expectedSignatureNames.filter(
    (name) => !assetsByName.has(name),
  );
  if (missingSignatures.length > 0) {
    throw new Error(
      `Draft is missing GPG signature asset(s): ${missingSignatures.join(", ")}.`,
    );
  }

  const token = githubAuthToken();
  if (!token)
    throw new Error("gh returned an empty GitHub authentication token.");
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-draft-gpg-verify-"),
  );
  try {
    const downloaded = new Map();
    const downloadByName = async (name) => {
      if (downloaded.has(name)) return downloaded.get(name);
      if (
        typeof name !== "string" ||
        name !== path.posix.basename(name) ||
        name !== path.win32.basename(name) ||
        /[\\/:\0]/u.test(name) ||
        name === "." ||
        name === ".."
      ) {
        throw new Error(
          `Draft references an unsafe asset name ${JSON.stringify(name)}.`,
        );
      }
      const asset = assetsByName.get(name);
      if (!asset)
        throw new Error(`Draft checksum references missing asset ${name}.`);
      const destination = path.join(temporaryDirectory, name);
      await downloadDraftAsset(repoOwner, repoName, asset, destination, token);
      downloaded.set(name, destination);
      return destination;
    };

    for (const name of checksumNames) await downloadByName(name);
    for (const name of checksumNames) {
      const text = fs.readFileSync(downloaded.get(name), "utf8");
      const entries = parseSha256Sums(name, text);
      for (const { name: payloadName } of entries) {
        await downloadByName(payloadName);
      }
    }

    const verifiedAssets = new Map(
      [...downloaded].map(([name, filePath]) => [name, filePath]),
    );
    const covered = new Set();
    for (const name of checksumNames) {
      const listed = validateSha256Sums({
        checksumName: name,
        text: fs.readFileSync(downloaded.get(name), "utf8"),
        assets: verifiedAssets,
      });
      for (const payloadName of listed) covered.add(payloadName);
    }
    const requiredPayloadNames = [
      ...installers,
      ...requiredDraftStableManifestNames({ requireLinuxAarch64 }),
      ...requiredDraftBetaManifestNames({ requireLinuxAarch64 }),
    ];
    const unhashed = requiredPayloadNames.filter((name) => !covered.has(name));
    if (unhashed.length > 0) {
      throw new Error(
        `Required draft assets are absent from every SHA256SUMS file: ${unhashed.join(", ")}.`,
      );
    }

    for (const signatureName of signatureNames) {
      const signedName = signatureName.slice(0, -4);
      const signaturePath = await downloadByName(signatureName);
      const signedPath = await downloadByName(signedName);
      verifyGpgDetachedSignature({
        signaturePath,
        signedPath,
        expectedFingerprint,
      });
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyDraftUpdaterArtifacts({
  repoOwner,
  repoName,
  listedAssets,
  manifests,
}) {
  const assetsByName = new Map(
    listedAssets
      .filter((asset) => asset && typeof asset.name === "string")
      .map((asset) => [asset.name, asset]),
  );
  const records = new Map();
  for (const { manifest, name: manifestName } of manifests) {
    const problems = validateManifestData(manifest, manifestName);
    if (problems.length > 0) throw new Error(problems.join("; "));
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      const parsed = new URL(entry.url);
      const artifactName = decodeURIComponent(
        parsed.pathname.split("/").filter(Boolean).at(-1) || "",
      );
      const previous = records.get(artifactName);
      if (previous && previous.signature !== entry.signature) {
        throw new Error(
          `${manifestName} platform ${target} disagrees on the updater signature for ${artifactName}.`,
        );
      }
      records.set(artifactName, { signature: entry.signature });
    }
  }
  if (records.size === 0) {
    throw new Error("Draft manifests reference no updater artifacts.");
  }

  const token = githubAuthToken();
  if (!token)
    throw new Error("gh returned an empty GitHub authentication token.");
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-draft-verify-"),
  );
  try {
    const byName = new Map();
    const signatureByBaseName = new Map();
    for (const [name, record] of records) {
      const asset = assetsByName.get(name);
      if (!asset) {
        throw new Error(`Draft manifests reference missing asset ${name}.`);
      }
      const artifactPath = path.join(temporaryDirectory, name);
      await downloadDraftAsset(repoOwner, repoName, asset, artifactPath, token);
      const signatureAsset = assetsByName.get(`${name}.sig`);
      if (!signatureAsset) {
        throw new Error(`Draft manifests reference missing asset ${name}.sig.`);
      }
      const signaturePath = `${artifactPath}.sig`;
      await downloadDraftAsset(
        repoOwner,
        repoName,
        signatureAsset,
        signaturePath,
        token,
      );
      const manifestSignaturePath = `${artifactPath}.manifest.sig`;
      fs.writeFileSync(manifestSignaturePath, `${record.signature}\n`, {
        flag: "wx",
      });
      if (
        normalizeUpdaterSignature(signaturePath) !==
        normalizeUpdaterSignature(manifestSignaturePath)
      ) {
        throw new Error(
          `Draft asset ${name}.sig does not match updater signature in its manifest.`,
        );
      }
      byName.set(name, artifactPath);
      signatureByBaseName.set(name, signaturePath);
    }
    verifyUpdaterSignatures({
      root,
      releaseDir: temporaryDirectory,
      byName,
      signatureByBaseName,
      resolveUpdaterTargets,
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const version = readPackageVersion();
  const tag = `v${version}`;
  const repoOwner = process.env.GH_REPO_OWNER || "BurntToasters";
  const repoName = process.env.GH_REPO_NAME || "ROSI";
  const requireLinuxAarch64 = isExplicitTruthy(
    process.env.REQUIRE_LINUX_AARCH64,
  );
  assertGitHubCliAuthenticated();
  const headCommit = currentHeadCommit();
  const release = await loadDraftRelease(repoOwner, repoName, tag);
  const tagCommit = assertReleaseTagMatchesHead({
    owner: repoOwner,
    repo: repoName,
    tag,
    headCommit,
    api: githubApi,
    // GitHub draft releases may not create the tag ref until publication.
    allowMissing: true,
  });
  const listedAssets = await listDraftReleaseAssets(
    repoOwner,
    repoName,
    release.id,
  );
  const assets = listedAssets.map((asset) => asset?.name).filter(Boolean);
  assertDraftReleaseShape({
    release,
    assetNames: assets,
    version,
    headCommit,
    tagCommit,
    requireLinuxAarch64,
  });
  const manifestAssets = listedAssets.filter((asset) =>
    /^latest-[a-z0-9_-]+\.json$/i.test(asset?.name || ""),
  );
  const manifests = [];
  for (const asset of manifestAssets) {
    if (typeof asset.id !== "number") {
      throw new Error(`Draft asset ${asset.name} is missing a GitHub id.`);
    }
    const body = githubApiRaw(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`,
    );
    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `${asset.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (manifest?.version !== version) {
      throw new Error(
        `${asset.name} reports version ${JSON.stringify(manifest?.version)}, expected ${version}.`,
      );
    }
    assertManifestAssetReferences(manifest, asset.name, assets, {
      repoOwner,
      repoName,
      tag,
    });
    manifests.push({ manifest, name: asset.name });
  }
  const { sourceTag } = readLegacyFeedConfig(root);
  const legacyFeed = {};
  for (const name of LEGACY_FEED_FILES) {
    const asset = listedAssets.find((item) => item?.name === name);
    legacyFeed[name] = githubApiRaw(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`,
    );
    validateLegacyFeed({ name, text: legacyFeed[name], sourceTag });
  }
  const source = assertLegacySourceRelease(
    githubApi(
      "GET",
      `/repos/${repoOwner}/${repoName}/releases/tags/${sourceTag}`,
    ),
    sourceTag,
  );
  assertLegacyFeedAssets({
    feed: legacyFeed,
    sourceTag,
    assets: source.assets,
  });
  await verifyDraftUpdaterArtifacts({
    repoOwner,
    repoName,
    listedAssets,
    manifests,
  });
  await verifyDraftGpgAndChecksums({
    repoOwner,
    repoName,
    listedAssets,
    requireLinuxAarch64,
  });
  console.log(
    `verify-draft: ok (${tag}, draft, HEAD ${headCommit.slice(0, 12)}, ${assets.length} assets, prerelease=${isPrereleaseVersion(version)}, ROSI 4 feed -> ${sourceTag})`,
  );
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
