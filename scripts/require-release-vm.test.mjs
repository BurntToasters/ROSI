// Acceptance for scripts/require-release-vm.cjs (failure modes in
// scripts/require-release-vm.failure-modes.md). Runs the real script as a
// child process with a temporary HOME, so no real marker file is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "require-release-vm.cjs");
const PACKAGE_JSON = path.join(here, "..", "package.json");
const GUARDED_SCRIPTS = ["b", "r", "release:finalize"];

function runGuard({ home, releaseVm, lifecycle } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ROSI_RELEASE_VM;
  delete env.npm_lifecycle_event;
  if (releaseVm !== undefined) env.ROSI_RELEASE_VM = releaseVm;
  if (lifecycle !== undefined) env.npm_lifecycle_event = lifecycle;
  return spawnSync(process.execPath, [GUARD], { encoding: "utf8", env });
}

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-vm-guard-"));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("F1: a developer machine with no opt-in is refused with a clear message", () => {
  withHome((home) => {
    const result = runGuard({ home });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to run/);
    assert.match(result.stderr, /ROSI_RELEASE_VM=1/);
    assert.match(result.stderr, /\.rosi-release-vm/);
    assert.match(result.stderr, /git reset --hard/);
  });
});

test("F2: ROSI_RELEASE_VM=1 allows the script", () => {
  withHome((home) => {
    const result = runGuard({ home, releaseVm: "1" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("F3: any ROSI_RELEASE_VM value other than 1 is refused", () => {
  withHome((home) => {
    for (const value of ["0", "true", "yes", ""]) {
      const result = runGuard({ home, releaseVm: value });
      assert.notEqual(
        result.status,
        0,
        `ROSI_RELEASE_VM=${JSON.stringify(value)}`,
      );
    }
  });
});

test("F4: the marker file in the home directory allows the script", () => {
  withHome((home) => {
    fs.writeFileSync(path.join(home, ".rosi-release-vm"), "");
    const result = runGuard({ home });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("F5: a home directory without the marker is refused", () => {
  withHome((home) => {
    fs.writeFileSync(path.join(home, ".gitconfig"), "");
    assert.notEqual(runGuard({ home }).status, 0);
  });
});

test("F6: near-miss marker names are refused", () => {
  withHome((home) => {
    for (const name of [
      "rosi-release-vm",
      ".rosi-release-vm.txt",
      ".rosi-release",
    ]) {
      fs.writeFileSync(path.join(home, name), "");
      assert.notEqual(runGuard({ home }).status, 0, name);
      fs.rmSync(path.join(home, name));
    }
  });
});

test("F7: a marker directory counts as existing", () => {
  withHome((home) => {
    fs.mkdirSync(path.join(home, ".rosi-release-vm"));
    assert.equal(runGuard({ home }).status, 0);
  });
});

test("F9: the refusal names the npm script that was run", () => {
  withHome((home) => {
    const result = runGuard({ home, lifecycle: "release:finalize" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release:finalize/);
  });
});

test("F10: a refusal exits nonzero so && stops the chain", () => {
  withHome((home) => {
    const result = runGuard({ home });
    assert.equal(result.status, 1);
  });
});

test("F8: b, r and release:finalize start with the guard in package.json", () => {
  const scripts = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).scripts;
  for (const name of GUARDED_SCRIPTS) {
    assert.match(
      scripts[name],
      /^node scripts\/require-release-vm\.cjs && /,
      `${name} must start with the release VM guard`,
    );
  }
});
