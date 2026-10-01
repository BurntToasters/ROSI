#!/usr/bin/env node
/**
 * Fail if package.json version is missing from CHANGELOG.md
 * (section heading and/or download URLs). Stable versions also reject the
 * Beta callout, placeholder notes, and prerelease download URLs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isStableReleaseVersion } from "./release-policy.cjs";

export function validateChangelogForVersion(changelog, version) {
  const errors = [];
  if (!version || typeof version !== "string") {
    errors.push("changelog-version: package.json has no version");
    return errors;
  }

  const tag = `v${version}`;
  // Same exact heading the draft-notes extractor reads (ensure-draft-release).
  const sectionOk = changelog.includes(`## Changes in \`${tag}:\``);
  const urlsOk = changelog.includes(`/download/${tag}/`);

  if (!sectionOk) {
    errors.push(
      `changelog-version: CHANGELOG.md missing section for ${tag} (expected "## Changes in \`${tag}:\`")`,
    );
  }
  if (!urlsOk) {
    errors.push(
      `changelog-version: CHANGELOG.md download links should include /download/${tag}/`,
    );
  }
  if (/\(add release notes\)/.test(changelog)) {
    errors.push(
      "changelog-version: CHANGELOG still has placeholder notes (auto-inserted by sync-version; write real notes before tagging)",
    );
  }
  if (isStableReleaseVersion(version)) {
    if (/This is a Beta build/.test(changelog)) {
      errors.push(
        "changelog-version: stable CHANGELOG must not include the Beta callout",
      );
    }
    if (/\/download\/v\d+\.\d+\.\d+-beta\./.test(changelog)) {
      errors.push(
        "changelog-version: stable CHANGELOG still has prerelease download URLs",
      );
    }
  }
  return errors;
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const errors = validateChangelogForVersion(changelog, version);
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`changelog-version: ok (v${version})`);
}

if (isDirectExecution()) {
  main();
}
