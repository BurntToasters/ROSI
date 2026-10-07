import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  clearQualityGateProof,
  recordSuccessfulQualityGate,
} from "./release-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, "..", "package.json");
const coverageSummaryPath = resolve(
  __dirname,
  "..",
  "coverage",
  "coverage-summary.json",
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const appVersion = packageJson.version ?? "unknown";
const scriptVersion = "1.1.5";
// ROSI verifies behavior end to end (npm run test:e2e). Coverage is reported,
// and per-file gates can be added here when a module needs one.
const criticalCoverageThresholds = {};

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};
const defaultTimeoutMs = 300_000;
const rustTimeoutMs = process.platform === "win32" ? 1_200_000 : 600_000;
const e2eTimeoutMs = process.platform === "win32" ? 1_200_000 : 900_000;

function createInitialResults() {
  return {
    typecheck: { status: "pending" },
    lint: { status: "pending" },
    format: { status: "pending" },
    noEmDash: { status: "pending" },
    changelog: { status: "pending" },
    updater: { status: "pending" },
    flatpak: { status: "pending" },
    cargoSafeUpdate: { status: "pending" },
    cargoUpdatePolicy: { status: "pending" },
    test: { status: "pending", passed: null, failed: null, files: null },
    coverage: {
      status: "pending",
      lines: null,
      statements: null,
      functions: null,
      branches: null,
    },
    rustfmt: { status: "pending" },
    rustprep: { status: "pending" },
    ytdlp: { status: "pending" },
    e2e: { status: "pending" },
    clippy: { status: "pending" },
    rust: { status: "pending" },
    vendorUpdater: { status: "pending" },
  };
}

function getNpmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function printTail(output, label) {
  const cleanOutput = stripAnsi(output).trim();
  if (!cleanOutput) return;
  const lines = cleanOutput.split("\n");
  const tail = lines.slice(-120).join("\n");
  console.log(`${colors.red}${label}:${colors.reset}`);
  console.log(`${colors.red}${tail}${colors.reset}`);
}

function parseTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const passedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+passed/);
  const failedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+failed/);
  const filesMatch = cleanOutput.match(
    /Test Files\s+(\d+)\s+passed(?:\s+\((\d+)\))?/,
  );

  results.test.passed = passedMatch ? parseInt(passedMatch[1], 10) : null;
  results.test.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

  if (filesMatch) {
    results.test.files = parseInt(filesMatch[1], 10);
  }
}

function aggregateCoverageEntries(entries) {
  const metrics = ["lines", "branches", "functions", "statements"];
  const totals = Object.fromEntries(
    metrics.map((metric) => [metric, { total: 0, covered: 0 }]),
  );
  for (const entry of entries) {
    for (const metric of metrics) {
      const block = entry?.[metric];
      if (!block || typeof block.total !== "number") continue;
      totals[metric].total += block.total;
      totals[metric].covered += block.covered ?? 0;
    }
  }
  const result = {};
  for (const metric of metrics) {
    const { total, covered } = totals[metric];
    result[metric] = {
      total,
      covered,
      skipped: 0,
      pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100,
    };
  }
  return result;
}

function findCriticalCoverageEntry(summary, fileName) {
  const normalizedName = fileName.replaceAll("\\", "/");
  const summaryEntries = Object.entries(summary).filter(
    ([key]) => key !== "total",
  );

  if (normalizedName.endsWith("/")) {
    const needle = `/src/${normalizedName}`;
    const matches = summaryEntries
      .filter(([filePath]) => {
        const normalizedPath = filePath.replaceAll("\\", "/");
        return (
          normalizedPath.includes(needle) && normalizedPath.endsWith(".ts")
        );
      })
      .map(([, entry]) => entry);
    if (matches.length === 0) return undefined;
    return aggregateCoverageEntries(matches);
  }

  return summaryEntries.find(([filePath]) =>
    filePath.replaceAll("\\", "/").endsWith(`/src/${normalizedName}`),
  )?.[1];
}

