import assert from "node:assert/strict";
import test from "node:test";
import { expectedReleaseBranch } from "./release-preflight.js";

test("beta and stable versions still map to their release branches", () => {
  assert.equal(expectedReleaseBranch("5.0.0-beta.4"), "beta");
  assert.equal(expectedReleaseBranch("5.0.0"), "main");
  assert.throws(() => expectedReleaseBranch("5.0.0-rc.1"));
});
