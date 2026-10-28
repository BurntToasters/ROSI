#!/usr/bin/env node
// End-to-end check of the compact macOS updater path, failure modes in
// e2e/updater-zst.failure-modes.md. It runs the real packer, Tauri signer,
// manifest generator and validator, the vendored plugin's extractor, and the
// renderer's updater.ts against real release archives, then writes
// e2e/artifacts/updater-zst-report.json.
//
// Inputs: per-arch `ROSI.app.tar.gz` from `tauri build --target
// {aarch64,x86_64}-apple-darwin --bundles app` when present. Otherwise they are
// derived from the universal archive and the prepared per-arch sidecars (the
// bundle signature is then invalid, which this check does not depend on).
// Requires macOS and zstd.

import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  ARCHES,
  assertPerArchBundle,
  bundleArchivePath,
  packMacosUpdaterArchive,
} from "./pack-macos-updater-zst.js";
import {
  generateUpdaterManifests,
  isPerArchTauriAppArchive,
} from "./gpg-sign.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const reportPath = path.join(
  root,
  "e2e",
  "artifacts",
  "updater-zst-report.json",
);
const universalArchive = path.join(
  root,
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/ROSI.app.tar.gz",
);
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const scenarios = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

async function scenario(id, title, body) {
  const started = Date.now();
  try {
    const details = (await body()) ?? {};
    scenarios.push({
      id,
      title,
      ok: true,
      ms: Date.now() - started,
      ...details,
    });
    console.log(`ok   ${id} ${title}`);
  } catch (error) {
    scenarios.push({
      id,
      title,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(
      `FAIL ${id} ${title}\n     ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Per-arch input archive: the real Tauri build when present. Otherwise the
 * universal bundle with `rosi` thinned and the per-arch sidecars Tauri would
 * bundle (src-tauri/binaries) swapped in.
 */
function perArchInput(arch, scratch) {
  const built = bundleArchivePath(arch);
  if (fs.existsSync(built))
    return { path: built, source: "tauri-per-arch-build" };
  const extractRoot = path.join(scratch, `per-arch-${arch}`);
  fs.mkdirSync(extractRoot, { recursive: true });
  run("tar", ["-xzf", universalArchive, "-C", extractRoot]);
  const macos = path.join(extractRoot, "ROSI.app/Contents/MacOS");
  const main = path.join(macos, "rosi");
  run("lipo", [
    main,
    "-thin",
    ARCHES[arch].lipoArch,
    "-output",
    `${main}.thin`,
  ]);
  fs.renameSync(`${main}.thin`, main);
  for (const sidecar of ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"]) {
    fs.copyFileSync(
      path.join(
        root,
        "src-tauri/binaries",
        `${sidecar}-${ARCHES[arch].rustTarget}`,
      ),
      path.join(macos, sidecar),
    );
  }
  const output = path.join(scratch, `ROSI-${arch}-input.app.tar.gz`);
  run(
    "tar",
    [
      "--no-xattrs",
      "--no-mac-metadata",
      "-czf",
      output,
      "-C",
      extractRoot,
      "ROSI.app",
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  return { path: output, source: "universal-bundle-with-per-arch-sidecars" };
}

function tauriCli(args) {
  // Never let a release key from the environment override the throwaway key.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("TAURI_SIGNING_"),
    ),
  );
  return run(path.join(root, "node_modules/.bin/tauri"), args, {
    cwd: root,
    env,
  });
}

/**
 * Resolves an updater target against the generated manifests the way
 * tauri-plugin-updater does with tauri.conf.json's endpoints: `{{target}}` is
 * the custom target or `darwin`, `{{arch}}` is aarch64. A default target looks
 * up `darwin-aarch64-app` then `darwin-aarch64`; a custom target only its key.
 */
function resolveFeed(manifests, target) {
  const templateTarget = target ?? "darwin";
  const keys = target ? [target] : ["darwin-aarch64-app", "darwin-aarch64"];
  for (const name of [
    `latest-${templateTarget}-aarch64.json`,
    `latest-${templateTarget}.json`,
  ]) {
    const platforms = manifests[name]?.platforms ?? {};
    const key = keys.find((candidate) => platforms[candidate]);
    if (key) return { manifest: name, key, url: platforms[key].url };
  }
  return null;
}

/**
 * Runs an updater.ts against a scripted feed; returns the targets it checked
 * and the warnings it logged. `sourceText` defaults to src/updater.ts.
 */
async function runRendererCheck({
  channel,
  compactTarget,
  betaTarget = "darwin-beta-aarch64-app",
  feed,
  installedVersion = "5.1.0",
  sourceText,
}) {
  const ts = require(path.join(root, "node_modules/typescript"));
  const source = (
    sourceText ?? fs.readFileSync(path.join(root, "src/updater.ts"), "utf8")
  ).replaceAll("import.meta.env.VITE_ROSI_E2E", "'1'");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const checks = [];
  const compactArgs = [];
  const warnings = [];
  const statuses = [];
  const window = {
    __ROSI_E2E__: {
      updaterAdapter: {
        invoke: async (command, args) => {
          if (command === "get_compact_updater_target") {
            compactArgs.push(args ?? null);
            return typeof compactTarget === "function"
              ? compactTarget(args)
              : compactTarget;
          }
          return {
            is_packaged: true,
            is_flatpak: false,
            get_settings: { updateChannel: channel },
            get_beta_updater_target: betaTarget,
          }[command];
        },
        check: async (target) => {
          checks.push(target ?? null);
          const result = feed(target ?? null);
          if (result instanceof Error) throw result;
          if (!result) return null;
          return {
            version: result,
            body: "",
            rawJson: {},
            download: async () => {},
            install: async () => {},
            close: async () => {},
          };
        },
      },
    },
  };
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    require: (id) =>
      id.includes("/app")
        ? { getVersion: async () => installedVersion }
        : { invoke: () => {}, check: () => {} },
    window,
    console: {
      error: console.error,
      warn: (...args) => warnings.push(args.join(" ")),
    },
    Date,
    Set,
    Object,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
  });
  exports.onUpdaterStatus((event) => statuses.push(event));
  const error = await exports.checkForUpdates();
  return {
    checks,
    compactArgs,
    warnings,
    error,
    available:
      statuses.find((event) => event.status === "available")?.version ?? null,
  };
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("e2e-updater-zst runs on macOS only.");
  if (!fs.existsSync(universalArchive)) {
    throw new Error(
      `missing ${universalArchive}; build the universal app first.`,
    );
  }
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-e2e-updater-zst-"),
  );
  const releaseDir = path.join(scratch, "release");
  fs.mkdirSync(releaseDir);
  const packed = {};
  const inputs = {};
  const requireRealBuilds = process.argv.includes("--require-real-builds");
  try {
    for (const arch of Object.keys(ARCHES))
      inputs[arch] = perArchInput(arch, scratch);

    if (requireRealBuilds) {
      await scenario(
        "Z04.8",
        "real per-arch builds are present (strict release proof)",
        () => {
          for (const arch of Object.keys(ARCHES)) {
            assert.equal(
              inputs[arch].source,
              "tauri-per-arch-build",
              `missing real per-arch build for ${arch}`,
            );
          }
        },
      );
      for (const arch of Object.keys(ARCHES)) {
        await scenario(
          `Z04.7-${arch}`,
          `real per-arch bundle for ${arch} passes codesign, stapler, and spctl`,
          () => {
            assertPerArchBundle(inputs[arch].path, arch, {
              verifySignature: true,
            });
          },
        );
      }
    }

    await scenario(
      "Z04.2",
      "packer refuses universal or wrong-arch bundles as per-arch input",
      () => {
        assert.throws(
          () => assertPerArchBundle(universalArchive, "aarch64"),
          /expected "arm64"/,
        );
        assert.throws(
          () => assertPerArchBundle(inputs.x86_64.path, "aarch64"),
          /expected "arm64"/,
        );
        assert.throws(
          () => assertPerArchBundle(inputs.aarch64.path, "x86_64"),
          /expected "x86_64"/,
        );
      },
    );

    for (const arch of Object.keys(ARCHES)) {
      await scenario(
        `Z04.3-${arch}`,
        `repack ${arch} with a byte-identical tar stream`,
        async () => {
          packed[arch] = await packMacosUpdaterArchive({
            input: inputs[arch].path,
            arch,
            version,
            outputDir: releaseDir,
            sign: false,
          });
          const { gzipBytes, zstdBytes, tarSha256 } = packed[arch];
          return {
            input: inputs[arch].source,
            gzipBytes,
            zstdBytes,
            savedPercent: Number(
              (100 - (zstdBytes / gzipBytes) * 100).toFixed(1),
            ),
            tarSha256,
          };
        },
      );
    }

    const keyPath = path.join(scratch, "updater.key");
    await scenario(
      "Z04.4",
      "throwaway minisign key signs every updater archive",
      () => {
        tauriCli(["signer", "generate", "--ci", "-p", "", "-w", keyPath]);
        fs.copyFileSync(
          universalArchive,
          path.join(releaseDir, "ROSI.app.tar.gz"),
        );
        for (const name of [
          "ROSI.app.tar.gz",
          ...Object.keys(ARCHES).map((arch) =>
            path.basename(packed[arch].output),
          ),
        ]) {
          tauriCli([
            "signer",
            "sign",
            "-f",
            keyPath,
            "-p",
            "",
            "--app-version",
            version,
            path.join(releaseDir, name),
          ]);
        }
      },
    );

    let manifests = {};
    await scenario(
      "Z04.5",
      "generator writes and validates stable and beta compact feeds",
      () => {
        const files = fs
          .readdirSync(releaseDir)
          .map((name) => path.join(releaseDir, name));
        const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
        const written = generateUpdaterManifests(files, {
          outputDir: releaseDir,
          publicKey,
        });
        manifests = Object.fromEntries(
          written.map((file) => [
            path.basename(file),
            JSON.parse(fs.readFileSync(file, "utf8")),
          ]),
        );
        for (const arch of Object.keys(ARCHES)) {
          for (const channel of ["", "-beta"]) {
            const key = `darwin${channel}-${arch}-app-zst`;
            const manifest = manifests[`latest-${key}.json`];
            assert.ok(manifest, `latest-${key}.json was not generated`);
            assert.deepEqual(Object.keys(manifest.platforms), [key]);
            assert.match(
              manifest.platforms[key].url,
              new RegExp(`/ROSI-${arch}\\.app\\.tar\\.zst$`),
            );
          }
        }
        return { manifests: Object.keys(manifests).sort() };
      },
    );

    await scenario(
      "Z04.6",
      "compact archives never become the legacy darwin fallback",
      () => {
        for (const arch of Object.keys(ARCHES)) {
          const generic = manifests[`latest-darwin-${arch}.json`].platforms;
          for (const key of [`darwin-${arch}`, `darwin-${arch}-app`]) {
            assert.match(generic[key].url, /\/ROSI\.app\.tar\.gz$/, key);
          }
          for (const betaKey of [
            `darwin-beta-${arch}`,
            `darwin-beta-${arch}-app`,
          ]) {
            const betaPlatforms = manifests[`latest-${betaKey}.json`].platforms;
            assert.match(
              betaPlatforms[betaKey].url,
              /\/ROSI\.app\.tar\.gz$/,
              betaKey,
            );
          }
        }
      },
    );

    await scenario(
      "Z04.1",
      "per-arch arch-less ROSI.app.tar.gz is never collected",
      () => {
        const target = path.join(root, "src-tauri/target");
        for (const arch of Object.keys(ARCHES)) {
          const dir = path.join(
            target,
            `${ARCHES[arch].rustTarget}/release/bundle/macos`,
          );
          assert.equal(
            isPerArchTauriAppArchive(path.join(dir, "ROSI.app.tar.gz")),
            true,
          );
          assert.equal(
            isPerArchTauriAppArchive(path.join(dir, "ROSI.app.tar.gz.sig")),
            true,
          );
          assert.equal(
            isPerArchTauriAppArchive(
              path.join(dir, `ROSI-${arch}.app.tar.zst`),
            ),
            false,
          );
        }
        assert.equal(isPerArchTauriAppArchive(universalArchive), false);
      },
    );

    let archMatrix = {};
    await scenario(
      "Z01/Z02",
      "vendored plugin extracts real archives into complete bundles",
      () => {
        const archives = [
          universalArchive,
          ...Object.keys(ARCHES).map((arch) => packed[arch].output),
        ];
        const output = run(
          "cargo",
          [
            "test",
            "--locked",
            "--manifest-path",
            "src-tauri/vendor/tauri-plugin-updater/Cargo.toml",
            "--lib",
            "macos_archive_tests",
            "--",
            "--include-ignored",
            "--nocapture",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ROSI_UPDATER_ZST_E2E_ARCHIVES: archives.join(":"),
            },
          },
        );
        const matches = [
          ...output.matchAll(
            /ROSI_UPDATER_ZST_E2E (\S+) extract_ms=(\d+) aarch64=(true|false) x86_64=(true|false) rosetta=(true|false)/g,
          ),
        ];
        const extractMs = Object.fromEntries(
          matches.map((m) => [path.basename(m[1]), Number(m[2])]),
        );
        archMatrix = Object.fromEntries(
          matches.map((m) => [
            path.basename(m[1]),
            {
              aarch64: m[3] === "true",
              x86_64: m[4] === "true",
              rosetta: m[5] === "true",
            },
          ]),
        );
        assert.equal(Object.keys(extractMs).length, archives.length);
        const passed = output.match(/test result: ok\. (\d+) passed/);
        assert.ok(passed, "plugin archive tests did not pass");
        return { pluginTestsPassed: Number(passed[1]), extractMs, archMatrix };
      },
    );

    await scenario(
      "Z02.4",
      "vendored updater rejects staged wrong-arch bundles and accepts host/Rosetta bundles",
      () => {
        assert.deepEqual(archMatrix["ROSI.app.tar.gz"], {
          aarch64: true,
          x86_64: true,
          rosetta: true,
        });
        assert.deepEqual(archMatrix["ROSI-aarch64.app.tar.zst"], {
          aarch64: true,
          x86_64: false,
          rosetta: true,
        });
        assert.deepEqual(archMatrix["ROSI-x86_64.app.tar.zst"], {
          aarch64: false,
          x86_64: true,
          rosetta: true,
        });
        return archMatrix;
      },
    );

    await scenario(
      "Z03.1",
      "stable macOS check uses the compact feed",
      async () => {
        const result = await runRendererCheck({
          channel: "stable",
          compactTarget: "darwin-aarch64-app-zst",
          feed: () => "9.0.0",
        });
        assert.deepEqual(result.checks, ["darwin-aarch64-app-zst"]);
        // The channel is re-read before and after the feed request.
        assert.ok(result.compactArgs.length > 0);
        assert.ok(result.compactArgs.every((args) => args.beta === false));
        assert.equal(result.available, "9.0.0");
        return result;
      },
    );

    await scenario(
      "Z03.2",
      "renderer routes the native aarch64 target the command returns under Rosetta (command mocked)",
      async () => {
        const rosettaTarget = (args) =>
          args?.beta ? "darwin-beta-aarch64-app-zst" : "darwin-aarch64-app-zst";
        const stable = await runRendererCheck({
          channel: "stable",
          compactTarget: rosettaTarget,
          feed: () => "9.0.0",
        });
        assert.deepEqual(stable.checks, ["darwin-aarch64-app-zst"]);
        assert.ok(stable.compactArgs.every((args) => args.beta === false));
        assert.equal(stable.available, "9.0.0");
        const beta = await runRendererCheck({
          channel: "beta",
          compactTarget: rosettaTarget,
          feed: () => "9.0.0-beta.1",
        });
        assert.deepEqual(beta.checks, ["darwin-beta-aarch64-app-zst"]);
        assert.ok(beta.compactArgs.every((args) => args.beta === true));
        assert.equal(beta.available, "9.0.0-beta.1");
        assert.equal(archMatrix["ROSI-aarch64.app.tar.zst"]?.rosetta, true);
        let rosettaSysctl = "skipped";
        if (os.arch() === "arm64") {
          const probe = spawnSync(
            "arch",
            ["-x86_64", "/usr/sbin/sysctl", "-n", "sysctl.proc_translated"],
            { encoding: "utf8" },
          );
          if (probe.status === 0) {
            rosettaSysctl = probe.stdout.trim();
            assert.equal(rosettaSysctl, "1");
          }
        }
        return {
          stable: stable.checks,
          beta: beta.checks,
          rosettaMachOAccepted: archMatrix["ROSI-aarch64.app.tar.zst"]?.rosetta,
          rosettaSysctl,
        };
      },
    );

    await scenario(
      "Z03.3",
      "missing compact feed falls back to the legacy target",
      async () => {
        const missing = new Error(
          "Could not fetch a valid release JSON from the remote",
        );
        const stable = await runRendererCheck({
          channel: "stable",
          compactTarget: "darwin-aarch64-app-zst",
          feed: (target) => (target ? missing : "9.0.0"),
        });
        // The compact check is not retried in place; the legacy target is the retry.
        assert.deepEqual(stable.checks, ["darwin-aarch64-app-zst", null]);
        assert.equal(stable.available, "9.0.0");
        assert.equal(stable.warnings.length, 1);
        assert.match(
          stable.warnings[0],
          /darwin-aarch64-app-zst check failed, falling back to the default target: Could not fetch/,
        );
        const beta = await runRendererCheck({
          channel: "beta",
          compactTarget: "darwin-beta-aarch64-app-zst",
          feed: (target) =>
            target.endsWith("-zst") ? missing : "9.0.0-beta.1",
        });
        assert.deepEqual(beta.checks, [
          "darwin-beta-aarch64-app-zst",
          "darwin-beta-aarch64-app",
        ]);
        assert.equal(beta.available, "9.0.0-beta.1");
        assert.equal(beta.warnings.length, 1);
        assert.match(
          beta.warnings[0],
          /darwin-beta-aarch64-app-zst check failed, falling back to darwin-beta-aarch64-app target/,
        );
        return { stable, beta };
      },
    );

    await scenario(
      "Z03.4",
      "compact feed reporting no update does not fall back",
      async () => {
        const result = await runRendererCheck({
          channel: "stable",
          compactTarget: "darwin-aarch64-app-zst",
          feed: () => null,
        });
        assert.ok(
          result.checks.every((target) => target === "darwin-aarch64-app-zst"),
        );
        assert.equal(result.available, null);
        assert.deepEqual(result.warnings, []);
        return result;
      },
    );

    await scenario(
      "Z03.5",
      "clients on 5.0.x never request the compact key",
      async () => {
        // The real 5.0.2 renderer. Its command would answer with a compact key,
        // and the 5.0.2 renderer must still never ask for one.
        const sourceText = run("git", ["show", "v5.0.2:src/updater.ts"], {
          cwd: root,
        });
        const stable = await runRendererCheck({
          channel: "auto",
          compactTarget: "darwin-aarch64-app-zst",
          installedVersion: "5.0.2",
          sourceText,
          feed: (target) => (resolveFeed(manifests, target) ? "9.0.0" : null),
        });
        assert.deepEqual(stable.compactArgs, []);
        assert.ok(stable.checks.every((target) => target === null));
        assert.equal(stable.available, "9.0.0");
        const stableFeed = resolveFeed(manifests, null);
        assert.equal(stableFeed?.manifest, "latest-darwin-aarch64.json");
        assert.equal(stableFeed?.key, "darwin-aarch64-app");
        assert.match(stableFeed?.url ?? "", /\/ROSI\.app\.tar\.gz$/);

        const beta = await runRendererCheck({
          channel: "auto",
          compactTarget: "darwin-beta-aarch64-app-zst",
          installedVersion: "5.0.2-beta.1",
          sourceText,
          feed: (target) =>
            resolveFeed(manifests, target) ? "9.0.0-beta.1" : null,
        });
        assert.deepEqual(beta.compactArgs, []);
        assert.ok(
          beta.checks.every((target) => target === "darwin-beta-aarch64-app"),
        );
        assert.equal(beta.available, "9.0.0-beta.1");
        const betaFeed = resolveFeed(manifests, "darwin-beta-aarch64-app");
        assert.equal(betaFeed?.manifest, "latest-darwin-beta-aarch64-app.json");
        assert.equal(betaFeed?.key, "darwin-beta-aarch64-app");
        assert.match(betaFeed?.url ?? "", /\/ROSI\.app\.tar\.gz$/);
        return {
          stable: { checks: stable.checks, feed: stableFeed },
          beta: { checks: beta.checks, feed: betaFeed },
        };
      },
    );

    await scenario(
      "Z03.6",
      "renderer keeps existing targets when the command returns no compact target (non-macOS)",
      async () => {
        const stable = await runRendererCheck({
          channel: "stable",
          compactTarget: null,
          feed: () => null,
        });
        const beta = await runRendererCheck({
          channel: "beta",
          compactTarget: null,
          feed: () => null,
        });
        assert.ok(stable.checks.every((target) => target === null));
        assert.ok(
          beta.checks.every((target) => target === "darwin-beta-aarch64-app"),
        );
        return { stable: stable.checks, beta: beta.checks };
      },
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    version,
    host: `${os.platform()}-${os.arch()}`,
    universalGzipBytes: fs.statSync(universalArchive).size,
    ok: scenarios.every((s) => s.ok),
    scenarios,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${path.relative(root, reportPath)}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `e2e-updater-zst: FAILED: ${error instanceof Error ? error.stack : error}`,
  );
  process.exit(1);
});
