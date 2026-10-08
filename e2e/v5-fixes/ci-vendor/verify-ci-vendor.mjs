#!/usr/bin/env node
// Manual/CI verifier for the ci-vendor fixes. Not run by the E2E gate because
// its live checks depend on the network (GitHub, crates.io). Writes a JSON
// artifact under e2e/artifacts/v5-fixes-ci-vendor/<timestamp>/.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const vendorDir = path.join(root, "src-tauri/vendor/tauri-plugin-updater");
// Evidence lives under e2e/artifacts/ with a timestamped directory per run.
const artifactDir = path.join(
  root,
  "e2e",
  "artifacts",
  "v5-fixes-ci-vendor",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ci = yaml.load(read(".github/workflows/ci.yml"));
const jobs = ci.jobs;
const onTriggers = ci.on ?? ci[true];
const SHA_RE = /^[0-9a-f]{40}$/;

function stepRuns(job) {
  return (job.steps ?? []).map((step) => step.run ?? "");
}

check(
  "ci.yml parses and declares a weekly schedule plus workflow_dispatch",
  () => {
    assert(onTriggers.schedule?.length === 1, "missing schedule trigger");
    const cron = onTriggers.schedule[0].cron;
    assert(/^\S+ \S+ \* \* 1$/.test(cron), `schedule is not weekly: ${cron}`);
    assert("workflow_dispatch" in onTriggers, "missing workflow_dispatch");
    return `cron=${cron}`;
  },
);

check("push branches are exactly main and beta, in that order", () => {
  assert(
    JSON.stringify(onTriggers.push?.branches) ===
      JSON.stringify(["main", "beta"]),
    `push branches: ${JSON.stringify(onTriggers.push?.branches)}`,
  );
  assert(
    JSON.stringify(onTriggers.pull_request?.branches) ===
      JSON.stringify(["main", "beta"]),
    "pull_request branches changed",
  );
  const keys = Object.keys(onTriggers);
  assert(
    keys.indexOf("pull_request") < keys.indexOf("schedule") &&
      keys.indexOf("pull_request") < keys.indexOf("workflow_dispatch"),
    `trigger order: ${keys}`,
  );
  return keys.join(",");
});

check("ci.yml declares Windows gpg note above the fetch step", () => {
  const text = read(".github/workflows/ci.yml");
  assert(
    /Git for Windows/.test(text) && /usr\\bin/.test(text),
    "gpg note missing",
  );
});

check("ytdlp-watch.yml starts CI after opening the bump PR", () => {
  const watch = yaml.load(read(".github/workflows/ytdlp-watch.yml"));
  const job = watch.jobs.watch;
  assert(
    job.permissions?.actions === "write",
    "watch job lacks actions: write",
  );
  assert(
    watch.permissions &&
      JSON.stringify(watch.permissions) ===
        JSON.stringify({ contents: "read" }),
    "top-level widened",
  );
  // Both commands sit in the same step; the dispatch must follow PR creation.
  const script = stepRuns(job).join("\n");
  const pr = script.indexOf("gh pr create");
  const dispatch = script.indexOf("gh workflow run ci.yml");
  assert(
    pr !== -1 && dispatch !== -1 && dispatch > pr,
    "gh workflow run ci.yml missing or before PR creation",
  );
  assert(
    !/copy-bundled-licenses\.js reads|still hardcodes/.test(
      read(".github/workflows/ytdlp-watch.yml"),
    ),
    "stale checklist line",
  );
});

check(
  "fetch-ytdlp update path no longer tells maintainers to edit copy-bundled-licenses.js",
  () => {
    assert(
      !read("scripts/fetch-ytdlp.cjs").includes(
        "still hardcodes YT_DLP_VERSION",
      ),
      "stale follow-up",
    );
  },
);

check("top-level permissions are least-privilege", () => {
  assert(
    JSON.stringify(ci.permissions) === JSON.stringify({ contents: "read" }),
    "permissions widened",
  );
});

check("every uses: reference is pinned to a full commit SHA", () => {
  const refs = [];
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) refs.push(step.uses);
    }
  }
  const bad = refs.filter((ref) => !SHA_RE.test(ref.split("@")[1] ?? ""));
  assert(bad.length === 0, `unpinned: ${bad.join(", ")}`);
  return `${refs.length} references`;
});

