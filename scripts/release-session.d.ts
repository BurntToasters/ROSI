export interface ReleaseIdentity {
  version: string;
  commit: string;
  platform: string;
  arch: string;
  node: string;
  rustc: string;
  packageLockSha256: string;
  cargoLockSha256: string;
}

export interface ReleaseSession extends ReleaseIdentity {
  qualityGateCompletedAt: number;
  startedAt: number;
}

export interface QualityGateProof extends ReleaseIdentity {
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
export function recordSuccessfulQualityGate(root?: string): {
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
