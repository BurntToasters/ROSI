"use strict";

/**
 * Guard for npm scripts that run `git reset --hard` and `git clean -fd`
 * (`b`, `r`, `release:finalize`). Those commands delete uncommitted work, so
 * they run only on release VMs. A VM opts in with ROSI_RELEASE_VM=1 or with
 * the marker file ~/.rosi-release-vm. Failure modes:
 * scripts/require-release-vm.failure-modes.md.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER_NAME = ".rosi-release-vm";

/** @returns {boolean} true when this host is a release VM */
function isReleaseVm({
  env = process.env,
  homedir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  return env.ROSI_RELEASE_VM === "1" || exists(path.join(homedir, MARKER_NAME));
}

function main() {
  if (isReleaseVm()) return 0;
  const script = process.env.npm_lifecycle_event || "this script";
  console.error(
    [
      `[release-vm] Refusing to run "${script}" on this machine.`,
      "It runs git reset --hard and git clean -fd, which delete uncommitted",
      "work and untracked files. It is for disposable release VMs only.",
      "On a release VM, opt in with ROSI_RELEASE_VM=1 or create the marker",
      `file ~/${MARKER_NAME}.`,
    ].join("\n"),
  );
  return 1;
}

module.exports = { isReleaseVm, MARKER_NAME };

if (require.main === module) {
  process.exitCode = main();
}
