import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReleaseRunProtection,
  main,
  parseReleaseArgs,
} from "./run-release.js";

const noProtectionCheck = { assertProtection: () => {} };

function protectedMainApi(calls) {
  return (method, endpoint) => {
    calls.push([method, endpoint]);
    return {
      required_status_checks: {
        strict: true,
        checks: [{ context: "ci-gate", app_id: 15368 }],
      },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    };
  };
}

test("a stable release checks main's branch protection before building", () => {
  const calls = [];
  assertReleaseRunProtection({
    api: protectedMainApi(calls),
    version: "5.1.0",
    env: {},
  });
  assert.deepEqual(calls, [
    ["GET", "/repos/BurntToasters/ROSI/branches/main/protection"],
  ]);
});

test("a beta release never queries branch protection", () => {
  const api = () => {
    throw new Error("beta release must not query branch protection");
  };
  assert.doesNotThrow(() =>
    assertReleaseRunProtection({ api, version: "5.1.0-beta.1", env: {} }),
  );
});

test("a release does not start when main's protection is too weak", () => {
  const calls = [];
  const runner = (...args) => calls.push(args);
  const api = () => ({
    required_status_checks: { strict: true, checks: [] },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  });
  assert.throws(
    () =>
      main(["win"], runner, {
        assertProtection: () =>
          assertReleaseRunProtection({ api, version: "5.1.0", env: {} }),
      }),
    /does not require ci-gate/,
  );
  assert.deepEqual(calls, []);
});

test("the protection check runs before any release step", () => {
  const calls = [];
  main(["mac"], (...args) => calls.push(["runner", ...args]), {
    assertProtection: () => calls.push(["protection"]),
  });
  assert.deepEqual(calls[0], ["protection"]);
  assert.equal(calls[1][0], "runner");
});

test("parseReleaseArgs accepts platform and optional release flags", () => {
  assert.deepEqual(parseReleaseArgs(["win"]), {
    platform: "win",
    skipCheck: false,
    continueScript: "release:win:continue",
  });
  assert.deepEqual(parseReleaseArgs(["mac", "--skip-e2e"]), {
    platform: "mac",
    skipCheck: false,
    continueScript: "release:mac:continue",
  });
  assert.deepEqual(
    parseReleaseArgs(["--skip-check", "--skip-e2e", "linux:x64"]),
    {
      platform: "linux:x64",
      skipCheck: true,
      continueScript: "release:linux:x64:continue",
    },
  );
  assert.deepEqual(parseReleaseArgs(["linux"]), {
    platform: "linux",
    skipCheck: false,
    continueScript: "release:linux:continue",
  });
  assert.deepEqual(parseReleaseArgs(["linux:arm64", "--skip-check"]), {
    platform: "linux:arm64",
    skipCheck: true,
    continueScript: "release:linux:arm64:continue",
  });
});

test("main scopes --skip-check to the release continuation", () => {
  const calls = [];
  main(
    ["mac", "--skip-check"],
    (...args) => calls.push(args),
    noProtectionCheck,
  );

  assert.deepEqual(calls.at(-1), [
    "release:mac:continue",
    [],
    { FORCE_UPLOAD: "1" },
  ]);
  assert.ok(calls.slice(0, -1).every(([, , envOverrides]) => !envOverrides));
});

test("main always skips local e2e while keeping the other release gates", () => {
  const calls = [];
  main(["win"], (...args) => calls.push(args), noProtectionCheck);

  assert.deepEqual(calls, [
    ["prerelease:prepare"],
    ["workspace:bootstrap"],
    ["test:all", ["--", "--require-clean-proof", "--skip-e2e"]],
    ["dist:clean-release-artifacts"],
    ["release:win:continue", [], {}],
  ]);
});

test("parseReleaseArgs rejects unknown flags and platforms", () => {
  assert.throws(() => parseReleaseArgs(["win", "--skip-tests"]), /Unknown/);
  assert.throws(() => parseReleaseArgs([]), /Usage/);
  assert.throws(() => parseReleaseArgs(["bsd"]), /Usage/);
  assert.throws(() => parseReleaseArgs(["win", "mac"]), /Usage/);
});
