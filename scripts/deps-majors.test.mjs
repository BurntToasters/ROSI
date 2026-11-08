import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  USER_AGENT,
  buildNpmItems,
  cargoReportLabel,
  collectCargoReport,
  collectDirectCargoDependencies,
  compareVersions,
  crateIndexPath,
  fetchCrateVersions,
  formatTextReport,
  isCargoCompatible,
  isCratesIoSource,
  isEntryPoint,
  isExactRequirement,
  isNpmExactPin,
  isPrereleaseVersion,
  mapWithConcurrency,
  NPM_OUTDATED_COMMAND,
  parseArguments,
  parseIndexLines,
  parseNpmOutdatedResult,
  readNpmOutdated,
  runCargoMetadata,
  selectLatestStable,
  selectManifestPath,
} from "./deps-majors.mjs";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const MEMBER_ID = "path+file:///repo/src-tauri#zinnia@1.0.0";
const VENDOR_SOURCE = "path+file:///repo/src-tauri/vendor/plugin";

function entry(vers, yanked = false) {
  return { vers, yanked };
}

function dep(name, requirement, locked, overrides = {}) {
  return {
    name,
    alias: null,
    requirement,
    kind: "normal",
    target: null,
    locked,
    ...overrides,
  };
}

function declared(name, req, overrides = {}) {
  return {
    name,
    req,
    kind: null,
    target: null,
    rename: null,
    optional: false,
    source: CRATES_IO,
    ...overrides,
  };
}

function lockedPackage(name, version, source = CRATES_IO) {
  const id = `${source}#${name}@${version}`;
  return { id, name, version, source, dependencies: [] };
}

function edge(pkg, { kind = null, target = null, extern } = {}) {
  return {
    name: extern ?? pkg.name.replaceAll("-", "_"),
    pkg: pkg.id,
    dep_kinds: [{ kind, target }],
  };
}

function metadataFor(
  memberDeclarations,
  memberEdges,
  extraPackages = [],
  extraNodes = [],
) {
  const member = {
    id: MEMBER_ID,
    name: "zinnia",
    version: "1.0.0",
    source: null,
    dependencies: memberDeclarations,
  };
  const packages = [member, ...extraPackages];
  return {
    packages,
    workspace_members: [MEMBER_ID],
    resolve: {
      root: MEMBER_ID,
      nodes: [{ id: MEMBER_ID, deps: memberEdges }, ...extraNodes],
    },
  };
}

test("sparse index paths follow the 1, 2, 3 and 4+ character layout", () => {
  assert.equal(crateIndexPath("a"), "1/a");
  assert.equal(crateIndexPath("ab"), "2/ab");
  assert.equal(crateIndexPath("abc"), "3/a/abc");
  assert.equal(crateIndexPath("sha2"), "sh/a2/sha2");
  assert.equal(crateIndexPath("getrandom"), "ge/tr/getrandom");
  assert.equal(crateIndexPath("window-vibrancy"), "wi/nd/window-vibrancy");
});

test("sparse index paths are lowercased for uppercase crate names", () => {
  assert.equal(crateIndexPath("Serde"), "se/rd/serde");
  assert.equal(crateIndexPath("ABC"), "3/a/abc");
  assert.equal(crateIndexPath("AB"), "2/ab");
});

test("sparse index paths reject names that could escape the index root", () => {
  assert.throws(() => crateIndexPath("../etc"), /invalid crate name/iu);
  assert.throws(() => crateIndexPath("a/b"), /invalid crate name/iu);
  assert.throws(() => crateIndexPath(""), /invalid crate name/iu);
});

test("latest stable skips prereleases and yanked releases", () => {
  const entries = [
    entry("0.9.0"),
    entry("0.10.9"),
    entry("0.11.0-rc.1"),
    entry("0.11.0", true),
    entry("0.10.10"),
  ];
  assert.equal(selectLatestStable(entries), "0.10.10");
});

