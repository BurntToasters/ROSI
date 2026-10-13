import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { stripSupersededPrereleases } from "./update-metainfo.js";
import { syncChangelogForVersion } from "./sync-version-helpers.js";
import { validateChangelogForVersion } from "./validate-changelog-version.js";

const STABLE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "run.rosie.rosi.metainfo.xml",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/Info.plist",
  "src-tauri/tauri.conf.json",
]);

const REQUIRED_STABLE_VERSION_PATHS = new Set([
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "CHANGELOG.md",
  "run.rosie.rosi.metainfo.xml",
]);

function stableVersionOf(version) {
  const match = String(version).match(/^(\d+\.\d+\.\d+)(?:-beta\.\d+)?$/u);
  if (!match)
    throw new Error(`Unsupported stable metadata version: ${version}.`);
  return match[1];
}

function parseJson(file, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

function assertJsonVersionOnly(
  file,
  baseText,
  headText,
  allowedFields,
  expectedBaseVersion,
  expectedHeadVersion,
) {
  const base = parseJson(file, baseText);
  const head = parseJson(file, headText);
  for (const fieldPath of allowedFields) {
    let baseParent = base;
    let headParent = head;
    for (const key of fieldPath.slice(0, -1)) {
      baseParent = baseParent?.[key];
      headParent = headParent?.[key];
    }
    const key = fieldPath.at(-1);
    const baseValue = baseParent?.[key];
    const headValue = headParent?.[key];
    if (baseValue === undefined || headValue === undefined) {
      throw new Error(
        `${file} is missing the allowed version field ${fieldPath.join(".")}.`,
      );
    }
    if (
      baseValue !== expectedBaseVersion ||
      headValue !== expectedHeadVersion
    ) {
      throw new Error(
        `${file} has an unexpected value in ${fieldPath.join(".")}.`,
      );
    }
    baseParent[key] = "<release-version>";
    headParent[key] = "<release-version>";
  }
  if (!isDeepStrictEqual(base, head)) {
    throw new Error(`${file} contains non-version changes.`);
  }
}

function replaceTomlVersion(text, tableName, packageName) {
  const lines = text.split(/\r?\n/u);
  let inTargetTable = false;
  let packageMatches = 0;
  let versionMatches = 0;
  let inTargetPackage = false;
  let packageVersionSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const table = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/u)?.[1];
    if (table) {
      if (inTargetPackage) {
        if (!packageVersionSeen)
          throw new Error(`${tableName} is missing ${packageName}'s version.`);
        inTargetPackage = false;
      }
      inTargetTable = table === "[package]" || table === "[[package]]";
      continue;
    }
    if (!inTargetTable) continue;
    if (tableName.endsWith("Cargo.lock")) {
      const name = line.match(/^\s*name\s*=\s*"([^"]+)"\s*$/u)?.[1];
      if (name !== undefined) {
        inTargetPackage = name === packageName;
        if (inTargetPackage) packageMatches += 1;
        continue;
      }
      if (inTargetPackage) {
        const versionMatch = line.match(
          /^(\s*version\s*=\s*)"([^"]+)"(\s*(?:#.*)?)$/u,
        );
        if (versionMatch) {
          lines[index] =
            `${versionMatch[1]}"<release-version>"${versionMatch[3]}`;
          versionMatches += 1;
          packageVersionSeen = true;
        }
      }
    } else if (inTargetTable) {
      const versionMatch = line.match(
        /^(\s*version\s*=\s*)"([^"]+)"(\s*(?:#.*)?)$/u,
      );
      if (versionMatch) {
        lines[index] =
          `${versionMatch[1]}"<release-version>"${versionMatch[3]}`;
        versionMatches += 1;
      }
    }
  }
  if (tableName.endsWith("Cargo.lock")) {
    if (inTargetPackage && !packageVersionSeen)
      throw new Error(`${tableName} is missing ${packageName}'s version.`);
    if (packageMatches !== 1 || versionMatches !== 1) {
      throw new Error(
        `${tableName} must contain exactly one ${packageName} package version.`,
      );
    }
  } else if (versionMatches !== 1) {
    throw new Error(
      `${tableName} must contain exactly one [package].version field.`,
    );
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return lines.join(newline);
}

function assertTomlVersionOnly(
  file,
  baseText,
  headText,
  expectedBaseVersion,
  expectedHeadVersion,
) {
  const base = replaceTomlVersion(baseText, file, "rosi");
  const head = replaceTomlVersion(headText, file, "rosi");
  const baseVersion = file.endsWith("Cargo.lock")
    ? baseText.match(
        /\[\[package\]\][\s\S]*?name = "rosi"[\s\S]*?version = "([^"]+)"/u,
      )?.[1]
    : baseText.match(/^[ \t]*version\s*=\s*"([^"]+)"/mu)?.[1];
  const actualHeadVersion = file.endsWith("Cargo.lock")
    ? headText.match(
        /\[\[package\]\][\s\S]*?name = "rosi"[\s\S]*?version = "([^"]+)"/u,
      )?.[1]
    : headText.match(/^[ \t]*version\s*=\s*"([^"]+)"/mu)?.[1];
  if (baseVersion !== expectedBaseVersion) {
    throw new Error(
      `${file} base package version does not match the beta release.`,
    );
  }
  if (actualHeadVersion !== expectedHeadVersion) {
    throw new Error(
      `${file} package version does not match ${expectedHeadVersion}.`,
    );
  }
  if (base !== head) {
    throw new Error(`${file} contains non-version changes.`);
  }
}

