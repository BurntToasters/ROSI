import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  RELEASE_LICENSE_SCRIPTS,
  runReleaseLicenses,
} from "./release-licenses.js";

const require = createRequire(import.meta.url);
const { npmInvocation } = require("./npm-cli.cjs");

test("every release generates strict Cargo license notices", () => {
  assert.deepEqual(RELEASE_LICENSE_SCRIPTS, [
    "licenses:npm",
    "licenses:cargo:strict",
    "licenses:bundled",
  ]);
});

test("Windows npm scripts run through the active npm CLI without a shell", () => {
  assert.deepEqual(
    npmInvocation({
      env: { npm_execpath: "C:\\npm\\npm-cli.js" },
      platform: "win32",
      execPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      prefixArgs: ["C:\\npm\\npm-cli.js"],
    },
  );

  const calls = [];
  const status = runReleaseLicenses({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    env: { npm_execpath: "C:\\npm\\npm-cli.js" },
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    cwd: "C:\\repo",
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.deepEqual(
    calls.map((call) => call.args),
    RELEASE_LICENSE_SCRIPTS.map((script) => [
      "C:\\npm\\npm-cli.js",
      "run",
      script,
    ]),
  );
});

test("Windows npm invocation fails closed without the active npm CLI", () => {
  assert.throws(
    () => npmInvocation({ env: {}, platform: "win32" }),
    /run this command through npm/,
  );
});