test("latest stable is null when only prereleases or yanked releases exist", () => {
  assert.equal(
    selectLatestStable([entry("1.0.0-beta.2"), entry("1.0.0", true)]),
    null,
  );
  assert.equal(selectLatestStable([]), null);
});

test("latest stable compares numerically, not lexically", () => {
  assert.equal(selectLatestStable([entry("1.9.0"), entry("1.10.0")]), "1.10.0");
  assert.equal(compareVersions("0.10.9", "0.9.0") > 0, true);
});

test("prerelease detection only flags versions with a prerelease tag", () => {
  assert.equal(isPrereleaseVersion("0.11.0-rc.1"), true);
  assert.equal(isPrereleaseVersion("2.0.0-alpha"), true);
  assert.equal(isPrereleaseVersion("0.11.0"), false);
  assert.equal(isPrereleaseVersion("1.0.0+build.5"), false);
});

test("index parsing reads one JSON object per line and rejects malformed lines", () => {
  const text =
    '{"vers":"1.0.0","yanked":false}\n{"vers":"1.0.1","yanked":true}\n';
  assert.deepEqual(parseIndexLines(text), [
    { vers: "1.0.0", yanked: false },
    { vers: "1.0.1", yanked: true },
  ]);
  assert.throws(() => parseIndexLines('{"vers":"1.0.0"}\n{oops'));
  assert.throws(() => parseIndexLines('{"yanked":false}'));
});

test("0.x minor bumps are breaking while 1.x minor bumps stay compatible", () => {
  assert.equal(isCargoCompatible("0.10.9", "0.11.0"), false);
  assert.equal(isCargoCompatible("0.10.9", "0.10.12"), true);
  assert.equal(isCargoCompatible("1.2.0", "1.3.0"), true);
  assert.equal(isCargoCompatible("1.2.0", "2.0.0"), false);
});

test("0.0.x versions are compatible only with the exact same version", () => {
  assert.equal(isCargoCompatible("0.0.3", "0.0.3"), true);
  assert.equal(isCargoCompatible("0.0.3", "0.0.4"), false);
  assert.equal(isCargoCompatible("0.0.3", "0.1.0"), false);
});

test("0.x patch bumps stay compatible", () => {
  assert.equal(isCargoCompatible("0.6.0", "0.6.2"), true);
  assert.equal(isCargoCompatible("0.1.0", "0.1.9"), true);
});

test("caret requirements report only versions outside their semver range", () => {
  assert.equal(
    cargoReportLabel(dep("sha2", "^0.10", "0.10.9"), "0.11.0"),
    "outside range",
  );
  assert.equal(
    cargoReportLabel(dep("sha2", "^0.10", "0.10.9"), "0.10.12"),
    null,
  );
  assert.equal(
    cargoReportLabel(dep("window-vibrancy", "^0.6", "0.6.0"), "0.8.1"),
    "outside range",
  );
  assert.equal(cargoReportLabel(dep("serde", "^1", "1.0.1"), "1.9.0"), null);
});

test("the locked version decides compatibility, not the requirement text", () => {
  assert.equal(
    cargoReportLabel(dep("pkg", "^0.3", "0.3.4"), "0.4.0"),
    "outside range",
  );
});

test("exact requirements report any newer version as pinned, even a patch bump", () => {
  assert.equal(isExactRequirement("=0.4.2"), true);
  assert.equal(isExactRequirement(" =0.4.2 "), true);
  assert.equal(isExactRequirement("^0.4.2"), false);
  assert.equal(
    cargoReportLabel(dep("pinned", "=0.4.2", "0.4.2"), "0.4.3"),
    "pinned",
  );
  assert.equal(
    cargoReportLabel(dep("pinned", "=0.4.2", "0.4.2"), "0.4.2"),
    null,
  );
  assert.equal(
    cargoReportLabel(dep("pinned", "=0.4.2", "0.4.2"), "0.4.1"),
    null,
  );
});

