// Acceptance for the gpg path handling in scripts/fetch-ytdlp.cjs (failure
// modes in scripts/fetch-ytdlp-gpg-path.failure-modes.md). Platform, flavor
// and the version probe are injected, so this runs on any host.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { gpgFlavor, gpgPath } = require("./fetch-ytdlp.cjs");

const MSYS_HOME = "Home: /home/runneradmin/.gnupg\n";
const NATIVE_HOME = "Home: C:/Users/runneradmin/AppData/Roaming/gnupg\n";

function probeReturning(text) {
  const calls = [];
  const probe = (command) => {
    calls.push(command);
    return text;
  };
  return { probe, calls };
}

test("F1: MSYS flavor turns a Windows path into a /c/ path", () => {
  assert.equal(
    gpgPath("C:\\Users\\RUNNER~1\\Temp\\ytdlp-gpg-1", "win32", "msys"),
    "/c/Users/RUNNER~1/Temp/ytdlp-gpg-1",
  );
  assert.equal(
    gpgPath("D:\\a\\ROSI\\ROSI\\assets\\yt-dlp-public.asc", "win32", "msys"),
    "/d/a/ROSI/ROSI/assets/yt-dlp-public.asc",
  );
});

test("F2: native flavor keeps the drive letter and only flips separators", () => {
  assert.equal(
    gpgPath("C:\\Users\\me\\Temp\\ytdlp-gpg-x", "win32", "native"),
    "C:/Users/me/Temp/ytdlp-gpg-x",
  );
  assert.equal(
    gpgPath("C:\\Users\\me\\Temp\\ytdlp-gpg-x", "win32"),
    "C:/Users/me/Temp/ytdlp-gpg-x",
  );
});

test("F8: drive-less relative paths keep their relative form", () => {
  assert.equal(
    gpgPath("assets\\yt-dlp-public.asc", "win32", "msys"),
    "assets/yt-dlp-public.asc",
  );
  assert.equal(
    gpgPath("assets\\yt-dlp-public.asc", "win32", "native"),
    "assets/yt-dlp-public.asc",
  );
});

test("F9: drive letter is lowercased for MSYS only", () => {
  assert.equal(gpgPath("c:\\x", "win32", "msys"), "/c/x");
  assert.equal(gpgPath("c:\\x", "win32", "native"), "c:/x");
});

test("F10: bare drive root", () => {
  assert.equal(gpgPath("C:\\", "win32", "msys"), "/c/");
  assert.equal(gpgPath("C:\\", "win32", "native"), "C:/");
});

test("F11: UNC paths are //server/share in both flavors", () => {
  assert.equal(
    gpgPath("\\\\server\\share\\x.asc", "win32", "msys"),
    "//server/share/x.asc",
  );
  assert.equal(
    gpgPath("\\\\server\\share\\x.asc", "win32", "native"),
    "//server/share/x.asc",
  );
});

test("F12: mixed separators are all normalized", () => {
  assert.equal(gpgPath("C:\\a/b\\c", "win32", "msys"), "/c/a/b/c");
  assert.equal(gpgPath("C:\\a/b\\c", "win32", "native"), "C:/a/b/c");
});

test("F13: spaces and parentheses are passed through unchanged", () => {
  assert.equal(
    gpgPath("C:\\Program Files (x86)\\Git\\x", "win32", "msys"),
    "/c/Program Files (x86)/Git/x",
  );
});

test("F7: non-Windows platforms are never converted", () => {
  assert.equal(
    gpgPath("/var/folders/x/ytdlp-gpg-x", "darwin"),
    "/var/folders/x/ytdlp-gpg-x",
  );
  assert.equal(gpgPath("/tmp/a b/c", "linux", "msys"), "/tmp/a b/c");
  assert.equal(gpgPath("/tmp/a\\b", "darwin", "native"), "/tmp/a\\b");
});

test("F3: Git for Windows usr\\bin gpg is MSYS, any slash style or case", () => {
  const { probe, calls } = probeReturning(NATIVE_HOME);
  const paths = [
    "C:\\Program Files\\Git\\usr\\bin\\gpg.exe",
    "c:/program files/git/usr/bin/GPG.EXE",
    "D:\\Git\\USR\\BIN\\gpg",
  ];
  for (const gpg of paths) {
    assert.equal(gpgFlavor(gpg, { platform: "win32", probe }), "msys", gpg);
  }
  assert.deepEqual(calls, [], "path match must not need the probe");
});

test("F4: bare gpg on PATH is MSYS when its Home line starts with /", () => {
  const { probe, calls } = probeReturning(MSYS_HOME);
  assert.equal(gpgFlavor("gpg", { platform: "win32", probe }), "msys");
  assert.deepEqual(calls, ["gpg"]);
});

test("F5: native GnuPG with a drive-letter Home line is native", () => {
  const { probe } = probeReturning(NATIVE_HOME);
  assert.equal(
    gpgFlavor("C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe", {
      platform: "win32",
      probe,
    }),
    "native",
  );
  assert.equal(gpgFlavor("gpg", { platform: "win32", probe }), "native");
});

test("F6: failed or empty probe falls back to native without throwing", () => {
  const empty = probeReturning("");
  assert.equal(
    gpgFlavor("gpg", { platform: "win32", probe: empty.probe }),
    "native",
  );
  const noHome = probeReturning("gpg (GnuPG) 2.4.5\nlibgcrypt 1.10.3\n");
  assert.equal(
    gpgFlavor("gpg", { platform: "win32", probe: noHome.probe }),
    "native",
  );
});

test("F7: non-Windows platforms are posix and never probe", () => {
  const { probe, calls } = probeReturning(MSYS_HOME);
  assert.equal(
    gpgFlavor("/usr/bin/gpg", { platform: "darwin", probe }),
    "posix",
  );
  assert.equal(gpgFlavor("gpg", { platform: "linux", probe }), "posix");
  assert.deepEqual(calls, []);
});

test("F14: default flavor keeps the two-argument win32 behavior", () => {
  assert.equal(
    gpgPath("C:\\Users\\me\\AppData\\Local\\Temp\\ytdlp-gpg-x", "win32"),
    "C:/Users/me/AppData/Local/Temp/ytdlp-gpg-x",
  );
});
