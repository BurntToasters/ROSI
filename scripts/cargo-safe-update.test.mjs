import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import {
  CARGO_SAFE_UPDATE_POLICY_VERSION,
  CARGO_SAFE_UPDATE_VERSION,
  MIN_PUBLISH_AGE_MS,
  acquireUpdateLock,
  crateIndexPath,
  filterRegistryIndex,
  findWorkspaceRoot,
  locateWorkspaceRoot,
  installValidatedLock,
  isPublishAgeAllowed,
  parseArguments,
  parsePublishTime,
  prepareCandidate,
  restoreRealLock,
  validateCandidate,
} from "./cargo-safe-update.mjs";
import {
  MINIMUM_NPM_VERSION,
  assertVendoredUpdaterParity,
  hasRustToolchain,
  isSupportedNodeVersion,
  isVersionAtLeast,
  npmAuditPlan,
  npmUpdateArguments,
  npmUpdateInvocation,
  parseVersion,
  readPinnedRustToolchain,
  restoreSnapshot,
  usesWindowsCmdShell,
} from "./npm-safe-update.mjs";

// Skip real Cargo integration tests if SKIP_CARGO_INTEGRATION=1
const SKIP_CARGO_INTEGRATION = process.env.SKIP_CARGO_INTEGRATION === "1";

// Simple no-dep Cargo fixture used for real Cargo tests
function createCargoFixture(
  dir,
  { name = "test-fixture", members = null, isVirtual = false } = {},
) {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "lib.rs"), "// no-op\n");
  if (isVirtual) {
    // Virtual workspace: no [package], just [workspace]
    const membersList = members
      ? `members = ${JSON.stringify(members)}`
      : "members = []";
    writeFileSync(
      path.join(dir, "Cargo.toml"),
      `[workspace]\n${membersList}\n`,
    );
  } else {
    writeFileSync(
      path.join(dir, "Cargo.toml"),
      `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n`,
    );
  }
}

const now = Date.parse("2026-08-20T12:00:00Z");
const olderThan72h = "2026-08-17T11:59:59Z";
const youngerThan72h = "2026-08-19T12:00:00Z";

function withMockFetch(records, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    for (const [pattern, handler] of Object.entries(records)) {
      if (urlStr.includes(pattern)) {
        if (typeof handler === "function") return handler(urlStr);
        if (handler.error) throw new Error(handler.error);
        if (handler.status && handler.status !== 200) {
          return new globalThis.Response("Not Found", {
            status: handler.status,
          });
        }
        const text = Array.isArray(handler)
          ? handler.map((r) => JSON.stringify(r)).join("\n")
          : typeof handler === "string"
            ? handler
            : JSON.stringify(handler);
        return new globalThis.Response(text, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new globalThis.Response("Not found", { status: 404 });
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test("1. allows publish age older than 72 hours", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    { "3/f/foo": [{ name: "foo", vers: "1.0.0", pubtime: olderThan72h }] },
    async () => {
      const result = await validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set() },
        now,
      );
      assert.equal(result.newlySelected.length, 1);
      assert.equal(result.approved.length, 1);
    },
  );
});

test("2. allows publish age exactly at 72 hours and blocks below 72 hours", () => {
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS, now), true);
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS + 1, now), false);
  assert.equal(crateIndexPath("a"), "1/a");
  assert.equal(crateIndexPath("ab"), "2/ab");
  assert.equal(crateIndexPath("foo"), "3/f/foo");
  assert.equal(crateIndexPath("serde"), "se/rd/serde");
});

test("3. blocks too-young direct dependency", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "2.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    { "3/f/foo": [{ name: "foo", vers: "2.0.0", pubtime: youngerThan72h }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /BLOCKED: dependency update violates 72-hour publish-age policy/,
      );
    },
  );
});

test("4. blocks too-young transitive dependency", async () => {
  const baseline = [
    { name: "app", version: "0.1.0", source: null },
    {
      name: "foo",
      version: "1.1.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  const candidate = [
    { name: "app", version: "0.1.0", source: null },
    {
      name: "foo",
      version: "1.1.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
    {
      name: "transitive-dep",
      version: "0.1.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    {
      "3/f/foo": [{ name: "foo", vers: "1.1.0", pubtime: olderThan72h }],
      "tr/an/transitive-dep": [
        { name: "transitive-dep", vers: "0.1.0", pubtime: youngerThan72h },
      ],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /transitive-dep 0\.1\.0/,
      );
    },
  );
});

test("5. allows existing young version already locked in baseline", async () => {
  const baseline = [
    {
      name: "foo",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  const candidate = [
    {
      name: "foo",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  const result = await validateCandidate(
    baseline,
    candidate,
    { allowYoung: new Set(), allowGit: new Set() },
    now,
  );
  assert.equal(result.newlySelected.length, 0);
});

test("6. blocks version upgrade from old to young", async () => {
  const baseline = [
    {
      name: "foo",
      version: "1.2.2",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  const candidate = [
    {
      name: "foo",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    { "3/f/foo": [{ name: "foo", vers: "1.2.3", pubtime: youngerThan72h }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /foo 1\.2\.3/,
      );
    },
  );
});

test("7. fails closed for new package with missing pubtime", async () => {
  assert.equal(parsePublishTime(undefined), null);
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    { "3/f/foo": [{ name: "foo", vers: "1.0.0" }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /missing or invalid pubtime/,
      );
    },
  );
});

test("8. fails closed for malformed pubtime", async () => {
  assert.equal(parsePublishTime("not-a-timestamp"), null);
  assert.equal(isPublishAgeAllowed(null, now), false);
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    { "3/f/foo": [{ name: "foo", vers: "1.0.0", pubtime: "invalid-date" }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /missing or invalid pubtime/,
      );
    },
  );
});

test("9. fails closed on crates.io lookup failure (HTTP 500 / 404 / network error)", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch({ "3/f/foo": { status: 500 } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(
          baseline,
          candidate,
          { allowYoung: new Set(), allowGit: new Set() },
          now,
        ),
      /cannot prove publish age/,
    );
  });
  await withMockFetch({ "3/f/foo": { status: 404 } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(
          baseline,
          candidate,
          { allowYoung: new Set(), allowGit: new Set() },
          now,
        ),
      /cannot prove publish age/,
    );
  });
  await withMockFetch({ "3/f/foo": { error: "Network timeout" } }, async () => {
    await assert.rejects(
      () =>
        validateCandidate(
          baseline,
          candidate,
          { allowYoung: new Set(), allowGit: new Set() },
          now,
        ),
      /cannot prove publish age/,
    );
  });
});

test("10. applies exact emergency override and continues blocking other young packages", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
    {
      name: "bar",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    {
      "3/b/bar": [{ name: "bar", vers: "1.0.0", pubtime: youngerThan72h }],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(["foo@1.2.3"]), allowGit: new Set() },
            now,
          ),
        /bar 1\.0\.0/,
      );
    },
  );
});

