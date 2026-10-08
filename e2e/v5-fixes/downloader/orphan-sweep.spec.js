import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { waitForAppReady } from "../../helpers/app-bridge.js";

// Acceptance for downloader Finding 5: stale ROSI staging entries left by a
// crash are swept at startup. The runner (run.mjs) plants the fixtures before
// WebDriver launches the app, because the sweep runs once at startup. The
// manifest lists what was planted.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set by e2e/v5-fixes/downloader/run.mjs; run the runner, not this spec alone`,
    );
  }
  return value;
}
const directory = requiredEnv("ROSI_V5_FIX_ARTIFACTS");
const manifest = JSON.parse(
  fs.readFileSync(requiredEnv("ROSI_V5_FIX_ORPHAN_MANIFEST"), "utf8"),
);
const downloads = manifest.downloads;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const base = (file) => path.basename(file);

describe("V5 fix: orphaned staging sweep", () => {
  it("sweeps stale entries and never follows symlinks", async () => {
    await waitForAppReady();
    const report = { finding: 5, checks: [] };
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      fs.readdirSync(downloads).includes(base(manifest.staleDir))
    ) {
      await browser.pause(250);
    }
    const names = fs.readdirSync(downloads);
    const recovered = names.filter(
      (name) => name.startsWith("clip") && name.endsWith(".mp4"),
    );
    const recoveredStreams = Object.entries(manifest.unmergedStreams).map(
      ([name, text]) => {
        const extension = path.extname(name);
        const stem = name.slice(0, -extension.length);
        const recoveredName = `${stem} (recovered)${extension}`;
        const target = path.join(downloads, recoveredName);
        return {
          recoveredName,
          identical:
            fs.existsSync(target) &&
            sha(fs.readFileSync(target)) === sha(Buffer.from(text)),
        };
      },
    );
    const recoveredBytes = recovered.map((name) =>
      fs.readFileSync(path.join(downloads, name)),
    );
    const staleMedia = Buffer.from(manifest.staleMediaText);
    const outsideBytes = Buffer.from(manifest.outsideText);
    report.checks.push(
      {
        name: "stale staging dir removed",
        invariantPassed: !names.includes(base(manifest.staleDir)),
      },
      {
        name: "stale media recovered with identical bytes",
        invariantPassed: recoveredBytes.some(
          (bytes) => sha(bytes) === sha(staleMedia),
        ),
        recovered,
      },
      {
        name: "yt-dlp intermediates discarded, not recovered",
        // Only the complete clip is recovered; no stream, temp, fragment or
        // control file appears in the download folder under any name.
        invariantPassed:
          recovered.length === 1 &&
          recovered[0] === "clip (recovered).mp4" &&
          manifest.intermediateNames.every((name) => !names.includes(name)),
        intermediateNames: manifest.intermediateNames,
        recovered,
      },
      {
        name: "unmerged format streams recovered, never deleted",
        invariantPassed:
          recoveredStreams.every((stream) => stream.identical) &&
          !names.includes(base(manifest.unmergedDir)),
        recoveredStreams,
      },
      {
        name: "recorded download folder swept",
        invariantPassed: !fs.existsSync(manifest.recordedStaleDir),
      },
      {
        name: "stale empty probe file removed",
        invariantPassed: !names.includes(base(manifest.probeFile)),
      },
      {
        name: "stale partial, empty dir and path file removed",
        invariantPassed:
          !names.includes(base(manifest.partName)) &&
          !names.includes(base(manifest.pathFile)),
      },
      {
        name: "fresh staging dir left alone",
        invariantPassed: names.includes(base(manifest.freshDir)),
      },
      {
        name: "symlink left in place and target untouched",
        invariantPassed:
          fs.lstatSync(manifest.symlink).isSymbolicLink() &&
          sha(fs.readFileSync(manifest.outsideFile)) === sha(outsideBytes),
      },
    );
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.ok(
      report.checks.every((check) => check.invariantPassed),
      JSON.stringify(report),
    );
  });
});
