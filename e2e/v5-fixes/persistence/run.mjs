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

const artifactRoot = path.resolve(
  REPO_ROOT,
  process.env.ROSI_PERSISTENCE_ARTIFACT_ROOT ||
    `e2e/artifacts/v5-fixes-persistence/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);
const ownedRoot = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-persistence",
);
if (!artifactRoot.startsWith(`${ownedRoot}${path.sep}`)) {
  throw new Error(
    "Persistence artifacts must use a new child directory under e2e/artifacts/v5-fixes-persistence.",
  );
}
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
fs.mkdirSync(artifactRoot, { recursive: true });

const sha256 = (file) => {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
};
const hashProfile = (dataDir) =>
  Object.fromEntries(
    fs
      .readdirSync(dataDir)
      .sort()
      .map((name) => [name, sha256(path.join(dataDir, name))]),
  );

const itemA = "https://persistence.invalid/a.mp4";
const legacyQueue = [
  { id: "legacy-a", url: itemA, status: "pending", addedAt: 1 },
];
const seeds = {
  "stats-damaged": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-stats.json"),
      '{"totalDownloads":',
    ),
  "stats-unreadable": (dir) =>
    fs.mkdirSync(path.join(dir, "download-stats.json")),
  "stats-newer-schema": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-stats.json"),
      JSON.stringify({ schemaVersion: 2, totalDownloads: 3 }),
    ),
  "stats-legacy-object": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-stats.json"),
      JSON.stringify({ totalDownloads: 7, successfulDownloads: 7 }),
    ),
  "activity-damaged": (dir) =>
    fs.writeFileSync(path.join(dir, "download-activity.json"), "[{"),
  "activity-unreadable": (dir) =>
    fs.mkdirSync(path.join(dir, "download-activity.json")),
  "activity-newer-schema": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-activity.json"),
      JSON.stringify({ schemaVersion: 2, items: [] }),
    ),
  "activity-legacy-array": (dir, profile) =>
    fs.writeFileSync(
      path.join(dir, "download-activity.json"),
      JSON.stringify([
        {
          id: "legacy-activity",
          owner: "manual",
          outcome: "success",
          statusMessage: "Download complete.",
          url: "https://persistence.invalid/done.mp4",
          request: {
            url: "https://persistence.invalid/done.mp4",
            outputPath: profile.downloads,
          },
          filename: "done.mp4",
          sizeBytes: 1000,
          format: "mp4",
          startedAt: 1000,
          completedAt: 2000,
        },
      ]),
    ),
  "queue-legacy-array": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-queue.json"),
      JSON.stringify(legacyQueue),
    ),
  "queue-backup-previous": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-queue.json"),
      JSON.stringify(legacyQueue),
    ),
  "queue-damaged-primary": (dir) => {
    fs.writeFileSync(path.join(dir, "download-queue.json"), '[{"id":');
    fs.writeFileSync(
      path.join(dir, "download-queue.backup.json"),
      JSON.stringify(legacyQueue),
    );
  },
  "queue-newer-schema": (dir) =>
    fs.writeFileSync(
      path.join(dir, "download-queue.json"),
      JSON.stringify({ schemaVersion: 2, items: legacyQueue }),
    ),
  "settings-unreadable": (dir) => {
    fs.rmSync(path.join(dir, "settings.json"));
    fs.mkdirSync(path.join(dir, "settings.json"));
  },
};

const observations = [];
for (const mode of Object.keys(seeds)) {
  const directory = path.join(artifactRoot, mode);
  fs.mkdirSync(directory, { recursive: true });
  const profile = createE2eProfile();
  seeds[mode](profile.dataDir, profile);
  const before = hashProfile(profile.dataDir);
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
        ROSI_E2E_SPECS: "./v5-fixes/persistence/persistence-acceptance.spec.js",
        ROSI_PERSISTENCE_MODE: mode,
        ROSI_PERSISTENCE_ARTIFACTS: directory,
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
  const observationPath = path.join(directory, "observation.json");
  const observation = fs.existsSync(observationPath)
    ? JSON.parse(fs.readFileSync(observationPath, "utf8"))
    : {
        mode,
        invariantPassed: false,
        error: result.error?.message || "No observation produced",
      };
  observations.push({
    ...observation,
    runnerExitCode: result.status,
    dataBefore: before,
    dataAfter: hashProfile(profile.dataDir),
  });
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      mode,
      invariantPassed: observation.invariantPassed,
      exitCode: result.status,
    }),
  );
}

const report = {
  finishedAt: new Date().toISOString(),
  allPassed: observations.every(
    (entry) => entry.invariantPassed === true && entry.runnerExitCode === 0,
  ),
  observations,
};
const reportText = `${JSON.stringify(report, null, 2)}\n`;
fs.writeFileSync(path.join(artifactRoot, "report.json"), reportText);
fs.writeFileSync(
  path.join(artifactRoot, "report.sha256"),
  `${crypto.createHash("sha256").update(reportText).digest("hex")}  report.json\n`,
);
console.log(
  `Report: ${path.relative(REPO_ROOT, path.join(artifactRoot, "report.json"))}`,
);
if (!report.allPassed) process.exitCode = 1;
