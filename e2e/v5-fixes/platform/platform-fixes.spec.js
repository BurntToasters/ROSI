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

// The declarations of every rule whose selector list names `selector` exactly.
// Comments are removed first. Nested blocks such as @media are read by their
// inner rules, since the pattern never matches across a brace.
function declarationsFor(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) =>
      selectors
        .split(",")
        .map((part) => part.trim())
        .includes(selector),
    )
    .map(([, , declarations]) => declarations)
    .join(";");
}

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
    const background = /background:\s*var\(--bg-gradient-mid\)/;
    assert.match(
      declarationsFor(css, "html"),
      background,
      "html does not set an opaque splash background",
    );
    assert.match(
      declarationsFor(css, "body.splash-screen"),
      background,
      "body.splash-screen does not set an opaque splash background",
    );
  });
});
