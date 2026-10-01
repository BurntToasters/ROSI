#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cargoManifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
const outputPath = join(repoRoot, "public", "licenses-cargo.json");
const unresolvedOutputPath = join(
  repoRoot,
  "public",
  "licenses-cargo-unresolved.json",
);
const requireComplete = process.argv.includes("--require-complete");
const sourceCheckouts = new Map();

// Some crates are published from a workspace that excludes `.cargo_vcs_info`
// and its root license files. Keep only exact, independently verifiable
// release revisions here; never infer a moving branch or a latest tag.
const SOURCE_REVISION_OVERRIDES = new Map([
  [
    "libappindicator-sys@0.9.0",
    {
      repository: "https://github.com/tauri-apps/libappindicator-rs",
      revision: "eafd1e3682a1247f595410266091e9684021cb6f",
      pathInRepository: "sys",
    },
  ],
  [
    "rustls-platform-verifier-android@0.1.1",
    {
      repository: "https://github.com/rustls/rustls-platform-verifier",
      revision: "28e5e5218cdf64daa6a43ec8d0ae36c4bab82d31",
      pathInRepository: ".",
    },
  ],
  [
    "winapi-i686-pc-windows-gnu@0.4.0",
    {
      repository: "https://github.com/retep998/winapi-rs",
      revision: "796a8e6c2971dc2ff1bcff166e6671284f9b5b6b",
      pathInRepository: "i686",
    },
  ],
  [
    "winapi-x86_64-pc-windows-gnu@0.4.0",
    {
      repository: "https://github.com/retep998/winapi-rs",
      revision: "796a8e6c2971dc2ff1bcff166e6671284f9b5b6b",
      pathInRepository: "x86_64",
    },
  ],
]);

// These exact published packages and source revisions contain no license file
// or license header beyond the SPDX declaration in Cargo.toml. Preserve the
// omission visibly in the generated notice instead of fabricating a generic
// license blob. The UI still exposes the declared SPDX references.
const REVIEWED_SOURCE_OMISSIONS = new Map([
  [
    "selectors@0.36.1",
    "The crates.io package and its pinned upstream source revision contain no license text beyond the MPL-2.0 declaration in Cargo.toml.",
  ],
  [
    "sigchld@0.2.4",
    "The crates.io package and its pinned upstream source revision contain no license text beyond the MIT declaration in Cargo.toml.",
  ],
  [
    "sigchld@0.2.5",
    "The crates.io package and its pinned upstream source revision contain no license text beyond the MIT declaration in Cargo.toml.",
  ],
]);

function runCargoMetadata() {
  const args = [
    "metadata",
    "--manifest-path",
    cargoManifestPath,
    "--format-version",
    "1",
    "--locked",
  ];
  const result = spawnSync("cargo", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to run cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with exit code ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  return JSON.parse(result.stdout);
}

function computeReachablePackageIds(metadata) {
  const workspaceMembers = new Set(
    Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
  );
  const resolveNodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  const nodesById = new Map(resolveNodes.map((node) => [node.id, node]));

  const queue = [...workspaceMembers];
  const reachable = new Set(queue);

  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodesById.get(id);
    if (!node || !Array.isArray(node.deps)) continue;

    for (const dep of node.deps) {
      const depId = typeof dep?.pkg === "string" ? dep.pkg : null;
      if (!depId || reachable.has(depId)) continue;
      reachable.add(depId);
      queue.push(depId);
    }
  }

  return { reachable, workspaceMembers };
}

