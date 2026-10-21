// Acceptance for scripts/msstore-pack.js (failure modes in
// scripts/msstore-pack.failure-modes.md). The F-numbers match that file. The
// pure parts run anywhere; makeappx itself needs Windows and is not called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as pack from "./msstore-pack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const SCRIPT = path.join(here, "msstore-pack.js");
const TEMPLATE = path.join(
  root,
  "src-tauri",
  "msstore-assets",
  "AppxManifest.xml",
);
const ASSETS = path.join(root, "src-tauri", "msstore-assets");
const TAURI_CONF = path.join(root, "src-tauri", "tauri.conf.json");
const CARGO_TOML = path.join(root, "src-tauri", "Cargo.toml");
const PACKAGE_JSON = path.join(root, "package.json");
const MSSTORE_DIR = path.join(root, "msstore");
const RUST_X64 = "x86_64-pc-windows-msvc";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readTemplate = () => fs.readFileSync(TEMPLATE, "utf8");
const scripts = () => readJson(PACKAGE_JSON).scripts;

function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-msstore-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const VALUES = {
  IDENTITY_NAME: "BurntToasters.ROSI",
  PUBLISHER: "CN=BC0CB990-55E8-4580-97B7-1E2DAA4B44F6",
  PUBLISHER_DISPLAY_NAME: "BurntToasters",
  VERSION: "5.0.0.0",
  ARCH: "x64",
  DESCRIPTION: "Cross-platform yt-dlp GUI",
  EXECUTABLE: "rosi.exe",
};

test("F6: a prerelease version is refused for Store packages", () => {
  assert.throws(() => pack.toStoreVersion("5.0.0-beta.4"), /must be stable/);
});

test("F7: --allow-prerelease maps a prerelease to X.Y.Z.0 for local tests", () => {
  assert.equal(
    pack.toStoreVersion("5.0.0-beta.4", { allowPrerelease: true }),
    "5.0.0.0",
  );
});

test("F8: a stable version maps to X.Y.Z.0 with or without the flag", () => {
  assert.equal(pack.toStoreVersion("5.0.0"), "5.0.0.0");
  assert.equal(
    pack.toStoreVersion("5.0.0", { allowPrerelease: true }),
    "5.0.0.0",
  );
});

test("F9: versions that are not three parts are refused", () => {
  assert.throws(() => pack.toStoreVersion("5.0"), /X\.Y\.Z/);
  assert.throws(() => pack.toStoreVersion("5.0.0.0"), /X\.Y\.Z/);
  assert.throws(() => pack.toStoreVersion(""), /X\.Y\.Z/);
});

test("F10: a component above 65535 is refused", () => {
  assert.throws(() => pack.toStoreVersion("65536.0.0"), /65535/);
  assert.equal(pack.toStoreVersion("5.65535.0"), "5.65535.0.0");
});

test("F11: build metadata is refused", () => {
  assert.throws(() => pack.toStoreVersion("5.0.0+abc"), /X\.Y\.Z/);
});

test("F12: versions not above ROSI 4's Store version 4.4.1.0 are refused", () => {
  assert.equal(pack.STORE_BASELINE_VERSION, "4.4.1.0");
  assert.throws(() => pack.toStoreVersion("4.4.1"), /greater than the ROSI 4/);
  assert.throws(() => pack.toStoreVersion("4.3.9"), /greater than the ROSI 4/);
  assert.equal(pack.toStoreVersion("4.4.2"), "4.4.2.0");
  assert.equal(pack.toStoreVersion("4.5.0"), "4.5.0.0");
});

test("F13: the revision is always 0, never the sync-version 65535", () => {
  for (const version of ["5.0.0", "5.1.2", "4.4.2"]) {
    assert.match(pack.toStoreVersion(version), /\.0$/);
  }
});

test("F14/F15: arguments are parsed and bad ones refused", () => {
  assert.deepEqual(pack.parseArgs([]), { arch: null, allowPrerelease: false });
  assert.deepEqual(pack.parseArgs(["x64", "--allow-prerelease"]), {
    arch: "x64",
    allowPrerelease: true,
  });
  assert.deepEqual(pack.parseArgs(["arm64"]), {
    arch: "arm64",
    allowPrerelease: false,
  });
  assert.throws(() => pack.parseArgs(["--allow-prereleas"]), /Unknown option/);
  assert.throws(() => pack.parseArgs(["ia32"]), /Unknown architecture/);
  assert.throws(() => pack.parseArgs(["X64"]), /Unknown architecture/);
  assert.throws(
    () => pack.parseArgs(["x64", "arm64"]),
    /Only one architecture/,
  );
});

