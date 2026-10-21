import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_IGNORES,
  evaluateIgnorePolicy,
} from "./check-rustsec-ignore-policy.mjs";

const reviewedConfig = `[advisories]\nignore = [\n${[...EXPECTED_IGNORES]
  .map((id) => `  "${id}",`)
  .join("\n")}\n]\n`;

test("reviewed RustSec ignores pass before the review deadline", () => {
  assert.deepEqual(
    evaluateIgnorePolicy(reviewedConfig, new Date("2026-09-05T00:00:00Z")),
    [],
  );
});

test("new RustSec ignores fail closed", () => {
  const errors = evaluateIgnorePolicy(
    reviewedConfig.replace(/\]\n$/, '  "RUSTSEC-2099-9999",\n]\n'),
    new Date("2026-09-05T00:00:00Z"),
  );
  assert.match(errors.join("\n"), /unreviewed ignore RUSTSEC-2099-9999/);
});

test("RustSec IDs in comments do not count as ignored advisories", () => {
  const errors = evaluateIgnorePolicy(
    `${reviewedConfig}\n# RUSTSEC-2099-9999\n`,
    new Date("2026-09-05T00:00:00Z"),
  );
  assert.doesNotMatch(errors.join("\n"), /unreviewed ignore RUSTSEC-2099-9999/);
});

test("reviewed RustSec debt expires", () => {
  const errors = evaluateIgnorePolicy(
    reviewedConfig,
    new Date("2026-12-01T00:00:00Z"),
  );
  assert.match(errors.join("\n"), /review expired/);
});
