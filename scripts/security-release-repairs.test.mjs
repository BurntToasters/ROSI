import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateQualityGate,
  validateReleaseSession,
  verifyFullE2eEvidence,
} from "./release-session.js";
import { REVIEWED_SOURCE_OMISSIONS } from "./generate-cargo-licenses.js";
import {
  EXPECTED_SCENARIOS,
  mayReuseE2eBinary,
  scenarioOutcomeProblems,
} from "./test-e2e.js";
import {
  buildCommitAssetName,
  buildCommitRecord,
  buildUploadList,
  writeBuildCommitRecords,
} from "./gpg-sign.js";
import {
  assertBuildCommitRecords,
  assertDraftReleaseShape,
  requiredDraftAssetNames,
  requiredDraftBuildCommitNames,
  requiredDraftChecksumNames,
} from "./verify-release-draft.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-10-03T12:00:00Z");
const expected = {
  version: "5.0.0-beta.2",
  commit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  platform: "darwin",
  arch: "arm64",
  node: "v24.16.0",
  rustc: "rustc 1.98.1 (test)",
  packageLockSha256: "c".repeat(64),
  cargoLockSha256: "d".repeat(64),
};

function successfulScenarios(overrides = {}) {
  return EXPECTED_SCENARIOS.map((name) => ({
    name,
    status: overrides[name] ?? "passed",
  }));
}

test("canonical outcomes allow the Linux-only XDG skip only off Linux", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(
      scenarioOutcomeProblems(
        successfulScenarios({ "xdg-download-dir": "skipped" }),
        platform,
      ),
      [],
    );
  }

  const linuxSkipProblems = scenarioOutcomeProblems(
    successfulScenarios({ "xdg-download-dir": "skipped" }),
    "linux",
  );
  assert.ok(
    linuxSkipProblems.some((problem) => problem.includes("xdg-download-dir")),
    JSON.stringify(linuxSkipProblems),
  );

  const failedProblems = scenarioOutcomeProblems(
    successfulScenarios({ "xdg-download-dir": "failed" }),
    "darwin",
  );
  assert.ok(
    failedProblems.some((problem) =>
      problem.includes("unacceptable status failed"),
    ),
    JSON.stringify(failedProblems),
  );

  const missingProblems = scenarioOutcomeProblems(
    successfulScenarios().filter(
      (scenario) => scenario.name !== "xdg-download-dir",
    ),
    "darwin",
  );
  assert.ok(
    missingProblems.some((problem) =>
      problem.includes("xdg-download-dir reported 0 times"),
    ),
    JSON.stringify(missingProblems),
  );

  const unexpectedProblems = scenarioOutcomeProblems(
    [
      ...successfulScenarios(),
      { name: "unexpected-scenario", status: "passed" },
    ],
    "darwin",
  );
  assert.ok(
    unexpectedProblems.some((problem) =>
      problem.includes("unexpected scenario"),
    ),
    JSON.stringify(unexpectedProblems),
  );
});

function fullGate(overrides = {}) {
  return {
    ...expected,
    scope: "full",
    e2e: {
      status: "passed",
      platform: expected.platform,
      arch: expected.arch,
      reportSha256: "e".repeat(64),
      binarySha256: "f".repeat(64),
      finishedAt: now - 60_000,
    },
    completedAt: now - 30_000,
    ...overrides,
  };
}

function buildVmGate(overrides = {}) {
  return {
    ...expected,
    scope: "build-vm-partial",
    e2e: { status: "skipped" },
    completedAt: now - 30_000,
    ...overrides,
  };
}

