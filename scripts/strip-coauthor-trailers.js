import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SCRIPT = "scripts/strip-coauthor-trailers.js";

// GitHub maps Co-authored-by emails onto contributor accounts.
// Optional `!` immediately inside the angle brackets opts the address in:
//   Co-authored-by: Name <!you@example.com>
// becomes a normal trailer after the hook runs.
const COAUTHOR_EMAIL_LINE =
  /^[ \t]*Co-authored-by:.*<[ \t]*(!)?[ \t]*([^>\s]+@[^>\s]+)>\s*$/i;

/**
 * @param {string} line
 * @returns {{ exempt: boolean, email: string } | null}
 */
export function parseCoauthorEmailLine(line) {
  const match = String(line || "").match(COAUTHOR_EMAIL_LINE);
  if (!match) return null;
  return { exempt: Boolean(match[1]), email: match[2] };
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isCoauthorEmailLine(line) {
  return parseCoauthorEmailLine(line) !== null;
}

/**
 * Agent addresses cannot be kept, even with `!`.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isForbiddenCoauthorEmail(email) {
  const lower = String(email || "")
    .trim()
    .toLowerCase();
  if (!lower) return false;
  if (lower.endsWith("@cursor.com")) return true;
  if (lower === "noreply@anthropic.com") return true;
  if (lower === "copilot@github.com") return true;
  if (lower.endsWith("+copilot@users.noreply.github.com")) return true;
  return false;
}

/**
 * @param {string} line
 * @returns {string}
 */
export function unbangCoauthorEmailLine(line) {
  return line.replace(/<[ \t]*![ \t]*([^>\s]+@[^>\s]+)>/i, "<$1>");
}

/**
 * Drop emailed co-authors unless they used `<!email>` and the address is not
 * a known agent. Exempt lines are rewritten to a normal GitHub trailer.
 *
 * @param {string} line
 * @returns {string | null}
 */
export function rewriteCoauthorLine(line) {
  const parsed = parseCoauthorEmailLine(line);
  if (!parsed) return line;
  if (!parsed.exempt || isForbiddenCoauthorEmail(parsed.email)) return null;
  return unbangCoauthorEmailLine(line);
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function messageHasCoauthorEmail(message) {
  return String(message || "")
    .split(/\r?\n/)
    .some((line) => isCoauthorEmailLine(line));
}

/**
 * CI backstop: leftover `<!email>` (hook did not run) or agent emails.
 * Human trailers that already had `!` removed are allowed.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function messageHasCoauthorPolicyViolation(message) {
  return String(message || "")
    .split(/\r?\n/)
    .some((line) => {
      const parsed = parseCoauthorEmailLine(line);
      if (!parsed) return false;
      return parsed.exempt || isForbiddenCoauthorEmail(parsed.email);
    });
}

/**
 * @param {string} message
 * @returns {string}
 */
export function stripCoauthorTrailers(message) {
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = [];
  for (const line of message.split(/\r?\n/)) {
    const next = rewriteCoauthorLine(line);
    if (next !== null) lines.push(next);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return "";
  return `${lines.join(newline)}${newline}`;
}

/**
 * @param {string} filePath
 * @returns {{ changed: boolean, original: string, next: string }}
 */
export function stripCoauthorTrailersFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  const next = stripCoauthorTrailers(original);
  if (next !== original) {
    fs.writeFileSync(filePath, next);
  }
  return { changed: next !== original, original, next };
}

/**
 * @param {string} range
 * @param {{ spawn?: typeof spawnSync }} [options]
 * @returns {string[]}
 */
export function coauthorPolicyViolationsInRange(range, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const result = spawn("git", ["log", "--format=%H%n%B%n==END==", range], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(stderr || `git log failed for range ${range}`);
  }
  const stdout = String(result.stdout || "");
  const hits = [];
  for (const block of stdout.split("==END==")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const newline = trimmed.indexOf("\n");
    const hash = newline === -1 ? trimmed : trimmed.slice(0, newline);
    const body = newline === -1 ? "" : trimmed.slice(newline + 1);
    if (messageHasCoauthorPolicyViolation(body)) {
      hits.push(hash);
    }
  }
  return hits;
}

/**
 * @param {string[]} argv
 * @returns {{ mode: "in-place", file: string } | { mode: "check-range", range: string } | { mode: "help" }}
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { mode: "help" };
  }
  if (args[0] === "--check-range") {
    if (!args[1]) {
      throw new Error("--check-range requires a git revision range");
    }
    return { mode: "check-range", range: args[1] };
  }
  if (args[0] === "--in-place") {
    if (!args[1]) {
      throw new Error("--in-place requires a commit-message file");
    }
    return { mode: "in-place", file: args[1] };
  }
  if (args.length === 1 && !args[0].startsWith("-")) {
    return { mode: "in-place", file: args[0] };
  }
  throw new Error(`unrecognized arguments: ${args.join(" ")}`);
}

export function isDirectExecution(
  moduleUrl = import.meta.url,
  executablePath = process.argv[1],
) {
  return Boolean(
    executablePath &&
    pathToFileURL(path.resolve(executablePath)).href === moduleUrl,
  );
}

function printHelp() {
  console.log(`Usage:
  node ${SCRIPT} <commit-message-file>
  node ${SCRIPT} --in-place <commit-message-file>
  node ${SCRIPT} --check-range <rev1>..<rev2>`);
}

function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.mode === "help") {
    printHelp();
    return 0;
  }
  if (options.mode === "in-place") {
    stripCoauthorTrailersFile(options.file);
    return 0;
  }
  const hits = coauthorPolicyViolationsInRange(options.range);
  if (hits.length > 0) {
    console.error(
      `Co-authored-by policy violation (${hits.length} commit${hits.length === 1 ? "" : "s"}): leftover <!email> markers or agent emails are not allowed.\n${hits.join("\n")}`,
    );
    return 1;
  }
  return 0;
}

if (isDirectExecution()) {
  try {
    process.exit(main());
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    console.error(`strip-coauthor-trailers failed: ${message}`);
    process.exit(1);
  }
}

export { main };
