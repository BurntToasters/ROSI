export function expectedReleaseBranch(version: string): "beta" | "main";

export type PreflightLog = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export function assertHostedCiPassed(options: {
  sha: string;
  owner: string;
  repo: string;
  api: (method: string, endpoint: string) => unknown;
  env?: NodeJS.ProcessEnv;
  log?: PreflightLog;
}): { verified: boolean; overridden: boolean };

export function runPreflight(options?: {
  git?: (args: string[]) => string;
  github?: {
    githubApi: (method: string, endpoint: string, body?: unknown) => unknown;
    assertGitHubCliAuthenticated: () => void;
  };
  identity?: () => { commit: string };
  env?: NodeJS.ProcessEnv;
  log?: PreflightLog;
  platform?: NodeJS.Platform;
  version?: string;
  assertZstd?: () => void;
}): void;