test("F16: missing or blank MSSTORE variables are all listed", () => {
  assert.throws(
    () => pack.readStoreEnv({ MSSTORE_PUBLISHER_DISPLAY_NAME: "   " }),
    (error) =>
      /MSSTORE_IDENTITY_NAME/.test(error.message) &&
      /MSSTORE_PUBLISHER:/.test(error.message) &&
      /MSSTORE_PUBLISHER_DISPLAY_NAME/.test(error.message),
  );
});

test("F17: a publisher that is not a CN= subject is refused", () => {
  assert.throws(
    () =>
      pack.readStoreEnv({
        MSSTORE_IDENTITY_NAME: "BurntToasters.ROSI",
        MSSTORE_PUBLISHER: "BC0CB990",
        MSSTORE_PUBLISHER_DISPLAY_NAME: "BurntToasters",
      }),
    /CN=/,
  );
});

test("F18: identity names with characters outside letters, digits, dot and dash are refused", () => {
  const base = {
    MSSTORE_PUBLISHER: "CN=X",
    MSSTORE_PUBLISHER_DISPLAY_NAME: "X",
  };
  assert.throws(
    () =>
      pack.readStoreEnv({
        ...base,
        MSSTORE_IDENTITY_NAME: "Burnt Toasters_ROSI",
      }),
    /MSSTORE_IDENTITY_NAME/,
  );
  const ok = pack.readStoreEnv({
    ...base,
    MSSTORE_IDENTITY_NAME: "BurntToasters.ROSI",
  });
  assert.equal(ok.identityName, "BurntToasters.ROSI");
  assert.equal(ok.publisher, "CN=X");
  assert.equal(ok.publisherDisplayName, "X");
});

test("F19: manifest values are XML-escaped", () => {
  const rendered = pack.renderManifest(readTemplate(), {
    ...VALUES,
    DESCRIPTION: `A & B <x> "y" 'z'`,
  });
  assert.match(rendered, /A &amp; B &lt;x&gt; &quot;y&quot; &apos;z&apos;/);
  assert.doesNotMatch(rendered, /<x>/);
});

test("F20: a template placeholder without a value is refused", () => {
  const { VERSION: _omit, ...partial } = VALUES;
  assert.throws(() => pack.renderManifest(readTemplate(), partial), /VERSION/);
});

test("F21: a value that would leave a placeholder in the output is refused", () => {
  assert.throws(
    () =>
      pack.renderManifest(readTemplate(), {
        ...VALUES,
        DESCRIPTION: "{{NOPE}}",
      }),
    /template text/,
  );
});

test("F22: the rendered Executable is the exe file name", () => {
  const rendered = pack.renderManifest(readTemplate(), VALUES);
  assert.match(rendered, /Executable="rosi\.exe"/);
  assert.match(rendered, /Name="BurntToasters\.ROSI"/);
  assert.match(rendered, /Publisher="CN=BC0CB990-55E8-4580-97B7-1E2DAA4B44F6"/);
  assert.match(rendered, /Version="5\.0\.0\.0"/);
  assert.match(rendered, /ProcessorArchitecture="x64"/);
});

test("F23: the manifest keeps internetClient, drops the startup task, and sets the device family", () => {
  const template = readTemplate();
  assert.match(template, /<Capability Name="internetClient" \/>/);
  assert.match(template, /rescap:Capability Name="runFullTrust"/);
  assert.doesNotMatch(template, /startupTask/);
  assert.match(template, /MinVersion="10\.0\.19041\.0"/);
  assert.match(template, /MaxVersionTested="10\.0\.26100\.0"/);
  assert.match(template, /<DisplayName>ROSI<\/DisplayName>/);
});

test("F24: a manifest asset that was not copied is refused", () => {
  withTemp((dir) => {
    const rendered = pack.renderManifest(readTemplate(), VALUES);
    fs.mkdirSync(path.join(dir, "Assets"));
    for (const file of fs.readdirSync(ASSETS)) {
      if (file.endsWith(".png"))
        fs.copyFileSync(
          path.join(ASSETS, file),
          path.join(dir, "Assets", file),
        );
    }
    assert.doesNotThrow(() => pack.assertManifestAssets(rendered, dir));
    fs.rmSync(path.join(dir, "Assets", "StoreLogo.png"));
    assert.throws(
      () => pack.assertManifestAssets(rendered, dir),
      /StoreLogo\.png/,
    );
  });
});

test("F25: the restored ROSI 4 PNGs have the PNG signature and the template's assets exist", () => {
  const pngs = fs.readdirSync(ASSETS).filter((file) => file.endsWith(".png"));
  assert.equal(pngs.length, 7);
  for (const file of pngs) {
    const bytes = fs.readFileSync(path.join(ASSETS, file));
    assert.equal(pack.isPngBytes(bytes), true, `${file} is not a PNG`);
  }
  for (const ref of pack.manifestAssetRefs(readTemplate())) {
    assert.ok(
      fs.existsSync(path.join(ASSETS, ref.split("\\").pop())),
      `${ref} missing`,
    );
  }
});