test("11. rejects emergency override when reason is missing", () => {
  assert.throws(
    () => parseArguments(["--allow-young", "foo@1.2.3"]),
    /--reason is required with every emergency override/,
  );
  assert.throws(
    () => parseArguments(["--allow-git", "repo@abc"]),
    /--reason is required with every emergency override/,
  );
});

test("12. continues blocking un-overridden transitive package during emergency override", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "foo",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
    {
      name: "transitive",
      version: "0.4.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    },
  ];
  await withMockFetch(
    {
      "tr/an/transitive": [
        { name: "transitive", vers: "0.4.0", pubtime: youngerThan72h },
      ],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(["foo@1.2.3"]), allowGit: new Set() },
            now,
          ),
        /transitive 0\.4\.0/,
      );
    },
  );
});

test("13. blocks git dependency revision change without override", async () => {
  const baseline = [
    {
      name: "my-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/repo#OLDREV",
    },
  ];
  const candidate = [
    {
      name: "my-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/repo#NEWREV",
    },
  ];
  await assert.rejects(
    () =>
      validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set() },
        now,
      ),
    /Blocked Git dependency update:\nmy-git-dep/,
  );
});

test("14. applies exact git override and continues blocking other git revision changes", async () => {
  const baseline = [
    {
      name: "my-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/repo#OLDREV",
    },
    {
      name: "other-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/other#OLDREV",
    },
  ];
  const candidate = [
    {
      name: "my-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/repo#NEWREV",
    },
    {
      name: "other-git-dep",
      version: "0.1.0",
      source: "git+https://github.com/example/other#NEWREV",
    },
  ];
  await assert.rejects(
    () =>
      validateCandidate(
        baseline,
        candidate,
        { allowYoung: new Set(), allowGit: new Set(["my-git-dep@NEWREV"]) },
        now,
      ),
    /other-git-dep/,
  );
});

test("15. ignores path and workspace dependencies for publish-age validation", async () => {
  const baseline = [];
  const candidate = [
    { name: "local-crate", version: "0.1.0", source: null },
    {
      name: "path-crate",
      version: "0.2.0",
      source: "path+file:///crates/path-crate",
    },
  ];
  const result = await validateCandidate(
    baseline,
    candidate,
    { allowYoung: new Set(), allowGit: new Set() },
    now,
  );
  assert.equal(result.newlySelected.length, 2);
  assert.equal(result.approved.length, 0);
});

test("16. blocks unsupported or private registry", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "private-pkg",
      version: "1.0.0",
      source: "registry+https://private.example/index",
    },
  ];
  await withMockFetch(
    { "pr/iv/private-pkg": [{ name: "private-pkg", vers: "1.0.0" }] },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /unsupported registry/,
      );
    },
  );
});

test("17. blocks alternate registry even when it claims an old pubtime", async () => {
  const baseline = [];
  const candidate = [
    {
      name: "private-pkg",
      version: "1.0.0",
      source: "registry+https://private.example/index",
    },
  ];
  await withMockFetch(
    {
      "pr/iv/private-pkg": [
        { name: "private-pkg", vers: "1.0.0", pubtime: olderThan72h },
      ],
    },
    async () => {
      await assert.rejects(
        () =>
          validateCandidate(
            baseline,
            candidate,
            { allowYoung: new Set(), allowGit: new Set() },
            now,
          ),
        /unsupported registry/,
      );
    },
  );
});

