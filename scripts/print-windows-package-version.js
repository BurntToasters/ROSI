import { windowsPackageVersionFromSemver } from "./sync-version-helpers.js";

const version = process.argv[2]?.trim();
if (!version) {
  console.error(
    "Usage: node scripts/print-windows-package-version.js <semver>",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(windowsPackageVersionFromSemver(version));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
