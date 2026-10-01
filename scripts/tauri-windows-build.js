import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const rawArgs = process.argv.slice(2);
// `--msstore` bakes the Microsoft Store distribution channel into both the
// frontend (Vite define) and the Rust binary (option_env!), which disables the
// in-app updater. It is not a Tauri CLI flag, so strip it before forwarding.
const msStore = rawArgs.includes("--msstore");
const args = rawArgs.filter((arg) => arg !== "--msstore");
assertStableReleaseOverridesAllowed();
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === "1";
const required = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN",
];
const missing = skipWindowsCodeSigning
  ? []
  : required.filter((name) => !process.env[name]?.trim());
if (process.platform !== "win32")
  throw new Error("Signed Windows builds must run on Windows.");
if (missing.length)
  throw new Error(
    `Missing Artifact Signing environment variables: ${missing.join(", ")}`,
  );
if (skipWindowsCodeSigning)
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
};
const target = valueAfter("--target");
if (!target.includes("windows"))
  throw new Error("A Windows --target is required.");
const root = fileURLToPath(new URL("..", import.meta.url));
const targetReleaseDir = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
);
const signScript = fileURLToPath(
  new URL("./windows-artifact-sign.ps1", import.meta.url),
);

function runPowershell(scriptPath, extraArgs = []) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...extraArgs,
    ],
    { stdio: "inherit", env: process.env },
  );
}

const buildEnv = { ...process.env };
if (msStore) {
  buildEnv.ROSI_DISTRIBUTION_CHANNEL = "msstore";
  console.log(
    "[tauri-windows-build] Building the Microsoft Store channel (in-app updater disabled).",
  );
} else {
  delete buildEnv.ROSI_DISTRIBUTION_CHANNEL;
}

const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
execFileSync(process.execPath, [tauriCli, "build", ...args, "--", "--locked"], {
  stdio: "inherit",
  env: buildEnv,
});
if (!skipWindowsCodeSigning) {
  const runtimeExecutables = readdirSync(targetReleaseDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(targetReleaseDir, entry.name));
  if (!runtimeExecutables.length)
    throw new Error(
      `No final Windows runtime executables found under ${targetReleaseDir}`,
    );
  for (const executable of runtimeExecutables) {
    console.log(
      `[tauri-windows-build] Finalizing Authenticode signature: ${executable}`,
    );
    runPowershell(signScript, ["-FilePath", executable]);
  }
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(
        new URL("./verify-windows-authenticode.ps1", import.meta.url),
      ),
      "-TargetReleaseDir",
      targetReleaseDir,
    ],
    { stdio: "inherit", env: process.env },
  );
}
