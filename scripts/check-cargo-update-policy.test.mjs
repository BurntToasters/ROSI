import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPolicyCheck } from "./check-cargo-update-policy.mjs";

function createTempRepo() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "policy-scan-test-"));
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      scripts: {
        u: "node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml",
      },
    }),
  );
  mkdirSync(path.join(tempDir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(tempDir, "scripts", "cargo-safe-update.mjs"),
    "// approved implementation\ncargo update\n",
  );
  writeFileSync(
    path.join(tempDir, "scripts", "npm-safe-update.mjs"),
    "// approved implementation\nnpm update\n",
  );
  return tempDir;
}

test("1. allows guarded update in package.json and approved implementation", () => {
  const root = createTempRepo();
  try {
    const logs = [];
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, true);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. blocks raw cargo update in package.json", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          u: "cd src-tauri && cargo update",
        },
      }),
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. blocks guarded plus raw update in one chained command", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          u: "node scripts/cargo-safe-update.mjs && cargo update",
        },
      }),
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. blocks recursive nested script in scripts/deps/rust/update.sh", () => {
  const root = createTempRepo();
  try {
    const nested = path.join(root, "scripts", "deps", "rust");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "update.sh"), "#!/bin/sh\ncargo update\n");
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("scripts/deps/rust/update.sh")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. blocks Unix lock deletion (rm -f src-tauri/Cargo.lock)", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "reset.sh"),
      "#!/bin/sh\nrm -f src-tauri/Cargo.lock\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("Cargo.lock deletion")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. blocks PowerShell lock deletion (Remove-Item -Force src-tauri/Cargo.lock)", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "reset.ps1"),
      "Remove-Item -Force src-tauri/Cargo.lock\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("Cargo.lock deletion")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. blocks cmd/batch deletion (del /f src-tauri\\Cargo.lock)", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "reset.cmd"),
      "del /f src-tauri\\Cargo.lock\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("Cargo.lock deletion")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. blocks batch file in tools/update-deps.bat", () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(
      path.join(root, "tools", "update-deps.bat"),
      "@echo off\ncargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("tools/update-deps.bat")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9. blocks Taskfile mutation (Taskfile.yml with cargo update)", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "Taskfile.yml"),
      'version: "3"\ntasks:\n  deps:\n    cmds:\n      - cargo update\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("Taskfile.yml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10. blocks Taskfile lock deletion (Taskfile.yaml with rm Cargo.lock)", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "Taskfile.yaml"),
      'version: "3"\ntasks:\n  clean:\n    cmds:\n      - rm Cargo.lock\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("Taskfile.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("11. allows documentation files containing cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "README.md"),
      "To update dependencies, run `cargo update` or `npm run u`.\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("12. requires exact path exclusion (tools/cargo-safe-update.mjs is blocked)", () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(
      path.join(root, "tools", "cargo-safe-update.mjs"),
      "cargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("tools/cargo-safe-update.mjs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P0: line-wide guard bypass regression tests ---

test("13. blocks cargo-safe-update.mjs && cargo update in a shell file", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.sh"),
      "#!/bin/sh\nnode scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml && cargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("14. blocks echo cargo-safe-update && cargo update in a shell file", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.sh"),
      "#!/bin/sh\necho cargo-safe-update && cargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("15a. blocks guarded wrapper + raw update in .ps1 file", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.ps1"),
      "node scripts/cargo-safe-update.mjs; cargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("15b. blocks guarded wrapper + raw update in .mjs file", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.mjs"),
      '// updater\nconst x = "node scripts/cargo-safe-update.mjs";\ncargo update\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("raw Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P1: programmatic JS/TS Cargo mutation detection ---