function parseCoverage(results) {
  try {
    const summary = JSON.parse(readFileSync(coverageSummaryPath, "utf8"));
    const total = summary?.total;
    if (!total) throw new Error("Missing total coverage block");

    results.coverage.lines = total.lines?.pct ?? null;
    results.coverage.statements = total.statements?.pct ?? null;
    results.coverage.functions = total.functions?.pct ?? null;
    results.coverage.branches = total.branches?.pct ?? null;
    const failures = [];
    for (const [fileName, thresholds] of Object.entries(
      criticalCoverageThresholds,
    )) {
      const entry = findCriticalCoverageEntry(summary, fileName);
      if (!entry) {
        failures.push(`${fileName} missing from coverage summary`);
        continue;
      }
      for (const [metric, minimum] of Object.entries(thresholds)) {
        const actual = entry[metric]?.pct;
        if (typeof actual !== "number" || actual < minimum) {
          failures.push(
            `${fileName} ${metric} ${actual ?? "n/a"}% < ${minimum}%`,
          );
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`critical coverage regression: ${failures.join("; ")}`);
    }
    results.coverage.status = "passed";
  } catch (err) {
    results.coverage.status = "failed";
    const reason = err instanceof Error ? err.message : String(err);
    console.log(
      `${colors.red}✗ coverage parsing failed (${reason})${colors.reset}\n`,
    );
  }
}

function runCommand(name, command, args, parser, results, options = {}) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
  const timeout = options.timeout ?? defaultTimeoutMs;
  const run = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: useShell,
    windowsHide: true,
    timeout,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  const stdout = run.stdout || "";
  const stderr = run.stderr || "";
  const output = `${stdout}${stderr}`;
  if (parser) parser(output, results);

  if (!run.error && run.status === 0) {
    results[name].status = "passed";
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return true;
  }

  results[name].status = "failed";
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || "unknown"}`
      : `exit code ${run.status}`;
  console.log(`${colors.red}✗ ${name} failed (${reason})${colors.reset}`);
  printTail(stdout, "stdout tail");
  printTail(stderr, "stderr tail");
  console.log("");
  return false;
}

function printBanner() {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║           ROSI TEST SUITE            ║
╚══════════════════════════════════════╝
ROSI Version: ${appVersion}
Script Version: ${scriptVersion}
${colors.reset}`);
}

