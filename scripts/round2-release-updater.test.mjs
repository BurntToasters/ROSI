import "./audit4-release.test.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyBundledNotices } from "./copy-bundled-licenses.js";
import { validateStableMetadataChange } from "./check-stable-metadata-pr.mjs";
import { syncChangelogForVersion } from "./sync-version-helpers.js";
import { run as updateMetainfo } from "./update-metainfo.js";
import { validateChangelogForVersion } from "./validate-changelog-version.js";
import {
  assertGpgValidSignature,
  assertDraftReleaseShape,
  requiredDraftBetaManifestNames,
  requiredDraftAssetNames,
  requiredDraftChecksumNames,
  requiredDraftStableManifestNames,
  resolveExpectedGpgSigner,
  validateSha256Sums,
} from "./verify-release-draft.js";
import { RELEASE_LICENSE_SCRIPTS } from "./release-licenses.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const beta = "1.2.3-beta.4";
const stable = "1.2.3";
const primaryFingerprint = "1234567890ABCDEF1234567890ABCDEF12345678";

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function metadataFiles() {
  const base = {
    "package.json": json({
      name: "rosi",
      version: beta,
      dependencies: { tauri: "2" },
    }),
    "package-lock.json": json({
      name: "rosi",
      version: beta,
      packages: {
        "": { name: "rosi", version: beta },
        "node_modules/tauri": { version: "2" },
      },
    }),
    "src-tauri/Cargo.toml": `[package]\nname = "rosi"\nversion = "${beta}"\n\n[dependencies]\ntauri = "2"\n`,
    "src-tauri/Cargo.lock": `[[package]]\nname = "rosi"\nversion = "${beta}"\n\n[[package]]\nname = "tauri"\nversion = "2.0.0"\n`,
    "src-tauri/Info.plist": `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${beta}</string><key>CFBundleVersion</key><string>${beta}</string></dict></plist>\n`,
    "src-tauri/tauri.conf.json": json({
      productName: "ROSI",
      version: beta,
      bundle: { resources: {} },
    }),
    "CHANGELOG.md": `# ROSI\n\n## Changes in \`v${beta}:\`\n\n- Beta notes.\n`,
    "run.rosie.rosi.metainfo.xml": `<component>\n  <launchable type="desktop-id">run.rosie.rosi.desktop</launchable>\n  <url type="homepage">https://example.invalid/rosi</url>\n  <releases>\n    <release version="${beta}" date="2026-01-01"/>\n    <release version="1.2.2-beta.1" date="2025-12-01"/>\n    <release version="1.2.2" date="2025-11-01"/>\n  </releases>\n</component>\n`,
  };
  const head = { ...base };
  head["package.json"] = json({
    ...JSON.parse(base["package.json"]),
    version: stable,
  });
  head["package-lock.json"] = json({
    ...JSON.parse(base["package-lock.json"]),
    version: stable,
    packages: {
      "": { name: "rosi", version: stable },
      "node_modules/tauri": { version: "2" },
    },
  });
  head["src-tauri/Cargo.toml"] = base["src-tauri/Cargo.toml"].replace(
    beta,
    stable,
  );
  head["src-tauri/Cargo.lock"] = base["src-tauri/Cargo.lock"].replace(
    beta,
    stable,
  );
  head["src-tauri/Info.plist"] = base["src-tauri/Info.plist"].replaceAll(
    beta,
    stable,
  );
  head["src-tauri/tauri.conf.json"] = json({
    ...JSON.parse(base["src-tauri/tauri.conf.json"]),
    version: stable,
  });
  head["CHANGELOG.md"] =
    `# ROSI\n\n## Changes in \`v${stable}:\`\n\n- Stable notes.\n\n${base["CHANGELOG.md"]}`;
  head["run.rosie.rosi.metainfo.xml"] =
    `<component>\n  <launchable type="desktop-id">run.rosie.rosi.desktop</launchable>\n  <url type="homepage">https://example.invalid/rosi</url>\n  <releases>\n    <release version="${stable}" date="2026-02-01"/>\n    <release version="1.2.2-beta.1" date="2025-12-01"/>\n    <release version="1.2.2" date="2025-11-01"/>\n  </releases>\n</component>\n`;
  return { base, head };
}

function metadataChanges({ base, head } = metadataFiles()) {
  return Object.keys(base).map((file) => ({
    path: file,
    status: "M",
    baseText: base[file],
    headText: head[file],
  }));
}

