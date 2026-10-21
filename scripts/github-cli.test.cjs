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
