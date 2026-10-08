# Long-term ROSI V5 audit and repair probes

These probes run the real unpackaged Tauri application through WebDriver using generated profiles. The failure inventory predates implementation; repair acceptance extensions precede the relevant production edits. No unit tests are added.

Run the maintained complete gate on macOS with repository dependencies, the pinned Rust toolchain, and FFmpeg installed:

```sh
npm run test:all
```

The canonical E2E gate requires the `long-term-persistence` aggregate. To rerun only the persistence cases after an E2E build:

```sh
node --input-type=module -e "import { buildE2eBinary } from './scripts/test-e2e.js'; buildE2eBinary();"
node e2e/long-term-v5-audit-run.mjs
```

Do not run Cargo commands between building the E2E application and running the standalone probes: another Cargo command can replace the binary. Do not run another GUI suite concurrently. The standalone runner currently targets the available macOS environment; Windows/Linux execution and timeout cleanup require validation before claiming release acceptance there.

The runner covers normal settings, failed and successful statistics reset, unreadable settings, a future schema, damaged settings, a blocked migration journal, a temporarily blocked V4 queue import, old-marker compatibility, temporary legacy settings corruption during retry, repaired destination restart, oversized queue rejection with an existing item followed by restart, and 500 short URLs followed by restart. Generated URLs use `audit.invalid`; the queue probes never start downloads or contact that host. All mutations affect generated test profiles.

Each run creates a fresh directory beneath `e2e/artifacts/long-term-v5-repairs/` and prints its report path. Existing directories cannot be reused or overwritten. Each case retains before/after state, native logs and an observation. Source snapshots and `working-tree.patch` identify uncommitted changes. The report binds the Git base, binary hash, copied sources, retained files and acceptance outcomes. The original audit evidence remains in `e2e/artifacts/long-term-v5-audit-2026-10-07/`.

Exit zero requires all fifteen observations to pass. Exit one with `runnerExitCode: 0` and `invariantPassed: false` means a case completed but failed acceptance. Missing observations or nonzero native runner exits are execution failures. The initial repair trial's short-URL false result was a harness assertion error; see the repair report for final results.

Verify a selected run, substituting its actual directory:

```sh
ROSI_REPAIR_REPORT=e2e/artifacts/long-term-v5-repairs/<run>/report.json node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const file = process.env.ROSI_REPAIR_REPORT;
const root = path.dirname(file);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const { reportSha256, ...report } = JSON.parse(fs.readFileSync(file));
assert.equal(hash(JSON.stringify(report, null, 2)), reportSha256);
for (const entry of report.artifacts) {
  const bytes = fs.readFileSync(path.join(root, entry.path));
  assert.equal(bytes.length, entry.bytes, entry.path);
  assert.equal(hash(bytes), entry.sha256, entry.path);
}
for (const [source, expected] of Object.entries(report.sourceSha256))
  assert.equal(hash(fs.readFileSync(path.join(root, 'sources', source))), expected, source);
console.log(`Verified ${report.artifacts.length} files and report/source hashes.`);
JS
```

Hashes prove retained evidence integrity relative to the report; they are not a signature or a guarantee that reruns produce identical timestamps, UUIDs or media bytes. These probes do not prove signed installed updates, other operating systems, assistive technology, or prolonged reliability. See `docs/FIXES-V5-AUDIT-2026-10-07.md` for repair outcomes and remaining gates.
