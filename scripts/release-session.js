import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { EXPECTED_SCENARIOS, scenarioOutcomeProblems } from "./test-e2e.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const RELEASE_SESSION_RELATIVE_PATH = path.join(
  "release",
  ".build-session.json",
);
const QUALITY_GATE_RELATIVE_PATH = path.join(
  "coverage",
  ".release-quality.json",
);
const HOSTED_CI_RELATIVE_PATH = path.join("coverage", ".hosted-ci-proof.json");
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const HEX_GIT = /^[a-f0-9]{40}$/i;
// Native Tauri builds rewrite these tracked outputs. Keep the allowlist exact:
// a new or unexpected file under gen/ must still invalidate release proof.
const GENERATED_TAURI_SCHEMA_PATHS = new Set(
  [
    "acl-manifests.json",
    "capabilities.json",
    "desktop-schema.json",
    "linux-schema.json",
    "macOS-schema.json",
    "windows-schema.json",
  ].map((name) => `src-tauri/gen/schemas/${name}`),
);

function command(commandName, args, root) {
  // trimEnd only: git porcelain uses " M path" / "M  path". trim() would turn
  // the first into "M path" and break XY/path parsing (schema ignore fails).
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** Paths from `git status --porcelain=v1` (keeps leading spaces in status text). */
function porcelainPaths(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      // XY PATH  or  XY ORIG -> PATH  (XY is always two status columns)
      const pathPart = line.length >= 3 ? line.slice(3) : line;
      return pathPart.includes(" -> ")
        ? pathPart.split(" -> ").at(-1)
        : pathPart;
    });
}

function isIgnorableReleaseDirtyPath(filePath) {
  // Git porcelain uses forward slashes on every platform, while the paths
  // used to read the generated proofs follow the host platform separator.
  const normalizedPath = filePath.replaceAll("\\", "/");
  const releaseSessionPath = RELEASE_SESSION_RELATIVE_PATH.replaceAll(
    "\\",
    "/",
  );
  const qualityGatePath = QUALITY_GATE_RELATIVE_PATH.replaceAll("\\", "/");
  const hostedCiPath = HOSTED_CI_RELATIVE_PATH.replaceAll("\\", "/");
  return (
    GENERATED_TAURI_SCHEMA_PATHS.has(normalizedPath) ||
    normalizedPath === releaseSessionPath ||
    normalizedPath === qualityGatePath ||
    normalizedPath === hostedCiPath
  );
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function currentReleaseIdentity(root = defaultRoot) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return {
    version: String(packageJson.version ?? ""),
    commit: command("git", ["rev-parse", "HEAD"], root),
    sourceTree: command("git", ["rev-parse", "HEAD^{tree}"], root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rustc: command("rustc", ["--version"], root),
    packageLockSha256: sha256File(path.join(root, "package-lock.json")),
    cargoLockSha256: sha256File(path.join(root, "src-tauri", "Cargo.lock")),
  };
}

function validateIdentity(record, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new Error(
        `${label} ${key} does not match this checkout/environment.`,
      );
    }
  }
}

function validateReleaseSession(
  session,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!session || typeof session !== "object") {
    throw new Error("Release build session is not an object.");
  }
  if (!Number.isFinite(session.startedAt)) {
    throw new Error("Release build session has no valid start time.");
  }
  const age = now - session.startedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release build session is expired; run release:prepare again.",
    );
  }

  validateIdentity(session, expected, "Release build session");
  if (!["full", "build-vm-partial"].includes(session.qualityGateScope)) {
    throw new Error(
      "Release build session has no accepted quality-gate scope.",
    );
  }
  if (!HEX_SHA256.test(session.qualityGateArtifactSha256 || "")) {
    throw new Error(
      "Release build session has no quality-gate artifact identity.",
    );
  }
  if (
    !Number.isFinite(session.qualityGateCompletedAt) ||
    session.qualityGateCompletedAt >= session.startedAt
  ) {
    throw new Error("Release build session has no valid quality-gate proof.");
  }
  return session;
}

