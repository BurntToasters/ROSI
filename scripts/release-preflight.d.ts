export function expectedReleaseBranch(version: string): "beta" | "main";

export interface BetaTagRecord {
  name: string;
  date: Date | null;
}

export function tagDateFromRecord(record: {
  objectType: string;
  taggerUnix?: string | null;
  commitUnix?: string | null;
}): Date | null;

export function newestBetaTag(
  stableVersion: string,
  tags: BetaTagRecord[],
): { name: string; beta: number; date: Date | null } | null;

export function readLocalBetaTags(
  version: string,
  runGit?: (args: string[]) => string,
): BetaTagRecord[];

export function assertStableBetaSoak(options: {
  version: string;
  listBetaTags?: (version: string) => BetaTagRecord[];
  now?: Date;
}): { tag: string; ageDays: number };
