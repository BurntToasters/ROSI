/**
 * ROSI 4 update feed for ROSI 5 releases.
 *
 * ROSI 4's electron-updater reads latest*.yml from whichever GitHub release
 * is newest, so every ROSI 5 release must carry them or v4 users get update
 * errors. The copies point at the v4 release named in legacy-v4-feed.json
 * through `../<tag>/<file>` URLs, which electron-updater resolves against the
 * v5 release's download path.
 *
 * Usage:
 *   npm run release:legacy-v4-feed                   upload to the v<version> draft
 *   npm run release:legacy-v4-feed -- --dry-run      build and validate only
 *   npm run release:legacy-v4-feed -- --dry-run --check-urls
 *   npm run release:legacy-v4-feed -- --release v5.0.0 --allow-published
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "ROSI";
const OUTPUT_DIR = path.join(root, "release", "legacy-v4-feed");

/** Channel files electron-updater requests: Windows, macOS, Linux x64, Linux arm64. */
export const LEGACY_FEED_FILES = Object.freeze([
  "latest.yml",
  "latest-mac.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
]);

const V4_TAG = /^v4\.\d+\.\d+$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEPT_OPTIONAL_KEYS = [
  "releaseDate",
  "releaseName",
  "minimumSystemVersion",
  "stagingPercentage",
];

export function readLegacyFeedConfig(repositoryRoot = root) {
  const config = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "legacy-v4-feed.json"), "utf8"),
  );
  assertV4Tag(config?.sourceTag, "legacy-v4-feed.json sourceTag");
  return { sourceTag: config.sourceTag };
}

function assertV4Tag(tag, label) {
  if (typeof tag !== "string" || !V4_TAG.test(tag)) {
    throw new Error(
      `${label} must be a stable ROSI 4 tag like v4.3.2, got ${JSON.stringify(tag)}.`,
    );
  }
}

/** The configured source must be a published, non-prerelease v4 release. */
export function assertLegacySourceRelease(release, sourceTag) {
  assertV4Tag(sourceTag, "Legacy feed source tag");
  if (release?.tag_name !== sourceTag) {
    throw new Error(
      `Legacy feed source release is ${JSON.stringify(release?.tag_name)}, expected ${sourceTag}.`,
    );
  }
  if (release.draft || release.prerelease) {
    throw new Error(
      `Legacy feed source ${sourceTag} must be a published stable release (draft=${Boolean(release.draft)}, prerelease=${Boolean(release.prerelease)}).`,
    );
  }
  return release;
}

function assertFileName(value, label) {
  if (
    typeof value !== "string" ||
    !SAFE_FILE_NAME.test(value) ||
    value.includes("..")
  ) {
    throw new Error(
      `${label} must be a plain release file name, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function assertSha512(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} is missing a base64 sha512.`);
  }
  return value;
}

function assertSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is missing a positive size.`);
  }
  return value;
}

function parseFeed(name, text) {
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    throw new Error(
      `${name} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} is not a YAML mapping.`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`${name} has no files.`);
  }
  return parsed;
}

function rewriteFeed(name, text, sourceTag) {
  const source = parseFeed(name, text);
  const expectedVersion = sourceTag.slice(1);
  if (String(source.version) !== expectedVersion) {
    throw new Error(
      `${name} from ${sourceTag} reports version ${JSON.stringify(source.version)}.`,
    );
  }
  const prefix = `../${sourceTag}/`;
  const files = source.files.map((file, index) => {
    const label = `${name} files[${index}]`;
    const out = {
      url: prefix + assertFileName(file?.url, `${label} url`),
      sha512: assertSha512(file.sha512, `${label} sha512`),
      size: assertSize(file.size, `${label} size`),
    };
    if (file.blockMapSize !== undefined) {
      out.blockMapSize = assertSize(file.blockMapSize, `${label} blockMapSize`);
    }
    if (file.isAdminRightsRequired !== undefined) {
      out.isAdminRightsRequired = Boolean(file.isAdminRightsRequired);
    }
    return out;
  });
  const feed = {
    version: expectedVersion,
    files,
    path: prefix + assertFileName(source.path, `${name} path`),
    sha512: assertSha512(source.sha512, `${name} sha512`),
  };
  for (const key of KEPT_OPTIONAL_KEYS) {
    if (source[key] !== undefined) feed[key] = source[key];
  }
  const text2 = yaml.dump(feed, { lineWidth: -1, noRefs: true });
  validateLegacyFeed({ name, text: text2, sourceTag });
  return text2;
}

/** Build the four feed files from the v4 release's own feed files. */
export function buildLegacyFeed({ sourceTag, sources }) {
  assertV4Tag(sourceTag, "Legacy feed source tag (ROSI 4)");
  const feed = {};
  for (const name of LEGACY_FEED_FILES) {
    const text = sources?.[name];
    if (typeof text !== "string") {
      throw new Error(`${sourceTag} is missing ${name}.`);
    }
    feed[name] = rewriteFeed(name, text, sourceTag);
  }
  return feed;
}

/**
 * Check a feed file already built or attached to a draft: right version,
 * every URL inside `../<sourceTag>/`, and hashes intact.
 */
export function validateLegacyFeed({ name, text, sourceTag }) {
  assertV4Tag(sourceTag, "Legacy feed source tag");
  const parsed = parseFeed(name, text);
  const expectedVersion = sourceTag.slice(1);
  if (String(parsed.version) !== expectedVersion) {
    throw new Error(
      `${name} reports version ${JSON.stringify(parsed.version)}, expected ${expectedVersion} (${sourceTag}).`,
    );
  }
  const prefix = `../${sourceTag}/`;
  const checkUrl = (value, label) => {
    if (typeof value !== "string" || !value.startsWith(prefix)) {
      throw new Error(
        `${name} ${label} must start with ${prefix}, got ${JSON.stringify(value)}.`,
      );
    }
    return assertFileName(value.slice(prefix.length), `${name} ${label}`);
  };
  const fileNames = parsed.files.map((file, index) => {
    assertSha512(file?.sha512, `${name} files[${index}] sha512`);
    assertSize(file.size, `${name} files[${index}] size`);
    return {
      name: checkUrl(file.url, `files[${index}] url`),
      size: file.size,
    };
  });
  checkUrl(parsed.path, "path");
  assertSha512(parsed.sha512, `${name} sha512`);
  return { version: expectedVersion, files: fileNames };
}

/** Every file the feed names must exist in the v4 release with that size. */
export function assertLegacyFeedAssets({ feed, sourceTag, assets }) {
  const sizes = new Map(
    (assets || []).map((asset) => [asset?.name, asset?.size]),
  );
  for (const [name, text] of Object.entries(feed)) {
    for (const file of validateLegacyFeed({ name, text, sourceTag }).files) {
      if (!sizes.has(file.name)) {
        throw new Error(
          `${name} names ${file.name}, which ${sourceTag} lacks.`,
        );
      }
      if (sizes.get(file.name) !== file.size) {
        throw new Error(
          `${name} lists ${file.name} as ${file.size} bytes; ${sourceTag} has ${sizes.get(file.name)}.`,
        );
      }
    }
  }
}

/** The absolute URL electron-updater downloads when the feed sits on `releaseTag`. */
export function resolveLegacyDownloadUrl(releaseTag, fileUrl) {
  return new URL(
    `/${REPO_OWNER}/${REPO_NAME}/releases/download/${releaseTag}/${fileUrl}`,
    "https://github.com",
  ).href;
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    .version;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    checkUrls: false,
    allowPublished: false,
    release: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check-urls") options.checkUrls = true;
    else if (arg === "--allow-published") options.allowPublished = true;
    else if (arg === "--release") options.release = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    options.release !== null &&
    !/^v5\.\d+\.\d+(-beta\.\d+)?$/.test(options.release)
  ) {
    throw new Error(
      `--release must be a ROSI 5 tag, got ${JSON.stringify(options.release)}.`,
    );
  }
  return options;
}

async function listAllPages(githubApi, endpoint) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function loadTargetRelease(github, tag, allowPublished) {
  const { isExpectedRelease } = require("./release-draft-metadata.cjs");
  const releases = await listAllPages(
    github.githubApi,
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
  );
  const drafts = releases.filter(
    (release) => release.draft && isExpectedRelease(release, tag),
  );
  if (drafts.length > 1) {
    throw new Error(`Multiple drafts exist for ${tag}; resolve them first.`);
  }
  if (drafts.length === 1) return drafts[0];
  const published = releases.find(
    (release) => !release.draft && release.tag_name === tag,
  );
  if (!published) {
    throw new Error(
      `No release exists for ${tag}. Create the draft with npm run release:draft first.`,
    );
  }
  if (!allowPublished) {
    throw new Error(
      `${tag} is already published. Pass --release ${tag} --allow-published to replace only its ROSI 4 feed files.`,
    );
  }
  return published;
}

async function uploadFeed(github, release, files) {
  const assets = await listAllPages(
    github.githubApi,
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}/assets`,
  );
  for (const filePath of files) {
    const name = path.basename(filePath);
    const wanted = fs.readFileSync(filePath);
    const existing = assets.find((asset) => asset?.name === name);
    if (existing) {
      const current = github.githubApiRaw(
        "GET",
        `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${existing.id}`,
      );
      if (current === wanted.toString("utf8")) {
        console.log(`  = ${name} already current`);
        continue;
      }
      github.githubApi(
        "DELETE",
        `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${existing.id}`,
      );
    }
    github.uploadReleaseAsset(release.upload_url, filePath);
    console.log(`  ^ ${name}`);
  }
  const after = await listAllPages(
    github.githubApi,
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}/assets`,
  );
  const present = new Set(after.map((asset) => asset?.name));
  const missing = files
    .map((filePath) => path.basename(filePath))
    .filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Upload did not attach: ${missing.join(", ")}.`);
  }
}

