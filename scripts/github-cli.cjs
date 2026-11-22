"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || "").match(
    /\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i,
  );
  return match ? Number(match[1] || match[2]) : undefined;
}

function githubApiArgs(method, endpoint, hasBody = false) {
  const args = ["api", "--method", method, endpoint];
  if (hasBody) args.push("--input", "-");
  return args;
}

function releaseAssetUploadArgs(uploadUrl, filePath) {
  const url = new URL(uploadUrl.replace("{?name,label}", ""));
  if (url.protocol !== "https:" || url.hostname !== "uploads.github.com") {
    throw new Error(`Refusing unexpected GitHub upload URL: ${uploadUrl}`);
  }
  url.searchParams.set("name", path.basename(filePath));
  const contentType = /\.(asc|txt|json)$/i.test(filePath)
    ? "text/plain"
    : "application/octet-stream";
  return [
    "api",
    "--method",
    "POST",
    url.toString(),
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `Content-Type: ${contentType}`,
    "--input",
    filePath,
  ];
}

// A stalled gh call inside the beta-sync lock would otherwise hold the lock
// forever. API calls get two minutes; asset uploads get ten.
const GITHUB_API_TIMEOUT_MS = 2 * 60 * 1000;
const GITHUB_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function runGitHub(
  args,
  { input, timeoutMs = GITHUB_API_TIMEOUT_MS, spawn = spawnSync } = {},
) {
  const result = spawn("gh", args, {
    encoding: "utf8",
    env: githubCliEnvironment(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "GitHub CLI is required. Install gh and run `gh auth login` on this release VM. Token environment variables are intentionally ignored; gh must hold credentials in its keyring.",
      );
    }
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `gh ${args.join(" ")} timed out after ${timeoutMs} ms and was stopped; check GitHub availability and re-run.`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    const error = new Error(
      `gh ${args.join(" ")} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result;
}

function githubJson(args, options) {
  const output = String(runGitHub(args, options).stdout || "").trim();
  return output ? JSON.parse(output) : {};
}

function githubApi(method, endpoint, body) {
  return githubJson(githubApiArgs(method, endpoint, body !== undefined), {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
}

function githubApiRawArgs(method, endpoint) {
  return [
    "api",
    "--method",
    method,
    endpoint,
    "--header",
    "Accept: application/octet-stream",
  ];
}

function githubApiRaw(method, endpoint) {
  return String(runGitHub(githubApiRawArgs(method, endpoint)).stdout || "");
}

// Bounds one HTTP request, headers and body alike, so a stalled download cannot
// hold the release lock. A timeout is rethrown with the URL and the limit.
function fetchWithTimeout(
  url,
  init = {},
  { timeoutMs, fetchImpl = fetch } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("fetchWithTimeout requires a positive timeoutMs.");
  }
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(
        `${url} did not respond within ${Math.round(timeoutMs / 1000)} s and was abandoned.`,
      );
    }
    throw error;
  });
}

function assertGitHubCliAuthenticated() {
  runGitHub(["auth", "status", "--hostname", "github.com"]);
}

function uploadReleaseAsset(uploadUrl, filePath, { spawn } = {}) {
  return githubJson(releaseAssetUploadArgs(uploadUrl, filePath), {
    timeoutMs: GITHUB_UPLOAD_TIMEOUT_MS,
    spawn,
  });
}

module.exports = {
  GITHUB_API_TIMEOUT_MS,
  GITHUB_UPLOAD_TIMEOUT_MS,
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiArgs,
  githubApiRaw,
  githubApiRawArgs,
  githubCliEnvironment,
  fetchWithTimeout,
  githubStatusCode,
  releaseAssetUploadArgs,
  runGitHub,
  uploadReleaseAsset,
};
