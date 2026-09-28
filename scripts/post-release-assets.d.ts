export const REPOSITORY_ROOT: string;
export const RELEASE_DIR: string;
export const BUILD_ONLY_DIRECTORIES: string[];
export const BUILD_ONLY_FILES: string[];
export const CLI_FLAG: string;

export function cleanReleaseArtifacts(releaseDir?: string): void;
export function getAfterPackLocation(
  env?: Record<string, string | undefined>,
): string;
export function isBetaReleaseVersion(
  version: string | undefined | null,
): boolean;
export function readPackageVersion(repositoryRoot?: string): string;
export function shouldSkipBetaMirror(
  env: Record<string, string | undefined> | undefined,
  version: string | undefined | null,
): boolean;
export function pathsEqual(
  left: string,
  right: string,
  platform?: NodeJS.Platform,
): boolean;
export function pathIsSameOrInside(
  candidate: string,
  parent: string,
  platform?: NodeJS.Platform,
): boolean;
export function isDirectExecution(
  argv?: string[],
  platform?: NodeJS.Platform,
): boolean;
export function getReleaseEntries(releaseDir: string): string[];
export function isMirrorableReleaseEntry(name: string): boolean;
export function verifyCopiedPath(
  sourcePath: string,
  destinationPath: string,
): void;
export function copyReleaseEntryToMirror(
  sourcePath: string,
  destinationPath: string,
): void;
export function resolveMirrorPaths(
  releaseDir: string | undefined,
  destination: string,
): { resolvedReleaseDir: string; resolvedDestination: string };
export function copyReleaseAssets(
  releaseDir: string | undefined,
  destination: string,
  options?: { logger?: Pick<Console, "log" | "warn" | "error"> },
): number;

export type FinalizeResult = {
  mirrored: boolean;
  destination: string;
  copiedEntries: number;
  skippedBetaMirror: boolean;
};

export function run(options?: {
  releaseDir?: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "log" | "warn" | "error">;
  version?: string;
}): FinalizeResult;

export function finalizeReleaseAssets(options?: {
  releaseDir?: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "log" | "warn" | "error">;
  version?: string;
}): FinalizeResult;