test("a full local gate must bind fresh same-platform E2E and binary artifacts", () => {
  assert.doesNotThrow(() => validateQualityGate(fullGate(), expected, { now }));
  for (const gate of [
    fullGate({ e2e: { status: "skipped" } }),
    fullGate({ e2e: { ...fullGate().e2e, platform: "linux" } }),
    fullGate({ e2e: { ...fullGate().e2e, reportSha256: "invalid" } }),
    fullGate({ e2e: { ...fullGate().e2e, binarySha256: null } }),
    fullGate({
      e2e: { ...fullGate().e2e, finishedAt: now - 26 * 60 * 60 * 1000 },
    }),
  ]) {
    assert.throws(() => validateQualityGate(gate, expected, { now }));
  }
});

test("a skipped-E2E build-VM proof does not require hosted CI", () => {
  assert.doesNotThrow(() =>
    validateQualityGate(buildVmGate(), expected, { now }),
  );
  assert.throws(() =>
    validateQualityGate(buildVmGate({ e2e: { status: "passed" } }), expected, {
      now,
    }),
  );
});

test("a gate proof is rejected for a different source tree, lock, or stale timestamp", () => {
  assert.throws(
    () =>
      validateQualityGate(
        fullGate(),
        { ...expected, sourceTree: "9".repeat(40) },
        { now },
      ),
    /sourceTree/,
  );
  assert.throws(
    () =>
      validateQualityGate(
        fullGate(),
        { ...expected, packageLockSha256: "9".repeat(64) },
        { now },
      ),
    /packageLockSha256/,
  );
  assert.throws(
    () =>
      validateQualityGate(
        fullGate({ completedAt: now - 26 * 60 * 60 * 1000 }),
        expected,
        { now },
      ),
    /expired/,
  );
});

test("only an ad-hoc E2E spec may reuse an existing native binary", () => {
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: false,
      reuseRequested: true,
      binaryFresh: true,
    }),
    false,
  );
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: true,
      reuseRequested: true,
      binaryFresh: true,
    }),
    true,
  );
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: true,
      reuseRequested: true,
      binaryFresh: false,
    }),
    false,
  );
});

test("release sessions retain an accepted gate scope and evidence identity", () => {
  const session = {
    ...expected,
    qualityGateCompletedAt: now - 30_000,
    qualityGateScope: "build-vm-partial",
    qualityGateArtifactSha256: "2".repeat(64),
    startedAt: now - 10_000,
  };
  assert.doesNotThrow(() => validateReleaseSession(session, expected, { now }));
  assert.throws(() =>
    validateReleaseSession(
      { ...session, qualityGateScope: "skipped-e2e" },
      expected,
      { now },
    ),
  );
  assert.throws(() =>
    validateReleaseSession(
      { ...session, qualityGateArtifactSha256: null },
      expected,
      { now },
    ),
  );
});

