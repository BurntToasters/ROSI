export function normalizeUpdaterSignature(sigPath: string): string;

export function verifyUpdaterSignatures(options: {
  root: string;
  releaseDir: string;
  byName: Map<string, string>;
  signatureByBaseName: Map<string, string>;
  resolveUpdaterTargets(name: string): unknown[];
}): void;