test('16. blocks spawnSync("cargo", ["update"]) in a non-excluded script', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "do-update.mjs"),
      'import { spawnSync } from "child_process";\nspawnSync("cargo", ["update"]);\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("programmatic Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("17. blocks spawnSync('cargo', ['generate-lockfile']) with single quotes", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "regen.mjs"),
      "spawnSync('cargo', ['generate-lockfile']);\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("programmatic Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('18. blocks execFileSync("cargo", ["add", "serde"])', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "adder.js"),
      'execFileSync("cargo", ["add", "serde"]);\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("programmatic Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('19. blocks execa("cargo", ["upgrade"])', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "upgrade.mjs"),
      'import { execa } from "execa";\nexeca("cargo", ["upgrade"]);\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("programmatic Cargo mutation")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("20. approved exact helper file (scripts/cargo-safe-update.mjs) remains excluded for programmatic calls", () => {
  // The approved helper internally uses spawnSync("cargo", ...); this must remain excluded
  const root = createTempRepo();
  try {
    // cargo-safe-update.mjs already exists in scripts/ (created by createTempRepo),
    // but its content has "cargo update" not a spawnSync form; override to test:
    writeFileSync(
      path.join(root, "scripts", "cargo-safe-update.mjs"),
      '// approved helper\nspawnSync("cargo", ["update", "--manifest-path", manifest]);\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(
      ok,
      true,
      "approved helper must remain excluded for programmatic calls",
    );
    assert.equal(errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P1: No whole-file DOCUMENTED_MENTIONS exemption ---

test('21. whole-file exemption removed - troubleshooting text + execSync("cargo update") fails', () => {
  const root = createTempRepo();
  try {
    // Simulate what bump-version.js might look like: documentation text + real mutation
    writeFileSync(
      path.join(root, "scripts", "bump-version.js"),
      '// regenerate the Cargo lockfile using the approved dependency-maintenance workflow\nexecSync("cargo update");\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(
      ok,
      false,
      'execSync("cargo update") in bump-version.js must be detected',
    );
    assert.ok(
      errors.some(
        (e) =>
          e.includes("programmatic Cargo mutation") ||
          e.includes("raw Cargo mutation"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("22. different file with same basename does not inherit any exemption", () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(
      path.join(root, "tools", "bump-version.js"),
      "cargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("tools/bump-version.js")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P2: Root-level JS/TS scanning ---

test("23. blocks root-level update-deps.mjs with cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "update-deps.mjs"),
      "#!/usr/bin/env node\ncargo update\n",
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("update-deps.mjs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("24. blocks root-level release-deps.js with cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "release-deps.js"),
      'const cmd = "cargo update";\nexec(cmd);\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("release-deps.js")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- P2: Cargo alias scanning ---

test('25. blocks .cargo/config.toml with [alias] u = "update"', () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, ".cargo"), { recursive: true });
    writeFileSync(
      path.join(root, ".cargo", "config.toml"),
      '[alias]\nu = "update"\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(
      errors.some((e) => e.includes("Cargo alias dependency mutation")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('26. blocks .cargo/config.toml with [alias] regen = ["generate-lockfile"]', () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, ".cargo"), { recursive: true });
    writeFileSync(
      path.join(root, ".cargo", "config.toml"),
      '[alias]\nregen = ["generate-lockfile"]\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(
      errors.some((e) => e.includes("Cargo alias dependency mutation")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('27. allows .cargo/config.toml with safe aliases (b = "build")', () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, ".cargo"), { recursive: true });
    writeFileSync(
      path.join(root, ".cargo", "config.toml"),
      '[alias]\nb = "build"\nt = "test"\nc = "check"\n',
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, true);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("28. blocks cargo +stable update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.sh"),
      "cargo +stable update\n",
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("29. blocks spawnSync cargo update with a toolchain selector", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.mjs"),
      'spawnSync("cargo", ["+stable", "update"]);\n',
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("30. blocks shell line-continuation cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.sh"),
      "cargo \\\n      update\n",
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("31. blocks Python subprocess cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.py"),
      'import subprocess\nsubprocess.run(["cargo", "update"], check=True)\n',
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("32. blocks a dynamically assembled execSync cargo update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.mjs"),
      'const command = ["cargo", "update"].join(" ");\nexecSync(command);\n',
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("33. blocks raw npm update in package.json", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { u2: "npm update && npm run test" } }),
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(
      errors.some((error) => error.includes("raw npm dependency mutation")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("34. blocks programmatic npm update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.mjs"),
      'spawnSync("npm", ["update"]);\n',
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("35. blocks a dynamically assembled execSync npm update", () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, "scripts", "update.mjs"),
      'const command = ["npm", "update"].join(" ");\nexecSync(command);\n',
    );
    const ok = runPolicyCheck({ root, log: () => {}, error: () => {} });
    assert.equal(ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
