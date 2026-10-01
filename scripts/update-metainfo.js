import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
const pkgPath = path.join(repoRoot, "package.json");
const xmlPath = path.join(repoRoot, "run.rosie.rosi.metainfo.xml");

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasExactReleaseVersion(xml, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<release\\b[^>]*\\bversion\\s*=\\s*(["'])${escapedVersion}\\1`,
  ).test(xml);
}

function isStableReleaseVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version || "").trim());
}

/**
 * AppStream treats `X.Y.Z-beta.N` as newer than `X.Y.Z`, so listing both with
 * stable first trips `releases-not-in-order`. Drop superseded prereleases of
 * the same base version when shipping the stable.
 */
function stripSupersededPrereleases(releasesSection, stableVersion) {
  if (!isStableReleaseVersion(stableVersion)) return releasesSection;
  const escaped = stableVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return releasesSection.replace(
    new RegExp(
      `\\s*<release\\b[^>]*\\bversion\\s*=\\s*["']${escaped}-(?:alpha|beta|rc)\\.[^"']+["'][^>]*(?:/>|>[\\s\\S]*?</release>)`,
      "gi",
    ),
    "",
  );
}

function run({
  now = new Date(),
  packagePath = pkgPath,
  metadataPath = xmlPath,
  check = false,
} = {}) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found at ${packagePath}`);
  }

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`AppStream metadata not found at ${metadataPath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse package.json: ${
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : String(error)
      }`,
    );
  }

  const version = pkg.version;
  if (!version) {
    throw new Error("package.json has no version field");
  }

  const dateStr = formatDate(now);
  const xml = fs.readFileSync(metadataPath, "utf8");

  const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
  if (!releasesLineMatch) {
    throw new Error("Could not find <releases> block in AppStream metadata");
  }

  const baseIndent = releasesLineMatch[1] || "";
  const releaseIndent = `${baseIndent}  `;
  const newReleaseTag = `${releaseIndent}<release version="${version}" date="${dateStr}"/>`;

  const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
  const releasesSectionMatch = xml.match(releasesSectionRegex);
  if (!releasesSectionMatch) {
    throw new Error("Could not locate releases section");
  }

  const existingReleaseRegex = new RegExp(
    `<release\\b(?=[^>]*\\bversion="${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")[^>]*(?:/>|>[\\s\\S]*?</release>)`,
  );
  const existingReleaseMatch =
    releasesSectionMatch[0].match(existingReleaseRegex);

  let updatedSection = releasesSectionMatch[0];
  if (existingReleaseMatch) {
    // A release date is historical metadata, not the build date. Once a
    // version exists, preserve its date so repeated release preparation stays
    // deterministic and does not dirty a clean source export.
    const currentDateMatch = existingReleaseMatch[0].match(/date="([^"]+)"/);
    if (currentDateMatch) {
      const pruned = stripSupersededPrereleases(updatedSection, version);
      if (pruned === updatedSection) {
        return { updated: false, version, date: currentDateMatch[1] };
      }
      if (check) {
        throw new Error(
          `AppStream still lists superseded prereleases of ${version}; remove them before release preparation`,
        );
      }
      updatedSection = pruned;
      const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
      fs.writeFileSync(metadataPath, updatedXml, "utf8");
      return { updated: true, version, date: currentDateMatch[1] };
    }
    if (check) {
      throw new Error(
        `AppStream release ${version} must have a committed release date`,
      );
    }

    const updatedRelease = existingReleaseMatch[0].replace(
      /<release\b/,
      `<release date="${dateStr}"`,
    );
    updatedSection = updatedSection.replace(
      existingReleaseMatch[0],
      updatedRelease,
    );
  } else {
    if (check) {
      throw new Error(
        `AppStream release ${version} is missing; add and commit it before release preparation`,
      );
    }
    // AppStream keeps release history newest-first. Never replace the previous
    // entry: software centers use it to show users what changed between versions.
    updatedSection = updatedSection.replace(
      /<releases>\s*/,
      `<releases>\n${newReleaseTag}\n${releaseIndent}`,
    );
  }

  updatedSection = stripSupersededPrereleases(updatedSection, version);

  if (updatedSection === releasesSectionMatch[0]) {
    return { updated: false, version, date: dateStr };
  }

  const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
  fs.writeFileSync(metadataPath, updatedXml, "utf8");
  return { updated: true, version, date: dateStr };
}

function isDirectExecution(
  moduleUrl = import.meta.url,
  executablePath = process.argv[1],
) {
  return Boolean(
    executablePath &&
    pathToFileURL(path.resolve(executablePath)).href === moduleUrl,
  );
}

if (isDirectExecution()) {
  try {
    const result = run({ check: process.argv.slice(2).includes("--check") });
    if (result.updated) {
      console.log(
        `Updated AppStream release to ${result.version} (${result.date})`,
      );
    } else {
      console.log("AppStream metadata already up to date");
    }
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    console.error(`Failed to update AppStream metadata: ${message}`);
    process.exit(1);
  }
}

export {
  formatDate,
  hasExactReleaseVersion,
  isDirectExecution,
  isStableReleaseVersion,
  run,
  stripSupersededPrereleases,
};
