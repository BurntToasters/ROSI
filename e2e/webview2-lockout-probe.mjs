#!/usr/bin/env node
// TEMP_WEBVIEW2_LOCKOUT_WORKAROUND: TEMPORARY probe, REMOVE with the workaround.
// Launches the E2E binary on fresh profiles and compares the Windows
// bad-password counter before and after each launch. Failure modes and removal
// criteria: e2e/webview2-lockout.failure-modes.md
//
//   node e2e/webview2-lockout-probe.mjs --mode with|without [--launches N]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  E2E_WEBVIEW2_BROWSER_ARGS,
  REPO_ROOT,
  TEMP_WEBVIEW2_LOCKOUT_FEATURES,
  createE2eProfile,
  e2eBinaryPath,
  mergeWebView2BrowserArgs,
} from "./helpers/profile.js";

const WEBVIEW2_CLIENT_KEY =
  "Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const STARTUP_TIMEOUT_MS = 60_000;
const DWELL_MS = 10_000;
const EXIT_TIMEOUT_MS = 15_000;
// Never let probing come closer than this to the lockout threshold.
const THRESHOLD_MARGIN = 3;

function fail(message) {
  console.error(`[webview2-lockout-probe] ${message}`);
  process.exit(2);
}

function parseOptions(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = value("--mode");
  if (mode !== "with" && mode !== "without") {
    fail("--mode must be 'with' or 'without'");
  }
  const launches = Number(value("--launches") ?? "1");
  const maxLaunches = mode === "without" ? 1 : 3;
  if (!Number.isInteger(launches) || launches < 1 || launches > maxLaunches) {
    fail(`--launches must be 1 to ${maxLaunches} in '${mode}' mode`);
  }
  return { mode, launches };
}

