import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { waitForAppReady } from "../../helpers/app-bridge.js";

// Acceptance for downloader Finding 4: the panic hook must not break logging,
// and the log must exist once the app starts. A panic cannot be triggered
// safely through WebDriver (panic = "abort"), so this checks the log trail.
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
const logPath = path.join(requiredEnv("ROSI_E2E_DATA_DIR"), "logs", "rosi.log");

describe("V5 fix: panic hook keeps a log trail", () => {
  it("writes startup lines to the rosi log and keeps the file readable", async () => {
    await waitForAppReady();
    const text = fs.readFileSync(logPath, "utf8");
    const report = {
      finding: 4,
      checks: [
        {
          name: "startup line is logged",
          invariantPassed: text.includes("starting ("),
        },
        {
          name: "log lines are single-line",
          invariantPassed: text
            .split("\n")
            .filter(Boolean)
            .every((line) => /^\d{4}-\d{2}-\d{2}T/.test(line)),
        },
      ],
    };
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    assert.ok(report.checks.every((check) => check.invariantPassed));
  });
});
