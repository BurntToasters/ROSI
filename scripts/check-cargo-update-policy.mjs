#!/usr/bin/env node

/* Temporary regression scanner. Remove together with cargo-safe-update.mjs
 * when stable Cargo minimum-publish-age replaces the wrapper. */

import console from "node:console";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CARGO_UPDATE_POLICY_SCANNER_VERSION = 5;
export const CARGO_UPDATE_SCANNER_VERSION = 5;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const EXECUTABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".cmd",
  ".bat",
  ".yml",
  ".yaml",
  ".py",
]);

export const EXACT_AUTOMATION_FILES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  "Taskfile",
  "Taskfile.yml",
  "Taskfile.yaml",
]);

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "release",
  "coverage",
  "vendor",
  ".vite",
  ".next",
  "build",
  "out",
]);

export const EXCLUDED_FILES = new Set([
  "scripts/cargo-safe-update.mjs",
  "scripts/npm-safe-update.mjs",
  "scripts/cargo-safe-update.test.mjs",
  "scripts/check-cargo-update-policy.mjs",
  "scripts/check-cargo-update-policy.test.mjs",
]);

// P0: raw shell-level Cargo mutation command
const RAW_CARGO_MUTATION_REGEX =
  /\bcargo(?:\s+\+[A-Za-z0-9._-]+)?\s+(update|upgrade|add|generate-lockfile)\b/;
const RAW_NPM_MUTATION_REGEX =
  /\bnpm(?:\.cmd)?\s+(?:update|upgrade)\b|\bnpm(?:\.cmd)?\s+audit\s+fix\b/;

// Cargo.lock deletion via shell/PowerShell/Node API
const LOCKFILE_DELETE_REGEX =
  /(?:\b(?:rm|unlink|Remove-Item|ri|del|erase|rmSync|unlinkSync)\b[^\n\r;]*[/\\]Cargo\.lock\b)|(?:\b(?:rm|unlink|Remove-Item|ri|del|erase|rmSync|unlinkSync)\s+[^\n\r;]*\bCargo\.lock\b)|(?:\b(?:rmSync|unlinkSync)\s*\([^)]*Cargo\.lock[^)]*\))/;

// Cargo.lock truncation / overwrite via shell redirect
const LOCKFILE_TRUNCATE_OVERWRITE_REGEX =
  /(?:>\s*(?:[^\n\r;]*[/\\])?Cargo\.lock\b)|(?:\btruncate\s+[^\n\r;]*\bCargo\.lock\b)/;

