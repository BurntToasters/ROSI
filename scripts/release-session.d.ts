export interface ReleaseIdentity {
  version: string;
  commit: string;
  sourceTree: string;
  platform: string;
  arch: string;
  node: string;
  rustc: string;
  packageLockSha256: string;
  cargoLockSha256: string;
}

export interface ReleaseSession extends ReleaseIdentity {
  qualityGateCompletedAt: number;
  qualityGateScope: "full" | "build-vm-partial";
  qualityGateArtifactSha256: string;
  startedAt: number;
}

export interface QualityGateProof extends ReleaseIdentity {
  scope: "full" | "build-vm-partial";
  e2e:
    | {
        status: "passed";
        platform: string;
        arch: string;
        reportPath: string;
        binaryPath: string;
        reportSha256: string;
        binarySha256: string;
        finishedAt: number;
      }
    | { status: "skipped" };
  gateStartedAt: number;
  completedAt: number;
}

export const DEFAULT_MAX_AGE_MS: number;
export const QUALITY_GATE_RELATIVE_PATH: string;
export const RELEASE_SESSION_RELATIVE_PATH: string;

export function currentReleaseIdentity(root?: string): ReleaseIdentity;
export function porcelainPaths(statusText: string): string[];
export function isIgnorableReleaseDirtyPath(filePath: string): boolean;
export function createReleaseSession(root?: string): ReleaseSession;
export function clearQualityGateProof(root?: string): void;
export function recordSuccessfulQualityGate(
  root?: string,
  options?: { skipE2e?: boolean; gateStartedAt?: number },
): {
  recorded: boolean;
  dirtyFiles: string | null;
};
export function validateQualityGate(
  proof: QualityGateProof,
  expected: ReleaseIdentity,
  options?: { now?: number; maxAgeMs?: number },
): QualityGateProof;
export function verifyQualityGate(
  root?: string,
  options?: { now?: number; maxAgeMs?: number },
): QualityGateProof;
export function validateReleaseSession(
  session: ReleaseSession,
  expected: ReleaseIdentity,
  options?: { now?: number; maxAgeMs?: number },
): ReleaseSession;
export function verifyReleaseSession(
  root?: string,
  options?: { now?: number; maxAgeMs?: number },
): ReleaseSession;
