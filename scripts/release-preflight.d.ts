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

/** Reads ROSI_STABLE_SOAK_WAIVER: null when unset or blank, else the trimmed reason. Throws when invalid. */
export function readSoakWaiver(
  env?: Record<string, string | undefined>,
): string | null;

export interface SoakWaiverWarningInput {
  tag: string;
  ageDays: number;
  reason: string;
}

export function formatSoakWaiverWarning(input: SoakWaiverWarningInput): string;

export function assertStableBetaSoak(options: {
  version: string;
  listBetaTags?: (version: string) => BetaTagRecord[];
  now?: Date;
  env?: Record<string, string | undefined>;
}): SoakResult;

export type SoakResult =
  | { tag: string; ageDays: number; waived: false }
  | { tag: string; ageDays: number; waived: true; reason: string };
