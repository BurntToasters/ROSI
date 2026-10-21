export interface CoauthorEmailLine {
  exempt: boolean;
  email: string;
}

export type StripCoauthorArgs =
  | { mode: "in-place"; file: string }
  | { mode: "check-range"; range: string }
  | { mode: "help" };

export function parseCoauthorEmailLine(line: string): CoauthorEmailLine | null;
export function isCoauthorEmailLine(line: string): boolean;
export function isForbiddenCoauthorEmail(email: string): boolean;
export function unbangCoauthorEmailLine(line: string): string;
export function rewriteCoauthorLine(line: string): string | null;
export function messageHasCoauthorEmail(message: string): boolean;
export function messageHasCoauthorPolicyViolation(message: string): boolean;
export function stripCoauthorTrailers(message: string): string;
export function stripCoauthorTrailersFile(filePath: string): {
  changed: boolean;
  original: string;
  next: string;
};
export function coauthorPolicyViolationsInRange(
  range: string,
  options?: {
    spawn?: (
      command: string,
      args: readonly string[],
      options: object,
    ) => {
      error?: Error;
      status: number | null;
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
    };
  },
): string[];
export function parseArgs(argv: string[]): StripCoauthorArgs;
export function isDirectExecution(
  moduleUrl?: string,
  executablePath?: string,
): boolean;
export function main(argv?: string[]): number;
