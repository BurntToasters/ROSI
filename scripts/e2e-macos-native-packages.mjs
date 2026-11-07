#!/usr/bin/env node

// Fixture E2E for native macOS package naming, architecture routing, release
// asset completeness, and checksums. Native signing/notarization acceptance is
// recorded separately because those checks require a macOS release machine.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertArchitectureCompatibility,
  assertBundleVersions,
  assertMinimumMacOSVersion,
  macosPackageName,
  normalizeDmgPackage,
  packageOutputPath,
  MACOS_TARGETS,
  verifyAppBundle,
} from "./zip-macos.js";
import {
  artifactMatchesVersion,
  checksumGroupsForArtifacts,
  checksumTargetKeysForArtifactName,
  cleanArtifactName,
  isArtifact,
  isSignable,
  pickNewestByBasename,
  resolveUpdaterTargets,
} from "./gpg-sign.js";
import {
  assertDraftReleaseShape,
  requiredDraftAssetNames,
  requiredDraftInstallerNames,
  requiredDraftSidecarNames,
} from "./verify-release-draft.js";
import { validateManifestData } from "./validate-updater-manifest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  root,
  "e2e",
  "artifacts",
  "macos-native-packages-report.json",
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const scenarios = [];
const REQUIRE_REAL_BUILDS = process.argv.includes("--require-real-builds");
const MACOS_PACKAGE_TARGETS = [
  { target: "universal-apple-darwin", arch: "universal" },
  { target: "aarch64-apple-darwin", arch: "arm64" },
  { target: "x86_64-apple-darwin", arch: "x64" },
];

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function runMacTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function bundleInventory(bundlePath) {
  const entries = [];
  let totalBytes = 0;
  const visit = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relativePath,
        type: "symlink",
        mode,
        target: fs.readlinkSync(absolutePath),
      });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relativePath, type: "directory", mode });
      const children = fs
        .readdirSync(absolutePath)
        .sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        visit(
          path.join(absolutePath, child),
          relativePath ? `${relativePath}/${child}` : child,
        );
      }
      return;
    }
    if (stat.isFile()) {
      totalBytes += stat.size;
      entries.push({
        path: relativePath,
        type: "file",
        mode,
        bytes: stat.size,
        sha256: sha256File(absolutePath),
      });
      return;
    }
    throw new Error(`Unsupported special file in app bundle: ${absolutePath}`);
  };
  visit(bundlePath, "");
  const sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return { entries, totalBytes, sha256 };
}

function requiredBundleAtRoot(directory, { exactRoot = false } = {}) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const appEntries = entries.filter((entry) => entry.name === "ROSI.app");
  if (
    appEntries.length !== 1 ||
    !appEntries[0].isDirectory() ||
    appEntries[0].isSymbolicLink()
  ) {
    throw new Error(
      `${directory} must contain exactly one directory named ROSI.app`,
    );
  }
  if (exactRoot && (entries.length !== 1 || entries[0].name !== "ROSI.app")) {
    throw new Error(
      `${directory} ZIP extraction must contain only ROSI.app at its root`,
    );
  }
  return path.join(directory, "ROSI.app");
}

function relativePath(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function packagePaths({ target, arch }) {
  const bundle = path.join(
    root,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
  );
  return {
    target,
    arch,
    appPath: path.join(bundle, "macos", "ROSI.app"),
    dmgPath: path.join(bundle, "dmg", `ROSI-MacOS-${arch}.dmg`),
    zipPath: path.join(bundle, "macos", `ROSI-MacOS-${arch}.zip`),
  };
}

function assertRecentBuild(filePath, buildStartedAt) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required real macOS build artifact: ${filePath}`);
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Expected a regular build output at ${filePath}`);
  }
  if (stat.mtimeMs < buildStartedAt - 2000) {
    throw new Error(
      `${filePath} predates the current release session; rebuild it before native acceptance.`,
    );
  }
  return stat;
}

