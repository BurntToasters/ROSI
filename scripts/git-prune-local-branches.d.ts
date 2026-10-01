export interface GitPruneOptions {
  remote: string;
  dryRun: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): GitPruneOptions;
export function stripRemotePrefix(ref: string, remote: string): string | null;
export function selectBranchesToDelete(
  localBranches: string[],
  remoteBranches: string[],
  currentBranch: string,
): string[];
export function deleteBranches(
  branches: string[],
  options?: { force?: boolean; dryRun?: boolean },
): {
  deleted: string[];
  skipped: Array<{ branch: string; reason: string }>;
};
export function main(argv?: string[]): number;
export function isDirectExecution(
  moduleUrl?: string,
  executablePath?: string,
): boolean;
