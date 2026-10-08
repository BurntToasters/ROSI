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

const relative = path.join(
  "e2e",
  "artifacts",
  "v5-fixes-network",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const artifactRoot = path.join(REPO_ROOT, relative);
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running this suite.",
  );
}
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "e2e/v5-fixes/network/run.mjs",
  "e2e/v5-fixes/network/network-policy.spec.js",
  "e2e/v5-fixes/network/network-policy.failure-modes.md",
  "src-tauri/src/ip_policy.rs",
  "src-tauri/src/validation.rs",
  "src-tauri/src/network_security.rs",
  "docs/NETWORK-POLICY.md",
];
fs.mkdirSync(artifactRoot, { recursive: true });
for (const source of sourceFiles) {
  const from = path.join(REPO_ROOT, source);
  if (!fs.existsSync(from)) continue;
  const destination = path.join(artifactRoot, "sources", source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(from, destination);
}
fs.writeFileSync(
  path.join(artifactRoot, "working-tree.patch"),
  spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: REPO_ROOT }).stdout,
);

const profile = createE2eProfile();
const resultsDirectory = path.join(artifactRoot, "app");
const result = spawnSync(
  process.execPath,
  [
    path.join(REPO_ROOT, "node_modules", ".bin", "wdio"),
    "run",
    "e2e/wdio.conf.js",
  ],
  {
    cwd: REPO_ROOT,
    env: {
      ...profile.env,
      ROSI_E2E_BINARY: binary,
      ROSI_E2E_DOWNLOADS: profile.downloads,
      ROSI_E2E_XDG_DOWNLOADS: profile.xdgDownloads,
      ROSI_E2E_PROFILE: profile.profileDir,
      ROSI_E2E_SPECS: "./v5-fixes/network/network-policy.spec.js",
      ROSI_V5_NETWORK_RESULTS_DIR: resultsDirectory,
    },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
fs.writeFileSync(
  path.join(artifactRoot, "wdio.log"),
  `${result.stdout ?? ""}${result.stderr ?? ""}`,
);

let observations = [];
try {
  observations = JSON.parse(
    fs.readFileSync(path.join(resultsDirectory, "observations.json"), "utf8"),
  );
} catch {}
const body = {
  suite: "v5-fixes-network-policy",
  startedAt: new Date().toISOString(),
  exitStatus: result.status,
  binarySha256: hash(fs.readFileSync(binary)),
  workingTreeDiffSha256: hash(
    fs.readFileSync(path.join(artifactRoot, "working-tree.patch")),
  ),
  sources: sourceFiles
    .filter((source) =>
      fs.existsSync(path.join(artifactRoot, "sources", source)),
    )
    .map((source) => ({
      path: source,
      sha256: hash(fs.readFileSync(path.join(artifactRoot, "sources", source))),
    })),
  observations,
};
const passed =
  result.status === 0 &&
  observations.length === 3 &&
  observations.every((entry) => entry.invariantPassed === true);
const report = {
  ...body,
  passed,
  reportSha256: hash(JSON.stringify(body, null, 2)),
};
fs.writeFileSync(
  path.join(artifactRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `V5 network policy evidence: ${path.join(artifactRoot, "report.json")}`,
);
if (!passed) {
  process.exitCode = 1;
}
