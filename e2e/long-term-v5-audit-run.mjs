import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  e2eSettings,
  REPO_ROOT,
} from "./helpers/profile.js";

const artifactRoot = path.resolve(
  REPO_ROOT,
  process.env.ROSI_LONG_TERM_ARTIFACT_ROOT ||
    `e2e/artifacts/long-term-v5-repairs/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(stamp) ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running these probes.",
  );
}
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const observations = [];
const startedAt = new Date().toISOString();
const profiles = [];
const ownedRoot = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "long-term-v5-repairs",
);
if (!artifactRoot.startsWith(`${ownedRoot}${path.sep}`)) {
  throw new Error(
    "Repair artifacts must use a new child directory under e2e/artifacts/long-term-v5-repairs.",
  );
}
fs.mkdirSync(path.dirname(artifactRoot), { recursive: true });
fs.mkdirSync(artifactRoot);
const sourceFiles = [
  "e2e/long-term-v5-audit-run.mjs",
  "e2e/long-term-v5-audit.spec.js",
  "e2e/long-term-v5-failure-modes.md",
  "src-tauri/src/settings.rs",
  "src-tauri/src/legacy.rs",
  "src-tauri/src/queue.rs",
  "src-tauri/src/downloader.rs",
  "src/rosiEngine.ts",
  "scripts/test-e2e.js",
];
for (const source of sourceFiles) {
  const destination = path.join(artifactRoot, "sources", source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, source), destination);
}
fs.writeFileSync(
  path.join(artifactRoot, "working-tree.patch"),
  spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: REPO_ROOT }).stdout,
);

function newProfile(options) {
  const profile = createE2eProfile(options);
  profile.env.ROSI_E2E_LEGACY_V4_DIR = path.join(
    profile.profileDir,
    "legacy-v4",
  );
  profiles.push(profile);
  return profile;
}

function snapshot(profile, directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(profile.dataDir, path.join(directory, "app-data"), {
    recursive: true,
  });
  const legacy = profile.env.ROSI_E2E_LEGACY_V4_DIR;
  if (fs.existsSync(legacy))
    fs.cpSync(legacy, path.join(directory, "legacy-v4"), { recursive: true });
}

function run(mode, profile, expectedQueueCount) {
  const directory = path.join(
    artifactRoot,
    `${observations.length + 1}-${mode}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  snapshot(profile, path.join(directory, "before"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules/@wdio/cli/bin/wdio.js"),
      "run",
      path.join(REPO_ROOT, "e2e/wdio.conf.js"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...profile.env,
        ROSI_E2E_BINARY: binary,
        ROSI_E2E_SPECS: "./long-term-v5-audit.spec.js",
        ROSI_LONG_TERM_MODE: mode,
        ROSI_LONG_TERM_EXPECTED_QUEUE_COUNT: String(expectedQueueCount ?? ""),
        ROSI_LONG_TERM_ARTIFACTS: directory,
      },
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(directory, "wdio.log"),
    `${result.stdout || ""}${result.stderr || ""}`,
  );
  snapshot(profile, path.join(directory, "after"));
  const observationPath = path.join(directory, "observation.json");
  const observation = fs.existsSync(observationPath)
    ? JSON.parse(fs.readFileSync(observationPath, "utf8"))
    : {
        mode,
        invariantPassed: null,
        error: result.error?.message || "No observation produced",
      };
  observations.push({
    ...observation,
    runnerExitCode: result.status,
    artifactDirectory: path.relative(REPO_ROOT, directory),
  });
  console.log(
    JSON.stringify({
      mode,
      invariantPassed: observation.invariantPassed,
      exitCode: result.status,
    }),
  );
}

try {
  const control = newProfile();
  run("control", control);
  run("stats-reset-failure", newProfile());
  run("stats-reset-control", newProfile());
  const unreadable = newProfile();
  fs.rmSync(path.join(unreadable.dataDir, "settings.json"));
  fs.mkdirSync(path.join(unreadable.dataDir, "settings.json"));
  run("unreadable-settings", unreadable);
  const future = newProfile();
  const futurePath = path.join(future.dataDir, "settings.json");
  const futureSettings = JSON.parse(fs.readFileSync(futurePath, "utf8"));
  Object.assign(futureSettings, {
    settingsVersion: 8,
    futureAuditField: { retained: true },
  });
  fs.writeFileSync(futurePath, JSON.stringify(futureSettings, null, 2));
  run("future-settings", future);
  const corrupt = newProfile();
  fs.writeFileSync(
    path.join(corrupt.dataDir, "settings.json"),
    '{"theme":"purple","LONG_TERM_DAMAGED_SETTINGS":',
  );
  run("corrupt-settings", corrupt);
  const migration = newProfile({ seedSettings: false });
  const legacy = migration.env.ROSI_E2E_LEGACY_V4_DIR;
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(legacy, "settings.json"),
    JSON.stringify(e2eSettings({ downloadFolder: migration.downloads })),
  );
  fs.writeFileSync(
    path.join(legacy, "download-queue.json"),
    JSON.stringify([
      {
        id: "legacy-audit-item",
        url: "https://audit.invalid/legacy.mp4",
        status: "pending",
        addedAt: 1,
      },
    ]),
  );
  fs.mkdirSync(path.join(migration.dataDir, "download-queue.json"));
  const blockedJournal = newProfile({ seedSettings: false });
  fs.cpSync(legacy, blockedJournal.env.ROSI_E2E_LEGACY_V4_DIR, {
    recursive: true,
  });
  fs.mkdirSync(path.join(blockedJournal.dataDir, "legacy-v4-import.json"));
  run("migration-marker-failure", blockedJournal);
  run("migration-failure", migration);
  const markerPath = path.join(migration.dataDir, "legacy-v4-import.json");
  const oldMarker = JSON.parse(fs.readFileSync(markerPath));
  oldMarker.outcome = "imported";
  delete oldMarker.retryFiles;
  fs.writeFileSync(markerPath, JSON.stringify(oldMarker));
  run("migration-old-marker", migration);
  const originalLegacySettings = fs.readFileSync(
    path.join(legacy, "settings.json"),
  );
  fs.writeFileSync(
    path.join(legacy, "settings.json"),
    "invalid legacy settings",
  );
  run("migration-source-corrupt", migration);
  fs.writeFileSync(path.join(legacy, "settings.json"), originalLegacySettings);
  fs.rmSync(path.join(migration.dataDir, "download-queue.json"), {
    recursive: true,
    force: true,
  });
  fs.writeFileSync(
    path.join(migration.dataDir, "download-stats.json"),
    JSON.stringify({ totalDownloads: 42 }),
  );
  run("migration-retry", migration);
  const queue = newProfile();
  run("queue-budget", queue);
  run("queue-reload", queue, observations.at(-1).queueCount);
  const normalQueue = newProfile();
  run("queue-normal", normalQueue);
  run("queue-reload", normalQueue, 500);
} finally {
  const body = {
    schemaVersion: 1,
    suite: "long-term-v5-audit",
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    }).stdout.trim(),
    binarySha256: hash(fs.readFileSync(binary)),
    workingTreeDiffSha256: hash(
      spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: REPO_ROOT }).stdout,
    ),
    sourceSha256: Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(artifactRoot, "sources", file))),
      ]),
    ),
    observations,
  };
  const manifest = [];
  function index(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) index(file);
      else if (entry.isFile() && entry.name !== "report.json")
        manifest.push({
          path: path.relative(artifactRoot, file),
          bytes: fs.statSync(file).size,
          sha256: hash(fs.readFileSync(file)),
        });
    }
  }
  index(artifactRoot);
  body.artifacts = manifest;
  fs.writeFileSync(
    path.join(artifactRoot, "report.json"),
    JSON.stringify(
      { ...body, reportSha256: hash(JSON.stringify(body, null, 2)) },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Long-term repair evidence: ${path.join(artifactRoot, "report.json")}`,
  );
  for (const profile of profiles)
    fs.rmSync(profile.profileDir, { recursive: true, force: true });
}
process.exitCode =
  observations.length === 15 &&
  observations.every(
    (entry) => entry.runnerExitCode === 0 && entry.invariantPassed === true,
  )
    ? 0
    : 1;