function realStablePromotionFixture() {
  const betaVersion = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const stableVersion = betaVersion.replace(/-beta\.\d+$/u, "");
  assert.notEqual(stableVersion, betaVersion, "fixture must start on a beta");

  const { base, head } = metadataFiles();
  for (const files of [base, head]) {
    for (const file of Object.keys(files)) {
      files[file] = files[file]
        .replaceAll(beta, betaVersion)
        .replaceAll(stable, stableVersion);
    }
  }

  const changelogPath = path.join(root, "CHANGELOG.md");
  const betaChangelog = fs.readFileSync(changelogPath, "utf8");
  const betaCallout =
    /^> \[!NOTE\]\r?\n> 🅱️ This is a Beta build\.\r?\n(?:\r?\n)?/mu;
  assert.match(betaChangelog, betaCallout);
  const calloutRemoved = betaChangelog.replace(betaCallout, "");
  const synced = syncChangelogForVersion(calloutRemoved, stableVersion);
  const placeholder = "- **Fix:** (add release notes)";
  assert.equal(synced.split(placeholder).length - 1, 1);
  const stableNotes =
    "- **Fix:** Stable promotion release notes.\n" +
    "- **Security:** Stable release metadata and updater signatures verified.";
  const stableChangelog = synced.replace(placeholder, stableNotes);
  assert.deepEqual(
    validateChangelogForVersion(stableChangelog, stableVersion),
    [],
  );
  base["CHANGELOG.md"] = betaChangelog;
  head["CHANGELOG.md"] = stableChangelog;
  return { base, head, betaVersion, stableVersion, stableChangelog };
}

test("stable metadata accepts the actual sync-version changelog promotion", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  assert.doesNotThrow(() =>
    validateStableMetadataChange({
      baseVersion: betaVersion,
      headVersion: stableVersion,
      changedFiles: metadataChanges({ base, head }),
    }),
  );
});

test("stable metadata rejects edits to existing changelog release history", () => {
  const { base, head, betaVersion, stableVersion, stableChangelog } =
    realStablePromotionFixture();
  const tampered = stableChangelog.replace(
    "ROSI moved from Electron to Tauri V2",
    "ROSI moved from another framework to Tauri V2",
  );
  assert.notEqual(tampered, stableChangelog);
  const changedHead = { ...head, "CHANGELOG.md": tampered };
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: changedHead }),
      }),
    /CHANGELOG.*only|only.*CHANGELOG|non-release/i,
  );
});

test("stable metainfo permits only insertion of the expected release element", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const changedMetainfo = {
    ...head,
    "run.rosie.rosi.metainfo.xml": head["run.rosie.rosi.metainfo.xml"].replace(
      "</component>",
      '<launchable type="desktop-id">attacker.desktop</launchable></component>',
    ),
  };

  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: changedMetainfo }),
      }),
    /metainfo.*only|only.*metainfo|non-release/i,
  );
});

test("stable metadata accepts the exact AppStream updater promotion output", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-round2-metainfo-"));
  try {
    const packagePath = path.join(temp, "package.json");
    const metadataPath = path.join(temp, "run.rosie.rosi.metainfo.xml");
    fs.writeFileSync(
      packagePath,
      json({ name: "rosi", version: stableVersion }),
    );
    fs.writeFileSync(metadataPath, base["run.rosie.rosi.metainfo.xml"]);
    updateMetainfo({
      now: new Date("2026-02-01T00:00:00.000Z"),
      packagePath,
      metadataPath,
    });
    const generatedMetainfo = fs.readFileSync(metadataPath, "utf8");
    const generatedHead = {
      ...head,
      "run.rosie.rosi.metainfo.xml": generatedMetainfo,
    };
    validateStableMetadataChange({
      baseVersion: betaVersion,
      headVersion: stableVersion,
      changedFiles: metadataChanges({ base, head: generatedHead }),
    });
    assert.match(generatedMetainfo, /version="1\.2\.2-beta\.1"/u);
    assert.doesNotMatch(
      generatedMetainfo,
      new RegExp(betaVersion.replaceAll(".", "\\."), "u"),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("stable metadata rejects dependency/config changes and every deletion", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const dependencyHead = {
    ...head,
    "package.json": json({
      ...JSON.parse(head["package.json"]),
      dependencies: { tauri: "3" },
    }),
  };
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: dependencyHead }),
      }),
    /package\.json.*non-version|non-version.*package\.json/i,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: [
          ...metadataChanges({ base, head }),
          {
            path: "scripts/release.js",
            status: "M",
            baseText: "old",
            headText: "new",
          },
        ],
      }),
    /unexpected|not release metadata/i,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: [
          ...metadataChanges({ base, head }),
          {
            path: "src-tauri/tauri.conf.json",
            status: "D",
            baseText: "present",
          },
        ],
      }),
    /delet/i,
  );
});

