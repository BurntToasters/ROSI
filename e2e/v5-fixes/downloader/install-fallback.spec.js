import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import {
  deterministicBytes,
  sha256,
  startMediaServer,
} from "../../helpers/media-server.js";

// Acceptance for downloader Finding 1: installs must succeed on filesystems
// that reject renameat2/renamex_np flags. The runner (run.mjs) mounts an exFAT
// image under the profile home and sets ROSI_V5_FIX_EXFAT_MOUNT; this spec
// only asserts on it.
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
const mount = requiredEnv("ROSI_V5_FIX_EXFAT_MOUNT");
const report = { finding: 1, platform: process.platform, checks: [] };
const record = (name, details) => {
  report.checks.push({ name, ...details });
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
};

describe("V5 fix: no-replace install fallback on exFAT", () => {
  it("completes a download and preserves a same-named existing file", async () => {
    await waitForAppReady();
    const mediaBytes = deterministicBytes(256 * 1024, 7);
    const server = await startMediaServer({
      "/fallback.mp4": { body: mediaBytes },
    });
    try {
      const existingName = "fallback.mp4";
      const existingBytes = Buffer.from("USER DATA MUST SURVIVE");
      fs.writeFileSync(path.join(mount, existingName), existingBytes);
      const response = await api("downloadVideo", {
        url: `${server.baseUrl}/fallback.mp4`,
        outputPath: mount,
        convertEnabled: false,
        hookBrowser: false,
        gpuAcceleration: false,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      await browser.waitUntil(
        async () => {
          const activity = await api("getDownloadActivity");
          return activity.data.some((item) => item.outcome === "success");
        },
        {
          timeout: 120_000,
          interval: 250,
          timeoutMsg: "Download did not finish",
        },
      );
      const preserved = fs.readFileSync(path.join(mount, existingName));
      record("existing same-named file is untouched", {
        invariantPassed: sha256(preserved) === sha256(existingBytes),
        existingSha256: sha256(existingBytes),
        afterSha256: sha256(preserved),
      });
      const installed = fs
        .readdirSync(mount)
        .filter((name) => name.endsWith(".mp4") && name !== existingName);
      const installedBytes = installed.map((name) =>
        fs.readFileSync(path.join(mount, name)),
      );
      record("download installed under a new name", {
        invariantPassed: installedBytes.some(
          (bytes) => sha256(bytes) === sha256(mediaBytes),
        ),
        installed,
        mediaSha256: sha256(mediaBytes),
        installedSha256: installedBytes.map(sha256),
      });
      record("no placeholder left behind", {
        invariantPassed: !fs
          .readdirSync(mount)
          .some((name) => name.startsWith(".rosi-")),
        entries: fs.readdirSync(mount),
      });
    } finally {
      await server.close();
    }
    assert.ok(
      report.checks.every((check) => check.invariantPassed !== false),
      "V5 fallback invariant failed; see report.json",
    );
  });
});