function assertInfoPlistVersionOnly(baseText, headText, headVersion) {
  const fields = ["CFBundleVersion", "CFBundleShortVersionString"];
  const stable = stableVersionOf(headVersion);
  function normalize(text) {
    const found = new Map();
    let output = text;
    for (const field of fields) {
      const pattern = new RegExp(
        `(<key>${field}<\\/key>\\s*<string>)([^<]*)(<\\/string>)`,
        "gu",
      );
      for (const match of text.matchAll(pattern)) {
        if (found.has(field)) throw new Error(`Info.plist repeats ${field}.`);
        found.set(field, match[2]);
      }
      output = output.replace(pattern, `$1<release-version>$3`);
    }
    return { output, found };
  }
  const base = normalize(baseText);
  const head = normalize(headText);
  if (base.found.size !== head.found.size || base.output !== head.output) {
    throw new Error("src-tauri/Info.plist contains non-version changes.");
  }
  const changedField = fields.some(
    (field) => base.found.get(field) !== head.found.get(field),
  );
  if (!changedField) {
    throw new Error("src-tauri/Info.plist contains no version field change.");
  }
  const betaVersion = `${stableVersionOf(headVersion)}-beta.`;
  for (const [field, value] of base.found) {
    if (value !== stable && !value.startsWith(betaVersion)) {
      throw new Error(
        `src-tauri/Info.plist base ${field} is not a release version.`,
      );
    }
  }
  for (const [field, value] of head.found) {
    if (value !== stable) {
      throw new Error(`src-tauri/Info.plist ${field} must be ${stable}.`);
    }
  }
}

function assertDocumentedReleaseMetadata(
  file,
  baseText,
  headText,
  headVersion,
) {
  if (file === "CHANGELOG.md") {
    assertChangelogReleasePromotion(baseText, headText, headVersion);
    return;
  }
  assertMetainfoReleasePromotion(baseText, headText, headVersion);
}

function assertChangelogReleasePromotion(baseText, headText, headVersion) {
  const betaCalloutPattern =
    /^> \[!NOTE\]\r?\n> 🅱️ This is a Beta build\.\r?\n(?:\r?\n)?/gmu;
  const baseCallouts = [...baseText.matchAll(betaCalloutPattern)];
  if (baseCallouts.length !== 1) {
    throw new Error(
      "CHANGELOG.md base must have exactly one removable Beta callout.",
    );
  }
  if ([...headText.matchAll(betaCalloutPattern)].length !== 0) {
    throw new Error(
      "CHANGELOG.md stable promotion must remove the Beta callout.",
    );
  }

  const baseWithoutCallout = baseText.replace(betaCalloutPattern, "");
  const synchronized = syncChangelogForVersion(baseWithoutCallout, headVersion);
  const placeholder = "- **Fix:** (add release notes)";
  if (synchronized.split(placeholder).length - 1 !== 1) {
    throw new Error(
      "CHANGELOG.md stable promotion must add one new stable release section.",
    );
  }
  const noteStart = synchronized.indexOf(placeholder);
  const prefix = synchronized.slice(0, noteStart);
  const suffix = synchronized.slice(noteStart + placeholder.length);
  if (
    !headText.startsWith(prefix) ||
    !headText.endsWith(suffix) ||
    headText.length < prefix.length + suffix.length
  ) {
    throw new Error(
      "CHANGELOG.md may only remove the Beta callout, sync download URLs, and add stable notes while preserving existing release history.",
    );
  }
  const notes = headText.slice(prefix.length, headText.length - suffix.length);
  if (
    !notes.trim() ||
    /\(add release notes\)/iu.test(notes) ||
    /^##\s/mu.test(notes) ||
    !/^-\s+\S/mu.test(notes)
  ) {
    throw new Error(
      "CHANGELOG.md stable release section must contain real bullet notes.",
    );
  }
  const errors = validateChangelogForVersion(headText, headVersion);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function assertMetainfoReleasePromotion(baseText, headText, headVersion) {
  const escapedVersion = headVersion.replaceAll(".", "\\.");
  const stableEntryPattern = new RegExp(
    '<release version="' +
      escapedVersion +
      '" date="(\\d{4}-\\d{2}-\\d{2})"\\/>',
    "gu",
  );
  const stableEntries = [...headText.matchAll(stableEntryPattern)];
  if (stableEntries.length !== 1) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml must add exactly one dated stable release element.",
    );
  }
  const releaseDate = stableEntries[0][1];
  const parsedDate = new Date(releaseDate + "T00:00:00.000Z");
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== releaseDate
  ) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml stable release date must be a valid YYYY-MM-DD date.",
    );
  }

  const releasesPattern = /<releases>[\s\S]*?<\/releases>/gu;
  const baseSections = [...baseText.matchAll(releasesPattern)];
  const headSections = [...headText.matchAll(releasesPattern)];
  if (baseSections.length !== 1 || headSections.length !== 1) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml must contain exactly one releases section.",
    );
  }
  const baseSection = baseSections[0][0];
  const existingStable = new RegExp(
    "<release\\b[^>]*\\bversion=[\"']" + escapedVersion + "[\"']",
    "u",
  );
  if (existingStable.test(baseSection)) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml base already contains the stable release.",
    );
  }

  const releasesLine = baseText.match(/^([ \t]*)<releases>[ \t]*$/mu);
  if (!releasesLine) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml releases section is not in the documented format.",
    );
  }
  const releaseIndent = releasesLine[1] + "  ";
  let expectedSection = baseSection.replace(
    /<releases>\s*/u,
    "<releases>\n" +
      releaseIndent +
      '<release version="' +
      headVersion +
      '" date="' +
      releaseDate +
      '"/>\n' +
      releaseIndent,
  );
  expectedSection = stripSupersededPrereleases(expectedSection, headVersion);
  const expectedHead = baseText.replace(releasesPattern, expectedSection);
  if (expectedHead !== headText) {
    throw new Error(
      "run.rosie.rosi.metainfo.xml may only add the stable release, prune same-version prereleases, and retain every other byte and release entry.",
    );
  }
}