check("heavy jobs skip on schedule", () => {
  for (const name of ["quality-gate", "rust-check", "smoke-build"]) {
    const condition = String(jobs[name].if ?? "");
    assert(condition.includes("schedule"), `${name} does not exclude schedule`);
  }
});

check("scheduled security jobs and live feed validation still run", () => {
  assert(
    !jobs["updater-manifest"].if,
    "updater-manifest must run on every event",
  );
  assert(!jobs["security-audit"].if, "security-audit must run on every event");
  const runs = stepRuns(jobs["updater-manifest"]).join("\n");
  assert(runs.includes("validate:updater:live"), "live feed step missing");
  const audit = stepRuns(jobs["security-audit"]).join("\n");
  for (const needle of [
    "npm audit --omit=dev",
    "audit:dev-reviewed",
    "check:rustsec-ignore-policy",
    "cargo audit",
  ]) {
    assert(audit.includes(needle), `security-audit lacks ${needle}`);
  }
  assert(
    audit.includes("scripts/check-vendored-updater.mjs"),
    "vendored updater check not in security-audit",
  );
});

check("ci-gate accepts skipped heavy jobs only on schedule", () => {
  const gate = jobs["ci-gate"].steps.find(
    (s) => s.name === "Require every release check",
  ).run;
  assert(
    /EVENT_NAME" = schedule|"\$EVENT_NAME" = schedule|= schedule/.test(gate),
    "no schedule branch",
  );
  assert(
    gate.includes('test "$QUALITY_GATE" = skipped'),
    "schedule branch does not require skipped quality-gate",
  );
});

check("yt-dlp binaries are fetched before every job that needs them", () => {
  const needs =
    /ytdlp:check|prepare:sidecars|prepare-sidecars|prepare:rust-tests|test:all|test:e2e|test:cov|tauri build/;
  const checked = [];
  for (const [name, job] of Object.entries(jobs)) {
    const steps = job.steps ?? [];
    const needing = steps.findIndex((s) => needs.test(s.run ?? ""));
    if (needing === -1) continue;
    const npmCi = steps.findIndex((s) => /^npm ci/.test(s.run ?? ""));
    const fetch = steps.findIndex(
      (s) => (s.run ?? "").trim() === "npm run ytdlp:fetch:all",
    );
    assert(
      npmCi !== -1 && fetch > npmCi && fetch < needing,
      `${name}: fetch step missing or out of order`,
    );
    checked.push(name);
  }
  assert(
    checked.length >= 3,
    `expected at least three jobs, got ${checked.join(",")}`,
  );
  return checked.join(",");
});

check("package.json defines ytdlp:fetch:all", () => {
  const pkg = JSON.parse(read("package.json"));
  assert(
    pkg.scripts?.["ytdlp:fetch:all"]?.startsWith(
      "node scripts/fetch-ytdlp.cjs --all",
    ),
    "script missing or changed",
  );
});

check("dependabot ignores tauri-plugin-updater for cargo", () => {
  const dep = yaml.load(read(".github/dependabot.yml"));
  const cargo = dep.updates.find((u) => u["package-ecosystem"] === "cargo");
  const ignored = (cargo.ignore ?? []).map((i) => i["dependency-name"]);
  assert(ignored.includes("tauri-plugin-updater"), "cargo ignore missing");
});

check("PATCHES.md records upstream version and checksum", () => {
  const patches = read("src-tauri/vendor/tauri-plugin-updater/PATCHES.md");
  assert(patches.includes("2.10.1"), "version missing");
  assert(
    patches.includes(
      "806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af",
    ),
    "checksum missing",
  );
});