function hasLicenseTerms(text) {
  return /permission is hereby granted|licensed under|gnu (?:lesser )?general public license|mozilla public license|redistribution and use/i.test(
    text,
  );
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function isRealPathWithin(root, candidate) {
  try {
    return isWithin(realpathSync(root), realpathSync(candidate));
  } catch {
    return false;
  }
}

function readLicenseTextsFromDirectory(packageDir, licenseFile = null) {
  const realPackageDir = realpathSync(packageDir);
  const names = new Set(
    readdirSync(packageDir).filter((name) =>
      /^(licen[cs]e|copying|notice|authors|copyright)(?:[._-].*)?$/i.test(name),
    ),
  );
  if (typeof licenseFile === "string" && licenseFile.trim()) {
    const filePath = resolve(packageDir, licenseFile);
    if (
      isWithin(packageDir, filePath) &&
      existsSync(filePath) &&
      isRealPathWithin(realPackageDir, filePath)
    ) {
      names.add(relative(packageDir, filePath));
    }
  }

  const sections = [];
  for (const name of [...names].sort()) {
    const filePath = resolve(packageDir, name);
    if (
      !isWithin(packageDir, filePath) ||
      !existsSync(filePath) ||
      !isRealPathWithin(realPackageDir, filePath)
    ) {
      continue;
    }
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const text = readFileSync(filePath, "utf8").trim();
    const attributionOnly = /^(authors|copyright)(?:[._-].*)?$/i.test(name);
    if (text && (!attributionOnly || hasLicenseTerms(text))) {
      sections.push(`--- ${name} ---\n${text}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function readLicenseTexts(pkg) {
  return readLicenseTextsFromDirectory(
    dirname(pkg.manifest_path),
    pkg.license_file,
  );
}

function normalizedRepositoryUrl(repository) {
  if (typeof repository !== "string" || !repository.trim()) return null;
  const raw = repository.trim().replace(/^git\+/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed with exit code ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function checkoutSourceRevision(repository, revision) {
  const key = `${repository}@${revision}`;
  const cached = sourceCheckouts.get(key);
  if (cached) return cached;

  const checkoutDir = mkdtempSync(join(tmpdir(), "rosi-cargo-license-"));
  try {
    runGit(["init", "--quiet"], checkoutDir);
    runGit(["remote", "add", "origin", repository], checkoutDir);
    runGit(["fetch", "--quiet", "--depth=1", "origin", revision], checkoutDir);
    runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], checkoutDir);
  } catch (error) {
    rmSync(checkoutDir, { recursive: true, force: true });
    throw error;
  }
  sourceCheckouts.set(key, checkoutDir);
  return checkoutDir;
}

function findSourceLicenseInCheckout(pkg, vcs, checkoutRoot, repository) {
  const sourcePath = vcs.pathInRepository || ".";
  const packageDir = resolve(checkoutRoot, sourcePath);
  if (
    !isWithin(checkoutRoot, packageDir) ||
    !existsSync(packageDir) ||
    !isRealPathWithin(checkoutRoot, packageDir)
  ) {
    return null;
  }
  const packageStat = lstatSync(packageDir);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) return null;

  let current = packageDir;
  for (;;) {
    if (!isRealPathWithin(checkoutRoot, current)) return null;
    const text = readLicenseTextsFromDirectory(
      current,
      current === packageDir ? pkg.license_file : null,
    );
    if (text) {
      return {
        text,
        repository,
        revision: vcs.revision,
        directory: relative(checkoutRoot, current) || ".",
      };
    }
    if (current === checkoutRoot) break;
    const parent = dirname(current);
    if (!isWithin(checkoutRoot, parent) || parent === current) break;
    current = parent;
  }
  return {
    noLicenseText: true,
    repository,
    revision: vcs.revision,
    directory: relative(checkoutRoot, packageDir) || ".",
  };
}

function readSourceRevisionLicenseTexts(pkg, vcs) {
  const repository =
    normalizedRepositoryUrl(vcs?.repository) ||
    normalizedRepositoryUrl(pkg.repository);
  if (!repository || !vcs) return null;

  try {
    const checkoutRoot = checkoutSourceRevision(repository, vcs.revision);
    return findSourceLicenseInCheckout(pkg, vcs, checkoutRoot, repository);
  } catch (error) {
    console.warn(
      `[licenses:cargo] Could not recover immutable source license for ${pkg.name}@${pkg.version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}

function cleanupSourceCheckouts() {
  for (const checkoutDir of sourceCheckouts.values()) {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
  sourceCheckouts.clear();
}

function spdxReferences(licenses) {
  const identifiers = licenses.match(/[A-Za-z0-9.-]+(?:\+)?/g) ?? [];
  return [...new Set(identifiers)]
    .filter(
      (identifier) =>
        !["AND", "OR", "WITH", "LicenseRef"].includes(identifier) &&
        !identifier.startsWith("DocumentRef-"),
    )
    .map((identifier) => ({
      identifier,
      url: `https://spdx.org/licenses/${encodeURIComponent(identifier)}.html`,
    }));
}

function readPackagedVcsInfo(pkg) {
  if (typeof pkg?.manifest_path !== "string") return null;
  const infoPath = join(dirname(pkg.manifest_path), ".cargo_vcs_info.json");
  if (!existsSync(infoPath)) return null;
  try {
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const revision = info?.git?.sha1;
    if (typeof revision !== "string" || !/^[a-f0-9]{40}$/i.test(revision)) {
      return null;
    }
    return {
      revision,
      pathInRepository:
        typeof info.path_in_vcs === "string" ? info.path_in_vcs : null,
    };
  } catch {
    return null;
  }
}

function sourceRevisionForPackage(pkg) {
  const packaged = readPackagedVcsInfo(pkg);
  const override = SOURCE_REVISION_OVERRIDES.get(`${pkg.name}@${pkg.version}`);
  if (!packaged) return override || null;
  if (!override?.repository || normalizedRepositoryUrl(pkg.repository)) {
    return packaged;
  }
  return { ...packaged, repository: override.repository };
}

function reviewedSourceOmissionForPackage(pkg) {
  return REVIEWED_SOURCE_OMISSIONS.get(`${pkg.name}@${pkg.version}`) || null;
}

function toLicenseEntry(pkg) {
  const licenses =
    typeof pkg.license === "string" && pkg.license.trim()
      ? pkg.license.trim()
      : "UNKNOWN";
  if (licenses === "UNKNOWN") {
    throw new Error(
      `Cargo dependency ${pkg.name}@${pkg.version} does not declare an SPDX license.`,
    );
  }

  const bundledText = readLicenseTexts(pkg);
  const vcs = bundledText ? null : sourceRevisionForPackage(pkg);
  const sourceRevisionResult =
    requireComplete && !bundledText && vcs
      ? readSourceRevisionLicenseTexts(pkg, vcs)
      : null;
  const reviewedOmission = reviewedSourceOmissionForPackage(pkg);
  const sourceOmission =
    !bundledText &&
    !sourceRevisionResult?.text &&
    reviewedOmission &&
    (!requireComplete || sourceRevisionResult?.noLicenseText === true)
      ? reviewedOmission
      : null;
  const licenseText = bundledText || sourceRevisionResult?.text || null;
  const entry = {
    licenses,
    repository:
      typeof pkg.repository === "string" && pkg.repository.trim()
        ? pkg.repository.trim()
        : null,
    packageManager: "cargo",
    // Stable builds may recover a workspace-root license only from the exact
    // immutable revision recorded by crates.io. Generic SPDX links remain
    // informational and never satisfy the fail-closed notice gate.
    licenseText,
    licenseTextStatus: bundledText
      ? "bundled"
      : sourceRevisionResult?.text
        ? "source-revision"
        : sourceOmission
          ? "reviewed-omission"
          : "not-packaged",
    licenseReferences: licenseText ? [] : spdxReferences(licenses),
  };

  if (Array.isArray(pkg.authors) && pkg.authors.length > 0) {
    const joined = pkg.authors
      .filter((author) => typeof author === "string" && author.trim())
      .join(", ");
    if (joined) {
      entry.publisher = joined;
    }
  }

  if (typeof pkg.source === "string" && pkg.source.trim()) {
    entry.source = pkg.source.trim();
  }
  if (vcs) {
    entry.sourceRevision = vcs.revision;
    entry.sourcePath = vcs.pathInRepository;
  }
  if (sourceRevisionResult?.text) {
    entry.licenseTextSource = {
      repository: sourceRevisionResult.repository,
      revision: sourceRevisionResult.revision,
      directory: sourceRevisionResult.directory,
    };
  }
  if (sourceOmission) {
    entry.licenseTextReview = {
      status: "source-omission-reviewed",
      reason: sourceOmission,
      repository: vcs?.repository || normalizedRepositoryUrl(pkg.repository),
      revision: vcs?.revision || null,
    };
  }

  return entry;
}

function buildCargoLicenses(metadata) {
  const { reachable, workspaceMembers } = computeReachablePackageIds(metadata);
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];

  const reachablePackages = packages.filter(
    (pkg) =>
      pkg &&
      typeof pkg.id === "string" &&
      reachable.has(pkg.id) &&
      !workspaceMembers.has(pkg.id) &&
      typeof pkg.name === "string" &&
      typeof pkg.version === "string",
  );
  const entries = {};
  for (const pkg of reachablePackages) {
    const key = `cargo:${pkg.name}@${pkg.version}`;
    entries[key] = toLicenseEntry(pkg);
  }

  return Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function main() {
  const metadata = runCargoMetadata();
  const licenses = buildCargoLicenses(metadata);
  const unresolved = Object.fromEntries(
    Object.entries(licenses).filter(
      ([, entry]) => entry.licenseTextStatus === "not-packaged",
    ),
  );
  const missingText = Object.keys(unresolved).length;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
  writeFileSync(
    unresolvedOutputPath,
    `${JSON.stringify(unresolved, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[licenses:cargo] Wrote ${Object.keys(licenses).length} cargo entries to ${outputPath}`,
  );
  if (missingText > 0) {
    const message =
      `${missingText} package license text(s) could not be recovered from their crates.io packages or immutable upstream source revisions. ` +
      `Exact unresolved report: ${unresolvedOutputPath}. Generic SPDX references are informational, not a substitute for required binary notices.`;
    if (requireComplete) {
      console.error(`[licenses:cargo] FAILED: ${message}`);
      process.exitCode = 1;
      return;
    }
    console.warn(`[licenses:cargo] WARNING: ${message}`);
    console.warn(
      "[licenses:cargo] Re-run with --require-complete for a fail-closed release compliance gate.",
    );
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    main();
  } finally {
    cleanupSourceCheckouts();
  }
}

export {
  REVIEWED_SOURCE_OMISSIONS,
  SOURCE_REVISION_OVERRIDES,
  findSourceLicenseInCheckout,
  normalizedRepositoryUrl,
  readLicenseTextsFromDirectory,
  reviewedSourceOmissionForPackage,
  sourceRevisionForPackage,
};
