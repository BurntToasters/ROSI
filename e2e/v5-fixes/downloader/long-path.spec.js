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

// Acceptance for downloader Wave 1 A6: a download whose final path is longer
// than MAX_PATH must install. The download folder is about 120 characters, and
// the title is 150 bytes, so the staged and final paths both pass 260 units.
// The runner (run.mjs) supplies ROSI_V5_FIX_ARTIFACTS and ROSI_E2E_DOWNLOADS.
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
const downloads = requiredEnv("ROSI_E2E_DOWNLOADS");
const report = { suite: "long-path", checks: [] };
const writeReport = () =>
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
const record = (name, details) => {
  report.checks.push({ name, ...details });
  writeReport();
};

// Win32 MAX_PATH is 260 units including the terminator, so a path of 260 or
// more characters is over the limit for a plain call.
const MAX_PATH_UNITS = 260;
const FOLDER_TARGET = 120;
const TITLE_BYTES = 150;

// A 150-byte ASCII title. The page's <title> becomes the yt-dlp title, which
// the output template caps at 150 bytes, so the name carries the full title.
const title = Array.from(
  { length: TITLE_BYTES },
  (_, index) => "abcdefghijklmnopqrstuvwxyz"[index % 26],
).join("");
const clipBytes = deterministicBytes(256 * 1024, "long-path:clip");
const page = `<!doctype html><html><head><title>${title}</title></head><body><video src="/clip.mp4"></video></body></html>\n`;

describe("V5 fix A6: long paths on Windows", () => {
  it("installs a download whose final and staged paths exceed MAX_PATH", async () => {
    await waitForAppReady();
    const server = await startMediaServer({
      "/page.html": {
        body: Buffer.from(page),
        contentType: "text/html; charset=utf-8",
      },
      "/clip.mp4": { body: clipBytes },
    });
    try {
      const padded = "rosi-long-folder".padEnd(
        Math.max(1, FOLDER_TARGET - downloads.length - 1),
        "x",
      );
      const folder = path.join(downloads, padded);
      fs.mkdirSync(folder);
      const folderLength = folder.length;
      const url = `${server.baseUrl}/page.html`;
      const response = await api("downloadVideo", {
        url,
        outputPath: folder,
        convertEnabled: false,
        hookBrowser: false,
        gpuAcceleration: false,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      let entry;
      await browser.waitUntil(
        async () => {
          entry = (await api("getDownloadActivity")).data.find(
            (item) => item.url === url,
          );
          return Boolean(entry);
        },
        {
          timeout: 120_000,
          interval: 250,
          timeoutMsg: "long-path download did not finish",
        },
      );
      // A failed download records its error here: the runner's log and this
      // field show whether yt-dlp or ROSI's publication step failed.
      const outcome = entry.outcome;
      const error = entry.error ?? entry.statusMessage ?? null;
      record("download finishes with a success outcome", {
        invariantPassed: outcome === "success",
        outcome,
        error,
      });
      const finalPath = entry.outputPath ?? "";
      record("final path is longer than MAX_PATH", {
        invariantPassed:
          process.platform !== "win32" || finalPath.length >= MAX_PATH_UNITS,
        folderLength,
        finalPathLength: finalPath.length,
        maxPathUnits: MAX_PATH_UNITS,
      });
      const installed =
        Boolean(finalPath) &&
        fs.existsSync(finalPath) &&
        sha256(fs.readFileSync(finalPath)) === sha256(clipBytes);
      record("final file exists with the delivered bytes", {
        invariantPassed: installed,
        finalPath,
        clipSha256: sha256(clipBytes),
      });
      const leftovers = fs
        .readdirSync(folder)
        .filter((name) => name.startsWith(".rosi-"));
      record("no staging leftovers after publication", {
        invariantPassed: leftovers.length === 0,
        leftovers,
      });
    } finally {
      await server.close();
    }
    assert.ok(
      report.checks.every((check) => check.invariantPassed === true),
      "long-path invariant failed; see report.json",
    );
  });
});