test("release checksum entries must match the released asset bytes", () => {
  const contents = Buffer.from("signed release artifact\n");
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  const assets = new Map([["ROSI-Windows-x64.exe", contents]]);
  assert.deepEqual(
    validateSha256Sums({
      checksumName: "SHA256SUMS-windows-x86_64.txt",
      text: `${digest}  ROSI-Windows-x64.exe\n`,
      assets,
    }),
    ["ROSI-Windows-x64.exe"],
  );
  for (const text of [
    `${"0".repeat(64)}  ROSI-Windows-x64.exe\n`,
    `${digest}  missing.exe\n`,
    `${digest}  ../ROSI-Windows-x64.exe\n`,
    `${digest}  ROSI-Windows-x64.exe\n${digest}  ROSI-Windows-x64.exe\n`,
    "not a checksum line\n",
  ]) {
    assert.throws(() =>
      validateSha256Sums({
        checksumName: "SHA256SUMS-windows-x86_64.txt",
        text,
        assets,
      }),
    );
  }
});

test("every required stable and beta manifest has a signed checksum bucket", () => {
  const checksums = new Set(requiredDraftChecksumNames());
  const manifests = [
    ...requiredDraftStableManifestNames(),
    ...requiredDraftBetaManifestNames(),
  ];

  for (const manifest of manifests) {
    const target = manifest.slice("latest-".length, -".json".length);
    const checksum = `SHA256SUMS-${target}.txt`;
    assert.ok(checksums.has(checksum), `${manifest} needs ${checksum}`);
    assert.ok(
      checksums.has(`${checksum}.asc`),
      `${checksum} needs a GPG signature`,
    );
  }
});

test("draft GPG trust resolves only one configured key and validates signer identity", () => {
  assert.throws(() => resolveExpectedGpgSigner({ keyId: "" }), /GPG_KEY_ID/i);
  const keyListing = [
    "pub:u:1:22:ABCDEF1234567890:0:0:::::sc:",
    `fpr:::::::::${primaryFingerprint}:`,
    "sub:u:1:22:9999AAAABBBBCCCC:0:0:::::s:",
    "fpr:::::::::9999AAAABBBBCCCC9999AAAABBBBCCCC9999AAAA:",
  ].join("\n");
  assert.equal(
    resolveExpectedGpgSigner({
      keyId: "ABCDEF1234567890",
      spawn: () => ({ status: 0, stdout: keyListing, stderr: "" }),
    }),
    primaryFingerprint,
  );
  assert.doesNotThrow(() =>
    assertGpgValidSignature({
      statusOutput: `[GNUPG:] VALIDSIG 9999AAAABBBBCCCC9999AAAABBBBCCCC9999AAAA 2026-01-01 1 0 4 0 1 10 00 ${primaryFingerprint}`,
      expectedFingerprint: primaryFingerprint,
    }),
  );
  assert.throws(
    () =>
      assertGpgValidSignature({
        statusOutput: `[GNUPG:] VALIDSIG ${"9".repeat(40)} 2026-01-01 1 0 4 0 1 10 00 ${"9".repeat(40)}`,
        expectedFingerprint: primaryFingerprint,
      }),
    /trusted|signer|fingerprint/i,
  );
  assert.throws(
    () =>
      assertGpgValidSignature({
        statusOutput: "[GNUPG:] BADSIG ABCDEF1234567890 Wrong Signer",
        expectedFingerprint: primaryFingerprint,
      }),
    /valid|signature|signer/i,
  );
});