test("18. unit: restoreRealLock preserves lockfile byte-for-byte on failure or drift", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "cargo-test-restore-"));
  try {
    const lockPath = path.join(tempDir, "Cargo.lock");
    const originalBytes = Buffer.from(
      "# EXACT_ORIGINAL_LOCKFILE_BYTES\nversion = 4\n",
    );
    writeFileSync(lockPath, originalBytes);

    writeFileSync(
      lockPath,
      Buffer.from("# TAMPERED_LOCKFILE_BYTES\nversion = 4\n"),
    );
    restoreRealLock(lockPath, {
      path: lockPath,
      existed: true,
      bytes: originalBytes,
    });
    assert.deepEqual(readFileSync(lockPath), originalBytes);

    rmSync(lockPath, { force: true });
    restoreRealLock(lockPath, {
      path: lockPath,
      existed: true,
      bytes: originalBytes,
    });
    assert.deepEqual(readFileSync(lockPath), originalBytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("19. transaction: installValidatedLock installs exact validated candidate lockfile on success", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "cargo-test-install-"));
  try {
    const manifestFilePath = path.join(tempDir, "Cargo.toml");
    const realLock = path.join(tempDir, "Cargo.lock");
    const candidateLock = path.join(tempDir, "Candidate.lock");
    mkdirSync(path.join(tempDir, "src"), { recursive: true });
    writeFileSync(path.join(tempDir, "src", "lib.rs"), "");

    writeFileSync(
      manifestFilePath,
      '[package]\nname = "test-pkg"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n',
    );
    const candidateContent = Buffer.from(
      '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "test-pkg"\nversion = "0.1.0"\n',
    );
    writeFileSync(realLock, Buffer.from("# ORIGINAL\nversion = 4\n"));
    writeFileSync(candidateLock, candidateContent);

    installValidatedLock(
      candidateLock,
      {
        path: realLock,
        existed: true,
        bytes: Buffer.from("# ORIGINAL\nversion = 4\n"),
      },
      ["--manifest-path", manifestFilePath],
      tempDir,
    );
    assert.deepEqual(readFileSync(realLock), candidateContent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("20. transaction: installValidatedLock rolls back to original lockfile when final verification fails", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "cargo-test-rollback-"));
  try {
    const realLock = path.join(tempDir, "Cargo.lock");
    const candidateLock = path.join(tempDir, "Candidate.lock");
    const originalContent = Buffer.from("# ORIGINAL_BYTES\nversion = 4\n");
    writeFileSync(realLock, originalContent);
    writeFileSync(
      candidateLock,
      Buffer.from("# INVALID_CANDIDATE\nversion = 4\n"),
    );

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: true, bytes: originalContent },
          ["--manifest-path", path.join(tempDir, "nonexistent-Cargo.toml")],
          tempDir,
        ),
      /Final Cargo\.lock verification failed; original lock restored\./,
    );

    assert.deepEqual(readFileSync(realLock), originalContent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("21. unit: detects and restores real lockfile modification drift during resolution", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "cargo-test-drift-"));
  try {
    const realLock = path.join(tempDir, "Cargo.lock");
    const originalBytes = Buffer.from("original lock bytes");
    writeFileSync(realLock, originalBytes);

    writeFileSync(realLock, Buffer.from("unexpectedly mutated lock bytes"));
    restoreRealLock(realLock, {
      path: realLock,
      existed: true,
      bytes: originalBytes,
    });
    assert.deepEqual(readFileSync(realLock), originalBytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("22. candidate stage implementation never invokes cargo build/check/test/run/bench", () => {
  const source = readFileSync(
    new URL("./cargo-safe-update.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:run|runAsync)\(\s*['"]cargo['"]\s*,\s*\[\s*['"](build|check|test|run|bench|install)['"]/,
  );
  assert.doesNotMatch(source, /\btauri\s+build\b/);
});

test("23. preserves and forwards standard Cargo update arguments", () => {
  const parsed = parseArguments([
    "-p",
    "serde",
    "--precise",
    "1.0.200",
    "--recursive",
    "--workspace",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-v",
  ]);
  assert.deepEqual(parsed.cargoArgs, [
    "-p",
    "serde",
    "--precise",
    "1.0.200",
    "--recursive",
    "--workspace",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-v",
  ]);
});

test("24. unit: prepares candidate in temporary lockfile using CARGO_RESOLVER_LOCKFILE_PATH and leaves it nonexistent if no baseline", () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "cargo-test-ws-"));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cargo-test-temp-"));
  try {
    // When no baseline lockfile exists:
    const result = prepareCandidate({
      cargoArgs: ["--manifest-path", path.join(workspaceDir, "Cargo.toml")],
      cwd: workspaceDir,
      realLock: null,
      baselineMetadata: null,
      tempRoot,
    });
    if (!result.copiedWorkspace) {
      assert.ok(result.env.CARGO_RESOLVER_LOCKFILE_PATH);
      assert.equal(
        path.basename(result.env.CARGO_RESOLVER_LOCKFILE_PATH),
        "Cargo.lock",
      );
      // Invariant: candidateLock MUST NOT exist before Cargo creates it!
      assert.equal(existsSync(result.candidateLock), false);
    }
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("25. dependency update entry points use guarded Cargo resolution", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["u", "u2", "deps:rust:update"]) {
    const command = packageJson.scripts?.[name];
    if (!command) continue;
    assert.doesNotMatch(command, /\bcargo update\b/);
    assert.match(command, /cargo-safe-update/);
  }
  for (const name of ["u", "u2"]) {
    const command = packageJson.scripts[name];
    assert.match(command, /npm-safe-update/);
    assert.match(command, /sync-version\.js/);
    assert.match(command, /update-metainfo\.js/);
    assert.doesNotMatch(command, /workspace:bootstrap|format|test:all/);
  }
});

test("26. unit: no-lock workspace generates candidate in temp, leaves real lock untouched, installs on approval", () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-int-nolock-"));
  const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-int-guard-"));
  try {
    const manifestFilePath = path.join(tempWs, "Cargo.toml");
    const realLock = path.join(tempWs, "Cargo.lock");
    mkdirSync(path.join(tempWs, "src"), { recursive: true });
    writeFileSync(path.join(tempWs, "src", "lib.rs"), "// simple lib\n");
    writeFileSync(
      manifestFilePath,
      '[package]\nname = "no-lock-fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n',
    );

    assert.equal(
      existsSync(realLock),
      false,
      "real Cargo.lock must not exist initially",
    );

    const prep = prepareCandidate({
      cargoArgs: ["--manifest-path", manifestFilePath],
      cwd: tempWs,
      realLock: null,
      baselineMetadata: null,
      tempRoot: tempGuard,
    });

    if (!prep.copiedWorkspace) {
      assert.equal(
        existsSync(prep.candidateLock),
        false,
        "candidateLock must not exist prior to resolution",
      );
    }

    // Simulate approval and transactional install
    const candidateContent = Buffer.from(
      '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "no-lock-fixture"\nversion = "0.1.0"\n',
    );
    writeFileSync(prep.candidateLock, candidateContent);

    assert.equal(
      existsSync(realLock),
      false,
      "real lock still does not exist before install",
    );

    installValidatedLock(
      prep.candidateLock,
      { path: realLock, existed: false, bytes: null },
      ["--manifest-path", manifestFilePath],
      tempWs,
    );

    assert.equal(existsSync(realLock), true, "real lock installed on approval");
    assert.deepEqual(readFileSync(realLock), candidateContent);
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
    rmSync(tempGuard, { recursive: true, force: true });
  }
});