async function checkUrls(feed, releaseTag) {
  for (const [name, text] of Object.entries(feed)) {
    const parsed = yaml.load(text);
    for (const file of parsed.files) {
      const url = resolveLegacyDownloadUrl(releaseTag, file.url);
      const response = await fetch(url, { method: "HEAD", redirect: "follow" });
      const length = Number(response.headers.get("content-length"));
      if (!response.ok || length !== file.size) {
        throw new Error(
          `${name}: ${url} returned HTTP ${response.status}, ${length} bytes (expected ${file.size}).`,
        );
      }
      console.log(`  ok ${name} -> ${url} (${length} bytes)`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { sourceTag } = readLegacyFeedConfig();
  const targetTag = options.release ?? `v${readPackageVersion()}`;
  const github = require("./github-cli.cjs");
  github.assertGitHubCliAuthenticated();

  const source = assertLegacySourceRelease(
    github.githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${sourceTag}`,
    ),
    sourceTag,
  );
  const sources = {};
  for (const name of LEGACY_FEED_FILES) {
    const asset = source.assets?.find((item) => item?.name === name);
    if (!asset) throw new Error(`${sourceTag} has no ${name} asset.`);
    sources[name] = github.githubApiRaw(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${asset.id}`,
    );
  }
  const feed = buildLegacyFeed({ sourceTag, sources });
  assertLegacyFeedAssets({ feed, sourceTag, assets: source.assets });

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = LEGACY_FEED_FILES.map((name) => {
    const filePath = path.join(OUTPUT_DIR, name);
    fs.writeFileSync(filePath, feed[name]);
    const digest = crypto.createHash("sha256").update(feed[name]).digest("hex");
    console.log(`  + ${name} -> ${sourceTag} (sha256 ${digest.slice(0, 16)})`);
    return filePath;
  });

  if (options.checkUrls) await checkUrls(feed, targetTag);
  if (options.dryRun) {
    console.log(
      `legacy-v4-feed: dry run ok (${sourceTag}, files in ${OUTPUT_DIR})`,
    );
    return;
  }
  const release = await loadTargetRelease(
    github,
    targetTag,
    options.allowPublished,
  );
  await uploadFeed(github, release, files);
  console.log(
    `legacy-v4-feed: ${targetTag} (${release.draft ? "draft" : "published"}) now points ROSI 4 at ${sourceTag}.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
