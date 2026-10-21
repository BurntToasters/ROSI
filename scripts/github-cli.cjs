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

function runGitHub(args, { input } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: githubCliEnvironment(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "GitHub CLI is required. Install gh and run `gh auth login` on this release VM. Token environment variables are intentionally ignored; gh must hold credentials in its keyring.",
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

function assertGitHubCliAuthenticated() {
  runGitHub(["auth", "status", "--hostname", "github.com"]);
}

function uploadReleaseAsset(uploadUrl, filePath) {
  return githubJson(releaseAssetUploadArgs(uploadUrl, filePath));
}

module.exports = {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiArgs,
  githubApiRaw,
  githubApiRawArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseAssetUploadArgs,
  runGitHub,
  uploadReleaseAsset,
};