// P1: programmatic Node/JS calls that bypass shell-level detection.
// Catches: spawn/spawnSync/execFile/execFileSync/execa/execaSync("cargo", ["update"/...])
// Also catches execSync("cargo update") style calls.
// Uses conservative regex; false positives in docs are reviewable.
const PROGRAMMATIC_CARGO_MUTATION_REGEX =
  /\b(?:spawn(?:Sync)?|execFile(?:Sync)?|execa(?:Sync)?)\s*\(\s*['"]cargo['"]\s*,\s*\[\s*(?:['"]\+[A-Za-z0-9._-]+['"]\s*,\s*)?['"](?:update|upgrade|add|generate-lockfile)['"]/;
// Also catch execSync("cargo update") / exec("cargo update") forms
const EXEC_SYNC_CARGO_MUTATION_REGEX =
  /\b(?:execSync|exec)\s*\(\s*['"]cargo(?:\s+\+[A-Za-z0-9._-]+)?\s+(?:update|upgrade|add|generate-lockfile)\b/;
const PYTHON_CARGO_MUTATION_REGEX =
  /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*\[?\s*['"]cargo['"]\s*,\s*(?:['"]\+[A-Za-z0-9._-]+['"]\s*,\s*)?['"](?:update|upgrade|add|generate-lockfile)['"]/;
const PROGRAMMATIC_NPM_MUTATION_REGEX =
  /\b(?:spawn(?:Sync)?|execFile(?:Sync)?|execa(?:Sync)?)\s*\(\s*['"]npm(?:\.cmd)?['"]\s*,\s*\[\s*['"](?:update|upgrade)['"]/;

export function normalizeRelPath(relPath) {
  return relPath.split(path.sep).join("/");
}

export function commandSegments(command) {
  return command.split(/&&|\|\||;|\n/u);
}

export function collapseLineContinuations(text) {
  return text.replace(/\\\r?\n[\t ]*/gu, " ");
}

export function stripCommentLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("REM ") ||
        trimmed.startsWith("rem ") ||
        trimmed.startsWith("::")
      ) {
        return "";
      }
      return line;
    })
    .join("\n");
}

// P0: No line-wide segmentIsGuarded short-circuit.
// Any raw Cargo mutation is always a violation outside the exact approved helper path.
export function classifyLine(line) {
  for (const segment of commandSegments(line)) {
    if (RAW_NPM_MUTATION_REGEX.test(segment)) {
      return {
        kind: "raw npm dependency mutation",
        text: segment.trim(),
      };
    }

    if (RAW_CARGO_MUTATION_REGEX.test(segment)) {
      return {
        kind: "raw Cargo mutation",
        text: segment.trim(),
      };
    }

    if (LOCKFILE_DELETE_REGEX.test(segment)) {
      return {
        kind: "Cargo.lock deletion",
        text: segment.trim(),
      };
    }

    if (LOCKFILE_TRUNCATE_OVERWRITE_REGEX.test(segment)) {
      return {
        kind: "Cargo.lock overwrite/truncate",
        text: segment.trim(),
      };
    }

    // P1: programmatic Node/JS cargo mutation (full-line check since these are not
    // typically chained with &&; checking each segment is still correct)
    if (
      PROGRAMMATIC_CARGO_MUTATION_REGEX.test(segment) ||
      EXEC_SYNC_CARGO_MUTATION_REGEX.test(segment) ||
      PYTHON_CARGO_MUTATION_REGEX.test(segment) ||
      PROGRAMMATIC_NPM_MUTATION_REGEX.test(segment)
    ) {
      return {
        kind: PROGRAMMATIC_NPM_MUTATION_REGEX.test(segment)
          ? "programmatic npm dependency mutation"
          : "programmatic Cargo mutation",
        text: segment.trim(),
      };
    }
  }

  return null;
}

export function walkExecutableFiles(root, currentDir = root, results = []) {
  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizeRelPath(path.relative(root, fullPath));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walkExecutableFiles(root, fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (
        EXECUTABLE_EXTENSIONS.has(ext) ||
        EXACT_AUTOMATION_FILES.has(entry.name)
      ) {
        results.push({ relPath, fullPath, ext, name: entry.name });
      }
    }
  }

  return results;
}

export function scanFile(relPath, fullPath, violations) {
  const normalizedRel = normalizeRelPath(relPath);
  if (EXCLUDED_FILES.has(normalizedRel)) return;

  let content;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    return;
  }

  const stripped = stripCommentLines(collapseLineContinuations(content));
  const lines = stripped.split(/\r?\n/u);

  const dynamicCargoVariables = new Set();
  const dynamicNpmVariables = new Set();
  for (const match of stripped.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu,
  )) {
    const expression = match[2];
    if (
      /['"]cargo['"]/u.test(expression) &&
      /['"](?:update|upgrade|add|generate-lockfile)['"]/u.test(expression)
    ) {
      dynamicCargoVariables.add(match[1]);
    }
    if (
      /['"]npm(?:\.cmd)?['"]/u.test(expression) &&
      /['"](?:update|upgrade)['"]/u.test(expression)
    ) {
      dynamicNpmVariables.add(match[1]);
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const finding = classifyLine(line);
    if (finding) {
      // P1: No whole-file DOCUMENTED_MENTIONS exemption.
      // Every finding in every file is reported. Use EXCLUDED_FILES for approved helpers only.
      violations.push({
        file: normalizedRel,
        line: i + 1,
        kind: finding.kind,
        text: finding.text,
      });
      continue;
    }

    for (const variable of dynamicCargoVariables) {
      const dynamicExecution = new RegExp(
        `\\b(?:execSync|exec)\\s*\\(\\s*${variable.replace(/[$]/gu, "\\$&")}\\s*[),]`,
        "u",
      );
      if (dynamicExecution.test(line)) {
        violations.push({
          file: normalizedRel,
          line: i + 1,
          kind: "dynamic Cargo mutation",
          text: line.trim(),
        });
        break;
      }
    }

    for (const variable of dynamicNpmVariables) {
      const dynamicExecution = new RegExp(
        `\\b(?:execSync|exec)\\s*\\(\\s*${variable.replace(/[$]/gu, "\\$&")}\\s*[),]`,
        "u",
      );
      if (dynamicExecution.test(line)) {
        violations.push({
          file: normalizedRel,
          line: i + 1,
          kind: "dynamic npm dependency mutation",
          text: line.trim(),
        });
        break;
      }
    }
  }
}

export function scanPackageJson(root, violations) {
  const manifestPath = path.join(root, "package.json");
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
  } catch {
    return;
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    for (const segment of commandSegments(collapseLineContinuations(command))) {
      const finding = classifyLine(segment);
      if (finding) {
        violations.push({
          file: "package.json",
          script: name,
          kind: finding.kind,
          text: finding.text,
        });
        break;
      }
    }
  }
}

// P2: Scan .cargo/config.toml and .cargo/config for dependency-mutating aliases.
// Disallow aliases whose expansion begins with or invokes update/upgrade/add/generate-lockfile.
export function scanCargoConfig(root, violations) {
  const configPaths = [
    path.join(root, ".cargo", "config.toml"),
    path.join(root, ".cargo", "config"),
  ];

  const MUTATION_ALIAS_REGEX = /^\s*(?:update|upgrade|add|generate-lockfile)\b/;

  for (const configPath of configPaths) {
    let content;
    try {
      content = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }

    let inAliasSection = false;
    const lines = content.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Detect section headers
      if (trimmed.startsWith("[")) {
        inAliasSection = trimmed === "[alias]";
        continue;
      }

      if (!inAliasSection) continue;

      // Key = "value" or Key = ["value", ...]
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const aliasValue = trimmed.slice(eqIdx + 1).trim();

      // Extract the first word from the alias expansion (strip quotes, brackets)
      const stripped = aliasValue
        .replace(/^\[?\s*['"]?/, "")
        .replace(/['"\]].*/u, "")
        .trim();

      if (MUTATION_ALIAS_REGEX.test(stripped)) {
        const relConfig = normalizeRelPath(path.relative(root, configPath));
        violations.push({
          file: relConfig,
          line: i + 1,
          kind: "Cargo alias dependency mutation",
          text: line.trim(),
        });
      }
    }
  }
}

export function runPolicyCheck({
  root = repoRoot,
  log = console.log,
  error = console.error,
} = {}) {
  const violations = [];
  scanPackageJson(root, violations);

  // P2: Scan .cargo/config for mutation aliases
  scanCargoConfig(root, violations);

  // Scan root automation exact files (Makefile, justfile, Taskfile, etc.)
  for (const name of EXACT_AUTOMATION_FILES) {
    const fullPath = path.join(root, name);
    try {
      if (statSync(fullPath).isFile()) {
        scanFile(name, fullPath, violations);
      }
    } catch {
      // file does not exist
    }
  }

  // Scan automation directories recursively
  const candidateDirs = [
    "scripts",
    "tools",
    "bin",
    "dev",
    "ops",
    "ci",
    "automation",
    "build-scripts",
    path.join(".github", "workflows"),
  ];

  for (const dir of candidateDirs) {
    const targetDir = path.join(root, dir);
    try {
      if (statSync(targetDir).isDirectory()) {
        const files = walkExecutableFiles(root, targetDir);
        for (const file of files) {
          scanFile(file.relPath, file.fullPath, violations);
        }
      }
    } catch {
      // directory does not exist
    }
  }

  // P2: Scan root-level shell, PowerShell, cmd, AND JS/TS automation files
  const ROOT_SCRIPT_EXTENSIONS = new Set([
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".psm1",
    ".cmd",
    ".bat",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".py",
  ]);
  try {
    const rootEntries = readdirSync(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ROOT_SCRIPT_EXTENSIONS.has(ext)) {
          scanFile(entry.name, path.join(root, entry.name), violations);
        }
      }
    }
  } catch {
    // ignore
  }

  if (violations.length > 0) {
    error("cargo-update-policy: unguarded dependency mutation found:\n");
    for (const v of violations) {
      if (v.script) {
        error(
          `  file: ${v.file} (script "${v.script}")\n  kind: ${v.kind}\n  text: ${v.text}\n`,
        );
      } else {
        error(
          `  file: ${v.file}:${v.line}\n  kind: ${v.kind}\n  text: ${v.text}\n`,
        );
      }
    }
    error(
      "Dependency-changing workflows must route through scripts/npm-safe-update.mjs and scripts/cargo-safe-update.mjs.",
    );
    return false;
  }

  log("cargo-update-policy: no unguarded dependency mutation found.");
  return true;
}

function main() {
  const success = runPolicyCheck();
  if (!success) {
    process.exitCode = 1;
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) main();

export { runPolicyCheck as checkCargoUpdatePolicy };