test("a latest version older than the locked one is never reported", () => {
  assert.equal(cargoReportLabel(dep("serde", "^1", "1.5.0"), "1.4.0"), null);
  assert.equal(cargoReportLabel(dep("serde", "^1", "1.5.0"), null), null);
});

test("only crates.io sources count as registry dependencies", () => {
  assert.equal(isCratesIoSource(CRATES_IO), true);
  assert.equal(
    isCratesIoSource("registry+sparse+https://index.crates.io/"),
    true,
  );
  assert.equal(isCratesIoSource(null), false);
  assert.equal(
    isCratesIoSource("git+https://github.com/owner/repo#abc123"),
    false,
  );
  assert.equal(isCratesIoSource("registry+https://example.com/index"), false);
});

test("path, git, patched, and inactive optional dependencies never reach the report", () => {
  const serde = lockedPackage("serde", "1.0.229");
  const patched = lockedPackage(
    "tauri-plugin-updater",
    "2.10.1",
    VENDOR_SOURCE,
  );
  const metadata = metadataFor(
    [
      declared("serde", "1"),
      declared("local-helper", "0.2", { source: null }),
      declared("git-crate", "1", {
        source: "git+https://github.com/owner/repo#abc",
      }),
      declared("tauri-plugin-updater", "2", { target: "cfg(unix)" }),
      declared("tauri-plugin-wdio", "1", { optional: true }),
    ],
    [edge(serde), edge(patched, { target: "cfg(unix)" })],
    [serde, patched],
  );
  assert.deepEqual(collectDirectCargoDependencies(metadata), [
    dep("serde", "1", "1.0.229"),
  ]);
});

test("renamed dependencies are reported under the real crate name with the alias kept", () => {
  const real = lockedPackage("real-crate", "1.2.3");
  const metadata = metadataFor(
    [declared("real-crate", "1", { rename: "alias_name" })],
    [edge(real, { extern: "alias_name" })],
    [real],
  );
  assert.deepEqual(collectDirectCargoDependencies(metadata), [
    dep("real-crate", "1", "1.2.3", { alias: "alias_name" }),
  ]);
});

test("transitive crates never leak into the direct dependency list", () => {
  const toml = lockedPackage("toml", "0.8.0");
  const helper = lockedPackage("tauri-helper", "2.0.0");
  helper.dependencies = [
    { name: "toml", req: "^0.8", kind: null, target: null },
  ];
  const metadata = metadataFor(
    [declared("tauri-helper", "2")],
    [edge(helper)],
    [toml, helper],
    [{ id: helper.id, deps: [edge(toml)] }],
  );
  assert.deepEqual(
    collectDirectCargoDependencies(metadata).map((d) => d.name),
    ["tauri-helper"],
  );
});

test("dev, build, and target-specific declarations keep their kind and locked version", () => {
  const minisign = lockedPackage("minisign-verify", "0.3.0");
  const build = lockedPackage("tauri-build", "2.7.2");
  const winOld = lockedPackage("windows-sys", "0.59.0");
  const winNew = lockedPackage("windows-sys", "0.61.2");
  const metadata = metadataFor(
    [
      declared("minisign-verify", "0.3", { kind: "dev" }),
      declared("tauri-build", "2", { kind: "build" }),
      declared("windows-sys", "0.59"),
      declared("windows-sys", "0.61", { target: "cfg(windows)" }),
    ],
    [
      edge(minisign, { kind: "dev" }),
      edge(build, { kind: "build" }),
      edge(winOld),
      edge(winNew, { target: "cfg(windows)" }),
    ],
    [minisign, build, winOld, winNew],
  );
  assert.deepEqual(collectDirectCargoDependencies(metadata), [
    dep("minisign-verify", "0.3", "0.3.0", { kind: "dev" }),
    dep("tauri-build", "2", "2.7.2", { kind: "build" }),
    dep("windows-sys", "0.59", "0.59.0"),
    dep("windows-sys", "0.61", "0.61.2", { target: "cfg(windows)" }),
  ]);
});

