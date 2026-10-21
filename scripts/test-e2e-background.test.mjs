// Failure modes: scripts/test-e2e-background.failure-modes.md
import assert from "node:assert/strict";
import test from "node:test";
import { e2eBackgroundValue } from "./test-e2e.js";

test("local macOS runs default to background mode (modes 1, 4)", () => {
  assert.equal(e2eBackgroundValue({ env: {}, platform: "darwin" }), "1");
});

test("CI keeps the foreground behavior (mode 1)", () => {
  assert.equal(
    e2eBackgroundValue({ env: { CI: "true" }, platform: "darwin" }),
    null,
  );
  assert.equal(
    e2eBackgroundValue({ env: { CI: "1" }, platform: "darwin" }),
    null,
  );
});

test("empty, false, or 0 CI values are not CI (modes 5, 6)", () => {
  for (const CI of ["", "false", "0"]) {
    assert.equal(e2eBackgroundValue({ env: { CI }, platform: "darwin" }), "1");
  }
});

test("ROSI_E2E_FOREGROUND=1 opts out (mode 2)", () => {
  assert.equal(
    e2eBackgroundValue({
      env: { ROSI_E2E_FOREGROUND: "1" },
      platform: "darwin",
    }),
    null,
  );
});

test("an explicit ROSI_E2E_BACKGROUND wins (mode 3)", () => {
  assert.equal(
    e2eBackgroundValue({
      env: { ROSI_E2E_BACKGROUND: "0" },
      platform: "darwin",
    }),
    "0",
  );
  assert.equal(
    e2eBackgroundValue({
      env: { ROSI_E2E_BACKGROUND: "1", CI: "true" },
      platform: "darwin",
    }),
    "1",
  );
});

test("Windows and Linux never get background mode by default (mode 4)", () => {
  for (const platform of ["win32", "linux"]) {
    assert.equal(e2eBackgroundValue({ env: {}, platform }), null);
  }
});
