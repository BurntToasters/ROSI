/**
 * Failure modes for the ROSI 4 update feed that every ROSI 5 release carries,
 * written before scripts/legacy-v4-feed.js. Each test lists the ids it covers.
 *
 * missing-file      A v4 feed file is absent, so that platform's v4 updater
 *                   fails with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND.
 * bare-url          A file url or `path` still resolves inside the v5 release,
 *                   where ROSI-Windows-x64.exe and ROSI-MacOS-universal.zip are
 *                   v5 builds.
 * absolute-url      An absolute URL gets the v5 download path prepended.
 * unsafe-name       A name with "/", "\", "..", "?", "#", "%" or a space moves
 *                   the resolved URL somewhere else.
 * wrong-target      The feed points at a v4 prerelease, a draft, a v5 tag, or
 *                   a tag other than the configured one.
 * version-mismatch  The feed version differs from the release it points at.
 * hash-lost         sha512 or size changes during the rewrite.
 * extra-keys        Source keys ROSI 4 does not need leak into the feed.
 * bad-yaml          Output that js-yaml, electron-updater's parser, reads
 *                   differently than intended.
 * missing-asset     The feed names a file the v4 release lacks or with a
 *                   different size.
 * gate-missing      The draft gate accepts a draft without the feed files.
 * gate-content      The draft gate accepts feed files that point elsewhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  LEGACY_FEED_FILES,
  assertLegacyFeedAssets,
  assertLegacySourceRelease,
  buildLegacyFeed,
  readLegacyFeedConfig,
  validateLegacyFeed,
} from "./legacy-v4-feed.js";
import {
  assertDraftReleaseShape,
  requiredDraftAssetNames,
} from "./verify-release-draft.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "testdata", "legacy-v4", "v4.3.2");
const SOURCE_TAG = "v4.3.2";
const sources = Object.fromEntries(
  LEGACY_FEED_FILES.map((name) => [
    name,
    fs.readFileSync(path.join(fixtureDir, name), "utf8"),
  ]),
);
const sourceRelease = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "release.json"), "utf8"),
);

/**
 * electron-updater 6.8.9 GitHubProvider.resolveFiles, reimplemented so the
 * test does not trust the module under test: getBaseDownloadPath(tag, url)
 * joined onto https://github.com with `new URL`.
 */
function resolveLikeElectronUpdater(releaseTag, fileUrl) {
  const pathname = `/BurntToasters/ROSI/releases/download/${releaseTag}/${fileUrl.replace(/ /g, "-")}`;
  return new URL(pathname, "https://github.com").href;
}

function withSource(name, mutate) {
  const parsed = yaml.load(sources[name]);
  mutate(parsed);
  return { ...sources, [name]: yaml.dump(parsed) };
}

test("the feed covers every channel file electron-updater requests (missing-file)", () => {
  assert.deepEqual([...LEGACY_FEED_FILES].sort(), [
    "latest-linux-arm64.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ]);
  for (const name of LEGACY_FEED_FILES) {
    const partial = { ...sources };
    delete partial[name];
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: partial }),
      new RegExp(name.replace(/\./g, "\\.")),
    );
  }
});

test("rewritten URLs resolve to the v4 release from any v5 tag (bare-url, hash-lost, bad-yaml, missing-asset)", () => {
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  assert.deepEqual(Object.keys(feed).sort(), [...LEGACY_FEED_FILES].sort());
  const sizes = new Map(
    sourceRelease.assets.map((asset) => [asset.name, asset.size]),
  );
  for (const name of LEGACY_FEED_FILES) {
    const out = yaml.load(feed[name]);
    const src = yaml.load(sources[name]);
    assert.equal(out.version, "4.3.2", name);
    assert.equal(out.sha512, src.sha512, `${name} sha512`);
    assert.equal(out.path, `../${SOURCE_TAG}/${src.path}`, `${name} path`);
    assert.equal(out.files.length, src.files.length, `${name} files`);
    out.files.forEach((file, index) => {
      const original = src.files[index];
      assert.equal(file.url, `../${SOURCE_TAG}/${original.url}`);
      assert.equal(file.sha512, original.sha512);
      assert.equal(file.size, original.size);
      assert.equal(file.blockMapSize, original.blockMapSize);
      for (const releaseTag of ["v5.0.0", "v5.0.0-beta.1", "v5.12.3"]) {
        assert.equal(
          resolveLikeElectronUpdater(releaseTag, file.url),
          `https://github.com/BurntToasters/ROSI/releases/download/${SOURCE_TAG}/${original.url}`,
        );
      }
      assert.equal(sizes.get(original.url), original.size, original.url);
    });
    assert.doesNotThrow(() =>
      validateLegacyFeed({ name, text: feed[name], sourceTag: SOURCE_TAG }),
    );
  }
  assert.doesNotThrow(() =>
    assertLegacyFeedAssets({
      feed,
      sourceTag: SOURCE_TAG,
      assets: sourceRelease.assets,
    }),
  );
});