check("PATCHES.md describes the advisory-db check, not cargo-audit", () => {
  const patches = read("src-tauri/vendor/tauri-plugin-updater/PATCHES.md");
  assert(patches.includes("rustsec/advisory-db"), "advisory-db not named");
  assert(
    patches.includes("crates/tauri-plugin-updater"),
    "advisory path not named",
  );
  assert(
    !/cargo-audit may not report/.test(patches),
    "stale cargo-audit gap still present",
  );
});

check(
  "ROSI.patch applies to pristine upstream 2.10.1 and reproduces the vendored tree",
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-updater-verify-"));
    const crate = path.join(tmp, "up.crate");
    execFileSync("curl", [
      "-sSfL",
      "-o",
      crate,
      "https://crates.io/api/v1/crates/tauri-plugin-updater/2.10.1/download",
    ]);
    const digest = createHash("sha256")
      .update(fs.readFileSync(crate))
      .digest("hex");
    assert(
      digest ===
        "806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af",
      `checksum ${digest}`,
    );
    const up = path.join(tmp, "up");
    fs.mkdirSync(up);
    execFileSync("tar", ["-xzf", crate, "-C", up, "--strip-components=1"]);
    const dry = spawnSync(
      "patch",
      ["-p1", "--dry-run", "-d", up, "-i", path.join(vendorDir, "ROSI.patch")],
      { encoding: "utf8" },
    );
    assert(dry.status === 0, `dry-run failed: ${dry.stdout}${dry.stderr}`);
    execFileSync("patch", [
      "-p1",
      "-s",
      "-d",
      up,
      "-i",
      path.join(vendorDir, "ROSI.patch"),
    ]);
    for (const file of fs.readdirSync(path.join(vendorDir, "src"))) {
      const a = fs.readFileSync(path.join(vendorDir, "src", file));
      const b = fs.readFileSync(path.join(up, "src", file));
      assert(a.equals(b), `src/${file} differs after applying ROSI.patch`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return "src/ identical after patch";
  },
);

check("ROSI.patch has no target/ or Cargo.lock hunks", () => {
  const patch = read("src-tauri/vendor/tauri-plugin-updater/ROSI.patch");
  assert(
    !/^\+\+\+ b\/(target\/|Cargo\.lock)/m.test(patch),
    "excluded path present",
  );
});

check("no em dashes in changed ci-vendor files", () => {
  const files = [
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    "scripts/check-vendored-updater.mjs",
    "src-tauri/vendor/tauri-plugin-updater/PATCHES.md",
    "e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs",
    ".github/workflows/ytdlp-watch.yml",
    "scripts/fetch-ytdlp.cjs",
  ];
  for (const file of files)
    assert(!read(file).includes("\u2014"), `em dash in ${file}`);
});

const advisoryDb = (name) => fixture(`advisory-db-${name}`);

check("check-vendored-updater: up to date and no advisory exits 0", () => {
  const out = runChecker([
    "--crates-json",
    fixture("crates-current.json"),
    "--advisory-db",
    advisoryDb("none"),
  ]);
  assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
});

check(
  "check-vendored-updater: behind without advisory warns and exits 0",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-newer.json"),
      "--advisory-db",
      advisoryDb("none"),
    ]);
    assert(out.status === 0, `exit ${out.status}`);
    assert(
      /::warning::.*is behind 2\.13\.2/.test(out.stdout + out.stderr),
      "no behind ::warning annotation",
    );
  },
);

check(
  "check-vendored-updater: advisory affecting vendored version exits 1 with ::error",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-newer.json"),
      "--advisory-db",
      advisoryDb("unpatched"),
    ]);
    assert(
      out.status === 1,
      `expected 1, got ${out.status}: ${out.stdout}${out.stderr}`,
    );
    assert(
      /::error::.*RUSTSEC-0000-0002/.test(out.stdout),
      "no ::error annotation naming the advisory",
    );
  },
);