export function validateStableMetadataChange({
  baseVersion,
  headVersion,
  changedFiles,
}) {
  const match = String(baseVersion).match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/u);
  if (!match || headVersion !== match[1]) {
    throw new Error(
      `Stable metadata must remove only the beta suffix (${baseVersion} -> ${headVersion}).`,
    );
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error("Stable metadata pull request has no changed files.");
  }
  const deletions = changedFiles.filter((change) => change.status === "D");
  if (deletions.length > 0) {
    throw new Error(
      `Stable metadata pull request may not delete files:\n${deletions.map((change) => change.path).join("\n")}`,
    );
  }
  const unexpected = changedFiles.filter(
    (change) =>
      change.status !== "M" ||
      !STABLE_METADATA_PATHS.has(String(change.path).replaceAll("\\", "/")),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Stable metadata pull request changed files that are not release metadata:\n${unexpected.map((change) => `${change.status} ${change.path}`).join("\n")}`,
    );
  }
  const byPath = new Map(
    changedFiles.map((change) => [change.path.replaceAll("\\", "/"), change]),
  );
  const missingRequired = [...REQUIRED_STABLE_VERSION_PATHS].filter(
    (file) => !byPath.has(file),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Stable metadata pull request is missing required release metadata:\n${missingRequired.join("\n")}`,
    );
  }
  for (const change of changedFiles) {
    const file = change.path.replaceAll("\\", "/");
    if (
      typeof change.baseText !== "string" ||
      typeof change.headText !== "string"
    ) {
      throw new Error(`${file} has no comparable base and head content.`);
    }
    switch (file) {
      case "package.json":
      case "src-tauri/tauri.conf.json":
        assertJsonVersionOnly(
          file,
          change.baseText,
          change.headText,
          [["version"]],
          baseVersion,
          headVersion,
        );
        break;
      case "package-lock.json":
        assertJsonVersionOnly(
          file,
          change.baseText,
          change.headText,
          [["version"], ["packages", "", "version"]],
          baseVersion,
          headVersion,
        );
        break;
      case "src-tauri/Cargo.toml":
      case "src-tauri/Cargo.lock":
        assertTomlVersionOnly(
          file,
          change.baseText,
          change.headText,
          baseVersion,
          headVersion,
        );
        break;
      case "src-tauri/Info.plist":
        assertInfoPlistVersionOnly(
          change.baseText,
          change.headText,
          headVersion,
        );
        break;
      case "CHANGELOG.md":
      case "run.rosie.rosi.metainfo.xml":
        assertDocumentedReleaseMetadata(
          file,
          change.baseText,
          change.headText,
          headVersion,
        );
        break;
    }
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function packageVersionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function fileAt(ref, file) {
  return git(["show", `${ref}:${file}`]);
}

function main() {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    throw new Error(
      "Usage: node scripts/check-stable-metadata-pr.mjs <base-ref> <head-ref>",
    );
  }
  const changedStatus = git([
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    "--diff-filter=ACDMRTUXB",
    `${baseRef}..${headRef}`,
  ])
    .split("\0")
    .filter(Boolean);
  const changedFiles = [];
  for (let index = 0; index < changedStatus.length; index += 2) {
    const status = changedStatus[index];
    const file = changedStatus[index + 1];
    if (!status || !file)
      throw new Error("Could not parse stable metadata file statuses.");
    changedFiles.push({
      status,
      path: file,
      baseText: status === "A" ? null : fileAt(baseRef, file),
      headText: status === "D" ? null : fileAt(headRef, file),
    });
  }
  validateStableMetadataChange({
    baseVersion: packageVersionAt(baseRef),
    headVersion: packageVersionAt(headRef),
    changedFiles,
  });
  console.log("Stable metadata pull request scope is valid.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