test("cargo metadata runs read-only with --locked and fails loudly on errors", () => {
  const calls = [];
  const okRun = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "{}", stderr: "", error: undefined };
  };
  assert.deepEqual(runCargoMetadata("src-tauri/Cargo.toml", okRun), {});
  assert.equal(calls[0].command, "cargo");
  assert.deepEqual(calls[0].args.slice(0, 2), ["metadata", "--format-version"]);
  assert.ok(calls[0].args.includes("--locked"));
  assert.ok(calls[0].args.includes("--all-features"));
  assert.ok(calls[0].args.includes("src-tauri/Cargo.toml"));

  assert.throws(
    () =>
      runCargoMetadata("Cargo.toml", () => ({
        status: 101,
        stdout: "",
        stderr: "lock file out of date",
      })),
    /lock file out of date/u,
  );
  assert.throws(
    () =>
      runCargoMetadata("Cargo.toml", () => ({
        error: new Error("spawn cargo ENOENT"),
      })),
    /ENOENT/u,
  );
});

test("per-crate fetch failures are recorded in errors and do not fail the report", async () => {
  const report = await collectCargoReport({
    dependencies: [
      dep("sha2", "^0.10", "0.10.9"),
      dep("getrandom", "^0.3", "0.3.4"),
    ],
    fetchVersions: async (name) => {
      if (name === "sha2") throw new Error("HTTP 503");
      return [entry("0.3.4"), entry("0.4.0")];
    },
    concurrency: 2,
  });
  assert.deepEqual(report.errors, [
    { source: "cargo", name: "sha2", message: "HTTP 503" },
  ]);
  assert.deepEqual(
    report.cargo.map((item) => [item.name, item.latest, item.label]),
    [["getrandom", "0.4.0", "outside range"]],
  );
});

test("a crate with only prerelease releases is an error, not a silent drop", async () => {
  const report = await collectCargoReport({
    dependencies: [dep("newthing", "^1", "1.0.0"), dep("serde", "^1", "1.0.1")],
    fetchVersions: async (name) =>
      name === "newthing" ? [entry("2.0.0-rc.1")] : [entry("1.0.1")],
    concurrency: 2,
  });
  assert.equal(report.cargo.length, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].name, "newthing");
});

test("a network failure for every crate fails the whole cargo report", async () => {
  await assert.rejects(
    collectCargoReport({
      dependencies: [
        dep("sha2", "^0.10", "0.10.9"),
        dep("getrandom", "^0.3", "0.3.4"),
      ],
      fetchVersions: async () => {
        throw new TypeError("fetch failed");
      },
      concurrency: 2,
    }),
    /crates\.io index/u,
  );
});

test("index requests send the report user agent and the sparse path", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response('{"vers":"0.11.0","yanked":false}\n', { status: 200 });
  };
  const entries = await fetchCrateVersions("sha2", fakeFetch);
  assert.equal(calls[0].url, "https://index.crates.io/sh/a2/sha2");
  assert.equal(calls[0].headers["User-Agent"], "tauri-deps-majors-report");
  assert.equal(USER_AGENT, "tauri-deps-majors-report");
  assert.equal(entries[0].vers, "0.11.0");
});

test("non-200 index responses are fetch errors", async () => {
  await assert.rejects(
    fetchCrateVersions(
      "missing-crate",
      async () => new Response("", { status: 404 }),
    ),
    /404/u,
  );
});

test("mapWithConcurrency caps in-flight work and keeps input order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6, 7, 8],
    3,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5 * (9 - value)));
      active -= 1;
      return value * 2;
    },
  );
  assert.ok(peak <= 3, `peak in-flight was ${peak}`);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16]);
});

test("npm exact pins are plain versions with no range operator", () => {
  for (const spec of ["2.10.1", "=2.10.1", "v2.10.1", "2.0.0-beta.1"]) {
    assert.equal(isNpmExactPin(spec), true, spec);
  }
  for (const spec of [
    "^1.0.0",
    "~1.0.0",
    ">=1.0.0",
    "1.x",
    "1.0",
    "*",
    "latest",
    "npm:foo@1.0.0",
    "file:../local",
    "1.0.0 - 2.0.0",
    "1 || 2",
    "",
  ]) {
    assert.equal(isNpmExactPin(spec), false, spec);
  }
});

