#!/usr/bin/env node
// Runner for the downloader v5 fixes. Owns its specs: plants fixtures, mounts
// the exFAT image, launches one fresh profile per spec through WebDriver, and
// writes a hashed report under e2e/artifacts/v5-fixes-downloader/<stamp>/.
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

const SPEC_DIR = "./v5-fixes/downloader";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactRoot = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-downloader",
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
  "e2e/v5-fixes/downloader/run.mjs",
  "e2e/v5-fixes/downloader/install-fallback.spec.js",
  "e2e/v5-fixes/downloader/orphan-sweep.spec.js",
  "e2e/v5-fixes/downloader/panic-trace.spec.js",
  "e2e/v5-fixes/downloader/failure-modes.md",
  "src-tauri/src/fs_util.rs",
  "src-tauri/src/staging.rs",
  "src-tauri/src/logging.rs",
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
function runSpec(name, profile, env, specDir) {
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
        ROSI_E2E_SPECS: `${SPEC_DIR}/${name}.spec.js`,
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
    name,
    spec: `e2e/v5-fixes/downloader/${name}.spec.js`,
    status: result.status === 0 && allPassed ? "passed" : "failed",
    exitStatus: result.status,
    error: result.error?.message ?? null,
    checks,
    artifacts: path.relative(REPO_ROOT, specDir),
  };
}

