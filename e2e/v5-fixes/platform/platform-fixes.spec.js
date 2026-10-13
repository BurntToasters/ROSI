import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repository-state probes for the platform fixes. They read the shipped
// configuration the release pipeline consumes, so they fail if a change
// reintroduces private-API transparency or drops the sidecar entitlement split.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("V5 platform fixes", () => {
  it("keeps the sidecar-only entitlements in a separate plist", () => {
    const sidecar = read("src-tauri/entitlements.sidecar.plist");
    assert.match(
      sidecar,
      /com\.apple\.security\.cs\.disable-library-validation/,
    );
    assert.match(
      sidecar,
      /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
    );
  });

  it("does not enable the macOS private API", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    assert.equal(config.app?.macOSPrivateApi, undefined);
    assert.doesNotMatch(read("src-tauri/Cargo.toml"), /macos-private-api/);
  });

  it("creates the splash window opaque", () => {
    const window = read("src-tauri/src/window.rs");
    assert.doesNotMatch(window, /\.transparent\(/);
    const css = read("src/css/splash.css");
    assert.match(
      css,
      /html\s*,\s*body\.splash-screen|body\.splash-screen\s*\{[^}]*background:\s*var\(--bg-gradient-mid\)/,
    );
  });
});
