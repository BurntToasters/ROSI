#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { npmInvocation } = require("./npm-cli.cjs");
const { spawnSync } = require("node:child_process");

const REVIEW_EXPIRES = "2026-12-01";
const REVIEWED_ADVISORIES = new Map([
  ["GHSA-GGR8-5VV4-36MX", "deepmerge-ts"],
  ["GHSA-JMR9-QJV8-65GV", "extract-zip"],
  ["GHSA-7PQW-9J4J-H8Q3", "extract-zip"],
  ["GHSA-5C6J-R48X-RMVQ", "serialize-javascript"],
  ["GHSA-QJ8W-GFJ5-8C6V", "serialize-javascript"],
]);

function advisoryId(via) {
  if (!via || typeof via !== "object") return null;
  const text = `${via.url || ""} ${via.title || ""}`;
  return (
    text
      .match(
        /GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i,
      )?.[0]
      ?.toUpperCase() || null
  );
}

function collectAdvisories(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vulnerability = vulnerabilities?.[name];
  if (!vulnerability) return [];
  const result = [];
  for (const via of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
    if (typeof via === "string") {
      result.push(...collectAdvisories(via, vulnerabilities, seen));
      continue;
    }
    result.push({ packageName: name, advisory: via, id: advisoryId(via) });
  }
  return result;
}

function isDevOnlyNode(node, lock) {
  const entry = lock?.packages?.[node];
  return Boolean(entry && entry.dev === true);
}

function nodesAreProvenDevOnly(nodes, lock) {
  return nodes.length > 0 && nodes.every((node) => isDevOnlyNode(node, lock));
}

function evaluateAudit(report, lock, now = new Date()) {
  const vulnerabilities = report?.vulnerabilities || {};
  const errors = [];
  const reviewed = new Map();
  const unreviewed = new Map();
  const reviewExpired =
    now.getTime() >= Date.parse(`${REVIEW_EXPIRES}T00:00:00Z`);

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const nodes = Array.isArray(vulnerability?.nodes)
      ? vulnerability.nodes
      : [];
    if (nodes.length === 0) {
      errors.push(`${name}: npm audit did not report affected install nodes`);
    }
    for (const node of nodes) {
      if (!isDevOnlyNode(node, lock)) {
        errors.push(`${name}: affected node ${node} is not proven dev-only`);
      }
    }
    const provenDevOnly = nodesAreProvenDevOnly(nodes, lock);

    const advisories = collectAdvisories(name, vulnerabilities);
    if (advisories.length === 0) {
      if (!provenDevOnly) {
        errors.push(`${name}: vulnerability chain has no resolvable advisory`);
      }
      continue;
    }
    for (const item of advisories) {
      if (!item.id) {
        if (!provenDevOnly) {
          errors.push(`${name}: advisory is missing a GHSA identifier`);
        }
        continue;
      }
      const expectedPackage = REVIEWED_ADVISORIES.get(item.id);
      const actualPackage = String(
        item.advisory?.name || item.packageName || "",
      );
      if (!expectedPackage) {
        unreviewed.set(item.id, actualPackage || name);
        continue;
      }
      if (actualPackage !== expectedPackage) {
        unreviewed.set(item.id, actualPackage || "unknown package");
        continue;
      }
      reviewed.set(item.id, expectedPackage);
    }
  }

  return {
    errors,
    reviewed: [...reviewed.entries()],
    unreviewed: [...unreviewed.entries()],
    reviewExpired,
  };
}

function runAudit(root) {
  const npm = npmInvocation();
  const result = spawnSync(
    npm.command,
    [...npm.prefixArgs, "audit", "--json", "--audit-level=moderate"],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `npm audit did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status !== 0 && !report.vulnerabilities) {
    throw new Error(
      `npm audit failed before producing a vulnerability report: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return report;
}

function resolveAuditRoot(
  args = process.argv.slice(2),
  defaultRoot = path.join(__dirname, ".."),
) {
  if (args.length === 0) return defaultRoot;
  if (args.length === 2 && args[0] === "--root" && args[1]) {
    return path.resolve(args[1]);
  }
  throw new Error("Usage: npm-dev-audit.cjs [--root <workspace>]");
}

function main() {
  const root = resolveAuditRoot();
  const report = runAudit(root);
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const { errors, reviewed, unreviewed, reviewExpired } = evaluateAudit(
    report,
    lock,
  );
  if (errors.length > 0) {
    for (const error of errors)
      console.error(`[npm-dev-audit] FAILED: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (reviewed.length === 0 && unreviewed.length === 0) {
    console.log("[npm-dev-audit] No moderate-or-higher npm advisories found.");
    return;
  }
  const details = [
    reviewed.length > 0
      ? `reviewed ${reviewed.map(([id]) => id).join(", ")}`
      : null,
    unreviewed.length > 0
      ? `unreviewed ${unreviewed.map(([id]) => id).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  console.warn(
    `[npm-dev-audit] Proven dev-only advisories (${details}); these do not ship to users.`,
  );
  if (reviewExpired && reviewed.length > 0) {
    console.warn(
      `[npm-dev-audit] Review date ${REVIEW_EXPIRES} has passed; re-evaluate the WDIO/Mocha dependency graph when a compatible patched chain is available.`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `[npm-dev-audit] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  REVIEW_EXPIRES,
  REVIEWED_ADVISORIES,
  advisoryId,
  collectAdvisories,
  evaluateAudit,
  isDevOnlyNode,
  resolveAuditRoot,
};