test("absolute and unsafe source URLs are refused (absolute-url, unsafe-name)", () => {
  const bad = [
    "https://example.com/ROSI-Windows.exe",
    "//example.com/ROSI-Windows.exe",
    "../v4.3.1/ROSI-Windows.exe",
    "sub/ROSI-Windows.exe",
    "sub\\ROSI-Windows.exe",
    "ROSI Windows.exe",
    "ROSI-Windows.exe?x=1",
    "ROSI-Windows.exe#frag",
    "ROSI%2FWindows.exe",
    "..",
    "",
  ];
  for (const url of bad) {
    const mutated = withSource("latest.yml", (parsed) => {
      parsed.files[0].url = url;
    });
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
      /file name/i,
      JSON.stringify(url),
    );
  }
  const badPath = withSource("latest-mac.yml", (parsed) => {
    parsed.path = "https://example.com/x.zip";
  });
  assert.throws(
    () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: badPath }),
    /file name/i,
  );
});

test("a source feed whose version differs from the tag is refused (version-mismatch)", () => {
  const mutated = withSource("latest-linux.yml", (parsed) => {
    parsed.version = "4.3.1";
  });
  assert.throws(
    () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
    /4\.3\.1.*v4\.3\.2|v4\.3\.2.*4\.3\.1/,
  );
});

test("missing hashes or sizes are refused (hash-lost)", () => {
  for (const key of ["sha512", "size"]) {
    const mutated = withSource("latest.yml", (parsed) => {
      delete parsed.files[1][key];
    });
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
      new RegExp(key),
    );
  }
});

test("only keys electron-updater uses are kept (extra-keys)", () => {
  const mutated = withSource("latest-mac.yml", (parsed) => {
    parsed.releaseNotes = "## v4 notes";
    parsed.somethingElse = true;
    parsed.minimumSystemVersion = "12.0.0";
  });
  const out = yaml.load(
    buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated })[
      "latest-mac.yml"
    ],
  );
  assert.equal(out.releaseNotes, undefined);
  assert.equal(out.somethingElse, undefined);
  assert.equal(out.minimumSystemVersion, "12.0.0");
  assert.equal(
    out.releaseDate,
    yaml.load(sources["latest-mac.yml"]).releaseDate,
  );
});

test("the source release must be a published ROSI 4 release (wrong-target)", () => {
  const ok = { tag_name: "v4.3.2", draft: false, prerelease: false };
  assert.doesNotThrow(() => assertLegacySourceRelease(ok, "v4.3.2"));
  const cases = [
    [{ ...ok, tag_name: "v4.3.3-beta.1", prerelease: true }, "v4.3.3-beta.1"],
    [{ ...ok, draft: true }, "v4.3.2"],
    [{ ...ok, prerelease: true }, "v4.3.2"],
    [{ ...ok, tag_name: "v5.0.0" }, "v5.0.0"],
    [{ ...ok, tag_name: "v3.9.0" }, "v3.9.0"],
    [ok, "v4.3.1"],
  ];
  for (const [release, configured] of cases) {
    assert.throws(
      () => assertLegacySourceRelease(release, configured),
      Error,
      JSON.stringify({ release, configured }),
    );
  }
  assert.throws(
    () => buildLegacyFeed({ sourceTag: "v5.0.0", sources }),
    /ROSI 4/,
  );
});

test("the committed config names a ROSI 4 release", () => {
  const config = readLegacyFeedConfig(root);
  assert.match(config.sourceTag, /^v4\.\d+\.\d+$/);
});

test("feed validation rejects files that do not point at the configured release (gate-content)", () => {
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: sources["latest.yml"],
        sourceTag: SOURCE_TAG,
      }),
    /\.\.\/v4\.3\.2\//,
  );
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: feed["latest.yml"],
        sourceTag: "v4.4.0",
      }),
    /v4\.4\.0/,
  );
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: "version: [",
        sourceTag: SOURCE_TAG,
      }),
    /latest\.yml/,
  );
  const wrongVersion = feed["latest.yml"].replace(
    "version: 4.3.2",
    "version: 4.3.1",
  );
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: wrongVersion,
        sourceTag: SOURCE_TAG,
      }),
    /4\.3\.1/,
  );
});

test("assets missing from the v4 release, or with another size, are refused (missing-asset)", () => {
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  const withoutMac = sourceRelease.assets.filter(
    (asset) => asset.name !== "ROSI-MacOS-universal.zip",
  );
  assert.throws(
    () =>
      assertLegacyFeedAssets({
        feed,
        sourceTag: SOURCE_TAG,
        assets: withoutMac,
      }),
    /ROSI-MacOS-universal\.zip/,
  );
  const resized = sourceRelease.assets.map((asset) =>
    asset.name === "ROSI-Windows-arm64.exe"
      ? { ...asset, size: asset.size + 1 }
      : asset,
  );
  assert.throws(
    () =>
      assertLegacyFeedAssets({ feed, sourceTag: SOURCE_TAG, assets: resized }),
    /ROSI-Windows-arm64\.exe/,
  );
});

test("the draft gate requires every feed file (gate-missing)", () => {
  const required = requiredDraftAssetNames();
  for (const name of LEGACY_FEED_FILES) assert.ok(required.includes(name));
  const release = { draft: true, prerelease: true, target_commitish: "abc" };
  const complete = requiredDraftAssetNames();
  assert.doesNotThrow(() =>
    assertDraftReleaseShape({
      release,
      assetNames: complete,
      version: "5.0.0-beta.1",
      headCommit: "abc",
    }),
  );
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release,
        assetNames: complete.filter((name) => name !== "latest-mac.yml"),
        version: "5.0.0-beta.1",
        headCommit: "abc",
      }),
    /latest-mac\.yml/,
  );
});