function validateQualityGate(
  qualityGate,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!qualityGate || typeof qualityGate !== "object") {
    throw new Error("Release quality-gate proof is not an object.");
  }
  if (!Number.isFinite(qualityGate.completedAt)) {
    throw new Error("Release quality-gate proof has no valid completion time.");
  }
  const age = now - qualityGate.completedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release quality-gate proof is expired; run test:all again.",
    );
  }
  validateIdentity(qualityGate, expected, "Release quality-gate proof");
  if (!HEX_GIT.test(qualityGate.sourceTree || "")) {
    throw new Error("Release quality-gate proof has no source-tree identity.");
  }
  if (qualityGate.scope === "full") {
    const e2e = qualityGate.e2e;
    if (
      e2e?.status !== "passed" ||
      e2e.platform !== expected.platform ||
      e2e.arch !== expected.arch ||
      !HEX_SHA256.test(e2e.reportSha256 || "") ||
      !HEX_SHA256.test(e2e.binarySha256 || "") ||
      !Number.isFinite(e2e.finishedAt) ||
      e2e.finishedAt > qualityGate.completedAt ||
      now - e2e.finishedAt > maxAgeMs
    ) {
      throw new Error(
        "Full release proof requires fresh same-platform E2E and binary artifacts.",
      );
    }
  } else if (qualityGate.scope === "build-vm-partial") {
    const hosted = qualityGate.hostedCi;
    const expectedBranch = /-beta\./.test(expected.version) ? "beta" : "main";
    if (
      qualityGate.e2e?.status !== "skipped" ||
      hosted?.checkName !== "ci-gate" ||
      hosted.status !== "completed" ||
      hosted.conclusion !== "success" ||
      hosted.event !== "push" ||
      hosted.branch !== expectedBranch ||
      hosted.headSha !== expected.commit ||
      !Number.isSafeInteger(hosted.checkRunId) ||
      !/^https:\/\/github\.com\/BurntToasters\/ROSI\//.test(hosted.url || "") ||
      !Number.isFinite(hosted.completedAt) ||
      hosted.completedAt > qualityGate.completedAt ||
      now - hosted.completedAt > maxAgeMs ||
      !HEX_SHA256.test(hosted.artifactSha256 || "")
    ) {
      throw new Error(
        "Skipped-E2E build-VM proof requires fresh successful hosted ci-gate evidence for this exact branch and HEAD.",
      );
    }
  } else {
    throw new Error("Release quality-gate proof has no accepted scope.");
  }
  return qualityGate;
}

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function clearHostedCiProof(root = defaultRoot) {
  fs.rmSync(path.join(root, HOSTED_CI_RELATIVE_PATH), { force: true });
}

function recordHostedCiProof(evidence, root = defaultRoot) {
  const proofPath = path.join(root, HOSTED_CI_RELATIVE_PATH);
  const proof = {
    ...evidence,
    artifactSha256: sha256Text(JSON.stringify(evidence)),
  };
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
    mode: 0o600,
  });
  return proof;
}

function expectedE2eEvidencePaths(root, identity) {
  const binary = process.platform === "win32" ? "rosi.exe" : "rosi";
  return {
    reportPath: path.join(
      root,
      "e2e",
      "artifacts",
      `e2e-report-${identity.platform}-${identity.arch}.json`,
    ),
    binaryPath: path.join(root, "src-tauri", "target", "debug", binary),
  };
}

