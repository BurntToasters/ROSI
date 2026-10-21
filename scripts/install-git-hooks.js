import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Point git at the tracked .githooks dir so pre-commit and commit-msg run locally.
// No-op in CI or outside a git checkout.
if (process.env.CI) process.exit(0);
if (!existsSync(".git")) process.exit(0);

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
} catch {
  // Non-fatal: developers can run the command manually.
}
