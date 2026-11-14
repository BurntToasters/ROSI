// Failure modes: scripts/test-e2e-background.failure-modes.md
import assert from "node:assert/strict";
import test from "node:test";
import { e2eBackgroundValue } from "./test-e2e.js";

const BACKGROUND_PLATFORMS = ["darwin", "win32"];

test("local macOS and Windows runs default to background mode (modes 1, 4, 17)", () => {
  for (const platform of BACKGROUND_PLATFORMS) {
    assert.equal(e2eBackgroundValue({ env: {}, platform }), "1");
  }
});

test("CI keeps the foreground behavior on macOS and Windows (mode 1)", () => {
  for (const platform of BACKGROUND_PLATFORMS) {
    assert.equal(e2eBackgroundValue({ env: { CI: "true" }, platform }), null);
    assert.equal(e2eBackgroundValue({ env: { CI: "1" }, platform }), null);
  }
});

test("empty, false, or 0 CI values are not CI (modes 5, 6)", () => {
  for (const platform of BACKGROUND_PLATFORMS) {
    for (const CI of ["", "false", "0"]) {
      assert.equal(e2eBackgroundValue({ env: { CI }, platform }), "1");
    }
  }
});

test("ROSI_E2E_FOREGROUND=1 opts out on macOS and Windows (mode 2, 29)", () => {
  for (const platform of BACKGROUND_PLATFORMS) {
    assert.equal(
      e2eBackgroundValue({
        env: { ROSI_E2E_FOREGROUND: "1" },
        platform,
      }),
      null,
    );
  }
});

test("an explicit ROSI_E2E_BACKGROUND wins on macOS and Windows (mode 3)", () => {
  for (const platform of BACKGROUND_PLATFORMS) {
    assert.equal(
      e2eBackgroundValue({
        env: { ROSI_E2E_BACKGROUND: "0" },
        platform,
      }),
      "0",
    );
    assert.equal(
      e2eBackgroundValue({
        env: { ROSI_E2E_BACKGROUND: "1", CI: "true" },
        platform,
      }),
      "1",
    );
  }
});

test("Linux gets no default background mode (mode 4)", () => {
  assert.equal(e2eBackgroundValue({ env: {}, platform: "linux" }), null);
  assert.equal(
    e2eBackgroundValue({
      env: { ROSI_E2E_BACKGROUND: "1" },
      platform: "linux",
    }),
    "1",
  );
});