test("bundled notices copy version-matched yt-dlp text to frontend assets", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-round2-licenses-"));
  try {
    fs.mkdirSync(path.join(temp, "assets"), { recursive: true });
    fs.mkdirSync(path.join(temp, "resources", "ffmpeg"), { recursive: true });
    fs.writeFileSync(
      path.join(temp, "assets", "YT-DLP-NOTICES.txt"),
      "yt-dlp notice\n",
    );
    fs.writeFileSync(
      path.join(temp, "assets", "yt-dlp-2026.08.19-THIRD_PARTY_LICENSES.txt"),
      "yt-dlp upstream bundled component licenses, 2026.08.19\n",
    );
    for (const file of [
      "NOTICE.txt",
      "ffmpeg_license.txt",
      "SOURCE_OFFER.txt",
    ]) {
      fs.writeFileSync(
        path.join(temp, "resources", "ffmpeg", file),
        `${file}\n`,
      );
    }
    const entries = copyBundledNotices(temp);
    const packagedNotice = path.join(
      temp,
      "public",
      "yt-dlp-third-party-licenses.txt",
    );
    assert.equal(
      fs.readFileSync(packagedNotice, "utf8"),
      "yt-dlp upstream bundled component licenses, 2026.08.19\n",
    );
    assert.ok(
      entries.some((entry) => entry.file === "yt-dlp-third-party-licenses.txt"),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("release license gate keeps strict Cargo 3.9 source coverage mandatory", () => {
  assert.ok(RELEASE_LICENSE_SCRIPTS.includes("licenses:cargo:strict"));
  assert.match(
    fs.readFileSync(path.join(root, "scripts", "release-licenses.js"), "utf8"),
    /licenses:cargo:strict/,
  );
});

test("draft release rejects a tag peeled to a different commit than HEAD", () => {
  const head = "a".repeat(40);
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release: {
          draft: true,
          prerelease: true,
          target_commitish: head,
        },
        assetNames: requiredDraftAssetNames(),
        version: "5.0.0-beta.2",
        headCommit: head,
        tagCommit: "b".repeat(40),
      }),
    /tag.*commit|commit.*tag/i,
  );
});

test("release tag resolution peels annotated tags and fails closed on mismatch", () => {
  const {
    resolveReleaseTagCommit,
    assertReleaseTagMatchesHead,
  } = require("./release-git-tag.cjs");
  const head = "a".repeat(40);
  const tagObject = "b".repeat(40);
  const nestedTagObject = "c".repeat(40);
  const calls = [];
  const api = (method, endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith("/git/ref/tags/v5.0.0-beta.2")) {
      return { object: { type: "tag", sha: tagObject } };
    }
    if (endpoint.endsWith(`/git/tags/${tagObject}`)) {
      return { object: { type: "tag", sha: nestedTagObject } };
    }
    if (endpoint.endsWith(`/git/tags/${nestedTagObject}`)) {
      return { object: { type: "commit", sha: head } };
    }
    throw new Error(`unexpected GitHub request ${method} ${endpoint}`);
  };
  assert.equal(
    resolveReleaseTagCommit({
      owner: "BurntToasters",
      repo: "ROSI",
      tag: "v5.0.0-beta.2",
      api,
    }),
    head,
  );
  assert.equal(calls.length, 3, "all annotated tag objects must be peeled");
  assert.throws(
    () =>
      assertReleaseTagMatchesHead({
        owner: "BurntToasters",
        repo: "ROSI",
        tag: "v5.0.0-beta.2",
        headCommit: "d".repeat(40),
        api,
      }),
    /tag.*commit|commit.*tag/i,
  );
  assert.equal(
    resolveReleaseTagCommit({
      owner: "BurntToasters",
      repo: "ROSI",
      tag: "v5.0.0-beta.2",
      api: () => {
        const missing = new Error("HTTP 404");
        missing.statusCode = 404;
        throw missing;
      },
    }),
    null,
    "a not-yet-created draft tag can be distinguished from API failure",
  );
});

test("direct release publication runs shared preflight after draft verification and before PATCH", () => {
  const source = fs.readFileSync(
    path.join(root, "scripts", "publish-release.cjs"),
    "utf8",
  );
  const mainStart = source.indexOf("async function main()");
  assert.notEqual(mainStart, -1, "publisher main function must be inspectable");
  const mainBody = source.slice(mainStart);
  const verify = mainBody.indexOf("runVerifyDraft();");
  const preflight = mainBody.indexOf("runReleasePreflight();");
  const patch = mainBody.indexOf('"PATCH"');
  assert.match(source, /release-preflight\.js/u);
  assert.ok(verify >= 0 && verify < preflight);
  assert.ok(preflight >= 0 && preflight < patch);
});
