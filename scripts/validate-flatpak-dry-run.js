#!/usr/bin/env node
/**
 * Flatpak packaging dry-run: verify required metadata/templates exist so CI
 * can catch drift without needing a full flatpak-builder install.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { hasExactReleaseVersion } from "./update-metainfo.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "run.rosie.rosi.metainfo.xml",
  "run.rosie.rosi.yml",
  "run.rosie.rosi.desktop",
  "src-tauri/linux/desktop-template.hbs",
  "scripts/prepare-flatpak-source.js",
  "scripts/prepare-sidecars.js",
];
const expectedRuntime = 'runtime-version: "50"';
const rustToolchain = fs
  .readFileSync(path.join(root, "rust-toolchain.toml"), "utf8")
  .match(/^channel = "(\d+\.\d+\.\d+)"$/m)?.[1];

let failed = false;
function fail(message) {
  console.error(`flatpak-dry-run: ${message}`);
  failed = true;
}

for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing ${rel}`);
}

const sourceExporter = path.join(root, "scripts", "prepare-flatpak-source.js");
if (fs.existsSync(sourceExporter)) {
  const source = fs.readFileSync(sourceExporter, "utf8");
  for (const marker of [
    "git",
    "archive",
    "--porcelain=v1",
    ".rosi-source-commit",
    "src-tauri/gen/schemas/",
    'path.join("resources", "ffmpeg", "linux", arch, binary)',
  ]) {
    if (!source.includes(marker)) fail(`source exporter missing ${marker}`);
  }
}

const manifest = path.join(root, "run.rosie.rosi.yml");
if (fs.existsSync(manifest)) {
  const yaml = fs.readFileSync(manifest, "utf8");
  if (!yaml.includes(expectedRuntime)) fail(`expected ${expectedRuntime}`);
  if (!yaml.includes("path: .flatpak-source")) {
    fail("build source must be a clean commit export");
  }
  if (!yaml.includes("npm ci") || !yaml.includes("--share=network")) {
    fail("sideload build must fetch integrity-locked dependencies explicitly");
  }
  if (
    !yaml.includes("npm@12 --") ||
    !yaml.includes("--before=") ||
    !yaml.includes("3 days ago")
  ) {
    fail(
      "node22 SDK npm 10.x must be upgraded to newest npm 12 with a 3-day --before age gate before npm ci",
    );
  }
  if (!yaml.includes("tauri build --no-bundle -- --locked")) {
    fail("Cargo build must enforce Cargo.lock");
  }
  if (
    !rustToolchain ||
    !yaml.includes(
      `test "$(rustc --version | cut -d' ' -f2)" = ${rustToolchain}`,
    ) ||
    yaml.includes("rustup toolchain install") ||
    yaml.includes("RUSTUP_TOOLCHAIN:")
  ) {
    fail(
      "Rust SDK extension must fail closed on the exact pinned compiler without invoking unavailable rustup",
    );
  }
  if (!yaml.includes("Unsupported FLATPAK_ARCH")) {
    fail("sidecar install must fail closed on unknown FLATPAK_ARCH");
  }
  for (const sidecar of ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"]) {
    if (!yaml.includes(sidecar)) fail(`manifest does not install ${sidecar}`);
  }
  if (!yaml.includes("node scripts/prepare-sidecars.js --target")) {
    fail("Flatpak must verify sidecars with prepare-sidecars (no stubs)");
  }
  if (yaml.includes("--allow-stub-ffmpeg")) {
    fail("Flatpak must never bundle development FFmpeg stubs");
  }
  if (yaml.includes("--filesystem=home")) {
    fail("Flatpak must keep least-privilege filesystem access");
  }
}

const metainfo = path.join(root, "run.rosie.rosi.metainfo.xml");
if (fs.existsSync(metainfo)) {
  const xml = fs.readFileSync(metainfo, "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!hasExactReleaseVersion(xml, pkg.version)) {
    fail(`metainfo needs an exact release version="${pkg.version}" attribute`);
  }
  for (const requiredMarkup of [
    '<component type="desktop-application">',
    "<id>run.rosie.rosi</id>",
    '<developer id="run.rosie">',
    '<launchable type="desktop-id">run.rosie.rosi.desktop</launchable>',
  ]) {
    if (!xml.includes(requiredMarkup))
      fail(`metainfo missing ${requiredMarkup}`);
  }
}

function runValidator(command, args) {
  const probe = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    console.log(`flatpak-dry-run: ${command} unavailable; static checks only`);
    return;
  }
  if (probe.error || probe.status !== 0) {
    fail(
      `${command} validation failed:\n${probe.stderr || probe.stdout || probe.error?.message}`,
    );
  }
}

runValidator("appstreamcli", [
  "validate",
  "--no-net",
  "run.rosie.rosi.metainfo.xml",
]);
runValidator("desktop-file-validate", ["run.rosie.rosi.desktop"]);

const tauriConfPath = path.join(root, "src-tauri/tauri.conf.json");
if (fs.existsSync(tauriConfPath)) {
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  if (tauriConf.identifier !== "run.rosie.rosi") {
    fail("tauri.conf.json identifier must be run.rosie.rosi");
  }
  const linux = tauriConf.bundle?.linux ?? {};
  for (const kind of ["deb", "rpm"]) {
    if (linux[kind]?.desktopTemplate !== "linux/desktop-template.hbs") {
      fail(
        `bundle.linux.${kind}.desktopTemplate must be linux/desktop-template.hbs`,
      );
    }
  }
  const externalBin = tauriConf.bundle?.externalBin ?? [];
  for (const sidecar of ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"]) {
    if (!externalBin.includes(`binaries/${sidecar}`)) {
      fail(`bundle.externalBin must include binaries/${sidecar}`);
    }
  }
}

const cargoToml = path.join(root, "src-tauri/Cargo.toml");
const vendorUpdater = path.join(
  root,
  "src-tauri/vendor/tauri-plugin-updater/src/updater.rs",
);
if (fs.existsSync(cargoToml)) {
  const cargo = fs.readFileSync(cargoToml, "utf8");
  if (
    !cargo.includes(
      'tauri-plugin-updater = { path = "vendor/tauri-plugin-updater" }',
    )
  ) {
    fail(
      "Cargo.toml must path-patch tauri-plugin-updater for macOS install quoting",
    );
  }
}
if (!fs.existsSync(vendorUpdater)) {
  fail("missing vendored tauri-plugin-updater sources");
} else {
  const updaterSrc = fs.readFileSync(vendorUpdater, "utf8");
  for (const marker of ["quoted form of", "execute_function"]) {
    if (!updaterSrc.includes(marker)) {
      fail(`vendored updater missing privileged-install marker ${marker}`);
    }
  }
}

if (failed) process.exit(1);
console.log("flatpak-dry-run: ok");
