#!/usr/bin/env node

import { init } from "license-checker-rseidelsohn";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const outputPath = join(repoRoot, "public", "licenses.json");

const modules = await new Promise((resolve, reject) => {
  init(
    {
      start: repoRoot,
      production: true,
      customFormat: {
        licenses: true,
        repository: true,
        licenseText: true,
      },
    },
    (error, result) => (error ? reject(error) : resolve(result)),
  );
});

const licenses = {};
for (const key of Object.keys(modules).sort()) {
  const entry = modules[key];
  licenses[key] = {
    licenses: Array.isArray(entry.licenses)
      ? entry.licenses.join(" OR ")
      : entry.licenses || "UNKNOWN",
    repository: entry.repository || null,
    licenseText: entry.licenseText || null,
    packageManager: "npm",
  };
}

const incomplete = Object.entries(licenses).filter(
  ([, entry]) => entry.licenses === "UNKNOWN" || !entry.licenseText,
);
if (incomplete.length > 0) {
  throw new Error(
    `Missing license metadata for: ${incomplete
      .slice(0, 10)
      .map(([name]) => name)
      .join(", ")}${incomplete.length > 10 ? "…" : ""}`,
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
console.log(
  `[licenses:npm] Wrote ${Object.keys(licenses).length} entries with license texts to ${outputPath}`,
);