test("npm items are direct packages whose latest differs from wanted", () => {
  const outdated = {
    "@wdio/cli": { current: "9.31.2", wanted: "9.31.2", latest: "10.0.0" },
    "@tauri-apps/plugin-updater": {
      current: "2.10.1",
      wanted: "2.10.1",
      latest: "2.10.3",
    },
    lucide: { current: "1.68.0", wanted: "1.69.0", latest: "1.69.0" },
    broken: { current: "1.0.0", wanted: "1.0.0" },
  };
  const packageJson = {
    dependencies: { "@tauri-apps/plugin-updater": "2.10.1", lucide: "^1.68.0" },
    devDependencies: { "@wdio/cli": "^9.31.2", broken: "^1.0.0" },
  };
  assert.deepEqual(buildNpmItems(outdated, packageJson), [
    {
      name: "@tauri-apps/plugin-updater",
      requirement: "2.10.1",
      kind: "dependencies",
      current: "2.10.1",
      wanted: "2.10.1",
      latest: "2.10.3",
      label: "pinned",
    },
    {
      name: "@wdio/cli",
      requirement: "^9.31.2",
      kind: "devDependencies",
      current: "9.31.2",
      wanted: "9.31.2",
      latest: "10.0.0",
      label: "outside range",
    },
  ]);
});

test("npm outdated exit code 1 with a JSON report is a successful read", () => {
  const parsed = parseNpmOutdatedResult({
    status: 1,
    stdout: '{"vite":{"current":"8.0.0","wanted":"8.0.0","latest":"9.0.0"}}',
    stderr: "",
  });
  assert.equal(parsed.vite.latest, "9.0.0");
});

test("npm outdated with exit 0 and an empty object is an empty report", () => {
  assert.deepEqual(
    parseNpmOutdatedResult({ status: 0, stdout: "{}\n", stderr: "" }),
    {},
  );
});

test("npm outdated without a JSON report is a failure", () => {
  assert.throws(
    () =>
      parseNpmOutdatedResult({
        status: 1,
        stdout: "",
        stderr: "ECONNREFUSED registry",
      }),
    /ECONNREFUSED registry/u,
  );
  assert.throws(
    () => parseNpmOutdatedResult({ status: 1, stdout: "not json", stderr: "" }),
    /JSON/u,
  );
});

test("npm error objects, spawn errors, and other exit codes are failures", () => {
  assert.throws(
    () =>
      parseNpmOutdatedResult({
        status: 1,
        stdout: '{"error":{"code":"E503","summary":"down"}}',
        stderr: "",
      }),
    /E503/u,
  );
  assert.throws(
    () => parseNpmOutdatedResult({ error: new Error("spawn ENOENT") }),
    /ENOENT/u,
  );
  assert.throws(
    () => parseNpmOutdatedResult({ status: 2, stdout: "{}", stderr: "" }),
    /exit 2/u,
  );
  assert.throws(() =>
    parseNpmOutdatedResult({ status: null, stdout: "{}", stderr: "" }),
  );
});

test("a package literally named error is not mistaken for an npm error", () => {
  const parsed = parseNpmOutdatedResult({
    status: 1,
    stdout: '{"error":{"current":"1.0.0","wanted":"1.0.0","latest":"2.0.0"}}',
    stderr: "",
  });
  assert.equal(parsed.error.latest, "2.0.0");
});

test("npm outdated runs as a fixed read-only command through the shell", () => {
  assert.ok(NPM_OUTDATED_COMMAND.includes("outdated --json --all=false"));
  const calls = [];
  const fakeRun = (command, options) => {
    calls.push({ command, options });
    return { status: 1, stdout: "{}", stderr: "" };
  };
  assert.deepEqual(readNpmOutdated(fakeRun), {});
  assert.equal(calls[0].command, NPM_OUTDATED_COMMAND);
  assert.equal(calls[0].options.shell, true);
});

