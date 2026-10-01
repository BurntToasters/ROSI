export type UpdaterChannelVariant = {
  targetSuffix: string;
  baseUrl: string;
};

export function assertReleaseTargetsCommit(
  release: { target_commitish?: string } | null | undefined,
  commit: string,
  env?: NodeJS.ProcessEnv,
  log?: { warn: (message: string) => void },
): { target_commitish?: string } | null | undefined;
export function artifactMatchesVersion(
  name: string,
  releaseVersion?: string,
): boolean;
export function rpmArtifactMatchesVersion(
  name: string,
  releaseVersion?: string,
): boolean;
export function checksumTargetKeysForArtifactName(
  name: string,
  channelVariants?: UpdaterChannelVariant[],
): string[];
export function buildUploadList(options: {
  artifacts: string[];
  checksumFiles: string[];
  signatureFiles: string[];
  stagingDirectory?: string;
}): string[];
export function isChecksumTextName(name: string): boolean;
export function isDirectExecution(): boolean;
export function isExplicitTruthy(value: unknown): boolean;
export function isGitHubConflict(error: unknown): boolean;
export function isTransactionalStagingAssetName(name: string): boolean;
export function listAllGithubPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[] | unknown>,
  options?: { perPage?: number },
): Promise<T[]>;
export function requiredLinuxTargetKeys(
  channelVariants: UpdaterChannelVariant[],
  byName: Map<string, string>,
): Set<string>;
export function resolveUpdaterTargets(
  name: string,
): Array<{ os: string; arch: string; installer: string }>;
export function requiredPublishedBetaManifestNames(): string[];
export function expectedPublishedBetaManifestNames(
  actualNames?: string[],
): string[];
export function validatePublishedBetaManifest(options: {
  name: string;
  contents: string;
  releaseAssetNames: Set<string>;
}): Array<{ name: string; url: string; signature: string }>;
export function updaterChannelVariants(
  isPrerelease: boolean,
  releaseBaseUrl?: string,
  tagBaseUrl?: string,
): UpdaterChannelVariant[];