test("27. unit: no-lock workspace restores absence on policy rejection or resolution failure", () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-int-reject-"));
  try {
    const realLock = path.join(tempWs, "Cargo.lock");
    assert.equal(existsSync(realLock), false);

    // If realLock was unexpectedly created during dirty resolution:
    writeFileSync(realLock, Buffer.from("dirty resolution bytes"));
    restoreRealLock(realLock, { path: realLock, existed: false, bytes: null });

    assert.equal(
      existsSync(realLock),
      false,
      "real lockfile must be deleted on rollback to absence",
    );
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
  }
});

test("28. transaction: no-lock workspace restores absence if final verification fails", () => {
  const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-int-verifail-"));
  const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-int-vguard-"));
  try {
    const realLock = path.join(tempWs, "Cargo.lock");
    const candidateLock = path.join(tempGuard, "Cargo.lock");
    writeFileSync(
      candidateLock,
      Buffer.from("# INVALID_CANDIDATE\nversion = 4\n"),
    );

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: false, bytes: null },
          ["--manifest-path", path.join(tempWs, "nonexistent-Cargo.toml")],
          tempWs,
        ),
      /Final Cargo\.lock verification failed; original lock restored\./,
    );

    assert.equal(
      existsSync(realLock),
      false,
      "new real Cargo.lock must be removed if workspace originally had no lockfile",
    );
  } finally {
    rmSync(tempWs, { recursive: true, force: true });
    rmSync(tempGuard, { recursive: true, force: true });
  }
});

