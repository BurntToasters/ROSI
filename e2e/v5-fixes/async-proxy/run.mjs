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

const relativeArtifactRoot = path.join(
  process.env.ROSI_E2E_ARTIFACT_DIR ??
    path.join(REPO_ROOT, "e2e", "artifacts", "v5-fixes-async-proxy"),
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const artifactRoot = path.isAbsolute(relativeArtifactRoot)
  ? relativeArtifactRoot
  : path.join(REPO_ROOT, relativeArtifactRoot);
const binary = process.env.ROSI_E2E_BINARY ?? e2eBinaryPath();
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
  "e2e/v5-fixes/async-proxy/run.mjs",
  "e2e/v5-fixes/async-proxy/async-proxy.spec.js",
  "e2e/v5-fixes/async-proxy/failure-modes.md",
  "src-tauri/src/network_security.rs",
  "src-tauri/src/network_security_async.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
fs.mkdirSync(artifactRoot, { recursive: true });
for (const source of sourceFiles) {
  const from = path.join(REPO_ROOT, source);
  if (!fs.existsSync(from)) continue;
  const destination = path.join(artifactRoot, "sources", source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(from, destination);
}
const patch = spawnSync("git", ["diff", "--binary", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "buffer",
});
if (patch.error || patch.status !== 0) {
  throw new Error(
    `Could not capture the working-tree diff: ${patch.error?.message ?? patch.stderr?.toString() ?? patch.status}`,
  );
}
fs.writeFileSync(path.join(artifactRoot, "working-tree.patch"), patch.stdout);

const profile = createE2eProfile();
const resultsDirectory = path.join(artifactRoot, "app");
const result = spawnSync(
  process.execPath,
  [
    path.join(REPO_ROOT, "node_modules", "@wdio", "cli", "bin", "wdio.js"),
    "run",
    "e2e/wdio.conf.js",
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
      ROSI_E2E_SPECS: "./v5-fixes/async-proxy/async-proxy.spec.js",
      ROSI_V5_ASYNC_PROXY_RESULTS_DIR: resultsDirectory,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const launchError = result.error
  ? {
      message: result.error.message,
      code: result.error.code ?? null,
    }
  : null;
fs.writeFileSync(
  path.join(artifactRoot, "wdio.log"),
  `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n[WDIO launcher error]\n${result.error.stack ?? result.error.message}\n` : ""}`,
);

let observations = [];
try {
  observations = JSON.parse(
    fs.readFileSync(path.join(resultsDirectory, "observations.json"), "utf8"),
  );
} catch {}
const body = {
  suite: "v5-fixes-async-proxy",
  startedAt: new Date().toISOString(),
  exitStatus: result.status,
  signal: result.signal ?? null,
  launchError,
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
  observations.length === 6 &&
  observations.every((observation) => observation.invariantPassed === true);
const report = {
  ...body,
  passed,
  reportSha256: hash(Buffer.from(JSON.stringify(body, null, 2))),
};
fs.writeFileSync(
  path.join(artifactRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `V5 async proxy evidence: ${path.join(artifactRoot, "report.json")}`,
);
if (!passed) process.exitCode = 1;