check(
  "check-vendored-updater: advisory fixed in vendored version exits 0",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-newer.json"),
      "--advisory-db",
      advisoryDb("patched"),
    ]);
    assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
  },
);

check(
  "check-vendored-updater: advisory marking vendored version unaffected exits 0",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-newer.json"),
      "--advisory-db",
      advisoryDb("unaffected"),
    ]);
    assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
  },
);

check("check-vendored-updater: withdrawn advisory is ignored", () => {
  const out = runChecker([
    "--crates-json",
    fixture("crates-newer.json"),
    "--advisory-db",
    advisoryDb("withdrawn"),
  ]);
  assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
});

check(
  "check-vendored-updater: multi-line patched array is parsed to its close",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-newer.json"),
      "--advisory-db",
      advisoryDb("multiline"),
    ]);
    assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
  },
);

check("check-vendored-updater: advisory without front matter exits 2", () => {
  const out = runChecker([
    "--crates-json",
    fixture("crates-newer.json"),
    "--advisory-db",
    advisoryDb("malformed"),
  ]);
  assert(
    out.status === 2,
    `expected 2, got ${out.status}: ${out.stdout}${out.stderr}`,
  );
});

check("check-vendored-updater: missing --advisory-db directory exits 2", () => {
  const out = runChecker([
    "--crates-json",
    fixture("crates-current.json"),
    "--advisory-db",
    fixture("no-such-db"),
  ]);
  assert(out.status === 2, `expected 2, got ${out.status}`);
});

check(
  "check-vendored-updater: unreachable advisory database warns, exits 0, and stays visible",
  () => {
    const out = runChecker([
      "--crates-json",
      fixture("crates-current.json"),
      "--advisory-url",
      "file:///nonexistent-rustsec-adb",
    ]);
    assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
    const lines = out.stdout
      .split("\n")
      .filter((line) => line.startsWith("::warning::"));
    assert(
      lines.some((line) => /advisory database unavailable/.test(line)),
      "no advisory-db ::warning",
    );
    assert(
      lines.every((line) => !line.includes("\n")),
      "annotation not single-line",
    );
  },
);

check("check-vendored-updater: unreachable crates.io warns and exits 0", () => {
  const out = runChecker([
    "--crates-json",
    path.join(here, "fixtures/does-not-exist.json"),
    "--advisory-db",
    advisoryDb("none"),
  ]);
  assert(out.status === 0, `exit ${out.status}`);
  assert(
    /::warning::.*could not query crates\.io/.test(out.stdout),
    "no crates.io ::warning",
  );
});

check("check-vendored-updater: malformed crates.io response exits 2", () => {
  const out = runChecker([
    "--crates-json",
    fixture("crates-malformed.json"),
    "--advisory-db",
    advisoryDb("none"),
  ]);
  assert(out.status === 2, `expected 2, got ${out.status}`);
});

check(
  "check-vendored-updater: live RustSec database and crates.io, no advisory for vendored crate",
  () => {
    const out = runChecker([]);
    assert(out.status === 0, `exit ${out.status}: ${out.stdout}${out.stderr}`);
    return out.stdout
      .split("\n")
      .filter((line) => line.startsWith("vendored"))
      .join(" ");
  },
);

function fixture(name) {
  return path.join(here, "fixtures", name);
}

function runChecker(args) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-vendored-updater.mjs"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "" },
    },
  );
}

const failed = results.filter((r) => !r.ok);
const artifact = {
  generatedAt: new Date().toISOString(),
  script: "e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs",
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(
  path.join(artifactDir, "verify-ci-vendor.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail && !r.ok ? ` :: ${r.detail}` : ""}`,
  );
console.log(`\n${artifact.passed}/${results.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
