import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

// R2 in failure-modes.md. Windows only: the shared launcher directory under
// the local data folder (ROSI_E2E_DATA_DIR/local in E2E builds). Other
// platforms keep one script directory per operation and record a note only.
const DATA_DIR = process.env.ROSI_E2E_DATA_DIR;
const BINARY = process.env.ROSI_E2E_BINARY;
const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const PREFIX = "rosi-media-tools-";
const LINK_ERROR = "Could not hard-link the media-tool launcher";
const resultsDirectory = process.env.ROSI_V5_MEDIA_DISPATCH_RESULTS_DIR;
const observations = [];

function record(name, details) {
  observations.push({ name, ...details });
  if (!resultsDirectory) return;
  fs.mkdirSync(resultsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDirectory, "launcher-reuse.observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}

// The gate reads skip records from this pass's results file and fails the area
// unless e2e/suites.json allows the skip on this platform.
function recordGateSkip(name, reason) {
  const resultsPath = process.env.ROSI_E2E_RESULTS;
  if (!resultsPath) return;
  let records = [];
  if (fs.existsSync(resultsPath)) {
    const parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    if (Array.isArray(parsed)) records = parsed;
  }
  records.push({ name, skipped: true, reason });
  fs.writeFileSync(
    resultsPath,
    `${JSON.stringify(records, null, 2)}
`,
  );
}

function launcherDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
    .map((entry) => entry.name)
    .sort();
}

function readLog() {
  const file = path.join(DATA_DIR, "logs", "rosi.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("R2 media-tool launcher location and reuse", () => {
  before(async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    await waitForAppReady();
  });

  it("shares one local launcher directory across fetches with equal settings", async () => {
    if (process.platform !== "win32") {
      const reason =
        "The shared launcher directory exists only on Windows. Other platforms keep one script directory per operation.";
      record("non-windows-not-applicable", { platform: process.platform });
      recordGateSkip("launcher-reuse", reason);
      return;
    }
    assert.ok(BINARY && fs.existsSync(BINARY), "ROSI_E2E_BINARY is not set");
    assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
    const localRoot = path.join(DATA_DIR, "local", "media-tools");
    const roamingRoot = path.join(DATA_DIR, "media-tools");

    // Earlier specs may have made directories for other configs. The first
    // fetch may add one; later fetches with the same settings must add none.
    const before = launcherDirectories(localRoot);
    await api("getFormats", `${MEDIA}/clip-one.mp4?launcher-reuse=1`);
    const afterFirst = launcherDirectories(localRoot);
    await api("getFormats", `${MEDIA}/clip-one.mp4?launcher-reuse=2`);
    await api("getFormats", `${MEDIA}/clip-one.mp4?launcher-reuse=3`);
    const afterThird = launcherDirectories(localRoot);

    assert.ok(afterFirst.length - before.length <= 1, "first fetch added many");
    assert.ok(afterFirst.length >= 1, "no launcher directory was created");
    assert.deepEqual(afterThird, afterFirst, "extra launcher directories");
    assert.deepEqual(
      launcherDirectories(roamingRoot),
      [],
      "launcher created in the roaming data folder",
    );

    // One directory per distinct config: no two share launcher.json content.
    const configs = afterThird.map((name) =>
      fs.readFileSync(path.join(localRoot, name, "launcher.json"), "utf8"),
    );
    assert.equal(new Set(configs).size, configs.length, "duplicate configs");

    const binary = fs.statSync(BINARY, { bigint: true });
    const loggedLinkError = readLog().includes(LINK_ERROR);
    const hardLinked = afterThird.every((name) => {
      const alias = path.join(localRoot, name, "ffmpeg.exe");
      assert.ok(fs.existsSync(alias), `ffmpeg alias is missing in ${name}`);
      const linked = fs.statSync(alias, { bigint: true });
      return linked.ino === binary.ino && linked.dev === binary.dev;
    });
    assert.ok(
      hardLinked || loggedLinkError,
      "alias is neither a hard link nor a logged copy fallback",
    );
    record("shared-launcher-directory", {
      directories: afterThird,
      hardLinked,
      loggedLinkError,
      invariantPassed: true,
    });
  });
});
