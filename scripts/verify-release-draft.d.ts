export function requiredDraftInstallerNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftSidecarNames(installers: string[]): string[];
export function requiredDraftStableManifestNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftBetaManifestNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftChecksumNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function requiredDraftAssetNames(options?: {
  requireLinuxAarch64?: boolean;
}): string[];
export function assertDraftReleaseShape(options: {
  release: {
    draft?: boolean;
    prerelease?: boolean;
    target_commitish?: string;
  };
  assetNames: string[];
  version: string;
  headCommit?: string;
  requireLinuxAarch64?: boolean;
}): { tag: string; missing: string[] };
export interface GitHubReleaseRef {
  id?: number;
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  target_commitish?: string;
}
export function selectDraftRelease(
  releases: GitHubReleaseRef[],
  tag: string,
): GitHubReleaseRef | null;
export function assertManifestAssetReferences(
  manifest: {
    platforms?: Record<
      string,
      { url?: string; signature?: string } | undefined
    >;
  },
  manifestName: string,
  assetNames: string[],
  options?: { repoOwner?: string; repoName?: string; tag?: string },
): void;
