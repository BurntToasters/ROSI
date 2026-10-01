interface UpdateMetainfoOptions {
  now?: Date;
  packagePath?: string;
  metadataPath?: string;
  check?: boolean;
}

interface UpdateMetainfoResult {
  updated: boolean;
  version: string;
  date: string;
}

export function formatDate(date: Date): string;
export function hasExactReleaseVersion(xml: string, version: string): boolean;
export function isDirectExecution(
  moduleUrl?: string,
  executablePath?: string,
): boolean;
export function run(options?: UpdateMetainfoOptions): UpdateMetainfoResult;
