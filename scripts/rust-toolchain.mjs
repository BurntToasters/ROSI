#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLCHAIN_FILE = "rust-toolchain.toml";
const EXACT_RUST_VERSION = /^\d+\.\d+\.\d+$/u;
const COMPONENT_NAME = /^[A-Za-z0-9_-]+$/u;
const TARGET_TRIPLE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const USAGE = `Usage: node scripts/rust-toolchain.mjs [--print | --install | --target <triple...>]

Without arguments, prints the exact Rust version pinned in rust-toolchain.toml.
  --print              Print the pinned version.
  --install            Install the pinned toolchain with its profile and components.
  --target <triple...> Add one or more targets to the pinned toolchain.`;

function toolchainError(filePath, message, cause) {
  return new Error(
    `${TOOLCHAIN_FILE} ${message}: ${filePath}`,
    cause === undefined ? undefined : { cause },
  );
}

function parseQuotedValue(rawValue, filePath, key) {
  const value = rawValue.match(/^"([^"]*)"\s*(?:#.*)?$/u)?.[1];
  if (value === undefined) {
    throw toolchainError(
      filePath,
      `has a malformed ${key}; expected a quoted string`,
    );
  }
  return value;
}

function parseComponents(rawValue, lines, startIndex, filePath) {
  const parts = [rawValue.replace(/\s+#.*$/u, "")];
  let index = startIndex;
  while (!parts.at(-1).includes("]")) {
    index += 1;
    if (index >= lines.length) {
      throw toolchainError(filePath, "has an unterminated components array");
    }
    parts.push(lines[index].trim().replace(/\s+#.*$/u, ""));
  }

  const text = parts.join(" ");
  const body = text.slice(0, text.indexOf("]"));
  const components = [...body.matchAll(/"([^"]+)"|'([^']+)'/gu)].map(
    (match) => match[1] ?? match[2],
  );
  if (components.length === 0) {
    throw toolchainError(filePath, "has an empty components array");
  }
  for (const component of components) {
    if (!COMPONENT_NAME.test(component)) {
      throw toolchainError(
        filePath,
        `has a malformed component name: ${component}`,
      );
    }
  }
  return { components, index };
}

export function readRustToolchain(root) {
  const filePath = path.join(root, TOOLCHAIN_FILE);
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw toolchainError(filePath, "is missing", error);
    }
    throw error;
  }

  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let section = "";
  let channel;
  let profile;
  let components = [];
  let componentsSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "toolchain") continue;

    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
    if (!keyValue) {
      throw toolchainError(filePath, `has a malformed line: ${line}`);
    }
    const [, key, rawValue] = keyValue;

    if (key === "channel") {
      if (channel !== undefined) {
        throw toolchainError(filePath, "defines channel more than once");
      }
      channel = parseQuotedValue(rawValue, filePath, "channel");
      continue;
    }
    if (key === "profile") {
      if (profile !== undefined) {
        throw toolchainError(filePath, "defines profile more than once");
      }
      profile = parseQuotedValue(rawValue, filePath, "profile");
      continue;
    }
    if (key === "components") {
      if (componentsSeen) {
        throw toolchainError(filePath, "defines components more than once");
      }
      const parsed = parseComponents(rawValue, lines, index, filePath);
      components = parsed.components;
      componentsSeen = true;
      index = parsed.index;
    }
  }

  if (!channel) {
    throw toolchainError(
      filePath,
      "must pin an exact Rust version; found no channel",
    );
  }
  if (!EXACT_RUST_VERSION.test(channel)) {
    throw toolchainError(
      filePath,
      `must pin an exact Rust version; found ${channel}`,
    );
  }

  return { channel, profile, components };
}

export function readPinnedRustToolchain(root) {
  return readRustToolchain(root).channel;
}

function parseArguments(argv) {
  const options = { action: "print", targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { action: "help" };
    }
    if (argument === "--print") {
      if (options.action !== "print") {
        throw new Error("Choose only one of --print, --install, or --target");
      }
      continue;
    }
    if (argument === "--install") {
      if (options.action !== "print") {
        throw new Error("Choose only one of --print, --install, or --target");
      }
      options.action = "install";
      continue;
    }
    if (argument === "--target") {
      if (options.action !== "print") {
        throw new Error("Choose only one of --print, --install, or --target");
      }
      const targets = argv.slice(index + 1);
      if (targets.length === 0) {
        throw new Error("--target requires at least one target triple");
      }
      for (const target of targets) {
        if (!TARGET_TRIPLE.test(target)) {
          throw new Error(`Invalid target triple: ${target}`);
        }
      }
      options.action = "target";
      options.targets = targets;
      break;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function runRustup(args) {
  const result = spawnSync("rustup", args, {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `rustup ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.action === "help") {
    console.log(USAGE);
    return;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const toolchain = readRustToolchain(root);

  if (options.action === "print") {
    console.log(toolchain.channel);
    return;
  }
  if (options.action === "install") {
    const args = [
      "toolchain",
      "install",
      toolchain.channel,
      "--profile",
      toolchain.profile || "minimal",
    ];
    if (toolchain.components.length > 0) {
      args.push("--component", toolchain.components.join(","));
    }
    runRustup(args);
    return;
  }

  runRustup([
    "target",
    "add",
    "--toolchain",
    toolchain.channel,
    ...options.targets,
  ]);
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