test("F26: only PNG files are listed for copying, and a bad PNG is refused", () => {
  withTemp((dir) => {
    fs.writeFileSync(
      path.join(dir, "Logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    fs.writeFileSync(path.join(dir, "AppxManifest.xml"), "<x/>");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
    assert.deepEqual(pack.listPngAssets(dir), ["Logo.png"]);
    fs.writeFileSync(path.join(dir, "Broken.png"), "nope");
    assert.throws(() => pack.listPngAssets(dir), /Broken\.png/);
  });
});

function sidecarFixture(
  dir,
  { rustTarget = RUST_X64, contents = {}, stub = {}, manifestOverride } = {},
) {
  const manifest = {};
  for (const name of pack.SIDECAR_NAMES) {
    const fileName = `${name}-${rustTarget}.exe`;
    const bytes = contents[name] ?? Buffer.from(`real ${name} binary`);
    fs.writeFileSync(path.join(dir, fileName), bytes);
    manifest[fileName] = {
      sha256: sha256(bytes),
      stub: stub[name] ?? false,
      source: "test",
    };
  }
  return { manifest: manifestOverride ? manifestOverride(manifest) : manifest };
}

test("F27: a missing sidecar is refused and named", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir);
    fs.rmSync(path.join(dir, `rosi-ffmpeg-${RUST_X64}.exe`));
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /rosi-ffmpeg-x86_64-pc-windows-msvc\.exe[\s\S]*prepare:sidecars/,
    );
  });
});

test("F28: a sidecar missing from the manifest is refused", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir, {
      manifestOverride: (m) => {
        delete m[`rosi-ffprobe-${RUST_X64}.exe`];
        return m;
      },
    });
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /ffprobe/,
    );
  });
});

test("F29: a manifest entry marked as a stub is refused", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir, { stub: { "rosi-ffmpeg": true } });
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /stub/,
    );
  });
});

test("F30: a small file with the stub marker is refused even when the manifest says real", () => {
  withTemp((dir) => {
    const stubBytes = Buffer.from(
      "#!/bin/sh\n# ROSI-SIDECAR-STUB: rosi-ffmpeg\nexit 127\n",
    );
    const { manifest } = sidecarFixture(dir, {
      contents: { "rosi-ffmpeg": stubBytes },
    });
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /stub marker/,
    );
  });
});

test("F31: a large real binary that mentions the marker is not a stub", () => {
  const big = Buffer.concat([
    Buffer.alloc(5000, 0x41),
    Buffer.from("ROSI-SIDECAR-STUB"),
  ]);
  assert.equal(pack.isStubBytes(big), false);
  assert.equal(pack.isStubBytes(Buffer.from("# ROSI-SIDECAR-STUB")), true);
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir, {
      contents: { "rosi-yt-dlp": big },
    });
    assert.equal(
      pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest })
        .length,
      3,
    );
  });
});

test("F32: a sidecar that changed after prepare is refused by sha256", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir);
    fs.writeFileSync(path.join(dir, `rosi-yt-dlp-${RUST_X64}.exe`), "tampered");
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /sha256/,
    );
  });
});

test("F33: the plan uses the target triple, so an arm64 sidecar is never used for x64", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir, {
      rustTarget: "aarch64-pc-windows-msvc",
    });
    assert.throws(
      () =>
        pack.planSidecars({ binariesDir: dir, rustTarget: RUST_X64, manifest }),
      /x86_64-pc-windows-msvc/,
    );
  });
});

test("sidecar plan maps each prepared file to its name next to the exe", () => {
  withTemp((dir) => {
    const { manifest } = sidecarFixture(dir);
    const plan = pack.planSidecars({
      binariesDir: dir,
      rustTarget: RUST_X64,
      manifest,
    });
    assert.deepEqual(
      plan.map((entry) => entry.to),
      ["rosi-yt-dlp.exe", "rosi-ffmpeg.exe", "rosi-ffprobe.exe"],
    );
  });
});

test("F34: the real bundle.resources config plans every notice into the package", () => {
  const plan = pack.planResources({
    tauriConf: readJson(TAURI_CONF),
    srcTauriDir: path.join(root, "src-tauri"),
    packDir: "/pack",
  });
  assert.equal(plan.length, 5);
  const targets = plan.map((entry) => entry.rel);
  assert.ok(targets.includes("yt-dlp/YT-DLP-NOTICES.txt"));
  assert.ok(targets.includes("ffmpeg/LICENSE.txt"));
  assert.ok(targets.includes("ffmpeg/SOURCE_OFFER.txt"));
});

