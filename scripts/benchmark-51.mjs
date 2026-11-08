import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_ARTIFACTS = path.join(REPO_ROOT, "e2e", "artifacts");
const METRIC_UNITS = Object.freeze({
  startupMs: "ms",
  idleCpuPercent: "percent",
  peakMemoryBytes: "bytes",
  queueLatencyMs: "ms",
  proxyThroughputBytesPerSecond: "bytes_per_second",
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runVersion(command, args) {
  let invocation = [command, args];
  if (process.platform === "win32" && command === "npm.cmd") {
    invocation = ["cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`]];
  }
  const result = spawnSync(invocation[0], invocation[1], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    return {
      status: "unavailable",
      reason:
        result.error?.message ?? `exited ${result.status ?? result.signal}`,
    };
  }
  return {
    status: "available",
    version: (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0],
  };
}

function gitValue(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function gitRaw(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout;
}

function repoRelative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function displayPath(file) {
  const relative = repoRelative(file);
  return relative === ".." || relative.startsWith(`..${path.sep}`)
    ? file
    : relative;
}

function walkFiles(root, accept = () => true) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && accept(file)) files.push(file);
    }
  };
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  return {
    path: repoRelative(file),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function collectArtifactSizes(artifactRoot) {
  const files = walkFiles(artifactRoot, (file) => {
    const basename = path.basename(file);
    return !basename.startsWith("benchmark-51-");
  });
  const groups = {};
  for (const file of files) {
    const relative = path.relative(artifactRoot, file).split(path.sep);
    const group = relative.length > 1 ? relative[0] : "_root";
    const current = groups[group] ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += fs.statSync(file).size;
    groups[group] = current;
  }
  return {
    root: repoRelative(artifactRoot),
    files: files.length,
    bytes: files.reduce((total, file) => total + fs.statSync(file).size, 0),
    groups,
  };
}

function collectSidecars() {
  const sidecarPattern =
    /^rosi-(?:yt-dlp|ffmpeg|ffprobe)(?:-[^.]+)?(?:\.exe)?$/i;
  const roots = [
    [path.join(REPO_ROOT, "src-tauri", "binaries"), "source"],
    [path.join(REPO_ROOT, "src-tauri", "target", "debug"), "debug-build"],
  ];
  const files = [];
  for (const [root, kind] of roots) {
    files.push(
      ...walkFiles(root, (file) =>
        sidecarPattern.test(path.basename(file)),
      ).map((file) => ({ ...fileRecord(file), kind })),
    );
  }
  return {
    files,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

function collectFrontendBuild() {
  const files = walkFiles(path.join(REPO_ROOT, "dist"));
  return {
    status: files.length > 0 ? "measured" : "not-measured",
    files: files.length,
    bytes:
      files.length > 0
        ? files.reduce((total, file) => total + fs.statSync(file).size, 0)
        : null,
    note: "Frontend build output; not a native release package.",
  };
}

function collectNativePackages() {
  const roots = [path.join(REPO_ROOT, "dist")];
  const target = path.join(REPO_ROOT, "src-tauri", "target");
  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "debug" ||
        entry.name === "release"
      ) {
        continue;
      }
      roots.push(path.join(target, entry.name, "release", "bundle"));
    }
    roots.push(path.join(target, "release", "bundle"));
  }
  const packagePattern =
    /\.(?:dmg|appimage|flatpak|deb|rpm|msi|msix|msixbundle|exe|zip|app\.tar\.(?:gz|zst))$/i;
  const files = roots.flatMap((root) =>
    walkFiles(root, (file) => packagePattern.test(path.basename(file))).map(
      (file) => fileRecord(file),
    ),
  );
  if (files.length === 0) {
    return {
      status: "not-measured",
      fileCount: null,
      bytes: null,
      files: [],
      reason:
        "No native release package artifacts were found in the scanned output directories.",
    };
  }
  return {
    status: "measured",
    files,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

function parseReportReference(file) {
  const record = fileRecord(file);
  let content = null;
  try {
    content = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A bad historical report remains visible as an unreadable reference.
  }
  return {
    ...record,
    readable: content !== null,
    recordedOutcome:
      content === null
        ? "unreadable"
        : content.passed === true || content.allPassed === true
          ? "claims-passed-unverified"
          : content.passed === false || content.allPassed === false
            ? "claims-failed-unverified"
            : "no-verdict-field",
    commit: content?.commit ?? null,
    platform: content?.platform ?? null,
    arch: content?.arch ?? null,
    startedAt: content?.startedAt ?? null,
    finishedAt: content?.finishedAt ?? null,
    scenarioCount: Array.isArray(content?.scenarios)
      ? content.scenarios.length
      : null,
    binarySha256: content?.binarySha256 ?? null,
  };
}

function collectReportReferences(artifactRoot) {
  const files = walkFiles(artifactRoot, (file) => {
    const basename = path.basename(file);
    return (
      /^e2e-report-.*\.json$/i.test(basename) ||
      /^e2e-stability-.*\.json$/i.test(basename) ||
      basename === "report.json" ||
      basename === "result.json"
    );
  });
  return files.map(parseReportReference);
}

function collectScenarioInventory(manifest) {
  const staticByFeature = {};
  for (const scenario of manifest.scenarios) {
    staticByFeature[scenario.feature] =
      (staticByFeature[scenario.feature] ?? 0) + 1;
  }
  const v5Root = path.join(REPO_ROOT, "e2e", "v5-fixes");
  const dynamicV5Areas = fs.existsSync(v5Root)
    ? fs
        .readdirSync(v5Root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
          const directory = path.join(v5Root, entry.name);
          return (
            fs.existsSync(path.join(directory, "run.mjs")) ||
            fs
              .readdirSync(directory, { withFileTypes: true })
              .some((file) => file.isFile() && file.name.endsWith(".spec.js"))
          );
        })
        .map((entry) => entry.name)
        .sort()
    : [];
  return {
    staticDiscoveredCount: manifest.scenarios.length,
    staticByFeature,
    staticIds: manifest.scenarios.map((scenario) => scenario.name),
    dynamicV5DiscoveredCount: dynamicV5Areas.length,
    dynamicV5Areas,
    execution: {
      status: "not-run-by-benchmark",
      executedScenarioCount: null,
      note: "Inventory discovery is not E2E execution evidence.",
    },
  };
}

function loadRuntimeMetrics(metricsFile) {
  const definitions = Object.keys(METRIC_UNITS);
  if (!metricsFile) {
    return {
      status: "missing",
      source: null,
      missingMetrics: definitions,
      reason:
        "No runtime measurement file was supplied; no historical values were inferred.",
      measurements: Object.fromEntries(
        definitions.map((name) => [
          name,
          { status: "not-measured", unit: METRIC_UNITS[name] },
        ]),
      ),
    };
  }
  const file = path.resolve(metricsFile);
  const inputBytes = fs.readFileSync(file);
  const input = JSON.parse(inputBytes.toString("utf8"));
  if (input.schemaVersion !== 1) {
    throw new Error("runtime metrics schemaVersion must be 1");
  }
  if (input.platform !== process.platform || input.arch !== process.arch) {
    throw new Error(
      `runtime metrics host ${input.platform}/${input.arch} does not match capture host ${process.platform}/${process.arch}`,
    );
  }
  if (input.platformRelease && input.platformRelease !== os.release()) {
    throw new Error(
      `runtime metrics OS release ${input.platformRelease} does not match capture release ${os.release()}`,
    );
  }
  if (typeof input.method !== "string" || input.method.trim() === "") {
    throw new Error("runtime metrics must describe the measurement method");
  }
  const values = input.measurements ?? {};
  const measurements = {};
  const missingMetrics = [];
  for (const name of definitions) {
    const measurement = values[name];
    if (measurement === undefined) {
      measurements[name] = { status: "not-measured", unit: METRIC_UNITS[name] };
      missingMetrics.push(name);
      continue;
    }
    if (
      typeof measurement.value !== "number" ||
      !Number.isFinite(measurement.value) ||
      measurement.value < 0 ||
      measurement.unit !== METRIC_UNITS[name]
    ) {
      throw new Error(
        `runtime metric ${name} needs a nonnegative number in ${METRIC_UNITS[name]}`,
      );
    }
    measurements[name] = {
      status: "measured",
      value: measurement.value,
      unit: measurement.unit,
      samples:
        Number.isInteger(measurement.samples) && measurement.samples > 0
          ? measurement.samples
          : null,
      method: measurement.method ?? input.method,
      evidence: measurement.evidence ?? null,
    };
  }
  if (
    measurements.idleCpuPercent.status === "measured" &&
    measurements.idleCpuPercent.value > 100
  ) {
    throw new Error("runtime metric idleCpuPercent must be between 0 and 100");
  }
  return {
    status: missingMetrics.length === 0 ? "measured" : "partial",
    source: {
      path: displayPath(file),
      sha256: sha256(inputBytes),
      measuredAt: input.measuredAt ?? null,
      method: input.method,
      platformRelease: input.platformRelease ?? os.release(),
    },
    missingMetrics,
    measurements,
  };
}

function compareReports(current, baseline) {
  if (baseline.schemaVersion !== 2) {
    throw new Error("comparison baseline schemaVersion must be 2");
  }
  const problems = [];
  if (baseline.reportSha256) {
    const { reportSha256, ...unsigned } = baseline;
    if (
      sha256(Buffer.from(JSON.stringify(unsigned, null, 2))) !== reportSha256
    ) {
      throw new Error("comparison baseline reportSha256 is invalid");
    }
  } else {
    problems.push("baseline has no reportSha256 integrity field");
  }
  const sameHost =
    current.platform === baseline.platform && current.arch === baseline.arch;
  if (!sameHost) problems.push("platform or architecture differs");
  const sameRuntimeHost =
    sameHost && current.platformRelease === baseline.platformRelease;
  if (sameHost && !sameRuntimeHost)
    problems.push("operating-system release differs");

  const metrics = {};
  for (const [name, currentMetric] of Object.entries(
    current.runtimeMetrics.measurements,
  )) {
    const baselineMetric = baseline.runtimeMetrics?.measurements?.[name];
    if (
      !sameRuntimeHost ||
      currentMetric.status !== "measured" ||
      baselineMetric?.status !== "measured" ||
      currentMetric.unit !== baselineMetric.unit ||
      currentMetric.method !== baselineMetric.method
    ) {
      metrics[name] = {
        status: "not-comparable",
        currentStatus: currentMetric.status,
        baselineStatus: baselineMetric?.status ?? "missing",
        unit: currentMetric.unit,
        reason:
          sameRuntimeHost &&
          currentMetric.status === "measured" &&
          baselineMetric?.status === "measured" &&
          currentMetric.method !== baselineMetric.method
            ? "measurement method differs"
            : undefined,
      };
      continue;
    }
    const delta = currentMetric.value - baselineMetric.value;
    metrics[name] = {
      status: "compared",
      baseline: baselineMetric.value,
      current: currentMetric.value,
      delta,
      unit: currentMetric.unit,
      deltaPercent:
        baselineMetric.value === 0
          ? null
          : (delta / baselineMetric.value) * 100,
    };
  }
  const sizeDelta = (currentValue, baselineValue) =>
    sameHost
      ? {
          status: "compared",
          baseline: baselineValue,
          current: currentValue,
          delta: currentValue - baselineValue,
        }
      : {
          status: "not-comparable",
          reason: "platform or architecture differs",
        };
  const packageSizes = () => {
    const currentPackages = current.sizes.nativePackages;
    const baselinePackages = baseline.sizes.nativePackages;
    if (!sameHost) {
      return {
        status: "not-comparable",
        reason: "platform or architecture differs",
      };
    }
    if (
      currentPackages?.status !== "measured" ||
      baselinePackages?.status !== "measured"
    ) {
      return {
        status: "not-measured",
        currentStatus: currentPackages?.status ?? "missing",
        baselineStatus: baselinePackages?.status ?? "missing",
        reason: "A missing package inventory is not a zero-size package.",
      };
    }
    return {
      status: "compared",
      baseline: baselinePackages.bytes,
      current: currentPackages.bytes,
      delta: currentPackages.bytes - baselinePackages.bytes,
    };
  };
  return {
    baseline: {
      path: baseline.reportPath ?? null,
      reportSha256: baseline.reportSha256 ?? null,
      sourceRevision: baseline.sourceRevision ?? null,
      platform: baseline.platform,
      arch: baseline.arch,
      platformRelease: baseline.platformRelease,
    },
    compatible: sameHost,
    runtimeEnvironmentMatches: sameRuntimeHost,
    runtimeMetricsComparable:
      sameRuntimeHost &&
      Object.keys(METRIC_UNITS).every(
        (name) => metrics[name]?.status === "compared",
      ),
    problems,
    sizes: {
      evidenceArtifacts: sizeDelta(
        current.sizes.evidenceArtifacts.bytes,
        baseline.sizes.evidenceArtifacts.bytes,
      ),
      sidecars: sizeDelta(
        current.sizes.sidecars.bytes,
        baseline.sizes.sidecars.bytes,
      ),
      frontendBuild: sizeDelta(
        current.sizes.frontendBuild.bytes,
        baseline.sizes.frontendBuild.bytes,
      ),
      nativePackages: packageSizes(),
    },
    runtimeMetrics: metrics,
  };
}

function parseArgs(argv) {
  const options = {
    label: "current",
    out: null,
    compare: null,
    metrics: null,
    snapshot: null,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    const [key, inlineValue] = argument.startsWith("--")
      ? argument.slice(2).split(/=(.*)/s, 2)
      : [null, null];
    if (
      !key ||
      !["label", "out", "compare", "runtime-metrics", "snapshot"].includes(key)
    ) {
      throw new Error(`unknown benchmark option: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`--${key} needs a value`);
    if (key === "runtime-metrics") options.metrics = value;
    else options[key] = value;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.label)) {
    throw new Error(
      "--label may contain only letters, numbers, dots, underscores, and hyphens",
    );
  }
  return options;
}

function readSnapshot(snapshotDir) {
  if (!snapshotDir) return null;
  const root = path.resolve(snapshotDir);
  const headFile = path.join(root, "head.txt");
  const hashesFile = path.join(root, "hashes.json");
  const trackedFile = path.join(root, "tracked.txt");
  if (![headFile, hashesFile, trackedFile].every(fs.existsSync)) {
    throw new Error(
      "clean snapshot needs head.txt, hashes.json, and tracked.txt",
    );
  }
  const hashes = JSON.parse(fs.readFileSync(hashesFile, "utf8"));
  const stagedPatch = fs.existsSync(path.join(root, "staged.patch"))
    ? fs.statSync(path.join(root, "staged.patch")).size
    : null;
  const unstagedPatch = fs.existsSync(path.join(root, "unstaged.patch"))
    ? fs.statSync(path.join(root, "unstaged.patch")).size
    : null;
  const snapshotHead = fs.readFileSync(headFile, "utf8").trim();
  return {
    path: root,
    head: snapshotHead,
    trackedFileCount: fs
      .readFileSync(trackedFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length,
    hashedFileCount: hashes.length,
    stagedPatchBytes: stagedPatch,
    unstagedPatchBytes: unstagedPatch,
    matchesCurrentHead: snapshotHead === gitValue(["rev-parse", "HEAD"]),
    cleanSnapshot: stagedPatch === 0 && unstagedPatch === 0,
  };
}

function collectWorktreeIdentity() {
  const statusRecords = gitRaw([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])
    .split("\0")
    .filter(Boolean);
  const files = [];
  for (let index = 0; index < statusRecords.length; index += 1) {
    const record = statusRecords[index];
    const hasStatusPrefix = /^[ MADRCU?!]{2} /.test(record);
    const status = hasStatusPrefix ? record.slice(0, 2) : "rename-source";
    const relativePath = hasStatusPrefix ? record.slice(3) : record;
    const absolutePath = path.resolve(REPO_ROOT, relativePath);
    const resolvedRelative = path.relative(REPO_ROOT, absolutePath);
    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelative)
    ) {
      throw new Error(
        `git reported a worktree path outside the repository: ${relativePath}`,
      );
    }
    let kind = "missing";
    let fileSha256 = null;
    if (fs.existsSync(absolutePath)) {
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        kind = "symlink";
        fileSha256 = sha256(Buffer.from(fs.readlinkSync(absolutePath)));
      } else if (stats.isFile()) {
        kind = "file";
        fileSha256 = sha256(fs.readFileSync(absolutePath));
      } else if (stats.isDirectory()) {
        kind = "directory";
      }
    }
    files.push({
      status,
      path: resolvedRelative.split(path.sep).join("/"),
      kind,
      sha256: fileSha256,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    sha256: sha256(Buffer.from(JSON.stringify(files))),
  };
}

function capture(options) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "e2e", "suites.json"), "utf8"),
  );
  const artifactRoot = path.resolve(DEFAULT_ARTIFACTS);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const tauriCliPackage = path.join(
    REPO_ROOT,
    "node_modules",
    "@tauri-apps",
    "cli",
    "package.json",
  );
  const tauriCli = fs.existsSync(tauriCliPackage)
    ? {
        status: "available",
        version: JSON.parse(fs.readFileSync(tauriCliPackage, "utf8")).version,
      }
    : {
        status: "unavailable",
        declaredRange: packageJson.devDependencies?.["@tauri-apps/cli"] ?? null,
      };
  const commit = gitValue(["rev-parse", "HEAD"]);
  const worktreeIdentity = collectWorktreeIdentity();
  const sourceRevision = {
    commit,
    dirty: worktreeIdentity.files.length > 0,
    changedPathCount: worktreeIdentity.files.length,
    worktreeSha256: worktreeIdentity.sha256,
    worktreeFiles: worktreeIdentity.files,
    diffSha256: sha256(
      Buffer.from(gitRaw(["diff", "--binary", "HEAD", "--", "."])),
    ),
  };
  const scenarioInventory = collectScenarioInventory(manifest);
  const reportReferences = collectReportReferences(artifactRoot);
  const current = {
    schemaVersion: 2,
    label: options.label,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    platformRelease: os.release(),
    sourceRevision,
    cleanSnapshot: readSnapshot(options.snapshot),
    versions: {
      node: { status: "available", version: process.version },
      npm: runVersion(process.platform === "win32" ? "npm.cmd" : "npm", [
        "--version",
      ]),
      rustc: runVersion("rustc", ["--version"]),
      cargo: runVersion("cargo", ["--version"]),
      tauriCli,
      packageManager: packageJson.packageManager ?? null,
      packageVersion: packageJson.version,
    },
    scenarioInventory,
    sizes: {
      evidenceArtifacts: collectArtifactSizes(artifactRoot),
      sidecars: collectSidecars(),
      frontendBuild: collectFrontendBuild(),
      nativePackages: collectNativePackages(),
    },
    runtimeMetrics: loadRuntimeMetrics(options.metrics),
    historicalReportReferences: {
      count: reportReferences.length,
      references: reportReferences,
      note: "Archived report contents are unverified references only; they are not baseline execution results for this capture.",
    },
    executionEvidence: {
      status: "not-run",
      passed: null,
      note: "This command inventories files and reports. It does not execute E2E scenarios or infer historical pass status.",
    },
  };
  if (options.compare) {
    const baselinePath = path.resolve(options.compare);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    current.comparison = compareReports(
      { ...current, reportPath: null },
      { ...baseline, reportPath: repoRelative(baselinePath) },
    );
  }
  return current;
}

function help() {
  process.stdout.write(
    [
      "Usage: node scripts/benchmark-51.mjs [options]",
      "  --label <name>                 Report label (default: current)",
      "  --out <path>                   Explicit report path (refuses overwrite by default)",
      "  --force                        Allow overwriting an explicit --out path",
      "  --compare <report.json>        Compare sizes and supplied runtime measurements",
      "  --runtime-metrics <file.json>  Import actual measurements using schemaVersion 1",
      "  --snapshot <directory>         Record the saved clean-snapshot identity",
      "",
      "Runtime metrics fields: startupMs (ms), idleCpuPercent (percent), peakMemoryBytes (bytes),",
      "queueLatencyMs (ms), proxyThroughputBytesPerSecond (bytes_per_second).",
    ].join("\n") + "\n",
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.resolve(
    options.out ??
      path.join(
        DEFAULT_ARTIFACTS,
        `benchmark-51-${options.label}-${process.platform}-${process.arch}-${timestamp}-${process.pid}.json`,
      ),
  );
  if (
    !options.force &&
    (fs.existsSync(outPath) || fs.existsSync(`${outPath}.sha256`))
  ) {
    throw new Error(
      `benchmark output already exists; choose a new --out path or pass --force: ${displayPath(outPath)}`,
    );
  }
  const report = capture(options);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  report.reportPath = displayPath(outPath);
  const canonical = JSON.stringify(report, null, 2);
  report.reportSha256 = sha256(Buffer.from(canonical));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(outPath, serialized);
  const fileHash = sha256(Buffer.from(serialized));
  fs.writeFileSync(
    `${outPath}.sha256`,
    `${fileHash}  ${path.basename(outPath)}\n`,
  );
  process.stdout.write(
    `${report.reportPath}\n` +
      `reportSha256=${report.reportSha256}\n` +
      `evidenceArtifacts=${report.sizes.evidenceArtifacts.files} files, ${report.sizes.evidenceArtifacts.bytes} bytes\n` +
      `sidecars=${report.sizes.sidecars.fileCount} files, ${report.sizes.sidecars.bytes} bytes\n` +
      `nativePackages=${report.sizes.nativePackages.status}${report.sizes.nativePackages.bytes === null ? " (not measured)" : `: ${report.sizes.nativePackages.bytes} bytes`}\n` +
      `staticScenarios=${report.scenarioInventory.staticDiscoveredCount}; dynamicV5Areas=${report.scenarioInventory.dynamicV5DiscoveredCount}; executed=not-run\n` +
      `runtimeMetrics=${report.runtimeMetrics.status}\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