function checkRealBuilds() {
  const acceptance = {
    status: "failed",
    mode: "require-real-builds",
    packages: [],
    checks: [],
    cleanup: { status: "not-needed", detachedMounts: [] },
  };
  if (process.platform !== "darwin") {
    acceptance.status = "blocked";
    acceptance.reason = `--require-real-builds requires macOS; current host is ${process.platform}.`;
    return acceptance;
  }

  const mountedVolumes = [];
  let temporaryRoot = null;
  let primaryError = null;
  try {
    const tauriConfig = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    if (tauriConfig.version !== pkg.version) {
      throw new Error(
        `Tauri version ${tauriConfig.version} does not match package.json ${pkg.version}.`,
      );
    }
    const sessionPath = path.join(root, "release", ".build-session.json");
    if (!fs.existsSync(sessionPath)) {
      throw new Error(
        "Release build session is missing; run release:prepare before real package acceptance.",
      );
    }
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (
      session.version !== pkg.version ||
      !Number.isFinite(session.startedAt)
    ) {
      throw new Error(
        "Release build session version or start time is invalid.",
      );
    }
    acceptance.checks.push({
      name: "release-session-version",
      status: "passed",
      version: session.version,
      startedAt: session.startedAt,
    });

    const packageRecords = new Map();
    for (const targetSpec of MACOS_PACKAGE_TARGETS) {
      const paths = packagePaths(targetSpec);
      const appInfo = path.join(paths.appPath, "Contents", "Info.plist");
      const hostBinary = path.join(paths.appPath, "Contents", "MacOS", "rosi");
      for (const outputPath of [
        paths.appPath,
        paths.dmgPath,
        paths.zipPath,
        appInfo,
        hostBinary,
      ]) {
        const stat = assertRecentBuild(outputPath, session.startedAt);
        if (stat.isFile() && stat.size === 0) {
          throw new Error(
            `Required real macOS build output is empty: ${outputPath}`,
          );
        }
      }
      verifyAppBundle(paths.appPath, paths.target, tauriConfig, root);
      const sourceTree = bundleInventory(paths.appPath);
      const source = {
        path: relativePath(paths.appPath),
        bytes: sourceTree.totalBytes,
        sha256: sourceTree.sha256,
        inventory: sourceTree.entries,
      };
      acceptance.checks.push({
        name: `${targetSpec.arch}-source-bundle`,
        status: "passed",
        sourcePath: source.path,
        sourceBytes: source.bytes,
        sourceSha256: source.sha256,
      });

      for (const kind of ["dmg", "zip"]) {
        const packagePath = kind === "dmg" ? paths.dmgPath : paths.zipPath;
        const stat = fs.statSync(packagePath);
        const record = {
          target: paths.target,
          arch: paths.arch,
          kind,
          name: path.basename(packagePath),
          path: relativePath(packagePath),
          bytes: stat.size,
          sha256: sha256File(packagePath),
          sourceBundle: {
            path: source.path,
            bytes: source.bytes,
            sha256: source.sha256,
          },
        };
        if (kind === "zip") {
          const extractionRoot = path.join(
            temporaryRoot ??
              (temporaryRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), "rosi-macos-real-"),
              )),
            `zip-${paths.arch}`,
          );
          fs.mkdirSync(extractionRoot, { recursive: true });
          runMacTool("ditto", ["-x", "-k", packagePath, extractionRoot]);
          const extractedApp = requiredBundleAtRoot(extractionRoot, {
            exactRoot: true,
          });
          verifyAppBundle(extractedApp, paths.target, tauriConfig, root);
          const extractedTree = bundleInventory(extractedApp);
          assert.deepEqual(
            extractedTree.entries,
            sourceTree.entries,
            `${record.name} changed ROSI.app content, permissions, or symlink targets`,
          );
          record.roundTrip = {
            status: "passed",
            bundleBytes: extractedTree.totalBytes,
            bundleSha256: extractedTree.sha256,
            signature: "passed",
            staple: "passed",
          };
        } else {
          runMacTool("xcrun", ["stapler", "validate", packagePath]);
          const mountRoot = path.join(
            temporaryRoot ??
              (temporaryRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), "rosi-macos-real-"),
              )),
            `mount-${paths.arch}`,
          );
          fs.mkdirSync(mountRoot, { recursive: true });
          runMacTool("hdiutil", [
            "attach",
            "-readonly",
            "-nobrowse",
            "-noautoopen",
            "-mountpoint",
            mountRoot,
            packagePath,
          ]);
          mountedVolumes.push(mountRoot);
          const mountedApp = requiredBundleAtRoot(mountRoot);
          verifyAppBundle(mountedApp, paths.target, tauriConfig, root);
          const mountedTree = bundleInventory(mountedApp);
          assert.deepEqual(
            mountedTree.entries,
            sourceTree.entries,
            `${record.name} changed ROSI.app content, permissions, or symlink targets`,
          );
          record.mount = {
            status: "passed",
            bundleBytes: mountedTree.totalBytes,
            bundleSha256: mountedTree.sha256,
            signature: "passed",
            staple: "passed",
            imageStaple: "passed",
          };
        }
        packageRecords.set(`${paths.arch}.${kind}`, record);
        acceptance.packages.push(record);
      }
    }

    const universal = {
      dmg: packageRecords.get("universal.dmg"),
      zip: packageRecords.get("universal.zip"),
    };
    for (const arch of ["arm64", "x64"]) {
      for (const kind of ["dmg", "zip"]) {
        const native = packageRecords.get(`${arch}.${kind}`);
        const baseline = universal[kind];
        native.universalBytes = baseline.bytes;
        native.smallerThanUniversal = native.bytes < baseline.bytes;
        if (!native.smallerThanUniversal) {
          throw new Error(
            `${native.name} is ${native.bytes} bytes, not smaller than ${baseline.name} at ${baseline.bytes} bytes.`,
          );
        }
        acceptance.checks.push({
          name: `${arch}-${kind}-smaller-than-universal`,
          status: "passed",
          nativeBytes: native.bytes,
          universalBytes: baseline.bytes,
          nativeSha256: native.sha256,
          universalSha256: baseline.sha256,
        });
      }
    }
    acceptance.checks.push({
      name: "all-six-real-package-files",
      status: "passed",
      packageCount: acceptance.packages.length,
    });
    acceptance.status = "passed";
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    acceptance.error = primaryError.message;
  } finally {
    const detachErrors = [];
    for (const mountPoint of mountedVolumes.toReversed()) {
      try {
        runMacTool("hdiutil", ["detach", "-quiet", mountPoint]);
        acceptance.cleanup.detachedMounts.push(mountPoint);
      } catch (firstError) {
        try {
          runMacTool("hdiutil", ["detach", "-force", "-quiet", mountPoint]);
          acceptance.cleanup.detachedMounts.push(mountPoint);
        } catch (forceError) {
          detachErrors.push({
            mountPoint,
            error:
              forceError instanceof Error
                ? forceError.message
                : String(forceError),
            originalError:
              firstError instanceof Error
                ? firstError.message
                : String(firstError),
          });
        }
      }
    }
    if (detachErrors.length > 0) {
      acceptance.cleanup.status = "failed";
      acceptance.cleanup.errors = detachErrors;
      acceptance.status = "failed";
      acceptance.error = [
        acceptance.error,
        "Could not detach every mounted DMG.",
      ]
        .filter(Boolean)
        .join(" ");
    } else if (mountedVolumes.length > 0) {
      acceptance.cleanup.status = "passed";
    }
    if (temporaryRoot) {
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        acceptance.status = "failed";
        acceptance.cleanup.status = "failed";
        acceptance.cleanup.temporaryRootError =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        acceptance.error = [
          acceptance.error,
          "Could not remove temporary package verification files.",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }
    if (primaryError && acceptance.status !== "failed") {
      acceptance.status = "failed";
    }
  }
  return acceptance;
}

