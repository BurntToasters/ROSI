import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../../..");
const queuePath = path.join(repoRoot, "src-tauri/src/queue.rs");
const artifactDirectory = path.join(
  repoRoot,
  "e2e/artifacts/v5-fixes-persistence/queue-publication",
);
const scratchDirectory = path.join(artifactDirectory, "_scratch");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Could not extract source between ${start} and ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

function waitForSourceFunctions(source) {
  const snapshot = between(source, "fn revisioned_snapshot(", "fn state()");
  const broadcast = between(
    source,
    "fn broadcast()",
    "fn resolve_output_path(",
  );
  const lockIndex = broadcast.search(/QUEUE_PUBLICATION\s*\.lock\(\)/);
  const snapshotIndex = broadcast.indexOf("revisioned_snapshot(true)");
  const lockBeforeSnapshot =
    lockIndex >= 0 && snapshotIndex >= 0 && lockIndex < snapshotIndex;
  return { snapshot, broadcast, lockBeforeSnapshot };
}

const harnessTemplate = String.raw`
use std::sync::{Condvar, LockResult, Mutex, MutexGuard};
use std::time::{Duration, Instant};

type QueueItem = u64;
struct QueueState { revision: u64, items: Vec<QueueItem> }
static QUEUE: Mutex<QueueState> = Mutex::new(QueueState { revision: 0, items: Vec::new() });

struct Progress {
    first_entered: bool,
    release_first: bool,
    publication_lock_attempts: usize,
    events: Vec<Vec<u64>>,
    persistence_schedules: usize,
}
static PROGRESS: (Mutex<Progress>, Condvar) = (
    Mutex::new(Progress {
        first_entered: false,
        release_first: false,
        publication_lock_attempts: 0,
        events: Vec::new(),
        persistence_schedules: 0,
    }),
    Condvar::new(),
);

struct ObservedMutex { inner: Mutex<()> }
impl ObservedMutex {
    const fn new() -> Self { Self { inner: Mutex::new(()) } }
    fn lock(&self) -> LockResult<MutexGuard<'_, ()>> {
        {
            let mut progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
            progress.publication_lock_attempts += 1;
            PROGRESS.1.notify_all();
        }
        self.inner.lock()
    }
}
static QUEUE_PUBLICATION: ObservedMutex = ObservedMutex::new();

fn state() -> MutexGuard<'static, QueueState> { QUEUE.lock().unwrap_or_else(|p| p.into_inner()) }
fn schedule_persist() {
    let mut progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
    progress.persistence_schedules += 1;
    PROGRESS.1.notify_all();
}
mod app_state {
    pub fn emit(_event: &str, payload: Vec<u64>) {
        let mut progress = super::PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
        if payload == vec![1] {
            progress.first_entered = true;
            super::PROGRESS.1.notify_all();
            while !progress.release_first {
                progress = super::PROGRESS.1.wait(progress).unwrap_or_else(|p| p.into_inner());
            }
        }
        progress.events.push(payload);
        super::PROGRESS.1.notify_all();
    }
}

__SNAPSHOT__
__BROADCAST__

fn wait_for(mut ready: impl FnMut(&Progress) -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        if ready(&progress) { return true; }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return false; };
        let (next, result) = PROGRESS.1.wait_timeout(progress, remaining).unwrap_or_else(|p| p.into_inner());
        progress = next;
        if result.timed_out() && !ready(&progress) { return false; }
    }
}

fn main() {
    state().items = vec![1];
    let older = std::thread::spawn(broadcast);
    if !wait_for(|progress| progress.first_entered, Duration::from_secs(2)) {
        let mut progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
        progress.release_first = true;
        PROGRESS.1.notify_all();
        drop(progress);
        let _ = older.join();
        eprintln!("Timed out waiting for the first queue event.");
        std::process::exit(2);
    }

    state().items = vec![2];
    let newer = std::thread::spawn(broadcast);
    let second_progress = wait_for(
        |progress| progress.publication_lock_attempts >= 2 || progress.events.iter().any(|event| event == &vec![2]),
        Duration::from_secs(2),
    );
    {
        let mut progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
        progress.release_first = true;
        PROGRESS.1.notify_all();
    }
    older.join().unwrap();
    newer.join().unwrap();

    let events = {
        let progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
        progress.events.clone()
    };
    let persistence_schedules = {
        let progress = PROGRESS.0.lock().unwrap_or_else(|p| p.into_inner());
        progress.persistence_schedules
    };
    let queue = state();
    let authoritative_state = queue.items.clone();
    let revision = queue.revision;
    let passed = second_progress
        && events == vec![vec![1], vec![2]]
        && authoritative_state == vec![2]
        && revision == 2
        && persistence_schedules == 2;
    println!("events={events:?}");
    println!("authoritative_state={authoritative_state:?}");
    println!("revision={revision}");
    println!("persistence_schedules={persistence_schedules}");
    println!("second_producer_progress={second_progress}");
    if !passed { std::process::exit(1); }
}
`;

