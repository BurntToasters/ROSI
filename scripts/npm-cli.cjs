"use strict";

function npmInvocation({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }

  const npmExecPath = String(env.npm_execpath || "").trim();
  if (!npmExecPath) {
    throw new Error(
      "npm_execpath is unavailable on Windows; run this command through npm.",
    );
  }
  return { command: execPath, prefixArgs: [npmExecPath] };
}

module.exports = { npmInvocation };