// Scripts go through -EncodedCommand so their quotes survive the Windows
// command line; values reach them only through environment variables.
function powershell(script, env = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`powershell exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function readCounter() {
  const out = powershell(
    '$u = [ADSI]"WinNT://$env:COMPUTERNAME/$env:USERNAME,user"; ' +
      "$last = try { ([datetime]$u.LastLogin.Value).ToUniversalTime().ToString('o') } catch { '' }; " +
      "@{ bad = [int]$u.BadPasswordAttempts.Value; lastLogin = $last } | ConvertTo-Json -Compress",
  );
  return JSON.parse(out);
}

function readLockoutThreshold() {
  const result = spawnSync("net", ["accounts"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const match = /Lockout threshold:\s+(\S+)/i.exec(result.stdout ?? "");
  if (!match) return undefined;
  return match[1].toLowerCase() === "never" ? Infinity : Number(match[1]);
}

function readRuntimeVersion() {
  for (const root of ["HKLM\\SOFTWARE\\WOW6432Node", "HKCU\\Software"]) {
    const result = spawnSync(
      "reg",
      ["query", `${root}\\${WEBVIEW2_CLIENT_KEY}`, "/v", "pv"],
      { encoding: "utf8", windowsHide: true },
    );
    const match = /\bpv\s+REG_SZ\s+(\S+)/.exec(result.stdout ?? "");
    if (match) return match[1];
  }
  return null;
}

/** Browser (non-child) WebView2 processes whose command line names `folder`. */
function webview2BrowserProcesses(folder) {
  const out = powershell(
    "@(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | " +
      "Where-Object { $_.CommandLine -and " +
      "$_.CommandLine.IndexOf($env:PROBE_FOLDER, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and " +
      "$_.CommandLine -notmatch '--type=' } | " +
      "Select-Object ProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress -Depth 3",
    { PROBE_FOLDER: folder },
  );
  return out ? [].concat(JSON.parse(out)) : [];
}

function anyWebView2Process(folder) {
  return (
    powershell(
      "@(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | " +
        "Where-Object { $_.CommandLine -and " +
        "$_.CommandLine.IndexOf($env:PROBE_FOLDER, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count",
      { PROBE_FOLDER: folder },
    ) !== "0"
  );
}

function runningE2eBinaries(binary) {
  const out = powershell(
    "@(Get-CimInstance Win32_Process -Filter \"Name='rosi.exe'\" | " +
      "Where-Object { $_.ExecutablePath -ieq $env:PROBE_BINARY }).Count",
    { PROBE_BINARY: binary },
  );
  return Number(out);
}

/** Every --disable-features list; Chromium honors only the last one. */
function disabledFeatureSwitches(commandLine) {
  return [...commandLine.matchAll(/--disable-features=([^\s"]+)/g)].map(
    (match) => match[1].split(",").filter(Boolean),
  );
}

function withoutTempFeatures(args) {
  return args
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (!token.startsWith("--disable-features=")) return token;
      const kept = token
        .slice("--disable-features=".length)
        .split(",")
        .filter((name) => !TEMP_WEBVIEW2_LOCKOUT_FEATURES.includes(name));
      return kept.length ? `--disable-features=${kept.join(",")}` : null;
    })
    .filter(Boolean)
    .join(" ");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function launchOnce(binary, mode, index) {
  const profile = createE2eProfile();
  // Spawned directly, the app resolves app data under the temp USERPROFILE and
  // exits when the folder is missing.
  for (const name of ["Roaming", "Local"]) {
    fs.mkdirSync(path.join(profile.home, "AppData", name), { recursive: true });
  }
  const folder = profile.env.WEBVIEW2_USER_DATA_FOLDER;
  const merged = mergeWebView2BrowserArgs(
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    E2E_WEBVIEW2_BROWSER_ARGS,
  );
  const args = mode === "with" ? merged : withoutTempFeatures(merged);
  const record = { launch: index, mode, requestedArgs: args, valid: false };
  let child;
  try {
    const before = readCounter();
    record.before = before;
    child = spawn(binary, [], {
      env: {
        ...process.env,
        ...profile.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const exited = new Promise((resolve) => child.once("close", resolve));
    const found = await waitFor(
      () =>
        child.exitCode !== null
          ? { exited: child.exitCode }
          : webview2BrowserProcesses(folder)[0],
      STARTUP_TIMEOUT_MS,
    );
    const browser = found && !("exited" in found) ? found : null;
    if (found && "exited" in found) {
      record.invalidReason = `the app exited with ${found.exited} before WebView2 started`;
      await Promise.race([exited, sleep(EXIT_TIMEOUT_MS)]);
      record.appStderrTail = stderr;
    } else if (browser) {
      record.webview2Executable = browser.ExecutablePath;
      record.browserDisableFeatureSwitches = disabledFeatureSwitches(
        browser.CommandLine,
      );
      await sleep(DWELL_MS);
    } else {
      record.invalidReason = "no WebView2 browser process for this profile";
    }
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([exited, sleep(EXIT_TIMEOUT_MS)]);
    if (!(await waitFor(() => !anyWebView2Process(folder), EXIT_TIMEOUT_MS))) {
      record.leftoverWebView2 = true;
    }
    const after = readCounter();
    record.after = after;
    record.delta = after.bad - before.bad;
    if (browser) {
      const seen = new Set(record.browserDisableFeatureSwitches.at(-1) ?? []);
      const argsReached =
        mode === "with"
          ? TEMP_WEBVIEW2_LOCKOUT_FEATURES.every((name) => seen.has(name))
          : TEMP_WEBVIEW2_LOCKOUT_FEATURES.every((name) => !seen.has(name));
      if (after.lastLogin !== before.lastLogin) {
        record.invalidReason = "a sign-in reset the counter during the launch";
      } else if (!argsReached) {
        record.invalidReason =
          "the browser process did not get the expected --disable-features";
      } else {
        record.valid = true;
      }
    }
  } finally {
    if (child && child.exitCode === null) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
    fs.rmSync(profile.profileDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
    record.profileRemoved = !fs.existsSync(profile.profileDir);
  }
  return record;
}

function verdict(mode, records) {
  if (records.some((record) => !record.valid)) return "invalid";
  const raised = records.some((record) => record.delta > 0);
  if (mode === "with") return raised ? "workaround-insufficient" : "mitigated";
  return raised ? "affected" : "not-reproduced";
}

async function main() {
  if (process.platform !== "win32") fail("Windows only");
  const { mode, launches } = parseOptions(process.argv.slice(2));
  const binary = e2eBinaryPath();
  if (!fs.existsSync(binary)) {
    fail(`missing ${binary}; build it with a normal E2E run first`);
  }
  if (runningE2eBinaries(binary) > 0) {
    fail(`another ${path.basename(binary)} from ${binary} is running`);
  }
  const threshold = readLockoutThreshold();
  if (threshold === undefined || Number.isNaN(threshold)) {
    fail("could not read the lockout threshold from 'net accounts'");
  }
  const start = readCounter();
  const planned = mode === "without" ? launches : 0;
  if (start.bad + planned >= threshold - THRESHOLD_MARGIN) {
    fail(
      `bad-password count ${start.bad} is too close to the lockout threshold ${threshold}; wait for it to reset`,
    );
  }

  const report = {
    tool: "e2e/webview2-lockout-probe.mjs",
    startedAt: new Date().toISOString(),
    mode,
    launches,
    webview2Runtime: readRuntimeVersion(),
    lockoutThreshold: Number.isFinite(threshold) ? threshold : "never",
    tempFeatures: TEMP_WEBVIEW2_LOCKOUT_FEATURES,
    records: [],
  };
  for (let index = 1; index <= launches; index += 1) {
    const record = await launchOnce(binary, mode, index);
    report.records.push(record);
    console.log(
      `[webview2-lockout-probe] launch ${index}: delta ${record.delta ?? "?"}` +
        (record.valid ? "" : ` (invalid: ${record.invalidReason})`),
    );
    if (!record.valid || (mode === "with" && record.delta > 0)) break;
  }
  report.finishedAt = new Date().toISOString();
  report.verdict = verdict(mode, report.records);

  const dir = path.join(REPO_ROOT, "e2e", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `webview2-lockout-probe-${report.startedAt.replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[webview2-lockout-probe] verdict: ${report.verdict} (${file})`);
  process.exit(
    report.verdict === "invalid" || report.verdict === "workaround-insufficient"
      ? 1
      : 0,
  );
}

await main();