if (
  !path
    .resolve(artifactDirectory)
    .startsWith(path.join(repoRoot, "e2e/artifacts"))
) {
  throw new Error("Queue publication artifacts must stay under e2e/artifacts.");
}
fs.mkdirSync(artifactDirectory, { recursive: true });
if (fs.existsSync(scratchDirectory)) {
  fs.rmSync(scratchDirectory, { recursive: true, force: true });
}
fs.mkdirSync(scratchDirectory, { recursive: true });

let report;
try {
  const queueSource = fs.readFileSync(queuePath, "utf8");
  const { snapshot, broadcast, lockBeforeSnapshot } =
    waitForSourceFunctions(queueSource);
  const harnessSource = harnessTemplate
    .replace("__SNAPSHOT__", snapshot)
    .replace("__BROADCAST__", broadcast);
  const rustPath = path.join(scratchDirectory, "queue-publication.rs");
  const executablePath = path.join(scratchDirectory, "queue-publication.exe");
  fs.writeFileSync(rustPath, harnessSource);
  const compile = spawnSync(
    "rustc",
    ["--edition=2021", rustPath, "-o", executablePath],
    {
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (compile.status !== 0) {
    throw new Error(
      `Rust harness compilation failed: ${compile.stderr || compile.error?.message}`,
    );
  }
  const run = spawnSync(executablePath, [], {
    encoding: "utf8",
    timeout: 10000,
  });
  report = {
    method:
      "Exact revisioned_snapshot and broadcast source with a bounded Rust concurrency harness and stub transport; no native app launch.",
    sourceSha256: hash(queueSource),
    harnessSha256: hash(harnessSource),
    lockBeforeSnapshot,
    exitCode: run.status,
    stdout: run.stdout.trim(),
    stderr: run.stderr.trim(),
    invariantPassed:
      lockBeforeSnapshot &&
      run.status === 0 &&
      run.stdout.includes("events=[[1], [2]]") &&
      run.stdout.includes("authoritative_state=[2]") &&
      run.stdout.includes("revision=2") &&
      run.stdout.includes("persistence_schedules=2") &&
      run.stdout.includes("second_producer_progress=true"),
  };
} finally {
  fs.rmSync(scratchDirectory, { recursive: true, force: true });
}

const reportText = `${JSON.stringify(report, null, 2)}\n`;
const reportPath = path.join(artifactDirectory, "report.json");
fs.writeFileSync(reportPath, reportText);
fs.writeFileSync(
  path.join(artifactDirectory, "report.sha256"),
  `${hash(reportText)}  report.json\n`,
);
console.log(
  `${JSON.stringify(report, null, 2)}\nArtifact: ${path.relative(repoRoot, reportPath)}`,
);
if (!report.invariantPassed) process.exitCode = 1;