test("29. unit: findWorkspaceRoot correctly locates roots for standalone, member, and virtual workspaces", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cargo-ws-roots-"));
  try {
    // 1. Nested standalone (src-tauri without root workspace)
    const standaloneDir = path.join(tempRoot, "standalone");
    const tauriDir = path.join(standaloneDir, "src-tauri");
    mkdirSync(tauriDir, { recursive: true });
    writeFileSync(
      path.join(tauriDir, "Cargo.toml"),
      '[package]\nname = "standalone"\nversion = "0.1.0"\n',
    );
    assert.equal(
      findWorkspaceRoot(path.join(tauriDir, "Cargo.toml")),
      tauriDir,
    );

    // 2. Member of workspace (repo with root Cargo.toml [workspace] and crates/app)
    const wsDir = path.join(tempRoot, "ws-with-members");
    const appDir = path.join(wsDir, "crates", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(wsDir, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/app"]\n',
    );
    writeFileSync(
      path.join(appDir, "Cargo.toml"),
      '[package]\nname = "app"\nversion = "0.1.0"\n',
    );
    assert.equal(findWorkspaceRoot(path.join(appDir, "Cargo.toml")), wsDir);

    // 3. Virtual workspace root
    assert.equal(findWorkspaceRoot(path.join(wsDir, "Cargo.toml")), wsDir);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("30. version markers are exported", () => {
  assert.equal(CARGO_SAFE_UPDATE_POLICY_VERSION, 5);
  assert.equal(CARGO_SAFE_UPDATE_VERSION, 5);
});

// --- Phase 2: Cargo-authoritative workspace root tests ---
// These require real Cargo to be installed.

test(
  "31. locateWorkspaceRoot: standalone nested src-tauri (real cargo locate-project)",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "cargo-locate-standalone-"),
    );
    try {
      const projectDir = path.join(tempRoot, "project");
      const tauriDir = path.join(projectDir, "src-tauri");
      mkdirSync(tauriDir, { recursive: true });
      createCargoFixture(tauriDir, { name: "standalone-tauri" });

      const result = locateWorkspaceRoot(
        path.join(tauriDir, "Cargo.toml"),
        tauriDir,
      );
      assert.equal(
        result,
        tauriDir,
        "workspace root for nested standalone should be src-tauri dir",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "32. locateWorkspaceRoot: workspace member → returns workspace root (real cargo locate-project)",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "cargo-locate-member-"),
    );
    try {
      const wsDir = tempRoot;
      const appDir = path.join(wsDir, "crates", "app");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(path.join(appDir, "src"), { recursive: true });
      writeFileSync(path.join(appDir, "src", "lib.rs"), "// member\n");
      writeFileSync(
        path.join(appDir, "Cargo.toml"),
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n',
      );
      writeFileSync(
        path.join(wsDir, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n',
      );

      const result = locateWorkspaceRoot(
        path.join(appDir, "Cargo.toml"),
        wsDir,
      );
      assert.equal(
        result,
        wsDir,
        "workspace root for member should be workspace root",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "33. locateWorkspaceRoot: virtual workspace → returns workspace root (real cargo locate-project)",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "cargo-locate-virtual-"),
    );
    try {
      const wsDir = tempRoot;
      const crateA = path.join(wsDir, "crates", "a");
      mkdirSync(crateA, { recursive: true });
      mkdirSync(path.join(crateA, "src"), { recursive: true });
      writeFileSync(path.join(crateA, "src", "lib.rs"), "// crate a\n");
      writeFileSync(
        path.join(crateA, "Cargo.toml"),
        '[package]\nname = "crate-a"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n',
      );
      // Virtual workspace: no [package], just [workspace]
      writeFileSync(
        path.join(wsDir, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n',
      );

      const result = locateWorkspaceRoot(
        path.join(crateA, "Cargo.toml"),
        wsDir,
      );
      assert.equal(
        result,
        wsDir,
        "workspace root for virtual workspace member should be workspace root",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "34. locateWorkspaceRoot: fails closed on invalid manifest path",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    assert.throws(
      () => locateWorkspaceRoot("/nonexistent/path/to/Cargo.toml"),
      /Unable to determine Cargo workspace root|cargo locate-project|failed/,
    );
  },
);

// --- Phase 3: Real Cargo no-lock integration tests ---

test(
  "35. integration: standalone no-lock - real cargo update creates candidate, real lock stays absent, install creates real lock",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-real-nolock-"));
    const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-real-guard-"));
    try {
      createCargoFixture(tempWs, { name: "cargo-safe-update-no-lock-fixture" });
      const manifestFilePath = path.join(tempWs, "Cargo.toml");
      const realLock = path.join(tempWs, "Cargo.lock");

      assert.equal(existsSync(realLock), false, "precondition: no Cargo.lock");

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath],
        cwd: tempWs,
        realLock: null,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: tempWs,
      });

      if (!prep.copiedWorkspace) {
        // CARGO_RESOLVER_LOCKFILE_PATH mode: candidate starts absent
        assert.equal(
          existsSync(prep.candidateLock),
          false,
          "candidate must not exist before cargo update",
        );

        // Run real cargo update with redirected lock
        const result = spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });
        assert.equal(
          result.status,
          0,
          `cargo update failed:\n${result.stderr}`,
        );

        // Candidate lock must now exist
        assert.equal(
          existsSync(prep.candidateLock),
          true,
          "candidate Cargo.lock must exist after cargo update",
        );

        // Real workspace lock must still be absent
        assert.equal(
          existsSync(realLock),
          false,
          "real Cargo.lock must remain absent before approval",
        );

        // cargo metadata --locked with candidate env must succeed
        const metaResult = spawnSync(
          "cargo",
          [
            "metadata",
            "--locked",
            "--format-version=1",
            "--manifest-path",
            manifestFilePath,
          ],
          { cwd: prep.cwd, env: prep.env, encoding: "utf8" },
        );
        assert.equal(
          metaResult.status,
          0,
          `cargo metadata failed:\n${metaResult.stderr}`,
        );

        // Install the candidate
        installValidatedLock(
          prep.candidateLock,
          { path: realLock, existed: false, bytes: null },
          ["--manifest-path", manifestFilePath],
          tempWs,
        );

        assert.equal(
          existsSync(realLock),
          true,
          "real Cargo.lock installed after approval",
        );

        // Final cargo metadata --locked must succeed
        const finalMeta = spawnSync(
          "cargo",
          [
            "metadata",
            "--locked",
            "--format-version=1",
            "--manifest-path",
            manifestFilePath,
          ],
          { cwd: tempWs, env: process.env, encoding: "utf8" },
        );
        assert.equal(
          finalMeta.status,
          0,
          `final cargo metadata failed:\n${finalMeta.stderr}`,
        );
      }
    } finally {
      rmSync(tempWs, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test(
  "36. integration: standalone no-lock dry-run - real lock remains absent after full flow",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-real-dryrun-"));
    const tempGuard = mkdtempSync(
      path.join(os.tmpdir(), "cargo-real-dryguard-"),
    );
    try {
      createCargoFixture(tempWs, { name: "cargo-safe-update-dryrun-fixture" });
      const manifestFilePath = path.join(tempWs, "Cargo.toml");
      const realLock = path.join(tempWs, "Cargo.lock");

      assert.equal(existsSync(realLock), false);

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath, "--dry-run"],
        cwd: tempWs,
        realLock: null,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: tempWs,
      });

      if (!prep.copiedWorkspace) {
        spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });
        // In dry-run we never call installValidatedLock, so real lock stays absent
        assert.equal(
          existsSync(realLock),
          false,
          "real Cargo.lock must remain absent in dry-run",
        );
      }
    } finally {
      rmSync(tempWs, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test(
  "37. integration: nested src-tauri no-lock - lock goes to src-tauri, not parent",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempProject = mkdtempSync(
      path.join(os.tmpdir(), "cargo-real-nested-"),
    );
    const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-real-nguard-"));
    try {
      const tauriDir = path.join(tempProject, "src-tauri");
      mkdirSync(tauriDir, { recursive: true });
      createCargoFixture(tauriDir, { name: "nested-tauri-fixture" });

      const manifestFilePath = path.join(tauriDir, "Cargo.toml");
      const expectedLock = path.join(tauriDir, "Cargo.lock");
      const wrongLock = path.join(tempProject, "Cargo.lock");

      const wsRoot = locateWorkspaceRoot(manifestFilePath, tauriDir);
      assert.equal(
        wsRoot,
        tauriDir,
        "workspace root for nested standalone should be src-tauri",
      );

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath],
        cwd: tauriDir,
        realLock: null,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: wsRoot,
      });

      if (!prep.copiedWorkspace) {
        spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });

        assert.equal(
          existsSync(expectedLock),
          false,
          "real lock must not exist in src-tauri before approval",
        );
        assert.equal(
          existsSync(wrongLock),
          false,
          "lock must NOT be created in parent dir",
        );
      }
    } finally {
      rmSync(tempProject, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test(
  "38. integration: workspace member no-lock - lock goes to workspace root",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-real-wsmember-"));
    const tempGuard = mkdtempSync(
      path.join(os.tmpdir(), "cargo-real-wmguard-"),
    );
    try {
      const appDir = path.join(tempWs, "crates", "app");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(path.join(appDir, "src"), { recursive: true });
      writeFileSync(path.join(appDir, "src", "lib.rs"), "// member\n");
      writeFileSync(
        path.join(appDir, "Cargo.toml"),
        '[package]\nname = "ws-member-fixture"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n',
      );
      writeFileSync(
        path.join(tempWs, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n',
      );

      const manifestFilePath = path.join(appDir, "Cargo.toml");
      const wsRoot = locateWorkspaceRoot(manifestFilePath, tempWs);
      assert.equal(wsRoot, tempWs);

      const expectedLock = path.join(tempWs, "Cargo.lock");
      const wrongLock = path.join(appDir, "Cargo.lock");

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath],
        cwd: tempWs,
        realLock: null,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: wsRoot,
      });

      if (!prep.copiedWorkspace) {
        spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });

        assert.equal(
          existsSync(expectedLock),
          false,
          "real workspace lock must stay absent before approval",
        );
        assert.equal(
          existsSync(wrongLock),
          false,
          "lock must NOT be created at member level",
        );
      }
    } finally {
      rmSync(tempWs, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test(
  "39. integration: virtual workspace no-lock - lock goes to virtual workspace root",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-real-virtual-"));
    const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-real-vguard-"));
    try {
      const crateA = path.join(tempWs, "crates", "a");
      mkdirSync(crateA, { recursive: true });
      mkdirSync(path.join(crateA, "src"), { recursive: true });
      writeFileSync(path.join(crateA, "src", "lib.rs"), "// virtual member\n");
      writeFileSync(
        path.join(crateA, "Cargo.toml"),
        '[package]\nname = "virtual-fixture"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n',
      );
      writeFileSync(
        path.join(tempWs, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n',
      );

      const manifestFilePath = path.join(crateA, "Cargo.toml");
      const wsRoot = locateWorkspaceRoot(manifestFilePath, tempWs);
      assert.equal(wsRoot, tempWs);

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath],
        cwd: tempWs,
        realLock: null,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: wsRoot,
      });

      if (!prep.copiedWorkspace) {
        spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });
        assert.equal(
          existsSync(path.join(tempWs, "Cargo.lock")),
          false,
          "root lock must stay absent before approval",
        );
      }
    } finally {
      rmSync(tempWs, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test(
  "40. integration: existing lock baseline - normal path works, original untouched before approval",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempWs = mkdtempSync(path.join(os.tmpdir(), "cargo-real-existing-"));
    const tempGuard = mkdtempSync(path.join(os.tmpdir(), "cargo-real-eguard-"));
    try {
      createCargoFixture(tempWs, { name: "cargo-existing-lock-fixture" });
      const manifestFilePath = path.join(tempWs, "Cargo.toml");
      const realLock = path.join(tempWs, "Cargo.lock");

      // Generate initial lockfile
      const initResult = spawnSync(
        "cargo",
        ["generate-lockfile", "--manifest-path", manifestFilePath],
        {
          cwd: tempWs,
          env: process.env,
          encoding: "utf8",
        },
      );
      assert.equal(
        initResult.status,
        0,
        `generate-lockfile failed:\n${initResult.stderr}`,
      );
      assert.equal(existsSync(realLock), true, "initial Cargo.lock must exist");

      const originalLockBytes = readFileSync(realLock);

      const prep = prepareCandidate({
        cargoArgs: ["--manifest-path", manifestFilePath],
        cwd: tempWs,
        realLock,
        baselineMetadata: null,
        tempRoot: tempGuard,
        workspaceRoot: tempWs,
      });

      if (!prep.copiedWorkspace) {
        spawnSync("cargo", ["update", ...prep.args], {
          cwd: prep.cwd,
          env: prep.env,
          encoding: "utf8",
        });
        // Real lock must be unchanged before approval
        assert.deepEqual(
          readFileSync(realLock),
          originalLockBytes,
          "real lock must remain unchanged before approval",
        );
      }
    } finally {
      rmSync(tempWs, { recursive: true, force: true });
      rmSync(tempGuard, { recursive: true, force: true });
    }
  },
);

test("41. transaction: rollback existing lock restores exact bytes on verification failure", () => {
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "cargo-rollback-existing-"),
  );
  try {
    const realLock = path.join(tempDir, "Cargo.lock");
    const candidateLock = path.join(tempDir, "Candidate.lock");
    const originalContent = Buffer.from("# EXACT_ORIGINAL_LOCK\nversion = 4\n");
    writeFileSync(realLock, originalContent);
    writeFileSync(
      candidateLock,
      Buffer.from("# INVALID_CANDIDATE\nversion = 4\n"),
    );

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: true, bytes: originalContent },
          ["--manifest-path", path.join(tempDir, "nonexistent-Cargo.toml")],
          tempDir,
        ),
      /Final Cargo\.lock verification failed; original lock restored\./,
    );
    // Exact bytes must be restored
    assert.deepEqual(readFileSync(realLock), originalContent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("42. registry filter keeps eligible releases while hiding only too-young releases", () => {
  const source = [
    { name: "foo", vers: "1.0.0", pubtime: youngerThan72h },
    { name: "foo", vers: "1.1.0", pubtime: olderThan72h },
    { name: "foo", vers: "1.2.0", pubtime: youngerThan72h },
    { name: "foo", vers: "1.3.0", pubtime: youngerThan72h },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

  const filtered = filterRegistryIndex(
    source,
    [
      {
        name: "foo",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ],
    { allowYoung: new Set(["foo@1.3.0"]), allowGit: new Set() },
    now,
  );

  assert.deepEqual(
    filtered
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).vers),
    ["1.0.0", "1.1.0", "1.3.0"],
  );
});

test("43. rejects registry URLs that only contain the crates.io index name", async () => {
  let fetched = false;
  await withMockFetch(
    {
      "3/f/foo": () => {
        fetched = true;
        return new globalThis.Response("", { status: 200 });
      },
    },
    async () => {
      const pkg = {
        name: "foo",
        version: "1.0.0",
        source: "registry+https://evil.example/crates.io-index",
      };
      await assert.rejects(
        () =>
          validateCandidate(
            [pkg],
            [pkg],
            { allowYoung: new Set(["foo@1.0.0"]), allowGit: new Set() },
            now,
          ),
        /unsupported registry/,
      );
      assert.equal(
        fetched,
        false,
        "unsupported registry must fail before any registry fetch",
      );
    },
  );
});

test("44. deceptive registry baseline cannot preserve a too-young release", () => {
  const filtered = filterRegistryIndex(
    `${JSON.stringify({ name: "foo", vers: "1.0.0", pubtime: youngerThan72h })}\n`,
    [
      {
        name: "foo",
        version: "1.0.0",
        source: "registry+https://evil.example/crates.io-index",
      },
    ],
    { allowYoung: new Set(), allowGit: new Set() },
    now,
  );
  assert.equal(filtered, "");
});

test("45. update environment versions fail closed at exact boundaries", () => {
  assert.deepEqual(parseVersion("12.0.1"), [12, 0, 1]);
  assert.equal(isVersionAtLeast("12.0.1", MINIMUM_NPM_VERSION), true);
  assert.equal(isVersionAtLeast("12.1.0", MINIMUM_NPM_VERSION), true);
  assert.equal(isVersionAtLeast("12.0.0", MINIMUM_NPM_VERSION), false);
  assert.equal(isVersionAtLeast("11.99.99", MINIMUM_NPM_VERSION), false);
  assert.equal(isSupportedNodeVersion("22.22.2"), true);
  assert.equal(isSupportedNodeVersion("22.22.1"), false);
  assert.equal(isSupportedNodeVersion("23.99.99"), false);
  assert.equal(isSupportedNodeVersion("24.15.0"), true);
  assert.equal(isSupportedNodeVersion("24.14.9"), false);
  assert.equal(isSupportedNodeVersion("25.99.99"), false);
  assert.equal(isSupportedNodeVersion("26.0.0"), true);
  assert.throws(() => parseVersion("latest"), /Invalid semantic version/);
});

// Failure modes covered: a floating `stable` toolchain passes without the
// repository pin; a prefix match accepts 1.98.10 for 1.98.1; rustup's
// host-qualified exact version is rejected; or a malformed pin passes.
test("45a. npm updater requires exact repository-pinned Rust toolchain", () => {
  const root = process.cwd();
  const pinned = readPinnedRustToolchain(root);
  assert.equal(pinned, "1.98.1");
  assert.equal(hasRustToolchain("1.98.1\n", pinned), true);
  assert.equal(
    hasRustToolchain("1.98.1-aarch64-apple-darwin (default)\n", pinned),
    true,
  );
  assert.equal(hasRustToolchain("stable\n", pinned), false);
  assert.equal(
    hasRustToolchain("stable-aarch64-apple-darwin\n", pinned),
    false,
  );
  assert.equal(
    hasRustToolchain("1.98.10-aarch64-apple-darwin\n", pinned),
    false,
  );

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rust-toolchain-pin-"));
  try {
    writeFileSync(
      path.join(tempRoot, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "2.7.3"\n',
    );
    assert.equal(readPinnedRustToolchain(tempRoot), "2.7.3");
    writeFileSync(
      path.join(tempRoot, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "stable"\n',
    );
    assert.throws(
      () => readPinnedRustToolchain(tempRoot),
      /must pin an exact Rust version/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("46. npm lock update cannot install packages or run lifecycle scripts", () => {
  const args = npmUpdateArguments("/isolated/npm-cache");
  assert.deepEqual(args, [
    "update",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--min-release-age=3",
    "--cache=/isolated/npm-cache",
  ]);
});

test("46a. npm update audits production strictly and proves remaining findings are dev-only", () => {
  const root = path.join("isolated", "workspace");
  const plan = npmAuditPlan(root, "/isolated/npm-cache", {
    command: process.execPath,
    prefixArgs: ["/npm/cli.js"],
  });
  assert.deepEqual(plan, [
    {
      command: process.execPath,
      args: [
        "/npm/cli.js",
        "audit",
        "--omit=dev",
        "--audit-level=high",
        "--ignore-scripts",
        "--cache=/isolated/npm-cache",
      ],
    },
    {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./npm-dev-audit.cjs", import.meta.url)),
        "--root",
        root,
      ],
    },
  ]);
});

test("46b. Windows npm.cmd spawn uses a shell; other commands stay shell-less", () => {
  assert.equal(usesWindowsCmdShell("npm"), false);
  assert.equal(usesWindowsCmdShell("cargo"), false);
  assert.equal(usesWindowsCmdShell("npm.cmd"), process.platform === "win32");
  assert.equal(usesWindowsCmdShell("NPM.CMD"), process.platform === "win32");
});

test("46c. npm scripts use the shell-free Windows CLI invocation", () => {
  assert.deepEqual(
    npmUpdateInvocation({
      env: { npm_execpath: "C:\\npm\\cli.js" },
      platform: "win32",
      execPath: "C:\\node.exe",
    }),
    { command: "C:\\node.exe", prefixArgs: ["C:\\npm\\cli.js"] },
  );
  assert.deepEqual(
    npmUpdateInvocation({
      env: {},
      platform: "win32",
      execPath: "C:\\node.exe",
    }),
    { command: "npm.cmd", prefixArgs: [] },
  );
});

test("46d. npm update keeps JavaScript updater pinned to the vendored Rust version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "npm-updater-parity-"));
  try {
    const vendor = path.join(
      root,
      "src-tauri",
      "vendor",
      "tauri-plugin-updater",
    );
    mkdirSync(vendor, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@tauri-apps/plugin-updater": "2.10.1" },
      }),
    );
    writeFileSync(
      path.join(vendor, "Cargo.toml"),
      '[package]\nname = "tauri-plugin-updater"\nversion = "2.10.1"\n\n[dependencies]\n',
    );
    const lock = Buffer.from(
      JSON.stringify({
        packages: {
          "node_modules/@tauri-apps/plugin-updater": { version: "2.10.1" },
        },
      }),
    );
    assert.doesNotThrow(() => assertVendoredUpdaterParity(root, lock));

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@tauri-apps/plugin-updater": "^2.10.0" },
      }),
    );
    assert.throws(
      () => assertVendoredUpdaterParity(root, lock),
      /must be pinned exactly/,
    );

    const mismatchedLock = Buffer.from(
      JSON.stringify({
        packages: {
          "node_modules/@tauri-apps/plugin-updater": { version: "2.11.0" },
        },
      }),
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@tauri-apps/plugin-updater": "2.10.1" },
      }),
    );
    assert.throws(
      () => assertVendoredUpdaterParity(root, mismatchedLock),
      /vendored Rust version is 2\.10\.1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("47. concurrent Cargo dependency updates are rejected", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "cargo-update-lock-"));
  try {
    const release = acquireUpdateLock(tempDir);
    assert.throws(
      () => acquireUpdateLock(tempDir),
      /Another Cargo dependency update holds/,
    );
    release();
    const releaseAgain = acquireUpdateLock(tempDir);
    releaseAgain();
    assert.equal(
      existsSync(path.join(tempDir, ".cargo-safe-update.lock")),
      false,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("48. lock installation refuses to overwrite a concurrent edit", () => {
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "cargo-update-compare-swap-"),
  );
  try {
    const realLock = path.join(tempDir, "Cargo.lock");
    const candidateLock = path.join(tempDir, "Candidate.lock");
    const original = Buffer.from("# ORIGINAL\nversion = 4\n");
    const concurrent = Buffer.from("# CONCURRENT_EDIT\nversion = 4\n");
    writeFileSync(realLock, original);
    writeFileSync(candidateLock, Buffer.from("# CANDIDATE\nversion = 4\n"));
    writeFileSync(realLock, concurrent);

    assert.throws(
      () =>
        installValidatedLock(
          candidateLock,
          { path: realLock, existed: true, bytes: original },
          ["--manifest-path", path.join(tempDir, "Cargo.toml")],
          tempDir,
        ),
      /Cargo\.lock changed since dependency update started/,
    );
    assert.deepEqual(readFileSync(realLock), concurrent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  "49. end-to-end dry-run uses proxy and leaves caller Cargo home untouched",
  { skip: SKIP_CARGO_INTEGRATION },
  () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cargo-safe-e2e-"));
    try {
      const workspace = path.join(tempRoot, "workspace");
      const userCargoHome = path.join(tempRoot, "user-cargo-home");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(userCargoHome, { recursive: true });
      createCargoFixture(workspace, {
        name: "cargo-safe-update-proxy-fixture",
      });
      const manifest = path.join(workspace, "Cargo.toml");
      writeFileSync(
        manifest,
        `${readFileSync(manifest, "utf8")}\n[dependencies]\nitoa = "=1.0.10"\n`,
      );
      writeFileSync(path.join(userCargoHome, "sentinel"), "unchanged\n");

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./cargo-safe-update.mjs", import.meta.url)),
          "--manifest-path",
          manifest,
          "--dry-run",
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CARGO_HOME: userCargoHome,
            RUSTUP_TOOLCHAIN: readPinnedRustToolchain(process.cwd()),
          },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /Dry run: real Cargo\.lock was not modified\./,
      );
      assert.equal(existsSync(path.join(workspace, "Cargo.lock")), false);
      assert.deepEqual(readdirSync(userCargoHome), ["sentinel"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test("50. end-to-end npm update is lock-only and uses a disposable cache", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "npm-safe-e2e-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    const userNpmCache = path.join(tempRoot, "user-npm-cache");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(userNpmCache, { recursive: true });
    writeFileSync(
      path.join(workspace, "package.json"),
      `${JSON.stringify({ name: "npm-safe-fixture", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "npm-safe-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "npm-safe-fixture", version: "1.0.0" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(userNpmCache, "sentinel"), "unchanged\n");

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./npm-safe-update.mjs", import.meta.url))],
      {
        cwd: workspace,
        env: { ...process.env, npm_config_cache: userNpmCache },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(workspace, "node_modules")), false);
    assert.equal(
      existsSync(path.join(workspace, ".npm-safe-update.lock")),
      false,
    );
    assert.deepEqual(readdirSync(userNpmCache), ["sentinel"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("51. npm rollback refuses to overwrite a concurrent package-lock edit", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "npm-safe-rollback-"));
  try {
    const packageLock = path.join(tempRoot, "package-lock.json");
    const original = { existed: true, bytes: Buffer.from("original\n") };
    const candidate = { existed: true, bytes: Buffer.from("candidate\n") };
    writeFileSync(packageLock, "concurrent\n");

    assert.throws(
      () => restoreSnapshot(packageLock, original, candidate),
      /Concurrent package-lock edit detected/,
    );
    assert.equal(readFileSync(packageLock, "utf8"), "concurrent\n");

    writeFileSync(packageLock, candidate.bytes);
    restoreSnapshot(packageLock, original, candidate);
    assert.equal(readFileSync(packageLock, "utf8"), "original\n");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
