import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialResults, main } from "./test-all.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readPackageJsonScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    .scripts;
}

test("createInitialResults includes cargoSafeUpdate and cargoUpdatePolicy in initial state", () => {
  const results = createInitialResults();
  assert.equal(results.cargoSafeUpdate.status, "pending");
  assert.equal(results.cargoUpdatePolicy.status, "pending");
  assert.equal(results.vendorUpdater.status, "pending");
  assert.equal(results.ytdlp.status, "pending");
  assert.equal(results.e2e.status, "pending");
});

test("package.json scripts define cargo safe update test and policy check", () => {
  const scripts = readPackageJsonScripts();
  assert.equal(
    scripts["test:cargo-safe-update"],
    "node --test scripts/cargo-safe-update.test.mjs scripts/check-cargo-update-policy.test.mjs scripts/test-all.test.js scripts/run-release.test.js scripts/github-cli.test.cjs scripts/release-branch-protection.test.cjs scripts/release-licenses.test.mjs scripts/npm-dev-audit.test.cjs scripts/generate-cargo-licenses.test.mjs scripts/check-rustsec-ignore-policy.test.mjs",
  );
  assert.equal(
    scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
  assert.equal(scripts["audit:dev-reviewed"], "node scripts/npm-dev-audit.cjs");
  assert.equal(
    scripts["check:rustsec-ignore-policy"],
    "node scripts/check-rustsec-ignore-policy.mjs",
  );
  assert.equal(
    scripts["repo:protect-release-branches"],
    "node scripts/release-branch-protection.cjs --apply",
  );
  assert.equal(scripts["ytdlp:check"], "node scripts/check-ytdlp.cjs");
  assert.equal(scripts["test:e2e"], "node scripts/test-e2e.js");
});

test("main prevents quality-gate proof recording when cargoSafeUpdate fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoSafeUpdate") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoSafeUpdate"));
  assert.ok(
    !calls.includes("recordProof"),
    "failing cargoSafeUpdate must not record quality gate proof",
  );
  assert.equal(exitCode, 1);
});

test("main prevents quality-gate proof recording when cargoUpdatePolicy fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoUpdatePolicy") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoUpdatePolicy"));
  assert.ok(
    !calls.includes("recordProof"),
    "failing cargoUpdatePolicy must not record quality gate proof",
  );
  assert.equal(exitCode, 1);
});

test("main records quality-gate proof when all checks pass", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:ytdlp"));
  assert.ok(calls.includes("run:e2e"));
  assert.ok(calls.includes("recordProof"));
  assert.equal(exitCode, 0);
});

test("main skips e2e and still records quality-gate proof for --skip-e2e", () => {
  const calls = [];
  const resultsSeen = [];
  const exitCode = main({
    root: repoRoot,
    skipE2e: true,
    clearProof: () => calls.push("clearProof"),
    recordProof: () => {
      calls.push("recordProof");
      return { recorded: true };
    },
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      results[name].status = "passed";
      if (name === "test") results.coverage.status = "passed";
      resultsSeen.push(results);
      return true;
    },
  });

  assert.ok(!calls.includes("run:e2e"));
  assert.equal(resultsSeen.at(-1)?.e2e.status, "skipped");
  assert.ok(calls.includes("recordProof"));
  assert.equal(exitCode, 0);
});

test("main keeps generic test:all green when proof cannot be recorded", () => {
  const exitCode = main({
    root: repoRoot,
    clearProof: () => {},
    recordProof: () => ({ recorded: false, dirtyFiles: " M source.ts" }),
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (_name, _cmd, _args, _parser, results) => {
      results[_name].status = "passed";
      if (_name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 0);
});

test("main fails release proof mode when proof cannot be recorded", () => {
  const exitCode = main({
    root: repoRoot,
    clearProof: () => {},
    recordProof: () => ({ recorded: false, dirtyFiles: " M source.ts" }),
    requireCleanProof: true,
    parseCoverage: (results) => {
      results.coverage.status = "passed";
    },
    runner: (_name, _cmd, _args, _parser, results) => {
      results[_name].status = "passed";
      if (_name === "test") results.coverage.status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 1);
});
