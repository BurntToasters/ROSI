const fs = require('fs');
const path = require('path');

const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');

if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary file not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

const thresholds = {
  'src/main/main.ts': { lines: 12, statements: 12 },
  'src/main/preload.ts': { lines: 80, statements: 80 },
};

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
  if (metrics.lines.pct < threshold.lines) {
    failures.push(`${file}: lines ${metrics.lines.pct}% < ${threshold.lines}%`);
  }
  if (metrics.statements.pct < threshold.statements) {
    failures.push(`${file}: statements ${metrics.statements.pct}% < ${threshold.statements}%`);
  }
}

if (failures.length > 0) {
  console.error('Coverage thresholds failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Coverage thresholds passed for main.ts and preload.ts.');
