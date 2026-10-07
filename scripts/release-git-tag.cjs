"use strict";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const MAX_ANNOTATED_TAG_DEPTH = 8;

function resolveReleaseTagCommit({ owner, repo, tag, api }) {
  if (typeof api !== "function") {
    throw new TypeError(
      "A GitHub API function is required to resolve a release tag.",
    );
  }
  if (!owner || !repo || !tag) {
    throw new Error("GitHub owner, repository, and release tag are required.");
  }

  let reference;
  try {
    reference = api(
      "GET",
      `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
  } catch (error) {
    if (Number(error?.statusCode) === 404) return null;
    throw new Error(
      `Could not resolve release tag ${tag}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let object = reference?.object;
  const visited = new Set();
  for (let depth = 0; depth <= MAX_ANNOTATED_TAG_DEPTH; depth += 1) {
    const sha = String(object?.sha || "");
    const type = String(object?.type || "");
    if (!FULL_GIT_SHA.test(sha)) {
      throw new Error(
        `GitHub returned an invalid object for release tag ${tag}.`,
      );
    }
    if (type === "commit") return sha.toLowerCase();
    if (type !== "tag") {
      throw new Error(
        `Release tag ${tag} resolves to ${type || "an unknown object"}, not a commit.`,
      );
    }
    if (visited.has(sha.toLowerCase())) {
      throw new Error(`Release tag ${tag} contains a cyclic annotated tag.`);
    }
    visited.add(sha.toLowerCase());
    if (depth === MAX_ANNOTATED_TAG_DEPTH) {
      throw new Error(
        `Release tag ${tag} exceeds the annotated-tag peeling limit.`,
      );
    }
    const annotated = api(
      "GET",
      `/repos/${owner}/${repo}/git/tags/${encodeURIComponent(sha)}`,
    );
    object = annotated?.object;
  }

  throw new Error(`Could not peel release tag ${tag} to a commit.`);
}

function assertReleaseTagMatchesHead({
  owner,
  repo,
  tag,
  headCommit,
  api,
  allowMissing = false,
}) {
  const expected = String(headCommit || "");
  if (!FULL_GIT_SHA.test(expected)) {
    throw new Error("Expected release HEAD must be a full Git commit SHA.");
  }
  const actual = resolveReleaseTagCommit({ owner, repo, tag, api });
  if (actual === null) {
    if (allowMissing) return null;
    throw new Error(
      `Release tag ${tag} does not exist; publication must create it at HEAD ${expected}.`,
    );
  }
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Release tag ${tag} resolves to commit ${actual}, not HEAD ${expected.toLowerCase()}.`,
    );
  }
  return actual;
}

module.exports = {
  assertReleaseTagMatchesHead,
  resolveReleaseTagCommit,
};
