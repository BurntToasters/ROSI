#!/usr/bin/env node
/**
 * Repeatable verification for the yt-dlp provenance changes.
 *
 * Exercises every row marked "verify" in ./failure-modes.md against the real
 * scripts, then writes a hashed report under
 * e2e/artifacts/v5-fixes-ytdlp/<timestamp>/ (report.json + report.sha256 +
 * copies of the upstream SHA2-256SUMS and its signature).
 *
 * Network is required for the live provenance checks (L1-L3, F6). Without it
 * those checks fail and the report says so.
 *
 * Usage: node e2e/v5-fixes/ytdlp/verify.mjs
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FETCH_SCRIPT = path.join(ROOT, "scripts", "fetch-ytdlp.cjs");
const CHECK_SCRIPT = path.join(ROOT, "scripts", "check-ytdlp.cjs");
const MANIFEST_PATH = path.join(ROOT, "assets", "ytdlp-checksums.json");
const TAURI_CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");

const fetcher = require(FETCH_SCRIPT);
const checker = require(CHECK_SCRIPT);

const FILE_NAMES = [
  "yt-dlp.exe",
  "yt-dlp_arm64.exe",
  "yt-dlp_macos",
  "yt-dlp_linux",
  "yt-dlp_linux_aarch64",
];

const results = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-verify-"));

function record(id, description, status, detail = "") {
  results.push({ id, description, status, detail });
  const mark = status === "pass" ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id} ${description}${detail ? ` :: ${detail}` : ""}`);
}

async function check(id, description, fn) {
  try {
    const detail = await fn();
    record(id, description, "pass", detail ?? "");
  } catch (error) {
    record(
      id,
      description,
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function runNode(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

function scratch(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function expectErrorMatching(errors, pattern) {
  assert(
    errors.some((item) => pattern.test(item)),
    `expected an error matching ${pattern}; got: ${JSON.stringify(errors)}`,
  );
}

// ─── Fixture helpers for check-ytdlp (offline) ──────────────────────────────

/** Builds a self-consistent fake assets dir; `mutate` tweaks it for negatives. */
function buildFixture(name, mutate = {}) {
  const dir = scratch(name);
  const assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const binaryBytes = Buffer.from("fake yt-dlp binary for verify.mjs\n");
  const licenseBytes = Buffer.from("fake third-party license text\n");
  const licenseFile = `yt-dlp-9999.01.01-THIRD_PARTY_LICENSES.txt`;
  fs.writeFileSync(path.join(assetsDir, "yt-dlp_linux"), binaryBytes);
  fs.writeFileSync(path.join(assetsDir, licenseFile), licenseBytes);
  const manifest = {
    version: "9999.01.01",
    files: {
      "yt-dlp_linux": crypto
        .createHash("sha256")
        .update(binaryBytes)
        .digest("hex"),
    },
    license: {
      file: licenseFile,
      sha256: crypto.createHash("sha256").update(licenseBytes).digest("hex"),
    },
  };
  if (mutate.manifest) mutate.manifest(manifest);
  const manifestPath = path.join(assetsDir, "ytdlp-checksums.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (mutate.license) {
    fs.writeFileSync(path.join(assetsDir, licenseFile), mutate.license);
  }
  if (mutate.binary) {
    fs.writeFileSync(path.join(assetsDir, "yt-dlp_linux"), mutate.binary);
  }
  if (mutate.removeBinary) {
    fs.rmSync(path.join(assetsDir, "yt-dlp_linux"), { force: true });
  }
  const tauriPath = path.join(dir, "tauri.conf.json");
  fs.writeFileSync(
    tauriPath,
    JSON.stringify({
      bundle: {
        resources: {
          [mutate.tauriPath ?? `../assets/${licenseFile}`]: "yt-dlp/x.txt",
        },
      },
    }),
  );
  return { assetsDir, manifestPath, tauriPath };
}

function runChecker(fixture) {
  return checker.verifyAssets({
    assetsDir: fixture.assetsDir,
    manifestPath: fixture.manifestPath,
    tauriConfPath: fixture.tauriPath,
  });
}

// ─── Checks ─────────────────────────────────────────────────────────────────