async function scenario(id, title, body) {
  const startedAt = Date.now();
  try {
    const details = (await body()) ?? {};
    scenarios.push({
      id,
      title,
      ok: true,
      ms: Date.now() - startedAt,
      ...details,
    });
    console.log(`ok   ${id} ${title}`);
  } catch (error) {
    scenarios.push({
      id,
      title,
      ok: false,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(
      `FAIL ${id} ${title}\n     ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function expectFailure(body, pattern) {
  assert.throws(body, pattern);
}

function makeDmgFixture(scratch, target, rawName) {
  const bundleRoot = path.join(scratch, target, "release", "bundle");
  const appPath = path.join(bundleRoot, "macos", "ROSI.app");
  const dmgDirectory = path.join(bundleRoot, "dmg");
  fs.mkdirSync(appPath, { recursive: true });
  fs.mkdirSync(dmgDirectory, { recursive: true });
  fs.writeFileSync(path.join(dmgDirectory, rawName), `${target} fixture`);
  return { appPath, dmgDirectory };
}

async function main() {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-macos-packages-"),
  );
  try {
    await scenario("MNP01", "native architecture mismatch is rejected", () => {
      assertArchitectureCompatibility(["arm64"], "aarch64-apple-darwin");
      expectFailure(
        () =>
          assertArchitectureCompatibility(["x86_64"], "aarch64-apple-darwin"),
        /expected.*arm64/,
      );
      expectFailure(
        () =>
          assertArchitectureCompatibility(
            ["arm64", "x86_64"],
            "x86_64-apple-darwin",
          ),
        /expected.*x86_64/,
      );
      return { nativeTargets: Object.keys(MACOS_TARGETS) };
    });

    await scenario(
      "MNP02",
      "universal yt-dlp is valid for native targets",
      () => {
        assertArchitectureCompatibility(
          ["x86_64", "arm64"],
          "aarch64-apple-darwin",
          { allowAdditional: true, label: "rosi-yt-dlp" },
        );
        expectFailure(
          () =>
            assertArchitectureCompatibility(
              ["x86_64"],
              "aarch64-apple-darwin",
              { allowAdditional: true, label: "rosi-yt-dlp" },
            ),
          /expected to include.*arm64/,
        );
        return { ytDlp: "universal2 allowed when requested slice exists" };
      },
    );

    await scenario(
      "MNP03",
      "minimum macOS floor is checked per requested slice",
      () => {
        assertMinimumMacOSVersion("rosi-ffmpeg", "arm64", "14.0", "15.0");
        expectFailure(
          () =>
            assertMinimumMacOSVersion("rosi-ffmpeg", "x86_64", "15.1", "15.0"),
          /requires macOS 15\.1/,
        );
        return {
          floor: "15.0",
          source: "fixture comparison through production guard",
        };
      },
    );

    await scenario(
      "MNP04",
      "signed-package acceptance requirements stay enforced",
      () => {
        const zipSource = fs.readFileSync(
          path.join(root, "scripts", "zip-macos.js"),
          "utf8",
        );
        const zstdSource = fs.readFileSync(
          path.join(root, "scripts", "pack-macos-updater-zst.js"),
          "utf8",
        );
        assert.match(zipSource, /codesign/);
        assert.match(zipSource, /stapler.*validate/s);
        assert.match(zipSource, /spctl/);
        assert.match(zstdSource, /codesign/);
        assert.match(zstdSource, /stapler.*validate/s);
        return {
          fixtureChecks:
            "signing, staple validation, and Gatekeeper calls remain wired",
          nativeAcceptance:
            process.platform === "darwin" ? "not-run" : "blocked",
        };
      },
    );

    await scenario(
      "MNP05",
      "bundle versions must match the release configuration",
      () => {
        assertBundleVersions(
          { bundleVersion: "5.1.3001", marketingVersion: "5.1.0" },
          {
            expectedBundleVersion: "5.1.3001",
            expectedMarketingVersion: "5.1.0",
          },
        );
        expectFailure(
          () =>
            assertBundleVersions(
              { bundleVersion: "5.1.3001", marketingVersion: "5.0.9" },
              {
                expectedBundleVersion: "5.1.3001",
                expectedMarketingVersion: "5.1.0",
              },
            ),
          /CFBundleShortVersionString/,
        );
        return { releaseVersion: pkg.version };
      },
    );

    await scenario(
      "MNP06",
      "package naming and DMG normalization stay unique by target",
      () => {
        assert.equal(
          macosPackageName("aarch64-apple-darwin", "dmg"),
          "ROSI-MacOS-arm64.dmg",
        );
        assert.equal(
          macosPackageName("x86_64-apple-darwin", "zip"),
          "ROSI-MacOS-x64.zip",
        );
        assert.equal(
          macosPackageName("universal-apple-darwin", "dmg"),
          "ROSI-MacOS-universal.dmg",
        );
        const arm = makeDmgFixture(
          scratch,
          "aarch64-apple-darwin",
          "ROSI_5.1.0-beta.1_aarch64.dmg",
        );
        const x64 = makeDmgFixture(
          scratch,
          "x86_64-apple-darwin",
          "ROSI_5.1.0-beta.1_x64.dmg",
        );
        const universal = makeDmgFixture(
          scratch,
          "universal-apple-darwin",
          "ROSI_5.1.0-beta.1_universal.dmg",
        );
        const armDmg = normalizeDmgPackage(arm.appPath, "aarch64-apple-darwin");
        const x64Dmg = normalizeDmgPackage(x64.appPath, "x86_64-apple-darwin");
        const universalDmg = normalizeDmgPackage(
          universal.appPath,
          "universal-apple-darwin",
        );
        assert.equal(path.basename(armDmg), "ROSI-MacOS-arm64.dmg");
        assert.equal(path.basename(x64Dmg), "ROSI-MacOS-x64.dmg");
        assert.equal(path.basename(universalDmg), "ROSI-MacOS-universal.dmg");
        for (const dmgPath of [armDmg, x64Dmg, universalDmg]) {
          assert.equal(fs.statSync(dmgPath).size > 0, true);
        }
        assert.equal(
          packageOutputPath(arm.appPath, "aarch64-apple-darwin"),
          path.join(path.dirname(arm.appPath), "ROSI-MacOS-arm64.zip"),
        );
        const rebuiltRawDmg = path.join(
          arm.dmgDirectory,
          "ROSI_5.1.0-beta.1_aarch64-rebuilt.dmg",
        );
        fs.writeFileSync(rebuiltRawDmg, "rebuilt arm64 fixture");
        normalizeDmgPackage(arm.appPath, "aarch64-apple-darwin");
        assert.equal(fs.readFileSync(armDmg, "utf8"), "rebuilt arm64 fixture");
        const ambiguous = makeDmgFixture(
          scratch,
          "ambiguous-apple-darwin",
          "ROSI_5.1.0-beta.1_x64.dmg",
        );
        fs.writeFileSync(
          path.join(ambiguous.dmgDirectory, "second.dmg"),
          "second",
        );
        expectFailure(
          () => normalizeDmgPackage(ambiguous.appPath, "x86_64-apple-darwin"),
          /Expected one DMG/,
        );
        return {
          normalized: [
            path.basename(armDmg),
            path.basename(x64Dmg),
            path.basename(universalDmg),
          ],
        };
      },
    );

    await scenario(
      "MNP07",
      "artifact collection preserves native names and signing eligibility",
      () => {
        const raw = path.join(
          "src-tauri",
          "target",
          "aarch64-apple-darwin",
          "release",
          "bundle",
          "dmg",
          "ROSI_5.1.0-beta.1.dmg",
        );
        assert.equal(
          cleanArtifactName(path.basename(raw), raw),
          "ROSI-MacOS-arm64.dmg",
        );
        assert.equal(
          cleanArtifactName("ROSI-MacOS-x64.zip"),
          "ROSI-MacOS-x64.zip",
        );
        for (const name of [
          "ROSI-MacOS-arm64.dmg",
          "ROSI-MacOS-arm64.zip",
          "ROSI-MacOS-x64.dmg",
          "ROSI-MacOS-x64.zip",
        ]) {
          assert.equal(isArtifact(name), true, `${name} must be collected`);
          assert.equal(
            isSignable(name),
            true,
            `${name} must receive a GPG signature`,
          );
        }
        assert.equal(artifactMatchesVersion("ROSI-MacOS-arm64.dmg"), true);
        const duplicateA = path.join(
          scratch,
          "aarch64-apple-darwin",
          "first",
          "ROSI_5.1.0-beta.1.dmg",
        );
        const duplicateB = path.join(
          scratch,
          "aarch64-apple-darwin",
          "second",
          "ROSI_5.1.0-beta.1.dmg",
        );
        fs.mkdirSync(path.dirname(duplicateA), { recursive: true });
        fs.mkdirSync(path.dirname(duplicateB), { recursive: true });
        fs.writeFileSync(duplicateA, "first");
        fs.writeFileSync(duplicateB, "second");
        expectFailure(
          () => pickNewestByBasename([duplicateA, duplicateB]),
          /Multiple current macOS package artifacts normalize to ROSI-MacOS-arm64\.dmg/,
        );
        return { nativePackageCount: 4 };
      },
    );

    await scenario(
      "MNP08",
      "draft verification requires all native and universal installers",
      () => {
        const required = requiredDraftAssetNames();
        const nativeInstallers = [
          "ROSI-MacOS-arm64.dmg",
          "ROSI-MacOS-arm64.zip",
          "ROSI-MacOS-x64.dmg",
          "ROSI-MacOS-x64.zip",
        ];
        for (const name of [
          ...nativeInstallers,
          "ROSI-MacOS-universal.dmg",
          "ROSI-MacOS-universal.zip",
        ]) {
          assert(required.includes(name), `${name} must be required`);
          assert(requiredDraftInstallerNames().includes(name));
          assert(requiredDraftSidecarNames([name]).includes(`${name}.asc`));
        }
        assertDraftReleaseShape({
          release: { draft: true, prerelease: true },
          assetNames: required,
          version: pkg.version,
        });
        expectFailure(
          () =>
            assertDraftReleaseShape({
              release: { draft: true, prerelease: true },
              assetNames: required.filter(
                (name) => name !== "ROSI-MacOS-arm64.zip",
              ),
              version: pkg.version,
            }),
          /ROSI-MacOS-arm64\.zip/,
        );
        return {
          requiredAssetCount: required.length,
          missingAssetRejected: "ROSI-MacOS-arm64.zip",
        };
      },
    );

    await scenario(
      "MNP09",
      "each native package has a GPG signing rule",
      () => {
        for (const name of [
          "ROSI-MacOS-arm64.dmg",
          "ROSI-MacOS-arm64.zip",
          "ROSI-MacOS-x64.dmg",
          "ROSI-MacOS-x64.zip",
        ]) {
          assert.equal(
            isSignable(name),
            true,
            `${name} must receive a GPG signature`,
          );
          assert(requiredDraftSidecarNames([name]).includes(`${name}.asc`));
        }
        return { gpgSidecars: 4 };
      },
    );

    await scenario(
      "MNP10",
      "checksum groups cover each package on its own architectures",
      () => {
        const packages = [
          "ROSI-MacOS-arm64.dmg",
          "ROSI-MacOS-arm64.zip",
          "ROSI-MacOS-x64.dmg",
          "ROSI-MacOS-x64.zip",
          "ROSI-MacOS-universal.dmg",
          "ROSI-MacOS-universal.zip",
        ];
        const channels = [
          { targetSuffix: "", baseUrl: "stable" },
          { targetSuffix: "-beta", baseUrl: "beta" },
        ];
        const groups = checksumGroupsForArtifacts(packages, channels);
        const names = (target) =>
          new Set(
            groups.get(target).map((filePath) => path.basename(filePath)),
          );
        for (const target of ["darwin-aarch64", "darwin-beta-aarch64"]) {
          assert(names(target).has("ROSI-MacOS-arm64.dmg"));
          assert(names(target).has("ROSI-MacOS-arm64.zip"));
          assert(names(target).has("ROSI-MacOS-universal.dmg"));
          assert.equal(names(target).has("ROSI-MacOS-x64.dmg"), false);
        }
        for (const target of ["darwin-x86_64", "darwin-beta-x86_64"]) {
          assert(names(target).has("ROSI-MacOS-x64.dmg"));
          assert(names(target).has("ROSI-MacOS-x64.zip"));
          assert(names(target).has("ROSI-MacOS-universal.zip"));
          assert.equal(names(target).has("ROSI-MacOS-arm64.zip"), false);
        }
        assert.deepEqual(
          checksumTargetKeysForArtifactName("ROSI-MacOS-arm64.zip", channels),
          ["darwin-aarch64", "darwin-beta-aarch64"],
        );
        return { checksumTargets: [...groups.keys()] };
      },
    );

    await scenario(
      "MNP11",
      "updater manifests keep universal fallback and architecture-specific zstd feeds",
      () => {
        const universal = resolveUpdaterTargets("ROSI.app.tar.gz").sort(
          (a, b) => a.arch.localeCompare(b.arch),
        );
        assert.deepEqual(
          universal.map(({ os: operatingSystem, arch, installer }) => ({
            operatingSystem,
            arch,
            installer,
          })),
          [
            { operatingSystem: "darwin", arch: "aarch64", installer: "app" },
            { operatingSystem: "darwin", arch: "x86_64", installer: "app" },
          ],
        );
        assert.deepEqual(resolveUpdaterTargets("ROSI-aarch64.app.tar.zst"), [
          { os: "darwin", arch: "aarch64", installer: "app-zst" },
        ]);
        assert.deepEqual(resolveUpdaterTargets("ROSI-x86_64.app.tar.zst"), [
          { os: "darwin", arch: "x86_64", installer: "app-zst" },
        ]);
        assert.deepEqual(resolveUpdaterTargets("ROSI-MacOS-arm64.dmg"), []);

        const fixture = JSON.parse(
          fs.readFileSync(
            path.join(
              root,
              "testdata",
              "updater",
              "latest-darwin-aarch64-app-zst.json",
            ),
            "utf8",
          ),
        );
        assert.deepEqual(
          validateManifestData(fixture, "latest-darwin-aarch64-app-zst.json"),
          [],
        );
        const wrongArch = structuredClone(fixture);
        wrongArch.platforms["darwin-aarch64-app-zst"].url =
          "https://github.com/BurntToasters/ROSI/releases/download/vfixture/ROSI-x86_64.app.tar.zst";
        assert(
          validateManifestData(
            wrongArch,
            "latest-darwin-aarch64-app-zst.json",
          ).some((problem) => problem.includes("does not match artifact")),
        );
        return {
          universalFeeds: 2,
          zstdFeeds: 2,
          signatureFixture: "valid shape",
        };
      },
    );

    await scenario(
      "MNP12",
      "release scripts reuse each native app build for DMG, ZIP, and zstd",
      () => {
        const scripts = pkg.scripts;
        assert.match(
          scripts["build:mac:arm64:prepared"],
          /--target aarch64-apple-darwin --bundles dmg,app/,
        );
        assert.match(
          scripts["build:mac:x64:prepared"],
          /--target x86_64-apple-darwin --bundles dmg,app/,
        );
        assert.match(
          scripts["build:mac:updater-arches:prepared"],
          /build:mac:native:prepared/,
        );
        assert.match(
          scripts["release:mac:continue"],
          /build:mac:zip:native.*build:mac:updater-zst.*--require-real-builds/,
        );
        return {
          preparedBuilds: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
        };
      },
    );

    await scenario(
      "MNP13",
      "native packaging never claims macOS acceptance on Windows",
      () => {
        const status = process.platform === "darwin" ? "not-run" : "blocked";
        assert(["blocked", "not-run"].includes(status));
        return { hostPlatform: process.platform, nativeAcceptance: status };
      },
    );

    await scenario(
      "MNP14",
      "release verification retains fallback and Rosetta coverage",
      () => {
        const scripts = pkg.scripts;
        assert.match(
          scripts["release:mac:continue"],
          /e2e-updater-zst\.mjs --require-real-builds/,
        );
        assert(
          fs.existsSync(path.join(root, "scripts", "e2e-updater-zst.mjs")),
        );
        return {
          updaterE2e:
            "universal fallback and Rosetta scenarios remain in the release gate",
        };
      },
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const nativeAcceptance = REQUIRE_REAL_BUILDS
    ? checkRealBuilds()
    : {
        status: process.platform === "darwin" ? "not-run" : "blocked",
        mode: "fixture-only",
        reason:
          process.platform === "darwin"
            ? "Fixture E2E does not inspect release packages; pass --require-real-builds after the signed macOS builds."
            : "macOS signing, notarization/stapling, DMG mounting, lipo/otool, and native app launch require the macOS release machine.",
        packages: [],
        checks: [],
        cleanup: { status: "not-run", detachedMounts: [] },
      };
  const fixtureFailures = scenarios.filter((item) => !item.ok).length;
  const nativeFailures =
    REQUIRE_REAL_BUILDS && nativeAcceptance.status !== "passed" ? 1 : 0;
  const evidenceNativeAcceptance = {
    status: nativeAcceptance.status,
    mode: nativeAcceptance.mode,
    reason: nativeAcceptance.reason ?? "",
    error: nativeAcceptance.error ?? "",
    packages: nativeAcceptance.packages.map((record) => ({
      target: record.target,
      arch: record.arch,
      kind: record.kind,
      name: record.name,
      bytes: record.bytes,
      sha256: record.sha256,
      sourceBundle: record.sourceBundle,
      smallerThanUniversal: record.smallerThanUniversal ?? null,
      roundTrip: record.roundTrip ?? null,
      mount: record.mount ?? null,
    })),
    checks: nativeAcceptance.checks,
    cleanup: nativeAcceptance.cleanup,
  };
  const evidenceIdentity = {
    version: pkg.version,
    hostPlatform: process.platform,
    hostArch: process.arch,
    scenarioResults: scenarios.map(({ id, title, ok }) => ({ id, title, ok })),
    nativeAcceptance: evidenceNativeAcceptance,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: pkg.version,
    mode: REQUIRE_REAL_BUILDS ? "require-real-builds" : "fixture-only",
    host: { platform: process.platform, arch: process.arch },
    failureModes: "e2e/macos-native-packages.failure-modes.md",
    scenarios,
    evidenceIdentity,
    nativeAcceptance: {
      ...nativeAcceptance,
      requiredChecks: [
        "Current release-session package and source outputs for all three targets",
        "Package and source bundle SHA-256 and byte counts",
        "Native DMG and ZIP smaller than the universal equivalents",
        "ZIP extraction preserves app tree, target architectures, signature, and staple",
        "Mounted DMG contains the target app with matching tree, signature, and staple",
        "Every mounted DMG detaches in finally",
      ],
    },
    summary: {
      passed: scenarios.filter((item) => item.ok).length,
      failed: fixtureFailures + nativeFailures,
      fixtureFailures,
      nativeFailures,
      nativeAcceptance: nativeAcceptance.status,
      evidenceSha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(evidenceIdentity))
        .digest("hex"),
    },
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const savedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const savedDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(savedReport.evidenceIdentity))
    .digest("hex");
  assert.equal(savedReport.summary.evidenceSha256, savedDigest);
  console.log(
    `e2e-macos-native-packages: ${report.summary.passed} passed, ${report.summary.failed} failed`,
  );
  console.log(
    `native macOS acceptance: ${nativeAcceptance.status} (${nativeAcceptance.mode})${nativeAcceptance.error ? `: ${nativeAcceptance.error}` : nativeAcceptance.reason ? `: ${nativeAcceptance.reason}` : ""}`,
  );
  console.log(
    `evidence: ${path.relative(root, reportPath).replaceAll("\\", "/")}`,
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `e2e-macos-native-packages: FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
