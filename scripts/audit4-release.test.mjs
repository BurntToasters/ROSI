import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assertManifestAssetReferences } from "./verify-release-draft.js";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../testdata/updater/latest-windows-aarch64.json", import.meta.url),
  ),
);
const entry = fixture.platforms["windows-aarch64-nsis"];
function validate(manifest, name = "latest-windows-aarch64.json") {
  const assets = Object.values(manifest.platforms).flatMap((e) => {
    const name = decodeURIComponent(new URL(e.url).pathname.split("/").at(-1));
    return [name, name + ".sig"];
  });
  assertManifestAssetReferences(manifest, name, assets, {
    repoOwner: "BurntToasters",
    repoName: "ROSI",
    tag: "v0.0.0-fixture",
  });
}
test("draft rejects a different platform in an ARM64 Windows feed", () =>
  assert.throws(() =>
    validate({ ...fixture, platforms: { "linux-x86_64-appimage": entry } }),
  ));
test("draft rejects the wrong artifact architecture", () =>
  assert.throws(() =>
    validate({
      ...fixture,
      platforms: {
        "windows-aarch64-nsis": {
          ...entry,
          url: entry.url.replace("arm64-setup", "x64-setup"),
        },
      },
    }),
  ));
test("draft rejects an unrelated installer key", () =>
  assert.throws(() =>
    validate({ ...fixture, platforms: { "windows-aarch64-msi": entry } }),
  ));
test("draft rejects a malformed signature envelope", () =>
  assert.throws(() =>
    validate({
      ...fixture,
      platforms: {
        "windows-aarch64-nsis": { ...entry, signature: "not-a-signature" },
      },
    }),
  ));
test("draft requires the NSIS key in its NSIS feed", () =>
  assert.throws(() =>
    validate(
      { ...fixture, platforms: { "windows-aarch64": entry } },
      "latest-windows-aarch64-nsis.json",
    ),
  ));
test("draft accepts a valid ARM64 manifest", () =>
  assert.doesNotThrow(() => validate(fixture)));
test("draft accepts universal macOS and beta architecture fallback", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../testdata/updater/latest-darwin-beta-aarch64.json",
        import.meta.url,
      ),
    ),
  );
  validate(manifest, "latest-darwin-beta-aarch64.json");
});