export function verifyFullE2eEvidence(proof, root, identity) {
  const { reportPath, binaryPath } = expectedE2eEvidencePaths(root, identity);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Full E2E evidence report is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { reportSha256: embeddedSha, ...reportBody } = report;
  const scenarioProblems = Array.isArray(report.scenarios)
    ? scenarioOutcomeProblems(report.scenarios, identity.platform)
    : ["scenario results are missing"];
  const screenshotScenario = Array.isArray(report.scenarios)
    ? report.scenarios.find((scenario) => scenario.name === "ui-screenshots")
    : null;
  const screenshotArtifactProblems = verifyScreenshotArtifacts(
    report.screenshots,
    root,
    identity,
    screenshotScenario,
  );
  if (
    proof.e2e.reportPath !==
      path.relative(root, reportPath).split(path.sep).join("/") ||
    proof.e2e.binaryPath !==
      path.relative(root, binaryPath).split(path.sep).join("/") ||
    sha256File(reportPath) !== proof.e2e.reportSha256 ||
    sha256Text(JSON.stringify(reportBody, null, 2)) !== embeddedSha ||
    report.passed !== true ||
    report.fullSuite !== true ||
    report.version !== identity.version ||
    report.commit !== identity.commit ||
    report.sourceTree !== identity.sourceTree ||
    report.packageLockSha256 !== identity.packageLockSha256 ||
    report.cargoLockSha256 !== identity.cargoLockSha256 ||
    report.platform !== identity.platform ||
    report.arch !== identity.arch ||
    report.node !== identity.node ||
    JSON.stringify(report.expectedScenarios) !==
      JSON.stringify(EXPECTED_SCENARIOS) ||
    scenarioProblems.length > 0 ||
    !Array.isArray(report.missingScenarios) ||
    report.missingScenarios.length > 0 ||
    !Array.isArray(report.scenarioProblems) ||
    report.scenarioProblems.length > 0 ||
    !Array.isArray(report.uncoveredLegacyImportFailureModes) ||
    report.uncoveredLegacyImportFailureModes.length > 0 ||
    !Array.isArray(report.screenshotProblems) ||
    report.screenshotProblems.length > 0 ||
    screenshotArtifactProblems.length > 0 ||
    !HEX_SHA256.test(report.binarySha256 || "")
  ) {
    throw new Error(
      "Full E2E evidence does not match the successful complete suite for this exact source and platform.",
    );
  }
  const startedAt = Date.parse(report.startedAt);
  const finishedAt = Date.parse(report.finishedAt);
  if (
    !Number.isFinite(proof.gateStartedAt) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    startedAt < proof.gateStartedAt ||
    finishedAt > proof.completedAt ||
    finishedAt !== proof.e2e.finishedAt
  ) {
    throw new Error(
      "Full E2E artifact timestamps are outside this quality-gate run.",
    );
  }
  if (
    !fs.existsSync(binaryPath) ||
    sha256File(binaryPath) !== proof.e2e.binarySha256 ||
    report.binarySha256 !== proof.e2e.binarySha256
  ) {
    throw new Error(
      "The E2E binary does not match the artifact recorded by the quality gate.",
    );
  }
}

function verifyScreenshotArtifacts(screenshots, root, identity, scenario) {
  if (
    !Array.isArray(screenshots) ||
    !scenario ||
    !Array.isArray(scenario.shots) ||
    scenario.shots.length === 0 ||
    screenshots.length !== scenario.shots.length
  ) {
    return ["screenshot evidence is missing or does not match its scenario"];
  }
  const expectedDirectory = `e2e/artifacts/screenshots/${identity.platform}-${identity.arch}/`;
  const rootPath = path.resolve(root);
  const problems = [];
  const shotsByName = new Map(scenario.shots.map((shot) => [shot?.name, shot]));
  const screenshotNames = screenshots.map((screenshot) => screenshot?.name);
  if (
    screenshots.some((screenshot) => !screenshot?.name) ||
    new Set(screenshotNames).size !== screenshotNames.length ||
    screenshotNames.some((name) => !shotsByName.has(name)) ||
    shotsByName.size !== screenshots.length
  ) {
    problems.push("screenshot evidence does not match the UI scenario names");
  }
  for (const screenshot of screenshots) {
    if (
      typeof screenshot?.path !== "string" ||
      !screenshot.path.startsWith(expectedDirectory) ||
      !HEX_SHA256.test(screenshot.sha256 || "") ||
      !Number.isSafeInteger(screenshot.bytes) ||
      screenshot.bytes <= 0
    ) {
      problems.push("screenshot identity is malformed");
      continue;
    }
    const absolute = path.resolve(root, screenshot.path);
    if (!absolute.startsWith(`${rootPath}${path.sep}`)) {
      problems.push("screenshot path escapes the checkout");
      continue;
    }
    try {
      const stat = fs.statSync(absolute);
      const scenarioShot = shotsByName.get(screenshot.name);
      if (
        !stat.isFile() ||
        stat.size !== screenshot.bytes ||
        sha256File(absolute) !== screenshot.sha256 ||
        scenarioShot?.file !== path.basename(screenshot.path) ||
        scenarioShot?.sha256 !== screenshot.sha256
      ) {
        problems.push(
          `${screenshot.path} does not match its artifact identity`,
        );
      }
    } catch {
      problems.push(`${screenshot.path} is missing`);
    }
  }
  return problems;
}