test("F34b: missing resource sources are all listed", () => {
  const conf = {
    bundle: {
      resources: { "../nope-a.txt": "a.txt", "../nope-b.txt": "b.txt" },
    },
  };
  assert.throws(
    () =>
      pack.planResources({
        tauriConf: conf,
        srcTauriDir: path.join(root, "src-tauri"),
        packDir: "/pack",
      }),
    (error) =>
      /nope-a\.txt/.test(error.message) && /nope-b\.txt/.test(error.message),
  );
});

test("F35: resource destinations that leave the app folder are refused", () => {
  for (const dest of ["../escape.txt", "/abs/escape.txt", "C:\\escape.txt"]) {
    const conf = { bundle: { resources: { "../LICENSE": dest } } };
    assert.throws(
      () =>
        pack.planResources({
          tauriConf: conf,
          srcTauriDir: path.join(root, "src-tauri"),
          packDir: "/pack",
        }),
      /inside the app folder/,
      dest,
    );
  }
});

test("F36: a bundle.resources list instead of a map is refused", () => {
  const conf = { bundle: { resources: ["../LICENSE"] } };
  assert.throws(
    () =>
      pack.planResources({
        tauriConf: conf,
        srcTauriDir: path.join(root, "src-tauri"),
        packDir: "/pack",
      }),
    /object map/,
  );
});

test("F38: a non-Windows host gets the Windows SDK message", () => {
  assert.throws(
    () => pack.locateMakeappx({ platform: "darwin" }),
    (error) => /Windows/.test(error.message) && /makeappx/.test(error.message),
  );
});

test("F2: a Windows host without makeappx or the SDK is refused", () => {
  assert.throws(
    () =>
      pack.locateMakeappx({
        platform: "win32",
        programFiles: "C:\\Program Files (x86)",
        findOnPath: () => null,
        exists: () => false,
        listDirs: () => [],
      }),
    /Windows SDK/,
  );
});

test("F3: the highest installed SDK version with makeappx is chosen", () => {
  const seen = [];
  const found = pack.locateMakeappx({
    platform: "win32",
    programFiles: "C:\\Program Files (x86)",
    findOnPath: () => null,
    listDirs: () => [
      "10.0.19041.0",
      "10.0.26100.0",
      "10.0.22621.0",
      "not-a-version",
    ],
    exists: (file) => {
      seen.push(file);
      return true;
    },
  });
  assert.equal(
    found,
    "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\makeappx.exe",
  );
  assert.equal(seen.length, 1);
});

test("a makeappx found on PATH is used first", () => {
  assert.equal(
    pack.locateMakeappx({
      platform: "win32",
      findOnPath: () => "C:\\sdk\\makeappx.exe",
      exists: () => false,
      listDirs: () => [],
    }),
    "C:\\sdk\\makeappx.exe",
  );
});

test("the script refuses a non-Windows host before creating msstore/", () => {
  if (process.platform === "win32") return;
  const existedBefore = fs.existsSync(MSSTORE_DIR);
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows/);
  assert.match(result.stderr, /makeappx/);
  assert.equal(fs.existsSync(MSSTORE_DIR), existedBefore);
});

test("the package.json Store scripts build no-bundle with the Store channel, then pack", () => {
  const s = scripts();
  for (const [name, triple] of [
    ["build:msstore:win:x64", "x86_64-pc-windows-msvc"],
    ["build:msstore:win:arm64", "aarch64-pc-windows-msvc"],
  ]) {
    assert.match(s[name], /tauri-windows-build\.js --msstore --target /, name);
    assert.ok(s[name].includes(triple), name);
    assert.match(s[name], /--no-bundle/, name);
    assert.doesNotMatch(s[name], /--bundles/, name);
  }
  for (const name of [
    "build:msstore",
    "build:msstore:x64",
    "build:msstore:arm64",
  ]) {
    assert.match(s[name], /prepare:sidecars/, name);
    assert.match(s[name], /msstore-pack\.js/, name);
    assert.doesNotMatch(s[name], /nsis/, name);
  }
  assert.match(s["build:msstore:x64"], /msstore-pack\.js x64$/);
  assert.match(s["build:msstore:arm64"], /msstore-pack\.js arm64$/);
  assert.match(s["build:msstore"], /msstore-pack\.js$/);
});

test("the cargo-safe-update test list includes this file and the e2e-only test", () => {
  const list = scripts()["test:cargo-safe-update"];
  assert.ok(list.includes("scripts/msstore-pack.test.mjs"));
  assert.ok(list.includes("scripts/test-e2e-only.test.mjs"));
});

test("the Cargo package name is the exe name (rosi)", () => {
  assert.equal(
    pack.cargoPackageName(fs.readFileSync(CARGO_TOML, "utf8")),
    "rosi",
  );
});