async function main() {
  const artifactStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = path.join(
    ROOT,
    "e2e",
    "artifacts",
    "v5-fixes-ytdlp",
    artifactStamp,
  );
  fs.mkdirSync(artifactDir, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );

  await check(
    "M1",
    "manifest has version, five files, and license record",
    () => {
      assert(/^\d{4}\.\d{2}\.\d{2}$/.test(manifest.version), "bad version");
      assert(
        JSON.stringify(Object.keys(manifest.files).sort()) ===
          JSON.stringify([...FILE_NAMES].sort()),
        `file set differs: ${Object.keys(manifest.files)}`,
      );
      for (const hash of Object.values(manifest.files)) {
        assert(/^[0-9a-f]{64}$/.test(hash), "bad sha256 in manifest");
      }
      assert(
        manifest.license.file ===
          `yt-dlp-${manifest.version}-THIRD_PARTY_LICENSES.txt`,
        "license file name does not match version",
      );
      assert(/^[0-9a-f]{64}$/.test(manifest.license.sha256), "bad license sha");
      return `version ${manifest.version}`;
    },
  );

  await check(
    "M2",
    "package.json exposes ytdlp:fetch and ytdlp:fetch:all",
    () => {
      const scripts = pkg.scripts;
      assert(
        scripts["ytdlp:fetch"]?.includes("scripts/fetch-ytdlp.cjs"),
        "ytdlp:fetch missing",
      );
      assert(
        scripts["ytdlp:fetch:all"]?.includes("--all"),
        "ytdlp:fetch:all missing --all",
      );
      assert(
        scripts["ytdlp:check"] === "node scripts/check-ytdlp.cjs",
        "ytdlp:check changed",
      );
      assert(
        scripts["ytdlp:check:generate"] === undefined,
        "unsafe generate script still present",
      );
      return "scripts present";
    },
  );

  await check("C0", "check-ytdlp passes on the committed assets", () => {
    const run = runNode(CHECK_SCRIPT, []);
    assert(run.status === 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    return run.stdout.trim();
  });

  await check("C1", "old-format manifest (binaries key) is rejected", () => {
    const fixture = buildFixture("c1", {
      manifest: (m) => {
        delete m.files;
        m.binaries = m.files ?? {};
      },
    });
    expectErrorMatching(runChecker(fixture).errors, /version|files|manifest/i);
    return "rejected";
  });

  await check("C2", "binary hash mismatch is rejected", () => {
    const fixture = buildFixture("c2", { binary: Buffer.from("tampered") });
    expectErrorMatching(runChecker(fixture).errors, /SHA-256 mismatch/);
    return "rejected";
  });

  await check(
    "C3",
    "license file missing for manifest version is rejected",
    () => {
      const fixture = buildFixture("c3", {
        removeBinary: false,
        manifest: (m) => {
          m.license.file = "yt-dlp-9999.01.02-THIRD_PARTY_LICENSES.txt";
        },
      });
      expectErrorMatching(runChecker(fixture).errors, /license/i);
      return "rejected";
    },
  );

  await check("C4", "license file content drift is rejected", () => {
    const fixture = buildFixture("c4", {
      license: Buffer.from("edited license\n"),
    });
    expectErrorMatching(runChecker(fixture).errors, /license.*(sha|mismatch)/i);
    return "rejected";
  });

  await check(
    "C5",
    "tauri.conf.json not referencing the license is rejected",
    () => {
      const fixture = buildFixture("c5", {
        tauriPath: "../assets/yt-dlp-0000.00.00-THIRD_PARTY_LICENSES.txt",
      });
      expectErrorMatching(runChecker(fixture).errors, /tauri/i);
      return "rejected";
    },
  );

  await check("C6", "no binaries present is rejected", () => {
    const fixture = buildFixture("c6", { removeBinary: true });
    expectErrorMatching(runChecker(fixture).errors, /No yt-dlp binaries/i);
    return "rejected";
  });

  await check(
    "C7",
    "well-formed fixture passes (negatives isolate one fault)",
    () => {
      const fixture = buildFixture("c7");
      const { errors } = runChecker(fixture);
      assert(
        errors.length === 0,
        `unexpected errors: ${JSON.stringify(errors)}`,
      );
      return "accepted";
    },
  );

  await check("F4", "--allow-unsigned-sums refused when CI is set", () => {
    const run = runNode(FETCH_SCRIPT, ["--all", "--allow-unsigned-sums"], {
      CI: "true",
    });
    assert(run.status !== 0, "exit 0 with CI set");
    assert(/not allowed/i.test(run.stderr), `stderr: ${run.stderr}`);
    return "refused";
  });

  await check("F5", "--allow-unsigned-sums refused with --update", () => {
    const run = runNode(FETCH_SCRIPT, [
      "--update",
      manifest.version,
      "--allow-unsigned-sums",
    ]);
    assert(run.status !== 0, "exit 0");
    return "refused";
  });

  await check("F15", "--update rejects a non-version string", () => {
    const run = runNode(FETCH_SCRIPT, ["--update", "../evil"]);
    assert(run.status !== 0, "exit 0");
    assert(/version/i.test(run.stderr), `stderr: ${run.stderr}`);
    return "refused";
  });

  await check("F14", "unknown --target triple is rejected", () => {
    const run = runNode(FETCH_SCRIPT, ["--target", "bogus-triple"]);
    assert(run.status !== 0, "exit 0");
    return "refused";
  });

  await check(
    "F13",
    "--missing-only skips verified files without network or gpg",
    () => {
      const run = runNode(FETCH_SCRIPT, ["--missing-only", "--all"], {
        PATH: "/nonexistent-dir-for-verify",
      });
      assert(run.status === 0, `exit ${run.status}: ${run.stderr}`);
      return run.stdout.trim().split("\n").pop();
    },
  );

  // Signature checks need the real upstream files, fetched live (L1).
  const upstreamDir = scratch("upstream");
  const sumsPath = path.join(upstreamDir, "SHA2-256SUMS");
  const sigPath = path.join(upstreamDir, "SHA2-256SUMS.sig");
  const releaseBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${manifest.version}/`;
  let sumsMap = null;

  await check(
    "L1",
    "upstream SHA2-256SUMS and .sig download for manifest version",
    async () => {
      await fetcher.downloadFile(`${releaseBase}SHA2-256SUMS`, sumsPath);
      await fetcher.downloadFile(`${releaseBase}SHA2-256SUMS.sig`, sigPath);
      sumsMap = fetcher.parseSums(fs.readFileSync(sumsPath, "utf8"));
      return `${sumsMap.size} entries`;
    },
  );

  await check(
    "F1a",
    "upstream SHA2-256SUMS signature verifies with pinned key",
    () => {
      const fingerprint = fetcher.verifySumsSignature({ sumsPath, sigPath });
      assert(
        fingerprint === fetcher.PINNED_FINGERPRINT,
        `fingerprint ${fingerprint}`,
      );
      return fingerprint;
    },
  );

  await check("F1", "tampered SHA2-256SUMS is rejected", () => {
    const tampered = path.join(upstreamDir, "tampered-sums");
    const text = fs.readFileSync(sumsPath, "utf8");
    fs.writeFileSync(
      tampered,
      text.replace(/^[0-9a-f]/m, (c) => (c === "0" ? "1" : "0")),
    );
    let threw = false;
    try {
      fetcher.verifySumsSignature({ sumsPath: tampered, sigPath });
    } catch {
      threw = true;
    }
    assert(threw, "tampered sums verified");
    return "rejected";
  });

  await check(
    "F2",
    "signature from a different key is rejected (pinned fingerprint)",
    () => {
      // Short path: gpg-agent sockets under a long homedir fail to bind.
      const gnupg = fs.mkdtempSync(path.join(os.tmpdir(), "yv-gpg-"));
      fs.chmodSync(gnupg, 0o700);
      const gpgBase = ["--homedir", gnupg, "--batch", "--quiet"];
      const gen = spawnSync(
        "gpg",
        [
          ...gpgBase,
          "--passphrase",
          "",
          "--quick-gen-key",
          "ROSI verify <verify@example.invalid>",
          "ed25519",
          "sign",
          "never",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      assert(gen.status === 0, `key generation failed: ${gen.stderr}`);
      const pubPath = path.join(upstreamDir, "attacker.asc");
      const pub = spawnSync("gpg", [...gpgBase, "--armor", "--export"], {
        encoding: "utf8",
      });
      fs.writeFileSync(pubPath, pub.stdout);
      const forgedSig = path.join(upstreamDir, "forged.sig");
      const sign = spawnSync(
        "gpg",
        [
          ...gpgBase,
          "--pinentry-mode",
          "loopback",
          "--passphrase",
          "",
          "--yes",
          "--detach-sign",
          "--output",
          forgedSig,
          sumsPath,
        ],
        { encoding: "utf8" },
      );
      assert(sign.status === 0, `signing failed: ${sign.stderr}`);
      let message = "";
      try {
        fetcher.verifySumsSignature({
          sumsPath,
          sigPath: forgedSig,
          keyPath: pubPath,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      spawnSync("gpgconf", ["--homedir", gnupg, "--kill", "gpg-agent"]);
      fs.rmSync(gnupg, { recursive: true, force: true });
      assert(/not the pinned yt-dlp key/.test(message), `message: ${message}`);
      return "rejected";
    },
  );

  await check("F3", "missing gpg fails closed", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    let message = "";
    try {
      fetcher.verifySumsSignature({ sumsPath, sigPath });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      process.env.PATH = savedPath;
    }
    assert(/gpg/i.test(message), `message: ${message}`);
    return "failed closed";
  });

  await check(
    "L2",
    "committed manifest hashes equal upstream signed sums",
    () => {
      assert(sumsMap, "no upstream sums");
      for (const name of FILE_NAMES) {
        assert(sumsMap.get(name) === manifest.files[name], `${name} differs`);
      }
      return "all five match";
    },
  );

  await check(
    "L2b",
    "present local binaries equal upstream signed sums",
    () => {
      assert(sumsMap, "no upstream sums");
      const present = FILE_NAMES.filter((name) =>
        fs.existsSync(path.join(ROOT, "assets", name)),
      );
      assert(present.length > 0, "no local binaries");
      for (const name of present) {
        assert(
          sha256(path.join(ROOT, "assets", name)) === sumsMap.get(name),
          `${name} does not match upstream`,
        );
      }
      return `${present.length} local binaries match upstream`;
    },
  );

  await check(
    "L3",
    "committed license file equals upstream tag text",
    async () => {
      const licensePath = path.join(upstreamDir, "THIRD_PARTY_LICENSES.txt");
      await fetcher.downloadFile(
        `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${manifest.version}/THIRD_PARTY_LICENSES.txt`,
        licensePath,
      );
      const upstreamHash = sha256(licensePath);
      assert(
        upstreamHash === manifest.license.sha256,
        "upstream license differs",
      );
      assert(
        sha256(path.join(ROOT, "assets", manifest.license.file)) ===
          upstreamHash,
        "local license differs",
      );
      return upstreamHash;
    },
  );

  await check(
    "L4",
    "committed public key equals upstream public.key",
    async () => {
      const keyPath = path.join(upstreamDir, "public.key");
      await fetcher.downloadFile(
        "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/public.key",
        keyPath,
      );
      assert(
        sha256(keyPath) === sha256(fetcher.PUBLIC_KEY_PATH),
        "committed key differs from upstream master public.key",
      );
      return "identical";
    },
  );

  await check(
    "F6",
    "verified download writes a matching file; corrupt download leaves nothing",
    async () => {
      const good = scratch("download-good");
      const expected = sumsMap.get("yt-dlp.exe");
      await fetcher.downloadVerified({
        name: "yt-dlp.exe",
        url: `${releaseBase}yt-dlp.exe`,
        expectedSha256: expected,
        destDir: good,
      });
      assert(sha256(path.join(good, "yt-dlp.exe")) === expected, "mismatch");
      const bad = scratch("download-bad");
      let rejected = false;
      try {
        await fetcher.downloadVerified({
          name: "yt-dlp.exe",
          url: `${releaseBase}yt-dlp.exe`,
          expectedSha256: "0".repeat(64),
          destDir: bad,
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "corrupt download accepted");
      const leftovers = fs.readdirSync(bad);
      assert(leftovers.length === 0, `leftover files: ${leftovers}`);
      return "good accepted, bad rejected and cleaned";
    },
  );

  await check("S3", "yt-dlp binaries are not tracked by git", () => {
    const run = spawnSync("git", ["ls-files", "assets/"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (run.status !== 0) return "not a git checkout; skipped";
    const tracked = run.stdout
      .split("\n")
      .filter((line) =>
        /^assets\/yt-dlp(\.exe|_arm64\.exe|_macos|_linux|_linux_aarch64)$/.test(
          line,
        ),
      );
    assert(tracked.length === 0, `tracked: ${tracked}`);
    return "none tracked";
  });

  // gpg lookup (failure modes G1-G8). Simulated platforms; no gpg is run.
  const GIT_GPG = "C:\\Program Files\\Git\\usr\\bin\\gpg.exe";
  const winEnv = { ProgramFiles: "C:\\Program Files" };

  await check("G1", "win32: gpg on PATH is preferred", () => {
    const gpg = fetcher.resolveGpg({
      env: winEnv,
      platform: "win32",
      runs: (command) => command === "gpg" || command === GIT_GPG,
      exists: () => true,
    });
    assert(gpg === "gpg", `resolved ${gpg}`);
    return gpg;
  });

  await check(
    "G2",
    "win32: falls back to Git for Windows gpg when PATH lacks it",
    () => {
      const gpg = fetcher.resolveGpg({
        env: winEnv,
        platform: "win32",
        runs: (command) => command === GIT_GPG,
        exists: (file) => file === GIT_GPG,
      });
      assert(gpg === GIT_GPG, `resolved ${gpg}`);
      return gpg;
    },
  );

  await check(
    "G3",
    "win32: a Git gpg that does not run is skipped, then fails closed",
    () => {
      let message = "";
      try {
        fetcher.resolveGpg({
          env: winEnv,
          platform: "win32",
          runs: () => false,
          exists: (file) => file === GIT_GPG,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(/gpg is not available/.test(message), `message: ${message}`);
      return "failed closed";
    },
  );

  await check(
    "G4",
    "win32: no gpg anywhere names Git for Windows and ROSI_GPG",
    () => {
      let message = "";
      try {
        fetcher.resolveGpg({
          env: {},
          platform: "win32",
          runs: () => false,
          exists: () => false,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(
        /Git for Windows/.test(message) && /ROSI_GPG/.test(message),
        `message: ${message}`,
      );
      return "explicit guidance";
    },
  );

  await check(
    "G5",
    "ROSI_GPG pointing at a missing file is an error, not a fallback",
    () => {
      let message = "";
      try {
        fetcher.resolveGpg({
          env: { ROSI_GPG: "/nonexistent/gpg" },
          platform: "darwin",
          runs: () => true,
          exists: () => false,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(
        /ROSI_GPG points at a missing file/.test(message),
        `message: ${message}`,
      );
      return "rejected";
    },
  );

  await check("G6", "ROSI_GPG set to an existing file wins over PATH", () => {
    const gpg = fetcher.resolveGpg({
      env: { ROSI_GPG: "/opt/gpg/bin/gpg" },
      platform: "darwin",
      runs: () => true,
      exists: () => true,
    });
    assert(gpg === "/opt/gpg/bin/gpg", `resolved ${gpg}`);
    return gpg;
  });

  await check(
    "G7",
    "gpgPath forward-slashes Windows paths only on win32",
    () => {
      const win = fetcher.gpgPath(
        "C:\\Users\\me\\AppData\\Local\\Temp\\ytdlp-gpg-x",
        "win32",
      );
      assert(
        win === "C:/Users/me/AppData/Local/Temp/ytdlp-gpg-x",
        `win32: ${win}`,
      );
      const posix = fetcher.gpgPath("/var/folders/x/ytdlp-gpg-x", "darwin");
      assert(posix === "/var/folders/x/ytdlp-gpg-x", `darwin: ${posix}`);
      return "converted on win32 only";
    },
  );

  await check(
    "G8",
    "darwin with no gpg does not consider the Git location",
    () => {
      let message = "";
      const probed = [];
      try {
        fetcher.resolveGpg({
          env: winEnv,
          platform: "darwin",
          runs: (command) => {
            probed.push(command);
            return false;
          },
          exists: () => true,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(!probed.some((c) => c.includes("Git")), `probed ${probed}`);
      assert(/gpg is not available/.test(message), `message: ${message}`);
      return "no Git probe";
    },
  );

  await check(
    "S4",
    "ytdlp:fetch:all runs cleanly when binaries are present",
    () => {
      const run = spawnSync("npm", ["run", "--silent", "ytdlp:fetch:all"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: process.env.PATH },
        timeout: 120_000,
      });
      assert(run.status === 0, `exit ${run.status}: ${run.stderr}`);
      return "exit 0";
    },
  );

  // Seamless release fetch (failure modes R1-R5). Offline; no network.
  await check(
    "R1",
    "transient failures are retried until success",
    async () => {
      let calls = 0;
      const value = await fetcher.withRetries(
        "fake download",
        async () => {
          calls += 1;
          if (calls < 3) throw new Error("socket hang up");
          return "ok";
        },
        3,
      );
      assert(value === "ok" && calls === 3, `calls ${calls}`);
      return `${calls} attempts`;
    },
  );

  await check(
    "R2",
    "a hash mismatch is retried and still fails closed",
    async () => {
      let calls = 0;
      let message = "";
      try {
        await fetcher.withRetries(
          "fake download",
          async () => {
            calls += 1;
            throw new Error("SHA-256 mismatch for yt-dlp_macos");
          },
          2,
        );
      } catch (error) {
        message = error.message;
      }
      assert(calls === 2, `calls ${calls}`);
      assert(/failed after 2 attempt/.test(message), message);
      return message.split("\n")[0];
    },
  );

  await check("R3", "HTTP 4xx is not retried", async () => {
    let calls = 0;
    try {
      await fetcher.withRetries(
        "fake download",
        async () => {
          calls += 1;
          throw new Error("HTTP 404 for https://example.invalid/x");
        },
        3,
      );
    } catch {
      /* expected */
    }
    assert(calls === 1, `calls ${calls}`);
    assert(!fetcher.isTransient(new Error("HTTP 403 for x")), "403 transient");
    assert(
      fetcher.isTransient(new Error("HTTP 503 for x")),
      "503 not transient",
    );
    return "1 attempt";
  });

  await check(
    "R5",
    "failed attempts leave no temp files in assets",
    async () => {
      const before = fs
        .readdirSync(path.join(ROOT, "assets"))
        .filter((n) => n.startsWith(".ytdlp-download-"));
      try {
        await fetcher.withRetries(
          "fake verified download",
          () =>
            fetcher.downloadVerified({
              name: "yt-dlp_macos",
              url: "https://127.0.0.1:9/unreachable",
              expectedSha256: "0".repeat(64),
              destDir: fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-retry-")),
            }),
          2,
        );
      } catch {
        /* expected */
      }
      const after = fs
        .readdirSync(path.join(ROOT, "assets"))
        .filter((n) => n.startsWith(".ytdlp-download-"));
      assert(after.length === before.length, `temp files ${after}`);
      return "clean";
    },
  );

  const failed = results.filter((item) => item.status !== "pass");
  const report = {
    generatedAt: new Date().toISOString(),
    repo: ROOT,
    manifestVersion: manifest.version,
    pinnedFingerprint: fetcher.PINNED_FINGERPRINT,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    },
    results,
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = path.join(artifactDir, "report.json");
  fs.writeFileSync(reportPath, reportText);
  const digest = crypto.createHash("sha256").update(reportText).digest("hex");
  fs.writeFileSync(
    path.join(artifactDir, "report.sha256"),
    `${digest}  report.json\n`,
  );
  if (fs.existsSync(sumsPath))
    fs.copyFileSync(sumsPath, path.join(artifactDir, "SHA2-256SUMS"));
  if (fs.existsSync(sigPath))
    fs.copyFileSync(sigPath, path.join(artifactDir, "SHA2-256SUMS.sig"));
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\nReport: ${path.relative(ROOT, reportPath)}`);
  console.log(`SHA-256: ${digest}`);
  console.log(
    `Result: ${report.summary.passed}/${report.summary.total} passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