function verifyHostedCiEvidence(proof, root, identity) {
  const proofPath = path.join(root, HOSTED_CI_RELATIVE_PATH);
  let hostedProof;
  try {
    hostedProof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Hosted ci-gate evidence is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { artifactSha256, ...evidence } = hostedProof;
  const hosted = proof.hostedCi;
  if (
    artifactSha256 !== hosted.artifactSha256 ||
    sha256Text(JSON.stringify(evidence)) !== artifactSha256 ||
    evidence.headSha !== identity.commit ||
    evidence.sourceTree !== identity.sourceTree ||
    evidence.version !== identity.version ||
    evidence.packageLockSha256 !== identity.packageLockSha256 ||
    evidence.cargoLockSha256 !== identity.cargoLockSha256 ||
    evidence.branch !== hosted.branch ||
    evidence.event !== "push" ||
    evidence.checkRunId !== hosted.checkRunId ||
    evidence.completedAt !== hosted.completedAt ||
    evidence.checkName !== "ci-gate" ||
    evidence.status !== "completed" ||
    evidence.conclusion !== "success" ||
    evidence.appId !== 15368 ||
    !Number.isSafeInteger(evidence.checkSuiteId) ||
    evidence.workflowRunStatus !== "completed" ||
    evidence.workflowRunConclusion !== "success" ||
    !Number.isSafeInteger(evidence.workflowRunId) ||
    String(evidence.workflowPath || "").split("@")[0] !==
      ".github/workflows/ci.yml" ||
    !Number.isFinite(evidence.workflowRunUpdatedAt) ||
    evidence.workflowRunUpdatedAt < evidence.completedAt
  ) {
    throw new Error(
      "Hosted ci-gate artifact does not match the exact successful check recorded in the proof.",
    );
  }
}

function recordSuccessfulQualityGate(
  root = defaultRoot,
  { skipE2e = false, gateStartedAt = Date.now() } = {},
) {
  let status;
  try {
    status = command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      root,
    );
  } catch {
    return { recorded: false, dirtyFiles: null };
  }
  if (status) {
    const dirtyPaths = porcelainPaths(status).filter(
      (filePath) => !isIgnorableReleaseDirtyPath(filePath),
    );
    if (dirtyPaths.length > 0) {
      return { recorded: false, dirtyFiles: status };
    }
  }
  const identity = currentReleaseIdentity(root);
  const completedAt = Date.now();
  let evidence;
  if (skipE2e) {
    let hostedProof;
    try {
      hostedProof = JSON.parse(
        fs.readFileSync(path.join(root, HOSTED_CI_RELATIVE_PATH), "utf8"),
      );
    } catch {
      return {
        recorded: false,
        dirtyFiles:
          "--skip-e2e requires exact successful hosted ci-gate evidence.",
      };
    }
    const { artifactSha256, ...hosted } = hostedProof;
    if (
      artifactSha256 !== sha256Text(JSON.stringify(hosted)) ||
      hosted.headSha !== identity.commit ||
      hosted.sourceTree !== identity.sourceTree ||
      hosted.completedAt > completedAt ||
      completedAt - hosted.completedAt > DEFAULT_MAX_AGE_MS
    ) {
      return {
        recorded: false,
        dirtyFiles:
          "Hosted ci-gate evidence is stale or does not match this source.",
      };
    }
    evidence = {
      scope: "build-vm-partial",
      e2e: { status: "skipped" },
      hostedCi: {
        checkName: hosted.checkName,
        status: hosted.status,
        conclusion: hosted.conclusion,
        event: hosted.event,
        branch: hosted.branch,
        headSha: hosted.headSha,
        checkRunId: hosted.checkRunId,
        url: hosted.url,
        completedAt: hosted.completedAt,
        artifactSha256,
      },
    };
  } else {
    const { reportPath, binaryPath } = expectedE2eEvidencePaths(root, identity);
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      evidence = {
        scope: "full",
        e2e: {
          status: "passed",
          platform: identity.platform,
          arch: identity.arch,
          reportPath: path.relative(root, reportPath).split(path.sep).join("/"),
          binaryPath: path.relative(root, binaryPath).split(path.sep).join("/"),
          reportSha256: sha256File(reportPath),
          binarySha256: sha256File(binaryPath),
          finishedAt: Date.parse(report.finishedAt),
        },
      };
    } catch (error) {
      return {
        recorded: false,
        dirtyFiles: `A complete E2E report and binary are required: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const proof = {
    ...identity,
    ...evidence,
    gateStartedAt,
    completedAt,
  };
  try {
    validateQualityGate(proof, identity, { now: completedAt });
    if (proof.scope === "full") verifyFullE2eEvidence(proof, root, identity);
    else verifyHostedCiEvidence(proof, root, identity);
  } catch (error) {
    return {
      recorded: false,
      dirtyFiles: error instanceof Error ? error.message : String(error),
    };
  }
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
    mode: 0o600,
  });
  return { recorded: true, dirtyFiles: null };
}

function assertReleaseTreeClean(root = defaultRoot) {
  let status;
  try {
    status = command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      root,
    );
  } catch (error) {
    throw new Error(
      `Could not inspect the release working tree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!status) return;
  const dirtyPaths = porcelainPaths(status).filter(
    (filePath) => !isIgnorableReleaseDirtyPath(filePath),
  );
  if (dirtyPaths.length > 0) {
    throw new Error(
      `Release working tree changed after the quality gate; run test:all again before continuing:\n${status}`,
    );
  }
}

function verifyQualityGate(root = defaultRoot, options) {
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Release quality-gate proof is missing or invalid. Run test:all first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const identity = currentReleaseIdentity(root);
  const validated = validateQualityGate(proof, identity, options);
  if (validated.scope === "full") {
    verifyFullE2eEvidence(validated, root, identity);
  } else {
    verifyHostedCiEvidence(validated, root, identity);
  }
  return validated;
}

function createReleaseSession(root = defaultRoot) {
  const qualityGate = verifyQualityGate(root);
  return {
    ...currentReleaseIdentity(root),
    qualityGateCompletedAt: qualityGate.completedAt,
    qualityGateScope: qualityGate.scope,
    qualityGateArtifactSha256: sha256File(
      path.join(root, QUALITY_GATE_RELATIVE_PATH),
    ),
    startedAt: Date.now(),
  };
}

function verifyReleaseSession(root = defaultRoot, options) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. Run release:prepare first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = validateReleaseSession(
    session,
    currentReleaseIdentity(root),
    options,
  );
  const qualityGate = verifyQualityGate(root, options);
  const qualityGatePath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  if (
    qualityGate.scope !== validated.qualityGateScope ||
    qualityGate.completedAt !== validated.qualityGateCompletedAt ||
    sha256File(qualityGatePath) !== validated.qualityGateArtifactSha256
  ) {
    throw new Error(
      "Release build session no longer matches its quality-gate scope and evidence artifact.",
    );
  }
  assertReleaseTreeClean(root);
  return validated;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const session = verifyReleaseSession();
    console.log(
      `release-session: ok (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`,
    );
  } catch (error) {
    console.error(
      `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  DEFAULT_MAX_AGE_MS,
  HOSTED_CI_RELATIVE_PATH,
  QUALITY_GATE_RELATIVE_PATH,
  RELEASE_SESSION_RELATIVE_PATH,
  assertReleaseTreeClean,
  clearQualityGateProof,
  clearHostedCiProof,
  createReleaseSession,
  currentReleaseIdentity,
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
  recordSuccessfulQualityGate,
  recordHostedCiProof,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
};