test("selectors 0.38.0 omission is bound to its exact immutable source", () => {
  const review = REVIEWED_SOURCE_OMISSIONS.get("selectors@0.38.0");
  assert.ok(review, "selectors 0.38.0 source review is missing");
  assert.equal(review.repository, "https://github.com/servo/stylo");
  assert.equal(review.revision, "572ecba2d1600e7c3d490586692a209faf703baa");
  assert.equal(review.pathInRepository, "selectors");
  assert.match(
    review.reason,
    /no license text under selectors or at the repository root.*MPL-2\.0/i,
  );
  assert.equal(REVIEWED_SOURCE_OMISSIONS.has("selectors@0.38.1"), false);
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// The verifier resolves the debug binary by the host OS, not the report's platform.
const hostBinaryName = process.platform === "win32" ? "rosi.exe" : "rosi";

function writeFullE2eFixture(directory, mutate = () => {}) {
  const binaryPath = path.join(
    directory,
    "src-tauri",
    "target",
    "debug",
    hostBinaryName,
  );
  const reportPath = path.join(
    directory,
    "e2e",
    "artifacts",
    "e2e-report-darwin-arm64.json",
  );
  const screenshotPath = path.join(
    directory,
    "e2e",
    "artifacts",
    "screenshots",
    "darwin-arm64",
    "proof.png",
  );
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(binaryPath, "fixture app binary");
  const screenshotBytes = Buffer.from("fixture screenshot bytes");
  fs.writeFileSync(screenshotPath, screenshotBytes);
  const wizardBytes = Buffer.from("fixture wizard screenshot bytes");
  fs.writeFileSync(
    path.join(path.dirname(screenshotPath), "wizard-welcome.png"),
    wizardBytes,
  );
  const wizardShot = {
    name: "wizard-welcome",
    file: "wizard-welcome.png",
    sha256: hash(wizardBytes),
    bytes: wizardBytes.length,
  };
  const startedAt = new Date(now - 120_000).toISOString();
  const finishedAt = new Date(now - 60_000).toISOString();
  const identity = {
    version: expected.version,
    commit: expected.commit,
    sourceTree: expected.sourceTree,
    platform: expected.platform,
    arch: expected.arch,
    node: expected.node,
    packageLockSha256: expected.packageLockSha256,
    cargoLockSha256: expected.cargoLockSha256,
  };
  const reportBody = {
    app: "ROSI",
    fullSuite: true,
    ...identity,
    startedAt,
    finishedAt,
    passed: true,
    worktreeDirty: false,
    worktreeStatusSha256: hash(""),
    expectedScenarios: [...EXPECTED_SCENARIOS],
    scenarios: EXPECTED_SCENARIOS.map((name) => ({
      name,
      status: "passed",
      ...(name === "ui-screenshots"
        ? {
            shots: [
              {
                name: "proof",
                file: "proof.png",
                sha256: hash(screenshotBytes),
              },
            ],
          }
        : {}),
      ...(name === "setup-wizard" ? { shots: [wizardShot] } : {}),
    })),
    missingScenarios: [],
    scenarioProblems: [],
    uncoveredLegacyImportFailureModes: [],
    screenshots: [
      {
        name: "proof",
        path: "e2e/artifacts/screenshots/darwin-arm64/proof.png",
        sha256: hash(screenshotBytes),
        bytes: screenshotBytes.length,
      },
      {
        name: "wizard-welcome",
        path: "e2e/artifacts/screenshots/darwin-arm64/wizard-welcome.png",
        sha256: wizardShot.sha256,
        bytes: wizardBytes.length,
      },
    ],
    screenshotProblems: [],
    binarySha256: hash(fs.readFileSync(binaryPath)),
  };
  mutate(reportBody);
  const reportSha256 = hash(JSON.stringify(reportBody, null, 2));
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ ...reportBody, reportSha256 }, null, 2)}\n`,
  );
  return {
    identity,
    binaryPath,
    reportPath,
    proof: {
      ...identity,
      gateStartedAt: now - 180_000,
      completedAt: now - 30_000,
      e2e: {
        status: "passed",
        platform: expected.platform,
        arch: expected.arch,
        reportPath: "e2e/artifacts/e2e-report-darwin-arm64.json",
        binaryPath: `src-tauri/target/debug/${hostBinaryName}`,
        reportSha256: hash(fs.readFileSync(reportPath)),
        binarySha256: hash(fs.readFileSync(binaryPath)),
        finishedAt: Date.parse(finishedAt),
      },
    },
    root: directory,
  };
}

test("full E2E proof checks the canonical suite, successful outcomes, and exact binary", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-full-e2e-proof-"),
  );
  try {
    const fixture = writeFullE2eFixture(directory);
    assert.doesNotThrow(() =>
      verifyFullE2eEvidence(fixture.proof, fixture.root, fixture.identity),
    );
    for (const mutate of [
      (report) => {
        report.expectedScenarios = ["forged-suite"];
      },
      (report) => {
        report.scenarios[0].status = "failed";
      },
      (report) => {
        report.scenarios[0].status = "skipped";
      },
      (report) => {
        report.missingScenarios = ["launch"];
      },
      (report) => {
        report.uncoveredLegacyImportFailureModes = ["missing-case"];
      },
      (report) => {
        report.screenshotProblems = ["missing screenshot"];
      },
      (report) => {
        report.binarySha256 = "0".repeat(64);
      },
      (report) => {
        report.screenshots.pop();
      },
    ]) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      const altered = writeFullE2eFixture(directory, mutate);
      assert.throws(() =>
        verifyFullE2eEvidence(altered.proof, altered.root, altered.identity),
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("full E2E proof rejects evidence from a dirty or unrecorded worktree", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-full-e2e-worktree-"),
  );
  try {
    const cases = [
      [
        "dirty worktree",
        (report) => {
          report.worktreeDirty = true;
        },
        /dirty worktree/,
      ],
      [
        "missing dirty flag",
        (report) => {
          delete report.worktreeDirty;
        },
        /worktree state/,
      ],
      [
        "missing status hash",
        (report) => {
          delete report.worktreeStatusSha256;
        },
        /worktree state/,
      ],
    ];
    for (const [label, mutate, pattern] of cases) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      const altered = writeFullE2eFixture(directory, mutate);
      assert.throws(
        () =>
          verifyFullE2eEvidence(altered.proof, altered.root, altered.identity),
        pattern,
        label,
      );
    }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const clean = writeFullE2eFixture(directory);
    assert.doesNotThrow(() =>
      verifyFullE2eEvidence(clean.proof, clean.root, clean.identity),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the two beta-2 unreviewed dev advisories no longer resolve to affected lock nodes", () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const basicFtp = lock.packages["node_modules/basic-ftp"];
  const braces = lock.packages["node_modules/braces"];
  assert.ok(basicFtp, "basic-ftp must remain in the reviewed test-tool graph");
  assert.ok(braces, "braces must remain in the reviewed test-tool graph");
  assert.equal(basicFtp.dev, true);
  assert.equal(braces.dev, true);
  assert.equal(basicFtp.version, "6.2.1");
  assert.equal(braces.version, "3.0.3");
  const audit = fs.readFileSync(
    path.join(root, "scripts", "npm-dev-audit.cjs"),
    "utf8",
  );
  assert.match(audit, /GHSA-C475-QRG2-PJ4R/);
  assert.match(audit, /GHSA-VFJ7-8CJW-P6XM/);
  assert.match(audit, /deeply nested brace|stack overflow/i);
  assert.match(audit, /2026-12-01/);
});

const BUILD_COMMIT = "c".repeat(40);
const BUILD_VERSION = "5.1.0-beta.3";
const BUILD_TAG = `v${BUILD_VERSION}`;
const PLATFORM_KEYS = requiredDraftChecksumNames()
  .filter((name) => name.endsWith(".txt"))
  .map((name) => name.slice("SHA256SUMS-".length, -".txt".length));

function buildRecordsFor(keys, commit = BUILD_COMMIT) {
  return new Map(
    keys.map((key) => [
      buildCommitAssetName(`SHA256SUMS-${key}.txt`),
      JSON.stringify({
        commit,
        version: BUILD_VERSION,
        tag: BUILD_TAG,
        platform: key,
      }),
    ]),
  );
}

test("R2: every per-platform checksum key has a build record and GPG signature in the draft", () => {
  const names = new Set(requiredDraftAssetNames());
  const expected = PLATFORM_KEYS.map(
    (key) => `build-commit-${key}.json`,
  ).sort();
  assert.deepEqual(requiredDraftBuildCommitNames(), expected);
  for (const name of expected) {
    assert.ok(names.has(name), `${name} must be a required draft asset`);
    assert.ok(names.has(`${name}.asc`), `${name} needs a GPG signature`);
  }
});

test("R2: build record names follow the platform checksum keys and reject other names", () => {
  assert.equal(
    buildCommitAssetName("SHA256SUMS-windows-x86_64.txt"),
    "build-commit-windows-x86_64.json",
  );
  assert.equal(
    buildCommitAssetName("SHA256SUMS-darwin-beta-aarch64.txt"),
    "build-commit-darwin-beta-aarch64.json",
  );
  for (const bad of [
    "latest-windows-x86_64.json",
    "SHA256SUMS-windows-x86_64.txt.asc",
    "SHA256SUMS-.txt",
    "SHA256SUMS-win dows.txt",
  ]) {
    assert.throws(() => buildCommitAssetName(bad), /SHA256SUMS/, bad);
  }
});

test("R2: a build record carries exactly commit, version, tag and platform, and needs a real SHA", () => {
  assert.deepEqual(
    buildCommitRecord({
      commit: BUILD_COMMIT,
      version: BUILD_VERSION,
      tag: BUILD_TAG,
      platform: "linux-x86_64",
    }),
    {
      commit: BUILD_COMMIT,
      version: BUILD_VERSION,
      tag: BUILD_TAG,
      platform: "linux-x86_64",
    },
  );
  for (const commit of ["", "abc", "g".repeat(40), "c".repeat(41), undefined]) {
    assert.throws(
      () =>
        buildCommitRecord({
          commit,
          version: BUILD_VERSION,
          tag: BUILD_TAG,
          platform: "linux-x86_64",
        }),
      /commit/i,
      String(commit),
    );
  }
});

test("R2: writing build records uses the commit passed in, one file per checksum key", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-build-commit-"),
  );
  try {
    const checksumFiles = [
      "SHA256SUMS-windows-x86_64.txt",
      "SHA256SUMS-linux-x86_64.txt",
    ].map((name) => path.join(directory, name));
    for (const file of checksumFiles) fs.writeFileSync(file, "");
    const written = writeBuildCommitRecords({
      checksumFiles,
      commit: BUILD_COMMIT,
      version: BUILD_VERSION,
      tag: BUILD_TAG,
      directory,
    });
    assert.deepEqual(written.map((file) => path.basename(file)).sort(), [
      "build-commit-linux-x86_64.json",
      "build-commit-windows-x86_64.json",
    ]);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(directory, "build-commit-windows-x86_64.json"),
          "utf8",
        ),
      ),
      {
        commit: BUILD_COMMIT,
        version: BUILD_VERSION,
        tag: BUILD_TAG,
        platform: "windows-x86_64",
      },
    );
    assert.throws(
      () =>
        writeBuildCommitRecords({
          checksumFiles: [path.join(directory, "latest-linux-x86_64.json")],
          commit: BUILD_COMMIT,
          version: BUILD_VERSION,
          tag: BUILD_TAG,
          directory,
        }),
      /SHA256SUMS/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("R2: the upload list admits build records and their signatures only from staging", () => {
  const stagingDirectory = path.join(os.tmpdir(), "rosi-upload-staging");
  const record = path.join(stagingDirectory, "build-commit-linux-x86_64.json");
  const signature = `${record}.asc`;
  assert.deepEqual(
    buildUploadList({
      artifacts: [],
      checksumFiles: [],
      buildCommitFiles: [record],
      signatureFiles: [signature],
      stagingDirectory,
    }),
    [record, signature],
  );
  assert.throws(
    () =>
      buildUploadList({
        artifacts: [],
        checksumFiles: [],
        buildCommitFiles: [
          path.join(os.tmpdir(), "elsewhere", "build-commit-linux-x86_64.json"),
        ],
        signatureFiles: [],
        stagingDirectory,
      }),
    /Refusing unvetted/,
  );
  assert.throws(
    () =>
      buildUploadList({
        artifacts: [record],
        checksumFiles: [],
        signatureFiles: [],
        stagingDirectory,
      }),
    /Refusing unvetted/,
  );
  assert.throws(
    () =>
      buildUploadList({
        artifacts: [],
        checksumFiles: [],
        buildCommitFiles: [],
        signatureFiles: [signature],
        stagingDirectory,
      }),
    /Refusing unvetted/,
  );
});

test("R2: the draft gate requires one build record per platform at the draft target commit", () => {
  const complete = buildRecordsFor(PLATFORM_KEYS);
  assert.doesNotThrow(() =>
    assertBuildCommitRecords({
      targetCommitish: BUILD_COMMIT,
      records: complete,
    }),
  );

  const staleName = buildCommitAssetName(`SHA256SUMS-${PLATFORM_KEYS[0]}.txt`);
  const stale = new Map(complete);
  stale.set(
    staleName,
    JSON.stringify({
      commit: "d".repeat(40),
      version: BUILD_VERSION,
      tag: BUILD_TAG,
      platform: PLATFORM_KEYS[0],
    }),
  );
  assert.throws(
    () =>
      assertBuildCommitRecords({
        targetCommitish: BUILD_COMMIT,
        records: stale,
      }),
    (error) =>
      error.message.includes(staleName) && /commit/i.test(error.message),
    "a record from another commit",
  );

  const extra = new Map(complete);
  extra.set(
    "build-commit-generic.json",
    JSON.stringify({
      commit: "d".repeat(40),
      version: BUILD_VERSION,
      tag: BUILD_TAG,
      platform: "generic",
    }),
  );
  assert.throws(
    () =>
      assertBuildCommitRecords({
        targetCommitish: BUILD_COMMIT,
        records: extra,
      }),
    /build-commit-generic\.json/,
    "an extra record from another commit",
  );

  const missing = new Map(complete);
  missing.delete(staleName);
  assert.throws(
    () =>
      assertBuildCommitRecords({
        targetCommitish: BUILD_COMMIT,
        records: missing,
      }),
    (error) => error.message.includes(staleName),
    "a missing platform record",
  );

  for (const [label, text] of [
    ["malformed JSON", "{not json"],
    ["no commit field", JSON.stringify({ version: BUILD_VERSION })],
    [
      "platform that does not match the file name",
      JSON.stringify({
        commit: BUILD_COMMIT,
        version: BUILD_VERSION,
        tag: BUILD_TAG,
        platform: "some-other-key",
      }),
    ],
  ]) {
    const broken = new Map(complete);
    broken.set(staleName, text);
    assert.throws(
      () =>
        assertBuildCommitRecords({
          targetCommitish: BUILD_COMMIT,
          records: broken,
        }),
      (error) => error.message.includes(staleName),
      label,
    );
  }

  for (const target of ["main", "", undefined]) {
    assert.throws(
      () =>
        assertBuildCommitRecords({
          targetCommitish: target,
          records: complete,
        }),
      /target/i,
      String(target),
    );
  }
});

test("R2: the draft shape gate fails when a platform build record is absent", () => {
  const target = BUILD_COMMIT;
  const dropped = buildCommitAssetName(`SHA256SUMS-${PLATFORM_KEYS[0]}.txt`);
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release: { draft: true, prerelease: true, target_commitish: target },
        assetNames: requiredDraftAssetNames().filter(
          (name) => name !== dropped,
        ),
        version: BUILD_VERSION,
        headCommit: target,
      }),
    (error) => error.message.includes(dropped),
  );
});

test("R2: the type declarations export the build-record API", () => {
  const gpgTypes = fs.readFileSync(
    path.join(root, "scripts", "gpg-sign.d.ts"),
    "utf8",
  );
  for (const name of [
    "buildCommitAssetName",
    "buildCommitRecord",
    "writeBuildCommitRecords",
  ]) {
    assert.match(gpgTypes, new RegExp(`export function ${name}\\b`), name);
  }
  assert.match(gpgTypes, /buildCommitFiles\?: string\[\]/);

  const verifyTypes = fs.readFileSync(
    path.join(root, "scripts", "verify-release-draft.d.ts"),
    "utf8",
  );
  for (const name of [
    "requiredDraftBuildCommitNames",
    "assertBuildCommitRecords",
  ]) {
    assert.match(verifyTypes, new RegExp(`export function ${name}\\b`), name);
  }
});
