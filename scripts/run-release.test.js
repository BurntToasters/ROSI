import test from "node:test";
import assert from "node:assert/strict";
import { main, parseReleaseArgs } from "./run-release.js";

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
  main(["mac", "--skip-check"], (...args) => calls.push(args));

  assert.deepEqual(calls.at(-1), [
    "release:mac:continue",
    [],
    { FORCE_UPLOAD: "1" },
  ]);
  assert.ok(calls.slice(0, -1).every(([, , envOverrides]) => !envOverrides));
});

test("main always skips local e2e while keeping the other release gates", () => {
  const calls = [];
  main(["win"], (...args) => calls.push(args));

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
