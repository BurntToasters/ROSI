import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Options must be an object literal or omitted. A number, boolean, array or
 * class instance passed by mistake would otherwise be ignored by destructuring.
 */
function assertOptionsObject(helper, options, allowed) {
  if (options === undefined) return {};
  const proto = options === null ? undefined : Object.getPrototypeOf(options);
  const plain =
    options !== null &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    (proto === Object.prototype || proto === null);
  if (!plain) {
    const kind =
      options === null
        ? "null"
        : Array.isArray(options)
          ? "array"
          : typeof options;
    throw new TypeError(
      `${helper} takes an options object or nothing, got ${kind}`,
    );
  }
  // A misspelled key would otherwise be ignored and its default used silently.
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `${helper} does not accept option(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`,
    );
  }
  return options;
}

const LISTER_TIMEOUT_MS = 30_000;
// Command lines of the lister itself; never reported as a match.
const LISTER_MARKERS = ["ps -Ao", "Get-CimInstance"];

const WINDOWS_LISTING_SCRIPT =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';

function listProcesses() {
  const [command, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LISTING_SCRIPT],
        ]
      : ["ps", ["-Ao", "pid=,command="]];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: LISTER_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `process listing (${command}) failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `process listing (${command}) exited with ${result.status}: ${String(result.stderr ?? "").slice(0, 300)}`,
    );
  }
  const output = String(result.stdout ?? "");
  if (output.trim() === "") {
    throw new Error(`process listing (${command}) printed nothing`);
  }
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)(?:\s(.*))?$/.exec(line);
    if (match) entries.push({ pid: Number(match[1]), command: match[2] ?? "" });
  }
  if (!entries.some((entry) => entry.pid === process.pid)) {
    throw new Error(
      `process listing (${command}) does not include this test (pid ${process.pid}); output format not trusted`,
    );
  }
  return entries;
}

/**
 * Command lines of live processes that mention `needle`. Never includes the
 * lister or this test. Throws when the listing fails or looks wrong, so an
 * empty result always means no process matched.
 */
export function processesMatching(needle) {
  if (typeof needle !== "string" || needle === "") {
    throw new TypeError("processesMatching needs a non-empty needle");
  }
  return listProcesses()
    .filter(
      (entry) =>
        entry.pid !== process.pid &&
        entry.command.includes(needle) &&
        !LISTER_MARKERS.some((marker) => entry.command.includes(marker)),
    )
    .map((entry) => entry.command);
}

/** Wait until no process mentions `needle`; throws with the survivors on timeout. */
export async function waitForNoProcess(needle, message, options) {
  const { timeout = 15_000, interval = 250 } = assertOptionsObject(
    "waitForNoProcess",
    options,
    ["timeout", "interval"],
  );
  if (!message) throw new TypeError("waitForNoProcess needs a message");
  const deadline = Date.now() + timeout;
  let found = processesMatching(needle);
  while (found.length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`${message}: ${found.join(" | ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    found = processesMatching(needle);
  }
}

/** Hex SHA-256 of a file. Throws, naming the path, when it cannot be read. */
export function sha256File(filePath) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(
      `sha256File could not read ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Scenario evidence. `record(name, details)` appends `{ name, ...details }`
 * (with `status` first when given) and rewrites `filePath` when set. Records
 * with `invariantPassed: false` are also listed in `failures`.
 */
export function createRecorder(options) {
  const { filePath = null, status = null } = assertOptionsObject(
    "createRecorder",
    options,
    ["filePath", "status"],
  );
  const entries = [];
  const failures = [];
  function record(name, details = {}) {
    if (typeof name !== "string" || name === "") {
      throw new TypeError("record needs a non-empty name");
    }
    const entry = { name, ...(status ? { status } : {}), ...details };
    entries.push(entry);
    if (details.invariantPassed === false) failures.push(name);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`);
    }
    return entry;
  }
  return { record, entries, failures };
}
