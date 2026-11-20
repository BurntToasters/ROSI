// Failure modes for scripts/get-ffmpeg.cjs, update-ffmpeg.cjs and check-ffmpeg.cjs.
// Written before the code. Network and 7z are never used; get() is injected.

// F1  the server URL is http, not a URL, empty, or carries credentials.
// F2  the first request would go out over http.
// F3  a redirect downgrades to http (or another scheme).
// F4  a redirect has no Location, loops past the limit, or the status is not 200.
// F5  the body is shorter than Content-Length (truncated download).
// F6  a failed download leaves a partial file behind.
// F7  an extracted binary differs from resources/ffmpeg/checksums.json.
// F8  one binary matches and the other does not (nothing may be installed).
// F9  the manifest lists a binary the archive did not contain.
// F10 the manifest is unreadable JSON, or holds a malformed hash or path.
// F11 a mismatch must leave the previous install byte for byte unchanged.

// F12 no manifest entry for a file: install it and report it as unverified.
// F13 the legacy single-binary entry shape still verifies ffmpeg.
// F14 a symlink inside the extracted archive is refused.
// F15 update-ffmpeg must refuse a non-https server before backing anything up.
// F16 the version parser must not accept ffprobe or garbage output.
// F17 regenerating checksums must keep a known version when it cannot be probed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const getFfmpeg = require("./get-ffmpeg.cjs");
const updateFfmpeg = require("./update-ffmpeg.cjs");
const checkFfmpeg = require("./check-ffmpeg.cjs");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rosi-ffmpeg-test-${label}-`));
}

function fakeGet(routes) {
  const calls = [];
  const get = (url, onResponse) => {
    calls.push(url);
    const route = routes[url];
    const res = Readable.from(route?.body ? [Buffer.from(route.body)] : []);
    res.statusCode = route?.status ?? 404;
    res.headers = route?.headers ?? {};
    setImmediate(() => onResponse(res));
    return { on() {} };
  };
  return { get, calls };
}

test("F1: only a plain https server URL is accepted", () => {
  assert.equal(
    getFfmpeg.assertHttpsUrl("https://dl.example/ffmpeg/", "server"),
    "https://dl.example/ffmpeg/",
  );
  for (const bad of [
    "http://dl.example/ffmpeg",
    "ftp://dl.example/ffmpeg",
    "file:///c:/x",
    "dl.example/ffmpeg",
    "",
    "https://user:pw@dl.example/ffmpeg",
  ]) {
    assert.throws(
      () => getFfmpeg.assertHttpsUrl(bad, "server"),
      /https|URL|credentials/i,
    );
  }
});

test("F1: the FFMPEG_DL_SERVER variable is checked by name", () => {
  assert.equal(
    getFfmpeg.assertHttpsServer({ FFMPEG_DL_SERVER: "https://dl.example/x/" }),
    "https://dl.example/x",
  );
  assert.throws(
    () =>
      getFfmpeg.assertHttpsServer({ FFMPEG_DL_SERVER: "http://dl.example" }),
    /FFMPEG_DL_SERVER/,
  );
  assert.throws(() => getFfmpeg.assertHttpsServer({}), /FFMPEG_DL_SERVER/);
});

test("F2: download never sends an http request", async () => {
  const dir = tempDir("f2");
  const { get, calls } = fakeGet({});
  await assert.rejects(
    getFfmpeg.download("http://dl.example/a.7z", path.join(dir, "a.7z"), {
      get,
    }),
    /https/i,
  );
  assert.deepEqual(calls, []);
});

test("F3: a redirect to http is refused and nothing is kept", async () => {
  const dir = tempDir("f3");
  const dest = path.join(dir, "a.7z");
  const { get, calls } = fakeGet({
    "https://dl.example/a.7z": {
      status: 302,
      headers: { location: "http://evil.example/a.7z" },
    },
    "http://evil.example/a.7z": { status: 200, body: "payload" },
  });
  await assert.rejects(
    getFfmpeg.download("https://dl.example/a.7z", dest, { get }),
    /https/i,
  );
  assert.deepEqual(calls, ["https://dl.example/a.7z"]);
  assert.equal(fs.existsSync(dest), false);
});

test("F3: https redirects, relative or absolute, are followed", async () => {
  const dir = tempDir("f3b");
  const dest = path.join(dir, "a.7z");
  const { get, calls } = fakeGet({
    "https://dl.example/x/a.7z": {
      status: 301,
      headers: { location: "/y/a.7z" },
    },
    "https://dl.example/y/a.7z": {
      status: 307,
      headers: { location: "https://cdn.example/a.7z" },
    },
    "https://cdn.example/a.7z": {
      status: 200,
      headers: { "content-length": "7" },
      body: "payload",
    },
  });
  await getFfmpeg.download("https://dl.example/x/a.7z", dest, { get });
  assert.equal(fs.readFileSync(dest, "utf8"), "payload");
  assert.equal(calls.length, 3);
});

test("F4: missing Location, redirect loops and bad status fail", async () => {
  const dir = tempDir("f4");
  const noLocation = fakeGet({ "https://dl.example/a": { status: 302 } });
  await assert.rejects(
    getFfmpeg.download("https://dl.example/a", path.join(dir, "a"), {
      get: noLocation.get,
    }),
    /Location/,
  );
  const loop = fakeGet({
    "https://dl.example/a": {
      status: 302,
      headers: { location: "https://dl.example/a" },
    },
  });
  await assert.rejects(
    getFfmpeg.download("https://dl.example/a", path.join(dir, "b"), {
      get: loop.get,
    }),
    /redirect/i,
  );
  const missing = fakeGet({});
  await assert.rejects(
    getFfmpeg.download("https://dl.example/a", path.join(dir, "c"), {
      get: missing.get,
    }),
    /HTTP 404/,
  );
  for (const name of ["a", "b", "c"]) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, name);
  }
});

test("F5/F6: a truncated body fails and leaves no file", async () => {
  const dir = tempDir("f5");
  const dest = path.join(dir, "a.7z");
  const { get } = fakeGet({
    "https://dl.example/a.7z": {
      status: 200,
      headers: { "content-length": "100" },
      body: "short",
    },
  });
  await assert.rejects(
    getFfmpeg.download("https://dl.example/a.7z", dest, { get }),
    /incomplete|truncated|Content-Length/i,
  );
  assert.equal(fs.existsSync(dest), false);
});

function makeInstall({ existing = {}, staged = {}, label }) {
  const stage = tempDir(`${label}-stage`);
  const dest = tempDir(`${label}-dest`);
  for (const [name, text] of Object.entries(staged)) {
    fs.writeFileSync(path.join(stage, name), text);
  }
  for (const [name, text] of Object.entries(existing)) {
    fs.writeFileSync(path.join(dest, name), text);
  }
  return { stage, dest };
}

function manifestFor(platform, arch, hashes, extra = {}) {
  const ext = platform === "win" ? ".exe" : "";
  const binaries = {};
  for (const [name, digest] of Object.entries(hashes)) {
    binaries[name] = {
      path: `resources/ffmpeg/${platform}/${arch}/${name}${ext}`,
      sha256: digest,
    };
  }
  return { [`${platform}:${arch}`]: { ...extra, binaries } };
}

function listing(dir) {
  return fs.readdirSync(dir).sort();
}

test("F7: matching hashes install both binaries", () => {
  const { stage, dest } = makeInstall({
    label: "ok",
    staged: { "ffmpeg.exe": "new-ffmpeg", "ffprobe.exe": "new-ffprobe" },
    existing: { "PLACE_BINARIES_HERE.txt": "keep" },
  });
  const manifest = manifestFor("win", "x64", {
    ffmpeg: sha("new-ffmpeg"),
    ffprobe: sha("new-ffprobe"),
  });
  const result = getFfmpeg.verifyAndInstall({
    stageDir: stage,
    destDir: dest,
    platform: "win",
    arch: "x64",
    manifest,
  });
  assert.deepEqual(result.verified.sort(), ["ffmpeg", "ffprobe"]);
  assert.deepEqual(result.unverified, []);
  assert.equal(
    fs.readFileSync(path.join(dest, "ffmpeg.exe"), "utf8"),
    "new-ffmpeg",
  );
  assert.deepEqual(listing(dest), [
    "PLACE_BINARIES_HERE.txt",
    "ffmpeg.exe",
    "ffprobe.exe",
  ]);
});

test("F7/F11: a mismatch fails and the previous install is unchanged", () => {
  const { stage, dest } = makeInstall({
    label: "bad",
    staged: { "ffmpeg.exe": "evil", "ffprobe.exe": "new-ffprobe" },
    existing: { "ffmpeg.exe": "old-ffmpeg", "ffprobe.exe": "old-ffprobe" },
  });
  const manifest = manifestFor("win", "x64", {
    ffmpeg: sha("expected-ffmpeg"),
    ffprobe: sha("new-ffprobe"),
  });
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "win",
        arch: "x64",
        manifest,
      }),
    /SHA-256 mismatch.*ffmpeg/s,
  );
  assert.equal(
    fs.readFileSync(path.join(dest, "ffmpeg.exe"), "utf8"),
    "old-ffmpeg",
  );
  assert.equal(
    fs.readFileSync(path.join(dest, "ffprobe.exe"), "utf8"),
    "old-ffprobe",
  );
  assert.deepEqual(listing(dest), ["ffmpeg.exe", "ffprobe.exe"]);
});

test("F8: one good and one bad binary installs neither", () => {
  const { stage, dest } = makeInstall({
    label: "mixed",
    staged: { ffmpeg: "good", ffprobe: "tampered" },
  });
  const manifest = manifestFor("linux", "x64", {
    ffmpeg: sha("good"),
    ffprobe: sha("original"),
  });
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "linux",
        arch: "x64",
        manifest,
      }),
    /mismatch/i,
  );
  assert.deepEqual(listing(dest), []);
});

test("F9: a binary the manifest lists but the archive lacks fails", () => {
  const { stage, dest } = makeInstall({
    label: "absent",
    staged: { ffmpeg: "good" },
  });
  const manifest = manifestFor("mac", "arm64", {
    ffmpeg: sha("good"),
    ffprobe: sha("other"),
  });
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "mac",
        arch: "arm64",
        manifest,
      }),
    /ffprobe/,
  );
  assert.deepEqual(listing(dest), []);
});

test("F10: an unreadable manifest or malformed entry fails closed", () => {
  const dir = tempDir("f10");
  const file = path.join(dir, "checksums.json");
  assert.equal(getFfmpeg.loadManifest(file), null);
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => getFfmpeg.loadManifest(file), /checksums\.json/);
  fs.writeFileSync(file, JSON.stringify({ "win:x64": { binaries: {} } }));
  assert.deepEqual(getFfmpeg.loadManifest(file), {
    "win:x64": { binaries: {} },
  });

  const { stage, dest } = makeInstall({
    label: "malformed",
    staged: { ffmpeg: "x" },
  });
  const bad = {
    "linux:x64": {
      binaries: {
        ffmpeg: { path: "resources/ffmpeg/linux/x64/ffmpeg", sha256: "zz" },
      },
    },
  };
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "linux",
        arch: "x64",
        manifest: bad,
      }),
    /malformed|sha256/i,
  );
  const wrongPath = manifestFor("linux", "x64", { ffmpeg: sha("x") });
  wrongPath["linux:x64"].binaries.ffmpeg.path =
    "resources/ffmpeg/mac/x64/ffmpeg";
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "linux",
        arch: "x64",
        manifest: wrongPath,
      }),
    /path/i,
  );
  assert.deepEqual(listing(dest), []);
});

test("F12: files without a manifest entry install and are reported", () => {
  const { stage, dest } = makeInstall({
    label: "none",
    staged: { ffmpeg: "a", ffprobe: "b" },
  });
  const noManifest = getFfmpeg.verifyAndInstall({
    stageDir: stage,
    destDir: dest,
    platform: "linux",
    arch: "arm64",
    manifest: null,
  });
  assert.deepEqual(noManifest.verified, []);
  assert.deepEqual(noManifest.unverified.sort(), ["ffmpeg", "ffprobe"]);
  assert.deepEqual(listing(dest), ["ffmpeg", "ffprobe"]);

  const second = makeInstall({
    label: "partial",
    staged: { ffmpeg: "a", ffprobe: "b" },
  });
  const partial = getFfmpeg.verifyAndInstall({
    stageDir: second.stage,
    destDir: second.dest,
    platform: "linux",
    arch: "arm64",
    manifest: manifestFor("linux", "arm64", { ffmpeg: sha("a") }),
  });
  assert.deepEqual(partial.verified, ["ffmpeg"]);
  assert.deepEqual(partial.unverified, ["ffprobe"]);
});

test("F13: the legacy single-binary entry still verifies ffmpeg", () => {
  const { stage, dest } = makeInstall({
    label: "legacy",
    staged: { ffmpeg: "a" },
  });
  const legacy = {
    "linux:x64": {
      path: "resources/ffmpeg/linux/x64/ffmpeg",
      sha256: sha("other"),
    },
  };
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "linux",
        arch: "x64",
        manifest: legacy,
      }),
    /mismatch/i,
  );
  legacy["linux:x64"].sha256 = sha("a");
  const result = getFfmpeg.verifyAndInstall({
    stageDir: stage,
    destDir: dest,
    platform: "linux",
    arch: "x64",
    manifest: legacy,
  });
  assert.deepEqual(result.verified, ["ffmpeg"]);
});

test("F14: a symlink in the extracted archive is refused", (t) => {
  const { stage, dest } = makeInstall({
    label: "link",
    staged: { ffmpeg: "a" },
  });
  try {
    fs.symlinkSync(path.join(stage, "ffmpeg"), path.join(stage, "ffprobe"));
  } catch {
    t.skip("symlinks cannot be created here");
    return;
  }
  assert.throws(
    () =>
      getFfmpeg.verifyAndInstall({
        stageDir: stage,
        destDir: dest,
        platform: "linux",
        arch: "x64",
        manifest: null,
      }),
    /symlink|link/i,
  );
  assert.deepEqual(listing(dest), []);
});

test("F15: update-ffmpeg refuses a bad server before any backup", () => {
  assert.equal(
    updateFfmpeg.preflight({ FFMPEG_DL_SERVER: "https://dl.example/x" }),
    "https://dl.example/x",
  );
  assert.throws(
    () => updateFfmpeg.preflight({ FFMPEG_DL_SERVER: "http://dl.example/x" }),
    /https/i,
  );
  assert.throws(() => updateFfmpeg.preflight({}), /FFMPEG_DL_SERVER/);
});

test("F16: the version parser reads ffmpeg banners only", () => {
  const parse = checkFfmpeg.ffmpegVersionFromOutput;
  assert.equal(
    parse(
      "ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000",
    ),
    "7.1.1-essentials_build-www.gyan.dev",
  );
  assert.equal(parse("ffmpeg version n7.0.2-1 Copyright"), "n7.0.2-1");
  assert.equal(parse("ffprobe version 7.1.1 Copyright"), null);
  assert.equal(parse("garbage"), null);
  assert.equal(parse(""), null);
  assert.equal(parse(undefined), null);
});

test("F17: a known version survives regeneration without a probe", () => {
  const binaries = { ffmpeg: { path: "p", sha256: "a" } };
  const build = checkFfmpeg.buildChecksumEntry;
  assert.deepEqual(build({ binaries, version: "7.1", previous: {} }), {
    version: "7.1",
    binaries,
  });
  assert.deepEqual(
    build({ binaries, version: null, previous: { version: "6.0" } }),
    { version: "6.0", binaries },
  );
  assert.deepEqual(build({ binaries, version: null, previous: undefined }), {
    binaries,
  });
  assert.deepEqual(
    build({ binaries, version: "7.1", previous: { version: "6.0" } }).version,
    "7.1",
  );
});
