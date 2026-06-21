const fs = require('fs');
const path = require('path');

const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');

if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary file not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

// Per-file floors for the security-critical / non-trivial main-process and
// shared modules. Each is set a few points below the currently-measured
// coverage so the gate catches regressions without being flaky. All four
// metrics (lines/statements/branches/functions) are enforced.
//
// NOTE: renderer modules (rosiEngine.ts, modules/*.ts) are intentionally absent.
// They are exercised via on-the-fly transpile+eval in the test suite, which v8
// coverage cannot attribute to the source files, so they report 0% here. Add
// floors for them only once the renderer tests import the compiled artifact.
const thresholds = {
  'src/main/main.ts': { lines: 80, statements: 80, branches: 70, functions: 80 },
  'src/main/downloader.ts': { lines: 88, statements: 88, branches: 72, functions: 88 },
  'src/main/platform.ts': { lines: 68, statements: 68, branches: 58, functions: 58 },
  'src/main/settings.ts': { lines: 88, statements: 88, branches: 82, functions: 90 },
  'src/main/updater.ts': { lines: 92, statements: 92, branches: 85, functions: 92 },
  'src/main/download/commandBuilders.ts': {
    lines: 88,
    statements: 88,
    branches: 86,
    functions: 90,
  },
  'src/main/download/videoInfo.ts': { lines: 70, statements: 70, branches: 60, functions: 70 },
  'src/main/preload.ts': { lines: 90, statements: 90, branches: 90, functions: 90 },
  'src/main/processKill.ts': { lines: 90, statements: 90, branches: 85, functions: 55 },
  'src/utils/ipcValidation.ts': { lines: 85, statements: 85, branches: 85, functions: 88 },
  'src/utils/validation.ts': { lines: 85, statements: 82, branches: 72, functions: 90 },
  'src/utils/downloadLifecycle.ts': { lines: 95, statements: 95, branches: 95, functions: 95 },
};

const METRICS = ['lines', 'statements', 'branches', 'functions'];

function findCoverageEntry(suffix) {
  const normalizedSuffix = suffix.replace(/\\/g, '/');
  return Object.entries(summary).find(([key]) =>
    key.replace(/\\/g, '/').endsWith(normalizedSuffix)
  );
}

const failures = [];

for (const [file, threshold] of Object.entries(thresholds)) {
  const match = findCoverageEntry(file);
  if (!match) {
    failures.push(`${file}: missing from coverage summary`);
    continue;
  }

  const [, metrics] = match;
  for (const metric of METRICS) {
    if (typeof threshold[metric] !== 'number') continue;
    const actual =
      metrics[metric] && typeof metrics[metric].pct === 'number' ? metrics[metric].pct : 0;
    if (actual < threshold[metric]) {
      failures.push(`${file}: ${metric} ${actual}% < ${threshold[metric]}%`);
    }
  }
}

if (failures.length > 0) {
  console.error('Coverage thresholds failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Coverage thresholds passed.');