function printSummary(results) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║              SUMMARY                 ║
╚══════════════════════════════════════╝
${colors.reset}`);

  const allPassed = Object.values(results).every(
    (result) => result.status === "passed" || result.status === "skipped",
  );

  console.log(
    `${colors.bold}TypeCheck:${colors.reset}  ${
      results.typecheck.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Lint:${colors.reset}       ${
      results.lint.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Format:${colors.reset}     ${
      results.format.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}No em dash:${colors.reset} ${
      results.noEmDash.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Changelog:${colors.reset}  ${
      results.changelog.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Updater:${colors.reset}    ${
      results.updater.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Flatpak:${colors.reset}    ${
      results.flatpak.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Cargo Safe Update:${colors.reset} ${
      results.cargoSafeUpdate?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Cargo Policy:${colors.reset}      ${
      results.cargoUpdatePolicy?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Tests:${colors.reset}      ${
      results.test.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset} (${results.test.passed ?? "n/a"} passed${
      results.test.failed && results.test.failed > 0
        ? `, ${results.test.failed} failed`
        : ""
    }${results.test.files ? `, ${results.test.files} files` : ""})`,
  );
  console.log(
    `${colors.bold}Coverage:${colors.reset}   ${
      results.coverage.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset} (lines ${results.coverage.lines ?? "n/a"}%, statements ${results.coverage.statements ?? "n/a"}%, functions ${results.coverage.functions ?? "n/a"}%, branches ${results.coverage.branches ?? "n/a"}%)`,
  );
  console.log(
    `${colors.bold}Rust Format:${colors.reset} ${
      results.rustfmt.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Rust Prep:${colors.reset}   ${
      results.rustprep.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}yt-dlp:${colors.reset}     ${
      results.ytdlp?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Clippy:${colors.reset}      ${
      results.clippy.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Rust Tests:${colors.reset} ${
      results.rust.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Vendor Updater:${colors.reset} ${
      results.vendorUpdater?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}E2E:${colors.reset}        ${
      results.e2e?.status === "passed"
        ? `${colors.green}✓ PASS`
        : results.e2e?.status === "skipped"
          ? `${colors.blue}SKIP`
          : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );

  console.log("");
  if (allPassed) {
    console.log(
      `${colors.green}${colors.bold}✓ All checks passed.${colors.reset}`,
    );
    return 0;
  }

  console.log(
    `${colors.red}${colors.bold}✗ Some checks failed. Review output above.${colors.reset}`,
  );
  return 1;
}

function main({
  root = resolve(__dirname, ".."),
  clearProof = clearQualityGateProof,
  recordProof = recordSuccessfulQualityGate,
  runner = runCommand,
  parseCoverage: parseCoverageResults = parseCoverage,
  requireCleanProof = false,
  skipE2e = false,
} = {}) {
  // A failed or interrupted run must invalidate any earlier release proof.
  const gateStartedAt = Date.now();
  clearProof(root);
  const results = createInitialResults();
  const npm = getNpmCommand();
  if (process.env.SKIP_E2E === "1") {
    console.error(
      `${colors.red}SKIP_E2E=1 is not allowed for npm run test:all. Unset it so the unpackaged WebdriverIO suite runs.${colors.reset}`,
    );
    return 1;
  }
  printBanner();

  runner("typecheck", npm, ["run", "typecheck"], null, results);
  runner("lint", npm, ["run", "lint"], null, results);
  runner("format", npm, ["run", "format:check"], null, results);
  runner("noEmDash", npm, ["run", "validate:no-em-dash"], null, results);
  runner("changelog", npm, ["run", "validate:changelog"], null, results);
  runner("updater", npm, ["run", "validate:updater"], null, results);
  runner("flatpak", npm, ["run", "validate:flatpak"], null, results);
  runner(
    "cargoSafeUpdate",
    npm,
    ["run", "test:cargo-safe-update"],
    null,
    results,
  );
  runner(
    "cargoUpdatePolicy",
    npm,
    ["run", "check:cargo-update-policy"],
    null,
    results,
  );
  const testPassed = runner(
    "test",
    npm,
    ["run", "test:cov"],
    parseTest,
    results,
  );
  if (testPassed) {
    parseCoverageResults(results);
  } else {
    results.coverage.status = "failed";
  }
  runner(
    "rustfmt",
    "cargo",
    [
      "fmt",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all",
      "--",
      "--check",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  const rustPrepared = runner(
    "rustprep",
    npm,
    ["run", "prepare:rust-tests"],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  if (rustPrepared) {
    runner("ytdlp", npm, ["run", "ytdlp:check"], null, results);
    runner(
      "clippy",
      "cargo",
      [
        "clippy",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ],
      null,
      results,
      { timeout: rustTimeoutMs },
    );
    runner(
      "rust",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-targets",
      ],
      null,
      results,
      { timeout: rustTimeoutMs },
    );
    runner(
      "vendorUpdater",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/vendor/tauri-plugin-updater/Cargo.toml",
        // Upstream doctests need a concrete Tauri Runtime; unit tests cover the
        // updater install-safety patches.
        "--lib",
      ],
      null,
      results,
      { timeout: rustTimeoutMs },
    );
    if (skipE2e) {
      results.e2e.status = "skipped";
      console.log(`${colors.blue}Skipping E2E (--skip-e2e).${colors.reset}\n`);
    } else {
      runner("e2e", npm, ["run", "test:e2e"], null, results, {
        timeout: e2eTimeoutMs,
      });
    }
  } else {
    results.clippy.status = "failed";
    results.rust.status = "failed";
    results.vendorUpdater.status = "failed";
    results.ytdlp.status = "failed";
    results.e2e.status = "failed";
    console.log(
      `${colors.red}Skipping clippy and Rust tests because Rust test assets could not be prepared.${colors.reset}\n`,
    );
  }

  const exitCode = printSummary(results);
  if (exitCode === 0) {
    const qualityGate = recordProof(root, { skipE2e, gateStartedAt });
    if (qualityGate.recorded) {
      console.log(
        `Release quality-gate proof recorded (scope: ${skipE2e ? "build-vm-partial with hosted ci-gate" : "full local E2E"}).`,
      );
    } else {
      console.error(
        `${colors.red}Release quality-gate proof NOT recorded. Resolve the reported issue and re-run test:all before any release step.${colors.reset}`,
      );
      if (qualityGate.dirtyFiles) {
        console.log("Proof rejection reason:");
        console.log(qualityGate.dirtyFiles);
      }
      if (requireCleanProof) return 1;
    }
  }
  return exitCode;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  process.exit(
    main({
      requireCleanProof: process.argv.includes("--require-clean-proof"),
      skipE2e: process.argv.includes("--skip-e2e"),
    }),
  );
}

export {
  createInitialResults,
  getNpmCommand,
  main,
  parseCoverage,
  parseTest,
  printSummary,
  runCommand,
};
