export function updateCargoLockPackageVersion(
  lockfile: string,
  packageName: string,
  version: string,
): string;

export function windowsPackageVersionFromSemver(version: string): string;

export function macBundleVersionFromSemver(version: string): string;

export function macMarketingVersionFromSemver(version: string): string;

export function updatePlistStringValue(
  plist: string,
  key: string,
  value: string,
): string;

export function syncChangelogForVersion(
  changelog: string,
  version: string,
): string;

export function syncNpmLockfileVersion(
  lockText: string,
  version: string,
): string;
