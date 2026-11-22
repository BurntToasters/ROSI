"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  githubApiArgs,
  githubCliEnvironment,
  releaseAssetUploadArgs,
} = require("./github-cli.cjs");

test("GitHub CLI uses stored authentication and preserves API arguments", () => {
  assert.deepEqual(
    githubCliEnvironment({
      PATH: "/bin",
      GH_TOKEN: "old",
      GITHUB_TOKEN: "old-too",
    }),
    { PATH: "/bin" },
  );
  assert.deepEqual(githubApiArgs("PATCH", "repos/o/r/releases/1", true), [
    "api",
    "--method",
    "PATCH",
    "repos/o/r/releases/1",
    "--input",
    "-",
  ]);
  assert.deepEqual(
    require("./github-cli.cjs").githubApiRawArgs(
      "GET",
      "repos/o/r/releases/assets/9",
    ),
    [
      "api",
      "--method",
      "GET",
      "repos/o/r/releases/assets/9",
      "--header",
      "Accept: application/octet-stream",
    ],
  );
});

test("release uploads use the GitHub uploads host and return JSON", () => {
  assert.deepEqual(
    releaseAssetUploadArgs(
      "https://uploads.github.com/repos/o/r/releases/1/assets{?name,label}",
      "/tmp/latest.json",
    ).slice(0, 5),
    [
      "api",
      "--method",
      "POST",
      "https://uploads.github.com/repos/o/r/releases/1/assets?name=latest.json",
      "--header",
    ],
  );
  assert.throws(
    () => releaseAssetUploadArgs("https://example.test/upload", "/tmp/app.zip"),
    /unexpected GitHub upload URL/,
  );
});

test("gh calls carry a timeout and report a stalled call clearly", () => {
  const {
    GITHUB_API_TIMEOUT_MS,
    GITHUB_UPLOAD_TIMEOUT_MS,
    runGitHub,
    uploadReleaseAsset,
  } = require("./github-cli.cjs");
  const seen = [];
  const spawnOk = (command, args, options) => {
    seen.push({ command, args, timeout: options.timeout });
    return { status: 0, stdout: "{}", stderr: "" };
  };
  assert.equal(GITHUB_API_TIMEOUT_MS, 2 * 60 * 1000);
  assert.equal(GITHUB_UPLOAD_TIMEOUT_MS, 10 * 60 * 1000);

  runGitHub(["auth", "status"], { spawn: spawnOk });
  assert.equal(seen.at(-1).timeout, GITHUB_API_TIMEOUT_MS);

  uploadReleaseAsset(
    "https://uploads.github.com/repos/o/r/releases/1/assets{?name,label}",
    __filename,
    { spawn: spawnOk },
  );
  assert.equal(seen.at(-1).timeout, GITHUB_UPLOAD_TIMEOUT_MS);

  const stalled = () => {
    const error = new Error("spawnSync gh ETIMEDOUT");
    error.code = "ETIMEDOUT";
    return { error, status: null, stdout: "", stderr: "" };
  };
  assert.throws(
    () => runGitHub(["api", "repos/o/r"], { spawn: stalled }),
    (error) => {
      assert.match(error.message, /timed out after 120000 ms/);
      assert.match(error.message, /gh api repos\/o\/r/);
      return true;
    },
  );
});

test("fetch to GitHub is bounded and a timeout names the URL", async () => {
  const { fetchWithTimeout } = require("./github-cli.cjs");
  let captured;
  const ok = await fetchWithTimeout(
    "https://api.github.com/repos/o/r",
    { headers: { Accept: "application/json" } },
    {
      timeoutMs: 60_000,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200 };
      },
    },
  );
  assert.equal(ok.status, 200);
  assert.equal(captured.url, "https://api.github.com/repos/o/r");
  assert.equal(captured.init.headers.Accept, "application/json");
  assert.ok(captured.init.signal instanceof AbortSignal);

  const stalled = () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  };
  await assert.rejects(
    fetchWithTimeout(
      "https://api.github.com/repos/o/r",
      {},
      { timeoutMs: 60_000, fetchImpl: stalled },
    ),
    (error) => {
      assert.match(error.message, /api\.github\.com\/repos\/o\/r/);
      assert.match(error.message, /did not respond within 60 s/);
      return true;
    },
  );

  await assert.rejects(
    fetchWithTimeout(
      "https://example.test/x",
      {},
      {
        timeoutMs: 1000,
        fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      },
    ),
    /fetch failed/,
  );
  assert.throws(
    () => fetchWithTimeout("https://example.test/x", {}, { timeoutMs: 0 }),
    /positive timeoutMs/,
  );
});
