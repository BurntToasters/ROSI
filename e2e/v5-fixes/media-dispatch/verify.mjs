// Windows integration verifier for private FFmpeg/FFprobe alias dispatch.
// Failure cases were recorded first in failure-modes.md. It launches the
// built ROSI image as real aliases, including through the bundled yt-dlp, and
// writes a repeatable SHA-256 report under e2e/artifacts/.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const VERIFIER = fileURLToPath(import.meta.url);
const DISPATCH_SOURCE = path.join(ROOT, "src-tauri", "src", "ffmpeg_guard.rs");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";
const ROSI = path.join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  `rosi${EXE_SUFFIX}`,
);
const YTDLP = path.join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  `rosi-yt-dlp${EXE_SUFFIX}`,
);
const FFMPEG = path.join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  `rosi-ffmpeg${EXE_SUFFIX}`,
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(
  ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-media-dispatch",
  stamp,
);
const report = {
  generatedAt: new Date().toISOString(),
  repository: ROOT,
  platform: process.platform,
  launchMode:
    "The verifier launches the helper-mode image through private FFmpeg/FFprobe aliases; no GUI is expected. Passing checks require configured tool-helper invocation or an explicit config refusal. GUI window state is not independently instrumented.",
  checks: [],
};
let scratch;
let server;
let isolatedEnv;
const cleanupIssues = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(id, description, action) {
  try {
    const detail = action();
    report.checks.push({ id, description, status: "pass", detail });
  } catch (error) {
    report.checks.push({
      id,
      description,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkAsync(id, description, action) {
  try {
    const detail = await action();
    report.checks.push({ id, description, status: "pass", detail });
  } catch (error) {
    report.checks.push({
      id,
      description,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: options.timeout ?? 15_000,
    windowsHide: true,
    env: { ...(isolatedEnv ?? process.env), ...(options.env ?? {}) },
    ...(options.argv0 ? { argv0: options.argv0 } : {}),
  });
  if (result.error?.code === "ETIMEDOUT") {
    killProcessTree(result.pid);
  }
  if (result.error) throw result.error;
  return result;
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function expectSuccess(result, label) {
  assert(
    result.status === 0,
    `${label} exited ${result.status}: ${(result.stderr ?? "").trim()}`,
  );
}

function writeHelper(executable, logPath, forwardTool = null) {
  const source = `
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const LOG_PATH: &str = ${JSON.stringify(logPath)};
const FORWARD_TOOL: Option<&str> = ${forwardTool ? `Some(${JSON.stringify(forwardTool)})` : "None"};

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let rendered = args.iter().map(|arg| format!("{:?}", arg)).collect::<Vec<_>>().join(" ");
    let mut log = OpenOptions::new().create(true).append(true).open(LOG_PATH).unwrap();
    writeln!(log, "{rendered}").unwrap();

    if let Some(tool) = FORWARD_TOOL {
        drop(log);
        let status = Command::new(tool).args(&args).status().unwrap();
        if args.iter().any(|arg| arg == "-bsfs") {
            std::thread::sleep(Duration::from_secs(6));
        }
        std::process::exit(status.code().unwrap_or(1));
    }

    if args.iter().any(|arg| arg == "-version") {
        println!("ffmpeg version 7.0 media-dispatch-e2e");
    }
    if args.iter().any(|arg| arg == "-bsfs") {
        println!("Bitstream filters:");
        std::thread::sleep(Duration::from_secs(6));
    }
    if let Some(index) = args.iter().position(|arg| arg == "-i") {
        if let (Some(input), Some(output)) = (args.get(index + 1), args.last()) {
            if input != output {
                let _ = fs::copy(Path::new(input), Path::new(output));
            }
        }
    }
}
`;
  const sourcePath = path.join(scratch, `${path.basename(executable)}.rs`);
  fs.writeFileSync(sourcePath, source);
  const built = run(
    "rustc",
    [
      "--crate-name",
      "media_dispatch_trace_helper",
      "--edition=2021",
      sourcePath,
      "-o",
      executable,
    ],
    {
      timeout: 60_000,
      env: {
        RUSTUP_HOME:
          process.env.RUSTUP_HOME ??
          path.join(process.env.USERPROFILE ?? "", ".rustup"),
      },
    },
  );
  expectSuccess(
    built,
    `build dispatch trace helper ${path.basename(executable)}`,
  );
}

function installAlias(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  const alias = path.join(directory, name);
  try {
    fs.linkSync(ROSI, alias);
    return { path: alias, method: "hard link" };
  } catch {
    fs.copyFileSync(ROSI, alias);
    return { path: alias, method: "copy fallback" };
  }
}

function writeConfig(directory, ffmpeg, ffprobe) {
  fs.writeFileSync(
    path.join(directory, "launcher.json"),
    JSON.stringify({ version: 1, ffmpeg, ffprobe }),
  );
}

function logText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createIsolatedEnvironment(root) {
  const home = path.join(root, "home");
  const dataDir = path.join(root, "app-data");
  const downloads = path.join(home, "Downloads", "rosi-e2e");
  const legacyDir = path.join(root, "legacy-appdata", "rosi");
  const webview2 = path.join(root, "webview2");
  const temp = path.join(root, "tmp");
  const roaming = path.join(root, "appdata");
  const local = path.join(root, "localappdata");
  const xdgData = path.join(root, "xdg-data");
  const xdgConfig = path.join(root, "xdg-config");
  const xdgState = path.join(root, "xdg-state");
  const xdgCache = path.join(root, "xdg-cache");
  for (const directory of [
    home,
    dataDir,
    downloads,
    legacyDir,
    webview2,
    temp,
    roaming,
    local,
    xdgData,
    xdgConfig,
    xdgState,
    xdgCache,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const homeDrive = path.win32.parse(home).root.slice(0, 2);
  return {
    ...process.env,
    ROSI_E2E: "1",
    ROSI_E2E_DATA_DIR: dataDir,
    ROSI_E2E_LEGACY_V4_DIR: legacyDir,
    ROSI_E2E_ALLOW_LOOPBACK: "1",
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: home.slice(homeDrive.length),
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    WEBVIEW2_USER_DATA_FOLDER: webview2,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--disable-gpu --disable-features=CalculateNativeWindowOcclusion,RendererCodeIntegrity",
  };
}

function captureProcessAsync(file, args, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      env: { ...(isolatedEnv ?? process.env) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr });
    });
  });
}

async function observeYtdlpAliasCommand(aliasPath) {
  let lastProbeDetail = "no matching process was visible";
  const expectedDirectory = path.win32
    .dirname(aliasPath)
    .toLowerCase()
    .replaceAll("/", "\\");
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'ffmpeg.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf(${powershellQuote(path.win32.dirname(aliasPath))}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.Contains('-bsfs') } | Select-Object -First 1 -ExpandProperty CommandLine`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await captureProcessAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      3_000,
    );
    const commandLine = result.stdout.trim();
    if (result.stderr.trim()) lastProbeDetail = result.stderr.trim();
    else if (result.timedOut)
      lastProbeDetail = "PowerShell process query timed out";
    if (commandLine) {
      const token = commandLine.trim().startsWith('"')
        ? commandLine.trim().slice(1, commandLine.trim().indexOf('"', 1))
        : commandLine.trim().split(/\s/, 1)[0];
      const argv0Directory = path.win32
        .dirname(token)
        .toLowerCase()
        .replaceAll("/", "\\");
      const argv0Name = path.win32.basename(token).toLowerCase();
      return {
        commandLine,
        argv0: token,
        extensionless: path.win32.extname(token) === "",
        expectedDirectory: expectedDirectory === argv0Directory,
        argv0Name,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { error: lastProbeDetail };
}

function killProcessTree(pid) {
  if (!pid) {
    cleanupIssues.push(
      "Could not terminate a timed-out child tree: missing PID",
    );
    return;
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error) {
    cleanupIssues.push(
      `Could not terminate child process tree ${pid}: ${result.error.message}`,
    );
  } else if (
    result.status !== 0 &&
    !/not found|no running instance/i.test(`${result.stdout}\n${result.stderr}`)
  ) {
    cleanupIssues.push(
      `Could not terminate child process tree ${pid}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function runAsync(file, args, timeoutMs = 25_000, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: ROOT,
      windowsHide: true,
      env: { ...(isolatedEnv ?? process.env), ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr });
    });
  });
}

function wavFixture() {
  const sampleRate = 8_000;
  const sampleCount = 2_000;
  const data = Buffer.alloc(sampleCount * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function startFixtureServer() {
  const wav = wavFixture();
  server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Accept-Ranges": "bytes",
    });
    response.end(wav);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}/dispatch-fixture.wav`;
}

async function main() {
  assert(
    process.platform === "win32",
    "media dispatch verification requires Windows CreateProcess behavior",
  );
  assert(fs.existsSync(ROSI), `built ROSI executable is missing: ${ROSI}`);
  assert(fs.existsSync(YTDLP), `built yt-dlp sidecar is missing: ${YTDLP}`);
  assert(fs.existsSync(FFMPEG), `built FFmpeg sidecar is missing: ${FFMPEG}`);
  report.hashes = {
    rosiBinary: { path: path.relative(ROOT, ROSI), sha256: sha256File(ROSI) },
    ytdlpBinary: {
      path: path.relative(ROOT, YTDLP),
      sha256: sha256File(YTDLP),
    },
    ffmpegSidecar: {
      path: path.relative(ROOT, FFMPEG),
      sha256: sha256File(FFMPEG),
    },
    dispatcherSource: {
      path: path.relative(ROOT, DISPATCH_SOURCE),
      sha256: sha256File(DISPATCH_SOURCE),
    },
    verifierSource: {
      path: path.relative(ROOT, VERIFIER),
      sha256: sha256File(VERIFIER),
    },
  };

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-media-dispatch-"));
  isolatedEnv = createIsolatedEnvironment(path.join(scratch, "profile"));
  const ffmpegLog = path.join(scratch, "ffmpeg-helper.log");
  const ffprobeLog = path.join(scratch, "ffprobe-helper.log");
  const ytDlpLog = path.join(scratch, "yt-dlp-ffmpeg.log");
  const ffmpegHelper = path.join(scratch, "ffmpeg-trace.exe");
  const ffprobeHelper = path.join(scratch, "ffprobe-trace.exe");
  const ytDlpHelper = path.join(scratch, "ffmpeg-forwarder.exe");
  writeHelper(ffmpegHelper, ffmpegLog);
  writeHelper(ffprobeHelper, ffprobeLog);
  writeHelper(ytDlpHelper, ytDlpLog, FFMPEG);

  const lowerDir = path.join(scratch, "lowercase");
  const lowerFfmpeg = installAlias(lowerDir, "ffmpeg.exe");
  writeConfig(lowerDir, ffmpegHelper, ffprobeHelper);
  check("A1", "built ffmpeg.exe alias dispatches to configured FFmpeg", () => {
    const previousLog = logText(ffmpegLog).length;
    const result = run(lowerFfmpeg.path, ["-version"]);
    expectSuccess(result, "ffmpeg.exe alias");
    assert(
      logText(ffmpegLog).slice(previousLog).includes("-version"),
      "FFmpeg helper was not called",
    );
    return { alias: lowerFfmpeg.path, installedAs: lowerFfmpeg.method };
  });

  const probeDir = path.join(scratch, "probe-case");
  const upperFfprobe = installAlias(probeDir, "FFPROBE.EXE");
  writeConfig(probeDir, ffmpegHelper, ffprobeHelper);
  check(
    "A2",
    "case-varied FFPROBE.EXE alias dispatches to configured FFprobe",
    () => {
      const previousLog = logText(ffprobeLog).length;
      const result = run(upperFfprobe.path, ["-version"]);
      expectSuccess(result, "FFPROBE.EXE alias");
      const log = logText(ffprobeLog).slice(previousLog);
      assert(log.includes("-version"), "FFprobe helper was not called");
      assert(
        log.includes("-protocol_whitelist") && log.includes("file,pipe"),
        "FFprobe protocol restriction was not preserved",
      );
      return { alias: upperFfprobe.path, installedAs: upperFfprobe.method };
    },
  );

  const extensionlessProbeDir = path.join(scratch, "extensionless-probe");
  const extensionlessProbe = installAlias(extensionlessProbeDir, "ffprobe.exe");
  writeConfig(extensionlessProbeDir, ffmpegHelper, ffprobeHelper);
  check(
    "A3",
    "extensionless ffprobe argv0 dispatches to configured FFprobe",
    () => {
      const previousLog = logText(ffprobeLog).length;
      const argv0 = extensionlessProbe.path.slice(0, -EXE_SUFFIX.length);
      const result = run(extensionlessProbe.path, ["-version"], { argv0 });
      expectSuccess(result, "extensionless ffprobe argv0");
      const log = logText(ffprobeLog).slice(previousLog);
      assert(log.includes("-version"), "FFprobe helper was not called");
      assert(
        log.includes("-protocol_whitelist") && log.includes("file,pipe"),
        "FFprobe protocol restriction was not preserved",
      );
      return {
        executable: extensionlessProbe.path,
        argv0,
        installedAs: extensionlessProbe.method,
      };
    },
  );

  const mixedDir = path.join(scratch, "mixed-case");
  const mixedFfmpeg = installAlias(mixedDir, "FfMpEg.ExE");
  writeConfig(mixedDir, ffmpegHelper, ffprobeHelper);
  check("A4", "mixed-case FfMpEg.ExE remains a recognized alias", () => {
    const previousLog = logText(ffmpegLog).length;
    const result = run(mixedFfmpeg.path, ["-version"]);
    expectSuccess(result, "FfMpEg.ExE alias");
    assert(
      logText(ffmpegLog).slice(previousLog).includes("-version"),
      "FFmpeg helper was not called",
    );
    return { alias: mixedFfmpeg.path, installedAs: mixedFfmpeg.method };
  });

  for (const invalid of [
    { id: "F1", name: "missing-config" },
    { id: "F2", name: "malformed-config", config: "{" },
    {
      id: "F3",
      name: "unsupported-config-version",
      config: JSON.stringify({
        version: 9,
        ffmpeg: ffmpegHelper,
        ffprobe: ffprobeHelper,
      }),
    },
    { id: "F4", name: "missing-config-extensionless", argv0: true },
    {
      id: "F5",
      name: "malformed-config-extensionless",
      config: "{",
      argv0: true,
    },
  ]) {
    const directory = path.join(scratch, invalid.name);
    const alias = installAlias(directory, "ffmpeg.exe");
    if (invalid.config) {
      fs.writeFileSync(path.join(directory, "launcher.json"), invalid.config);
    }
    check(
      invalid.id,
      `recognized alias fails closed with ${invalid.name}`,
      () => {
        const argv0 = invalid.argv0
          ? alias.path.slice(0, -EXE_SUFFIX.length)
          : undefined;
        const result = run(alias.path, ["-version"], { argv0 });
        assert(result.status === 1, `expected exit 1, got ${result.status}`);
        assert(
          result.stderr.includes("ROSI media-tool launcher refused to start"),
          `launcher refusal was not reported: ${(result.stderr ?? "").trim()}`,
        );
        return { argv0: argv0 ?? alias.path, refusal: result.stderr.trim() };
      },
    );
  }

  const ytDlpDir = path.join(scratch, "yt-dlp-aliases");
  const ytDlpFfmpeg = installAlias(ytDlpDir, "ffmpeg.exe");
  writeConfig(ytDlpDir, ytDlpHelper, ffprobeHelper);
  const url = await startFixtureServer();
  await checkAsync(
    "A5",
    "actual bundled yt-dlp dispatches its extensionless ffmpeg -bsfs command",
    async () => {
      const outputTemplate = path.join(scratch, "%(id)s.%(ext)s");
      const previousLog = logText(ytDlpLog).length;
      const ytDlp = runAsync(
        YTDLP,
        [
          "--no-cache-dir",
          "--ignore-config",
          "--no-plugin-dirs",
          "--no-warnings",
          "--no-playlist",
          "--force-generic-extractor",
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--proxy",
          "",
          "--ffmpeg-location",
          ytDlpDir,
          "--output",
          outputTemplate,
          "--verbose",
          url,
        ],
        25_000,
        {
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          all_proxy: "",
          NO_PROXY: "*",
          no_proxy: "*",
        },
      );
      const [result, commandLine] = await Promise.all([
        ytDlp,
        observeYtdlpAliasCommand(ytDlpFfmpeg.path),
      ]);
      assert(!result.timedOut, "yt-dlp or its media-tool child timed out");
      const invoked = logText(ytDlpLog).slice(previousLog);
      assert(
        invoked.includes("-bsfs"),
        "yt-dlp did not reach the FFmpeg -bsfs helper",
      );
      assert(
        commandLine && !commandLine.error,
        `could not observe yt-dlp's live FFmpeg command line: ${commandLine?.error ?? "no observation"}`,
      );
      assert(
        commandLine.argv0Name === "ffmpeg" && commandLine.extensionless,
        `yt-dlp did not pass an extensionless argv0: ${commandLine.commandLine}`,
      );
      assert(
        commandLine.expectedDirectory,
        `argv0 did not resolve inside the configured private alias directory: ${commandLine.commandLine}`,
      );
      report.ytDlp = {
        exitCode: result.status,
        alias: ytDlpFfmpeg.path,
        commandLine: commandLine.commandLine,
        observedArgv0: commandLine.argv0,
        helperArguments: invoked.trim().split(/\r?\n/),
      };
      return report.ytDlp;
    },
  );
}

try {
  await main();
} catch (error) {
  report.fatalError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (server?.listening) {
    try {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections?.();
      await closed;
    } catch (error) {
      cleanupIssues.push(
        `Could not close the fixture server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (scratch) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      cleanupIssues.push(
        `Could not remove scratch directory ${scratch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  report.cleanupErrors = cleanupIssues;
  const passed = report.checks.filter((item) => item.status === "pass").length;
  const failures = report.checks.filter(
    (item) => item.status === "fail",
  ).length;
  report.summary = {
    total:
      report.checks.length + cleanupIssues.length + (report.fatalError ? 1 : 0),
    passed,
    failed: failures + cleanupIssues.length + (report.fatalError ? 1 : 0),
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = path.join(artifactDir, "report.json");
  fs.writeFileSync(reportPath, text);
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(
    path.join(artifactDir, "report.sha256"),
    `${digest}  report.json\n`,
  );
  console.log(`Report: ${path.relative(ROOT, reportPath)}`);
  console.log(`SHA-256: ${digest}`);
  console.log(
    `Result: ${report.summary.passed}/${report.summary.total} passed`,
  );
  console.log(
    "ROSI helper-mode aliases were launched; GUI window state was not independently instrumented.",
  );
  if (cleanupIssues.length) {
    console.error(`Cleanup errors: ${cleanupIssues.join("; ")}`);
  }
  if (report.fatalError) console.error(report.fatalError);
  process.exitCode = report.summary.failed === 0 ? 0 : 1;
}
