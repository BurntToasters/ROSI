#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
  syncChangelogForVersion,
  updateCargoLockPackageVersion,
  updatePlistStringValue,
  windowsPackageVersionFromSemver,
  syncNpmLockfileVersion,
} from "./sync-version-helpers.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
).version;

const tauriConf = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
const macBundleVersion = macBundleVersionFromSemver(version);
const macMarketingVersion = macMarketingVersionFromSemver(version);
if (
  conf.version !== version ||
  conf.bundle?.macOS?.bundleVersion !== macBundleVersion
) {
  conf.version = version;
  if (!conf.bundle?.macOS) {
    console.error("tauri.conf.json is missing bundle.macOS configuration");
    process.exit(1);
  }
  conf.bundle.macOS.bundleVersion = macBundleVersion;
  fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");
  const verify = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
  if (
    verify.version !== version ||
    verify.bundle?.macOS?.bundleVersion !== macBundleVersion
  ) {
    console.error(`tauri.conf.json write verification failed`);
    process.exit(1);
  }
  console.log(`tauri.conf.json → ${version} (macOS build ${macBundleVersion})`);
}

const macInfoPath = path.join(root, "src-tauri", "Info.plist");
const macInfo = fs.readFileSync(macInfoPath, "utf8");
let updatedMacInfo;
try {
  updatedMacInfo = updatePlistStringValue(
    macInfo,
    "CFBundleShortVersionString",
    macMarketingVersion,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedMacInfo !== macInfo) {
  fs.writeFileSync(macInfoPath, updatedMacInfo);
  console.log(`Info.plist       → ${macMarketingVersion}`);
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf-8");
const updated = cargo.replace(
  /(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/s,
  `$1"${version}"`,
);
if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  const cargoVerify = fs.readFileSync(cargoPath, "utf-8");
  if (!cargoVerify.includes(`version = "${version}"`)) {
    console.error(`Cargo.toml write verification failed`);
    process.exit(1);
  }
  console.log(`Cargo.toml      → ${version}`);
}

const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const cargoLock = fs.readFileSync(cargoLockPath, "utf-8");
let updatedLock;
try {
  updatedLock = updateCargoLockPackageVersion(cargoLock, "rosi", version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedLock !== cargoLock) {
  fs.writeFileSync(cargoLockPath, updatedLock);
  const lockVerify = fs.readFileSync(cargoLockPath, "utf-8");
  if (
    !lockVerify.includes(`name = "rosi"\nversion = "${version}"`) &&
    !lockVerify.includes(`name = "rosi"\r\nversion = "${version}"`)
  ) {
    console.error(`Cargo.lock write verification failed`);
    process.exit(1);
  }
  console.log(`Cargo.lock      → ${version}`);
}

try {
  windowsPackageVersionFromSemver(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");
let syncedChangelog;
try {
  syncedChangelog = syncChangelogForVersion(changelog, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (syncedChangelog !== changelog) {
  fs.writeFileSync(changelogPath, syncedChangelog);
  console.log(`CHANGELOG.md    → ${version} (download URLs + section)`);
}

const npmLockPath = path.join(root, "package-lock.json");
const npmLock = fs.readFileSync(npmLockPath, "utf8");
let updatedNpmLock;
try {
  updatedNpmLock = syncNpmLockfileVersion(npmLock, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedNpmLock !== npmLock) {
  fs.writeFileSync(npmLockPath, updatedNpmLock);
  const lockVerify = JSON.parse(fs.readFileSync(npmLockPath, "utf8"));
  if (
    lockVerify.version !== version ||
    lockVerify.packages?.[""]?.version !== version
  ) {
    console.error("package-lock.json write verification failed");
    process.exit(1);
  }
  console.log(`package-lock.json → ${version}`);
}