// Orphan fixtures must exist before the app starts: the sweep runs once at
// startup and ignores anything planted later.
function plantOrphans(profile) {
  const outside = path.join(profile.profileDir, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const uuid = () => crypto.randomUUID();
  const downloads = profile.downloads;
  const manifest = {
    downloads,
    outside,
    staleDir: path.join(downloads, `.rosi-download-${uuid()}`),
    staleMediaText: "RECOVERABLE MEDIA BYTES",
    partName: path.join(downloads, `.rosi-convert-${uuid()}`),
    pathFile: path.join(downloads, `.rosi-path-7-${uuid()}.txt`),
    freshDir: path.join(downloads, `.rosi-download-${uuid()}`),
    symlink: path.join(downloads, `.rosi-retire-${uuid()}`),
    outsideFile: path.join(outside, "keep.txt"),
    outsideText: "OUTSIDE TARGET MUST NOT CHANGE",
  };
  fs.mkdirSync(manifest.staleDir);
  fs.writeFileSync(
    path.join(manifest.staleDir, "clip.mp4"),
    manifest.staleMediaText,
  );
  fs.writeFileSync(path.join(manifest.staleDir, "partial.part"), "x");
  // yt-dlp bookkeeping and merge intermediates: discarded, never recovered.
  manifest.intermediateNames = [
    "clip.f137.mp4",
    "clip.f251.webm",
    "clip.temp.mp4",
    "clip.mp4.part-Frag2",
    "clip.ytdl",
  ];
  for (const name of manifest.intermediateNames) {
    fs.writeFileSync(path.join(manifest.staleDir, name), "intermediate");
  }
  // A failed merge leaves only format streams: they are the only copy of the
  // media and must be recovered, not discarded.
  manifest.unmergedDir = path.join(downloads, `.rosi-download-${uuid()}`);
  manifest.unmergedStreams = {
    "song.f137.mp4": "VIDEO STREAM BYTES",
    "song.f251.webm": "AUDIO STREAM BYTES",
  };
  fs.mkdirSync(manifest.unmergedDir);
  for (const [name, text] of Object.entries(manifest.unmergedStreams)) {
    fs.writeFileSync(path.join(manifest.unmergedDir, name), text);
  }
  // Leftovers in a folder that only recorded activity points at.
  manifest.recordedFolder = path.join(profile.home, "Videos", "rosi-preset");
  fs.mkdirSync(manifest.recordedFolder, { recursive: true });
  manifest.recordedStaleDir = path.join(
    manifest.recordedFolder,
    `.rosi-download-${uuid()}`,
  );
  fs.mkdirSync(manifest.recordedStaleDir);
  fs.writeFileSync(path.join(manifest.recordedStaleDir, "x.part"), "x");
  manifest.probeFile = path.join(downloads, `.rosi-probe-${uuid()}`);
  fs.writeFileSync(manifest.probeFile, "");
  fs.writeFileSync(
    path.join(profile.dataDir, "download-activity.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: "sweep-recorded-folder",
          sessionId: 1,
          owner: "manual",
          outcome: "failed",
          statusMessage: "Failed",
          url: "https://video.invalid/recorded",
          request: { outputPath: manifest.recordedFolder },
          startedAt: 1,
          completedAt: 2,
        },
      ],
    }),
  );
  fs.mkdirSync(manifest.partName);
  fs.writeFileSync(manifest.pathFile, "/tmp/ignored\n");
  fs.mkdirSync(manifest.freshDir);
  fs.writeFileSync(manifest.outsideFile, manifest.outsideText);
  fs.symlinkSync(outside, manifest.symlink);
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  for (const target of [
    manifest.staleDir,
    manifest.unmergedDir,
    manifest.recordedStaleDir,
    manifest.probeFile,
    manifest.partName,
    manifest.pathFile,
    manifest.symlink,
  ]) {
    fs.lutimesSync(target, twoDaysAgo, twoDaysAgo);
  }
  const manifestPath = path.join(profile.profileDir, "orphan-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

// The exFAT image lives under the profile home: ROSI accepts download folders
// under the home folder (or /Volumes on macOS), and this mount is the only
// place the spec writes to.
function withExFatMount(profile, action) {
  const image = path.join(profile.profileDir, "rosi-exfat.dmg");
  const mount = path.join(profile.home, "exfat-mount");
  fs.mkdirSync(mount, { recursive: true });
  const created = spawnSync("hdiutil", [
    "create",
    "-size",
    "64m",
    "-fs",
    "ExFAT",
    "-volname",
    "ROSIEXFAT",
    image,
  ]);
  if (created.status !== 0) {
    throw new Error(`hdiutil create failed: ${created.stderr}`);
  }
  let attached = false;
  try {
    const attach = spawnSync("hdiutil", [
      "attach",
      "-nobrowse",
      "-mountpoint",
      mount,
      image,
    ]);
    if (attach.status !== 0) {
      throw new Error(`hdiutil attach failed: ${attach.stderr}`);
    }
    attached = true;
    return action(mount);
  } finally {
    if (attached) {
      const detach = spawnSync("hdiutil", ["detach", mount, "-force"], {
        encoding: "utf8",
      });
      if (detach.status !== 0) {
        console.error(`hdiutil detach failed: ${detach.stderr}`);
        process.exitCode = 1;
      }
    }
    fs.rmSync(image, { force: true });
  }
}

const cases = [];
const skipped = [];
const runnerProfiles = [];
const onMac = process.platform === "darwin";
const suppliedMount = process.env.ROSI_V5_FIX_EXFAT_MOUNT || "";
const dirFor = (name) => path.join(artifactRoot, "specs", name);

try {
  // install-fallback: macOS builds its own exFAT image; elsewhere it needs a
  // mount supplied through ROSI_V5_FIX_EXFAT_MOUNT, otherwise it is skipped.
  if (onMac) {
    const profile = createE2eProfile();
    runnerProfiles.push(profile);
    cases.push(
      withExFatMount(profile, (mount) =>
        runSpec(
          "install-fallback",
          profile,
          {
            ROSI_V5_FIX_EXFAT_MOUNT: mount,
          },
          dirFor("install-fallback"),
        ),
      ),
    );
  } else if (suppliedMount) {
    const profile = createE2eProfile();
    runnerProfiles.push(profile);
    cases.push(
      runSpec(
        "install-fallback",
        profile,
        {
          ROSI_V5_FIX_EXFAT_MOUNT: suppliedMount,
        },
        dirFor("install-fallback"),
      ),
    );
  } else {
    skipped.push({
      name: "install-fallback",
      spec: `e2e/v5-fixes/downloader/install-fallback.spec.js`,
      status: "skipped",
      reason: `platform: ${process.platform} needs ROSI_V5_FIX_EXFAT_MOUNT (an exFAT mount) to run`,
    });
  }

  const orphanProfile = createE2eProfile();
  runnerProfiles.push(orphanProfile);
  const manifestPath = plantOrphans(orphanProfile);
  cases.push(
    runSpec(
      "orphan-sweep",
      orphanProfile,
      {
        ROSI_V5_FIX_ORPHAN_MANIFEST: manifestPath,
      },
      dirFor("orphan-sweep"),
    ),
  );

  const panicProfile = createE2eProfile();
  runnerProfiles.push(panicProfile);
  cases.push(runSpec("panic-trace", panicProfile, {}, dirFor("panic-trace")));
} finally {
  for (const profile of runnerProfiles) {
    fs.rmSync(profile.profileDir, { recursive: true, force: true });
  }
}

const allCases = [...cases, ...skipped];
const body = {
  suite: "v5-fixes-downloader",
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  binarySha256,
  sources,
  cases: allCases,
  passed:
    cases.length > 0 &&
    cases.every((entry) => entry.status === "passed") &&
    skipped.every((entry) => entry.reason),
};
const report = { ...body, reportSha256: hash(JSON.stringify(body, null, 2)) };
fs.writeFileSync(
  path.join(artifactRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `V5 downloader evidence: ${path.relative(REPO_ROOT, path.join(artifactRoot, "report.json"))}`,
);
if (!report.passed) process.exitCode = 1;
