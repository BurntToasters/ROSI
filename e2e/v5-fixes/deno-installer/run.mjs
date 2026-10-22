#!/usr/bin/env node
// Runner for the Deno installer v5 fix. Plants an empty Deno probe directory
// and an empty installer directory inside a fresh profile, launches the app
// once through WebDriver with the real backend, and writes a hashed report
// under e2e/artifacts/v5-fixes-deno-installer/<stamp>/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "../../helpers/profile.js";

const SPEC_NAME = "deno-installer";
const SPEC_FILE = `e2e/v5-fixes/${SPEC_NAME}/${SPEC_NAME}.spec.js`;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactRoot = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-deno-installer",
  stamp,
);
const binary = e2eBinaryPath();
const buildStamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(buildStamp) ||
  fs.statSync(buildStamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running this suite.",
  );
}
const binarySha256 = hash(fs.readFileSync(binary));
const sourceFiles = [
  "e2e/v5-fixes/deno-installer/run.mjs",
  "e2e/v5-fixes/deno-installer/deno-installer.spec.js",
  "e2e/v5-fixes/deno-installer/failure-modes.md",
  "src-tauri/src/deno.rs",
  "src/engine/deno.ts",
  "src/engine/wizard.ts",
];
fs.mkdirSync(artifactRoot, { recursive: true });
const sources = sourceFiles.map((source) => {
  const bytes = fs.readFileSync(path.join(REPO_ROOT, source));
  const copy = path.join(artifactRoot, "sources", source);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, bytes);
  return { path: source, sha256: hash(bytes) };
});

const startedAt = new Date().toISOString();

// One wdio launch with its own profile. The spec writes its checks into
// specDir/report.json; the runner folds that into the top-level report.
function runSpec(profile, env, specDir) {
  fs.mkdirSync(specDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "@wdio", "cli", "bin", "wdio.js"),
      "run",
      path.join(REPO_ROOT, "e2e", "wdio.conf.js"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...profile.env,
        ROSI_E2E_BINARY: binary,
        ROSI_E2E_DOWNLOADS: profile.downloads,
        ROSI_E2E_XDG_DOWNLOADS: profile.xdgDownloads,
        ROSI_E2E_PROFILE: profile.profileDir,
        ROSI_E2E_SPECS: `./v5-fixes/${SPEC_NAME}/${SPEC_NAME}.spec.js`,
        ROSI_V5_FIX_ARTIFACTS: specDir,
        ...env,
      },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(specDir, "wdio.log"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  let checks = [];
  try {
    checks = JSON.parse(
      fs.readFileSync(path.join(specDir, "report.json"), "utf8"),
    ).checks;
  } catch {}
  const allPassed =
    checks.length > 0 &&
    checks.every((check) => check.invariantPassed === true);
  return {
    name: SPEC_NAME,
    spec: SPEC_FILE,
    status: result.status === 0 && allPassed ? "passed" : "failed",
    exitStatus: result.status,
    error: result.error?.message ?? null,
    checks,
    artifacts: path.relative(REPO_ROOT, specDir),
  };
}

// The app reads the reminder flag at startup. The E2E profile seeds it as
// dismissed, so the profile is flipped here to let the startup reminder show.
function enableStartupReminder(profile) {
  const settingsPath = path.join(profile.dataDir, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings.denoReminderDismissed = false;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

// Empty directories inside the profile. An empty installer directory means no
// package manager is found; an empty probe directory means Deno is not
// installed. Neither lookup reaches the real system PATH.
function emptyDir(profile, name) {
  const dir = path.join(profile.profileDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length !== 0) {
    throw new Error(`${dir} must be empty for the Deno installer suite`);
  }
  return dir;
}

const profile = createE2eProfile();
const installerDir = emptyDir(profile, "deno-installer-empty");
const probeDir = emptyDir(profile, "deno-probe-empty");
enableStartupReminder(profile);
const specDir = path.join(artifactRoot, "specs", SPEC_NAME);
let spec;
try {
  spec = runSpec(
    profile,
    {
      ROSI_E2E_DENO_INSTALLER_DIR: installerDir,
      ROSI_E2E_DENO_PROBE_DIR: probeDir,
    },
    specDir,
  );
} finally {
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
}

const body = {
  suite: "v5-fixes-deno-installer",
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  binarySha256,
  sources,
  cases: [spec],
  passed: spec.status === "passed",
};
const report = { ...body, reportSha256: hash(JSON.stringify(body, null, 2)) };
fs.writeFileSync(
  path.join(artifactRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `V5 Deno installer evidence: ${path.relative(REPO_ROOT, path.join(artifactRoot, "report.json"))}`,
);
if (!report.passed) process.exitCode = 1;
