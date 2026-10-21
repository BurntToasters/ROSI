export function shouldVerifyLiveArtifacts(options?: {
  shapeOnly?: boolean;
  requestedExpectedVersion?: string;
}): boolean;
export function collectManifestArtifactRefs(
  bodies: string[],
): Map<string, { url: string; signature: string }>;
export function resolveLiveUpdaterTargets(
  name: string,
): Array<{ os: string; arch: string }>;