test("manifest path defaults to src-tauri when it exists and to the root manifest otherwise", () => {
  assert.equal(
    selectManifestPath(null, () => true),
    "src-tauri/Cargo.toml",
  );
  assert.equal(
    selectManifestPath(null, () => false),
    "Cargo.toml",
  );
  assert.equal(
    selectManifestPath("vendor/x/Cargo.toml", () => true),
    "vendor/x/Cargo.toml",
  );
});

test("argument parsing accepts --json and both manifest path spellings", () => {
  assert.deepEqual(parseArguments([]), { json: false, manifestPath: null });
  assert.deepEqual(parseArguments(["--json"]), {
    json: true,
    manifestPath: null,
  });
  assert.deepEqual(parseArguments(["--manifest-path", "a/Cargo.toml"]), {
    json: false,
    manifestPath: "a/Cargo.toml",
  });
  assert.deepEqual(parseArguments(["--manifest-path=b/Cargo.toml", "--json"]), {
    json: true,
    manifestPath: "b/Cargo.toml",
  });
});

test("argument parsing rejects a missing manifest path value and unknown flags", () => {
  assert.throws(() => parseArguments(["--manifest-path"]), /manifest-path/u);
  assert.throws(() => parseArguments(["--manifest-path="]), /manifest-path/u);
  assert.throws(() => parseArguments(["--frobnicate"]), /Unknown argument/u);
});

test("importing the module does not count as running it directly", () => {
  const moduleUrl = new URL("./deps-majors.mjs", import.meta.url).href;
  assert.equal(isEntryPoint(moduleUrl, process.argv[1]), false);
  assert.equal(isEntryPoint(moduleUrl, undefined), false);
});

test("running the module by its own path counts as direct execution", () => {
  const modulePath = fileURLToPath(
    new URL("./deps-majors.mjs", import.meta.url),
  );
  assert.equal(isEntryPoint(pathToFileURL(modulePath).href, modulePath), true);
});

test("the text report names both sections and says so when nothing is found", () => {
  const text = formatTextReport(
    { cargo: [], npm: [], errors: [] },
    { manifestPath: "src-tauri/Cargo.toml" },
  );
  assert.match(text, /No Cargo dependencies/u);
  assert.match(text, /No npm dependencies/u);
});

test("the text report lists Cargo and npm rows with their labels and errors", () => {
  const text = formatTextReport(
    {
      cargo: [
        dep("real-crate", "1", "1.2.3", {
          alias: "alias_name",
          latest: "2.0.0",
          label: "outside range",
        }),
        dep("sha2", "^0.10", "0.10.9", {
          latest: "0.11.0",
          label: "outside range",
        }),
      ],
      npm: [
        {
          name: "@wdio/cli",
          requirement: "^9.31.2",
          kind: "devDependencies",
          current: "9.31.2",
          wanted: "9.31.2",
          latest: "10.0.0",
          label: "outside range",
        },
      ],
      errors: [{ source: "cargo", name: "getrandom", message: "HTTP 503" }],
    },
    { manifestPath: "src-tauri/Cargo.toml" },
  );
  assert.match(text, /sha2/u);
  assert.match(text, /0\.10\.9/u);
  assert.match(text, /0\.11\.0/u);
  assert.match(text, /real-crate \(as alias_name\)/u);
  assert.match(text, /@wdio\/cli/u);
  assert.match(text, /10\.0\.0/u);
  assert.match(text, /getrandom: HTTP 503/u);
});

test("cargo report labels ignore dependencies with no known latest version", () => {
  assert.equal(cargoReportLabel(dep("x", "^1", "1.0.0"), undefined), null);
  assert.equal(
    cargoReportLabel(dep("x", "=1.0.0", "1.0.0"), "1.0.1"),
    "pinned",
  );
});
