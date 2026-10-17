// Manual integration verifier for the beta3 media findings.
// Failure cases were recorded first in failure-modes.md. This compiles the
// production functions with small environment stand-ins, then runs the real
// bundled FFmpeg and records a hashed report. It does not launch the Tauri app.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";
const FFMPEG = path.join(
  ROOT,
  `src-tauri/target/debug/rosi-ffmpeg${EXE_SUFFIX}`,
);
const FFPROBE = path.join(
  ROOT,
  `src-tauri/target/debug/rosi-ffprobe${EXE_SUFFIX}`,
);
const reportStamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(
  ROOT,
  "e2e/artifacts/v5-fixes-media-tools",
  reportStamp,
);
const report = {
  generatedAt: new Date().toISOString(),
  repository: ROOT,
  source: "production Rust functions compiled into temporary harnesses",
  nativeApplicationLaunched: false,
  checks: [],
};
let scratch;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(id, name, action) {
  try {
    const detail = action();
    report.checks.push({
      id,
      name,
      status: "pass",
      detail: detail ?? "passed",
    });
  } catch (error) {
    report.checks.push({
      id,
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function expectRun(result, label) {
  assert(
    result.status === 0,
    `${label} exited ${result.status}: ${result.stderr}`,
  );
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function between(source, start, end, label) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `could not extract production ${label}`);
  return source.slice(first, last);
}

function buildMediaHarness() {
  const sourcePath = path.join(ROOT, "src-tauri/src/command_builders.rs");
  const source = fs.readFileSync(sourcePath, "utf8");
  const model = between(
    source,
    "#[derive(Clone, Debug, Default)]",
    "fn codec_after",
    "codec model",
  );
  const helpers = between(
    source,
    "const CONTAINER_COMPATIBLE_VIDEO",
    "fn resolve_gpu_video_encoder",
    "codec selection helpers",
  );
  const builder = between(
    source,
    "pub fn build_ffmpeg_args(",
    "pub struct YtdlpArgsInput",
    "FFmpeg argument builder",
  );
  const program = `
use std::path::Path;
${model}
${helpers}
${builder}
fn optional(value: &str) -> Option<String> { (value != "none").then(|| value.to_string()) }
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut source = SourceCodecs::default();
    source.video = optional(&args[4]);
    source.audio = optional(&args[5]);
    source.subtitles = if args[6] == "none" { Vec::new() } else { args[6].split(',').map(str::to_string).collect() };
    source.has_attached_pictures = args[7] == "true";
    let complete = args[8] == "true";
    println!("PRESERVE_ORIGINAL={}", must_preserve_original(&args[3], &source, complete));
    for arg in build_ffmpeg_args(Path::new(&args[1]), Path::new(&args[2]), &args[3], &args[9], Some(&source)) {
        println!("ARG={arg}");
    }
}
`;
  const rustFile = path.join(scratch, "media-harness.rs");
  const executable = path.join(scratch, `media-harness${EXE_SUFFIX}`);
  fs.writeFileSync(rustFile, program);
  const compiled = run("rustc", ["--edition=2021", rustFile, "-o", executable]);
  expectRun(compiled, "production media functions compile");
  return executable;
}

function buildPathHarness() {
  const sidecars = fs.readFileSync(
    path.join(ROOT, "src-tauri/src/sidecars.rs"),
    "utf8",
  );
  const process = fs.readFileSync(
    path.join(ROOT, "src-tauri/src/process_util.rs"),
    "utf8",
  );
  const guard = fs.readFileSync(
    path.join(ROOT, "src-tauri/src/ffmpeg_guard.rs"),
    "utf8",
  );
  const sidecarFunctions = between(
    sidecars,
    "pub fn bundled_ffmpeg()",
    "/// Log bundled sidecar versions",
    "FFmpeg path resolution",
  );
  const processFunctions = between(
    process,
    "fn env_path(",
    '#[cfg(target_os = "linux")]',
    "enhanced PATH",
  );
  const guardFunctions = between(
    guard,
    "fn resolve_executable(",
    "#[cfg(test)]",
    "guarded executable and ffprobe resolution",
  );
  const program = `
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
mod app_state { use std::path::PathBuf; pub fn home_dir() -> Option<PathBuf> { std::env::var_os("USERPROFILE").map(PathBuf::from) } }
mod logging { pub fn warn(_: &str) {} }
mod validation {
    use std::path::{Path, PathBuf};
    pub fn resolve_path(value: impl AsRef<Path>) -> PathBuf {
        let path = value.as_ref();
        if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap().join(path) }
    }
}
mod process_util {
    use std::path::PathBuf;
    ${processFunctions}
}
mod sidecars {
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;
    pub const FFMPEG_SIDECAR: &str = "rosi-ffmpeg";
    pub const FFPROBE_SIDECAR: &str = "rosi-ffprobe";
    pub fn bundled_path(name: &str) -> Option<PathBuf> {
        if name == FFMPEG_SIDECAR { std::env::var_os("ROSI_TEST_BUNDLED_FFMPEG").map(PathBuf::from) }
        else { std::env::var_os("ROSI_TEST_BUNDLED_FFPROBE").map(PathBuf::from) }
    }
    ${sidecarFunctions}
}
mod ffmpeg_guard {
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    ${guardFunctions}
    pub fn selected_executable(path: &Path) -> Option<PathBuf> { resolve_executable(path) }
    pub fn selected_probe(path: &Path) -> Option<PathBuf> { resolve_probe(path) }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(&args[1]);
    let explicit = root.join("explicit");
    let fallback = root.join("profile/.deno/bin");
    let ffmpeg_name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let ffprobe_name = format!("ffprobe{}", std::env::consts::EXE_SUFFIX);
    let bundle_name = format!("rosi-ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let bundle_probe_name = format!("rosi-ffprobe{}", std::env::consts::EXE_SUFFIX);
    let bundle = root.join("bundle").join(&bundle_name);
    std::env::set_var("USERPROFILE", root.join("profile"));
    std::env::set_var("LOCALAPPDATA", root.join("local"));
    std::env::set_var("ROSI_TEST_BUNDLED_FFMPEG", &bundle);
    std::env::set_var("ROSI_TEST_BUNDLED_FFPROBE", root.join("bundle").join(&bundle_probe_name));
    std::env::set_var("PATH", &explicit);
    let missing_bundle = root.join("not-present").join(&bundle_name);
    std::env::set_var("ROSI_TEST_BUNDLED_FFMPEG", &missing_bundle);
    let no_custom = sidecars::effective_ffmpeg(None);
    let explicit_binary = explicit.join(&ffmpeg_name).canonicalize().unwrap();
    assert_eq!(no_custom, explicit_binary, "without a bundle, default resolution must select explicit PATH absolutely");
    assert_eq!(ffmpeg_guard::selected_executable(&no_custom), Some(explicit_binary.clone()), "default conversion and guard must select the same no-bundle executable");
    println!("no-custom-no-bundle={}", no_custom.display());
    std::env::set_var("ROSI_TEST_BUNDLED_FFMPEG", &bundle);
    let picked = sidecars::effective_ffmpeg(Some("ffmpeg"));
    assert_eq!(picked, explicit_binary, "explicit PATH must beat enhanced fallback");
    let guarded = ffmpeg_guard::selected_executable(&picked).unwrap();
    assert_eq!(guarded, picked.canonicalize().unwrap(), "guard must keep the same executable");
    println!("explicit={}", picked.display());
    std::fs::remove_file(explicit.join(&ffmpeg_name)).unwrap();
    let enhanced = sidecars::effective_ffmpeg(Some("ffmpeg"));
    assert_eq!(enhanced, fallback.join(&ffmpeg_name).canonicalize().unwrap(), "enhanced fallback should resolve to an absolute executable");
    println!("enhanced={}", enhanced.display());
    std::fs::remove_file(fallback.join(&ffmpeg_name)).unwrap();
    let bundled = sidecars::effective_ffmpeg(Some("ffmpeg"));
    assert_eq!(bundled, bundle, "missing custom command must fall back to the bundle");
    println!("missing-custom={}", bundled.display());
    let default = sidecars::effective_ffmpeg(None);
    assert_eq!(default, bundle, "default selection must prefer the bundle");
    println!("default={}", default.display());
    let custom = root.join("custom").join(&ffmpeg_name);
    assert_eq!(sidecars::effective_ffmpeg(Some(custom.to_str().unwrap())), custom, "custom absolute executable path changed");
    assert_eq!(sidecars::effective_ffmpeg(Some(custom.parent().unwrap().to_str().unwrap())), custom, "custom directory did not resolve ffmpeg");
    println!("absolute-and-directory=preserved");
    let custom_probe = root.join("custom").join(&ffprobe_name).canonicalize().unwrap();
    assert_eq!(ffmpeg_guard::selected_probe(&custom), Some(custom_probe), "custom FFprobe sibling was not selected");
    println!("custom-sibling-ffprobe=preserved");
    if args.len() > 2 {
        let symlink = PathBuf::from(&args[2]);
        let symlink_probe = symlink.parent().unwrap().join(&ffprobe_name).canonicalize().unwrap();
        assert_eq!(ffmpeg_guard::selected_probe(&symlink), Some(symlink_probe), "symlink-local FFprobe sibling was not selected");
        println!("symlink-sibling-ffprobe=preserved");
    }
    std::env::set_var("PATH", root.join("empty-path"));
    std::env::set_var("ROSI_TEST_BUNDLED_FFMPEG", root.join("missing-bundle").join(&bundle_name));
    assert_eq!(sidecars::effective_ffmpeg(Some("ffmpeg")), PathBuf::from("ffmpeg"), "system command fallback changed when bundle and PATH are missing");
    println!("missing-bundle=system-command-fallback");
}
`;
  const rustFile = path.join(scratch, "path-harness.rs");
  const executable = path.join(scratch, `path-harness${EXE_SUFFIX}`);
  fs.writeFileSync(rustFile, program);
  const compiled = run("rustc", ["--edition=2021", rustFile, "-o", executable]);
  expectRun(compiled, "production path functions compile");
  return executable;
}

function invokeArgs(
  harness,
  {
    input,
    output,
    target,
    video = "none",
    audio = "none",
    subtitles = "none",
    artwork = false,
    complete = true,
    encoder = "libx264",
  },
) {
  const result = run(harness, [
    input,
    output,
    target,
    video,
    audio,
    subtitles,
    String(artwork),
    String(complete),
    encoder,
  ]);
  expectRun(result, `argument builder for ${target}/${video}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  return {
    preserveOriginal: lines.shift()?.split("=")[1] === "true",
    args: lines.map((line) => line.slice("ARG=".length)),
  };
}

function selectedCodec(args, selector) {
  const at = args.indexOf(selector);
  return at < 0 ? undefined : args[at + 1];
}

function makeFixtures(root) {
  const directories = [
    "explicit",
    "profile/.deno/bin",
    "local/deno/bin",
    "local/Microsoft/WinGet/Links",
    "bundle",
    "custom",
    "empty-path",
    "missing-bundle",
  ];
  for (const directory of directories)
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const directory of [
    "explicit",
    "profile/.deno/bin",
    "custom",
    "bundle",
  ]) {
    const name =
      directory === "bundle"
        ? `rosi-ffmpeg${EXE_SUFFIX}`
        : `ffmpeg${EXE_SUFFIX}`;
    fs.writeFileSync(path.join(root, directory, name), "path fixture");
  }
  fs.writeFileSync(
    path.join(root, `custom/ffprobe${EXE_SUFFIX}`),
    "custom ffprobe fixture",
  );
  fs.writeFileSync(
    path.join(root, `bundle/rosi-ffprobe${EXE_SUFFIX}`),
    "bundle ffprobe fixture",
  );
}

function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-media-tools-"));
  assert(
    fs.existsSync(FFMPEG),
    `Bundled FFmpeg is unavailable for ${process.platform}; expected ${FFMPEG}. Build the Tauri sidecars before running this verifier.`,
  );
  const mediaHarness = buildMediaHarness();
  const pathHarness = buildPathHarness();
  const pathFixture = path.join(scratch, "paths");
  makeFixtures(pathFixture);

  check(
    "P1",
    "no-bundle default and custom bare FFmpeg use explicit PATH and guard agrees",
    () => {
      const symlink = path.join(pathFixture, `symlink/ffmpeg${EXE_SUFFIX}`);
      let symlinkAvailable = false;
      try {
        fs.mkdirSync(path.dirname(symlink), { recursive: true });
        fs.symlinkSync(
          path.join(pathFixture, `custom/ffmpeg${EXE_SUFFIX}`),
          symlink,
          "file",
        );
        fs.writeFileSync(
          path.join(path.dirname(symlink), `ffprobe${EXE_SUFFIX}`),
          "symlink sibling",
        );
        symlinkAvailable = true;
      } catch (error) {
        report.symlinkFixture = {
          status: "unavailable",
          reason: error.message,
        };
      }
      const result = run(
        pathHarness,
        symlinkAvailable ? [pathFixture, symlink] : [pathFixture],
      );
      expectRun(result, "media path resolution");
      report.symlinkFixture ??= { status: "verified" };
      return result.stdout.trim().split(/\r?\n/);
    },
  );

  check("P2", "bundled FFmpeg process version probe succeeds", () => {
    assert(fs.existsSync(FFMPEG), `bundled FFmpeg missing: ${FFMPEG}`);
    const result = run(FFMPEG, ["-version"]);
    expectRun(result, "bundled FFmpeg version probe");
    assert(
      /ffmpeg version/i.test(result.stdout),
      "version probe did not identify FFmpeg",
    );
    return result.stdout.split(/\r?\n/)[0];
  });

  check(
    "C1",
    "MOV transcodes AV1 and retains compatible audio/subtitle/original-safety rules",
    () => {
      const cases = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mov",
        target: "mov",
        video: "av1",
        audio: "aac",
        subtitles: "subrip",
        artwork: false,
      });
      assert(
        selectedCodec(cases.args, "-c:v") === "libx264",
        `MOV AV1 selected ${selectedCodec(cases.args, "-c:v")}`,
      );
      assert(
        selectedCodec(cases.args, "-c:a") === "copy",
        "compatible AAC audio was not copied",
      );
      assert(
        cases.args.includes("-pix_fmt") && cases.args.includes("yuv420p"),
        "safe H.264 pixel format missing",
      );
      assert(
        cases.args.includes("-map") && cases.args.includes("0:s:0?"),
        "MOV subtitle map missing",
      );
      assert(
        selectedCodec(cases.args, "-c:s") === "mov_text",
        "MOV subtitle conversion missing",
      );
      assert(
        !cases.preserveOriginal,
        "complete supported MOV probe unexpectedly preserves original",
      );
      const attached = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mov",
        target: "mov",
        video: "av1",
        artwork: true,
      });
      assert(
        attached.preserveOriginal,
        "attached artwork loss did not preserve original",
      );
      const incomplete = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mov",
        target: "mov",
        video: "av1",
        complete: false,
      });
      assert(
        incomplete.preserveOriginal,
        "incomplete codec probe did not preserve original",
      );
      return {
        video: selectedCodec(cases.args, "-c:v"),
        audio: selectedCodec(cases.args, "-c:a"),
        subtitles: selectedCodec(cases.args, "-c:s"),
      };
    },
  );

  check(
    "C2",
    "MOV AV01 alias transcodes while MP4 AV1 remains stream-copy",
    () => {
      const mov = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mov",
        target: "mov",
        video: "av01",
      });
      const mp4 = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mp4",
        target: "mp4",
        video: "av1",
      });
      assert(
        selectedCodec(mov.args, "-c:v") === "libx264",
        "MOV AV01 alias was copied",
      );
      assert(
        selectedCodec(mp4.args, "-c:v") === "copy",
        "MP4 AV1 stream-copy behavior changed",
      );
      return {
        movAv01: selectedCodec(mov.args, "-c:v"),
        mp4Av1: selectedCodec(mp4.args, "-c:v"),
      };
    },
  );

  check(
    "C3",
    "MOV HEVC keeps hvc1 and incompatible audio is encoded as AAC",
    () => {
      const result = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mov",
        target: "mov",
        video: "hevc",
        audio: "opus",
      });
      const tag = result.args.indexOf("-tag:v");
      assert(
        selectedCodec(result.args, "-c:v") === "copy",
        "compatible HEVC was re-encoded",
      );
      assert(
        tag >= 0 && result.args[tag + 1] === "hvc1",
        "MOV HEVC hvc1 tag missing",
      );
      assert(
        selectedCodec(result.args, "-c:a") === "aac",
        "incompatible audio was not encoded as AAC",
      );
      return {
        video: selectedCodec(result.args, "-c:v"),
        tag: result.args[tag + 1],
        audio: selectedCodec(result.args, "-c:a"),
      };
    },
  );

  check(
    "C4",
    "MP3 and M4A retain audio-only copy and transcode decisions",
    () => {
      const mp3Copy = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mp3",
        target: "mp3",
        audio: "mp3",
      });
      const mp3Encode = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.mp3",
        target: "mp3",
        audio: "aac",
      });
      const m4aCopy = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.m4a",
        target: "m4a",
        audio: "aac",
      });
      const m4aEncode = invokeArgs(mediaHarness, {
        input: "source.mkv",
        output: "out.m4a",
        target: "m4a",
        audio: "opus",
      });
      assert(
        selectedCodec(mp3Copy.args, "-c:a") === "copy",
        "MP3 source no longer copies",
      );
      assert(
        selectedCodec(mp3Encode.args, "-c:a") === "libmp3lame",
        "MP3 transcode codec changed",
      );
      assert(
        selectedCodec(m4aCopy.args, "-c:a") === "copy",
        "AAC M4A source no longer copies",
      );
      assert(
        selectedCodec(m4aEncode.args, "-c:a") === "aac",
        "M4A transcode codec changed",
      );
      return "MP3/M4A audio handling preserved";
    },
  );

  const input = path.join(scratch, "av1-source.mkv");
  const generated = run(FFMPEG, [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=size=64x64:duration=0.2",
    "-c:v",
    "libaom-av1",
    "-cpu-used",
    "8",
    input,
  ]);
  if (generated.status !== 0) {
    report.checks.push({
      id: "R0",
      name: "generate real AV1 input",
      status: "fail",
      detail: generated.stderr,
    });
  } else {
    check(
      "R1",
      "real bundled FFmpeg converts AV1 to playable H.264 MOV",
      () => {
        const output = path.join(scratch, "av1-output.mov");
        const built = invokeArgs(mediaHarness, {
          input,
          output,
          target: "mov",
          video: "av1",
        });
        const conversion = run(FFMPEG, built.args);
        expectRun(conversion, "AV1 to MOV conversion");
        const probe = fs.existsSync(FFPROBE)
          ? run(FFPROBE, [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=codec_name",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              output,
            ])
          : run(FFMPEG, ["-hide_banner", "-i", output, "-f", "null", "-"]);
        if (fs.existsSync(FFPROBE)) expectRun(probe, "MOV video codec probe");
        assert(
          /h264/i.test(`${probe.stdout}\n${probe.stderr}`),
          "MOV output is not H.264",
        );
        return {
          codec: probe.stdout.trim() || "h264 (FFmpeg stream report)",
          exitCode: conversion.status,
        };
      },
    );

    check("R2", "real bundled FFmpeg keeps AV1 stream-copy in MP4", () => {
      const output = path.join(scratch, "av1-output.mp4");
      const built = invokeArgs(mediaHarness, {
        input,
        output,
        target: "mp4",
        video: "av1",
      });
      const conversion = run(FFMPEG, built.args);
      expectRun(conversion, "AV1 to MP4 conversion");
      const probe = fs.existsSync(FFPROBE)
        ? run(FFPROBE, [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            output,
          ])
        : run(FFMPEG, ["-hide_banner", "-i", output, "-f", "null", "-"]);
      if (fs.existsSync(FFPROBE)) expectRun(probe, "MP4 video codec probe");
      assert(
        /av1/i.test(`${probe.stdout}\n${probe.stderr}`),
        "MP4 output no longer contains AV1",
      );
      return {
        codec: probe.stdout.trim() || "av1 (FFmpeg stream report)",
        exitCode: conversion.status,
      };
    });

    check(
      "R3",
      "real bundled FFmpeg input process probe identifies AV1",
      () => {
        const probe = run(FFMPEG, [
          "-hide_banner",
          "-i",
          input,
          "-f",
          "null",
          "-",
        ]);
        assert(
          /Video: av1/i.test(probe.stderr),
          "input process probe did not identify AV1",
        );
        return probe.stderr.match(/Video: [^\r\n]+/)?.[0] ?? "AV1 identified";
      },
    );
  }

  report.summary = {
    total: report.checks.length,
    passed: report.checks.filter((item) => item.status === "pass").length,
    failed: report.checks.filter((item) => item.status === "fail").length,
  };
}

try {
  main();
} catch (error) {
  report.fatalError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (!report.summary) {
    report.summary = {
      total: report.checks.length,
      passed: report.checks.filter((item) => item.status === "pass").length,
      failed:
        report.checks.filter((item) => item.status === "fail").length +
        (report.fatalError ? 1 : 0),
    };
  }
  if (scratch) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
  fs.mkdirSync(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "report.json");
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(reportPath, reportText);
  const digest = crypto.createHash("sha256").update(reportText).digest("hex");
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
    `Native application launched: ${report.nativeApplicationLaunched}`,
  );
  if (report.fatalError) console.error(report.fatalError);
  process.exitCode = report.summary.failed === 0 ? 0 : 1;
}
