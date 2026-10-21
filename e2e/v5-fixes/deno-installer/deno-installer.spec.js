import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

// Acceptance for the Deno installer fix: a missing package manager fails
// before any native dialog, and every failure path offers the official
// instructions. The runner (run.mjs) sets both E2E hooks to empty directories;
// this spec drives the real backend and only stubs openExternal, so nothing
// is installed and no browser opens.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set by e2e/v5-fixes/deno-installer/run.mjs; run the runner, not this spec alone`,
    );
  }
  return value;
}
const directory = requiredEnv("ROSI_V5_FIX_ARTIFACTS");
requiredEnv("ROSI_E2E_DENO_INSTALLER_DIR");
requiredEnv("ROSI_E2E_DENO_PROBE_DIR");

const DOCS_URL = "https://docs.deno.com/runtime/getting_started/installation/";
const OFFICIAL_SENTENCE = "Install Deno with the official instructions";
const PLATFORM_ERRORS = {
  darwin: /Homebrew was not found, so Deno cannot be installed automatically/,
  win32: /winget was not found, so Deno cannot be installed automatically/,
  linux: /unavailable on this platform/,
};
const IS_LINUX = process.platform === "linux";
const report = {
  finding: "deno-installer",
  platform: process.platform,
  checks: [],
};
const record = (name, details) => {
  report.checks.push({ name, ...details });
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
};

// Runs one scenario, records its outcome, and rethrows a failure so mocha
// also reports it.
async function scenario(name, body) {
  try {
    const details = await body();
    record(name, { invariantPassed: true, ...details });
  } catch (error) {
    record(name, {
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function clickById(id) {
  await browser.execute((target) => {
    document.getElementById(target)?.click();
  }, id);
}

async function reloadRenderer() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => Boolean(window.__ROSI_E2E__?.ready) && Boolean(window.api),
      ),
    { timeout: 60_000, timeoutMsg: "renderer did not come back after reload" },
  );
}

// Records every external URL the app asks to open, instead of opening it.
function stubOpenExternal() {
  return browser.execute(() => {
    window.__rosiDenoInstaller = { external: [] };
    window.api.openExternal = async (url) => {
      window.__rosiDenoInstaller.external.push(url);
    };
  });
}

function externalCalls() {
  return browser.execute(() => window.__rosiDenoInstaller?.external ?? []);
}

function modalView() {
  return browser.execute(() => {
    const modal = document.getElementById("app-modal");
    return {
      active: modal.classList.contains("active"),
      title: document.getElementById("modal-title").textContent.trim(),
      message: document.getElementById("modal-message").textContent,
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => ({
          label: button.textContent.trim(),
          primary: button.classList.contains("modal-btn-primary"),
        }),
      ),
    };
  });
}

// Clicks a modal button by its label. The modal runs the action after its
// hide animation, so callers wait for the effect rather than the click.
function clickModalButton(label) {
  return browser.execute((text) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === text,
    );
    if (!button) throw new Error(`no modal button labelled ${text}`);
    button.click();
  }, label);
}

function wizardState() {
  return browser.execute(() => {
    const overlay = document.getElementById("setup-wizard");
    const steps = [...overlay.querySelectorAll(".wizard-step")];
    return {
      open: overlay.classList.contains("active"),
      step: steps.findIndex((step) => step.classList.contains("active")),
    };
  });
}

function denoView() {
  return browser.execute(() => {
    const status = document.getElementById("wizard-deno-status");
    const action = document.getElementById("wizard-deno-action");
    return {
      state: status.dataset.state ?? null,
      text: status.textContent.trim(),
      action: action.hidden ? null : action.textContent.trim(),
    };
  });
}

async function waitForDenoState(state) {
  let view = null;
  await browser.waitUntil(
    async () => {
      view = await denoView();
      return view.state === state;
    },
    {
      timeout: 15_000,
      timeoutMsg: `Deno step never reached state ${state}`,
    },
  );
  return view;
}

describe("V5 fix: Deno installer fails before any dialog and offers instructions", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("reminder failure shows the backend error and the official instructions", async () => {
    await scenario("reminder-failure-offers-instructions", async () => {
      if (IS_LINUX) {
        return {
          skipped: true,
          reason: "Linux shows only instructions; no automatic install exists",
        };
      }
      // The startup reminder opens after the Deno check; the runner enables it
      // in this profile and the probe directory is empty, so Deno is missing.
      await browser.waitUntil(
        async () => {
          const view = await modalView();
          return (
            view.active &&
            view.title === "Deno Required for Full YouTube Functionality"
          );
        },
        {
          timeout: 30_000,
          timeoutMsg: "startup Deno reminder never appeared",
        },
      );
      await stubOpenExternal();
      const offer = await modalView();
      const installButton = offer.buttons.find((b) => b.label === "Install");
      assert.ok(
        installButton,
        `reminder has no Install button: ${JSON.stringify(offer.buttons)}`,
      );

      await clickModalButton("Install");
      await browser.waitUntil(
        async () => {
          const view = await modalView();
          return view.active && view.title === "Installation Failed";
        },
        {
          timeout: 30_000,
          timeoutMsg: "Installation Failed modal never appeared",
        },
      );
      const failed = await modalView();
      const occurrences = failed.message.split(OFFICIAL_SENTENCE).length - 1;
      assert.equal(
        occurrences,
        1,
        `instruction sentence appears ${occurrences} times: ${failed.message}`,
      );
      assert.match(failed.message, PLATFORM_ERRORS[process.platform]);
      assert.deepEqual(
        failed.buttons.map((button) => button.label),
        ["Open Install Instructions", "OK"],
      );
      assert.equal(failed.buttons[0].primary, true);

      await clickModalButton("Open Install Instructions");
      await browser.waitUntil(async () => (await externalCalls()).length > 0, {
        timeout: 10_000,
        timeoutMsg: "Open Install Instructions did not open a URL",
      });
      const external = await externalCalls();
      assert.deepEqual(external, [DOCS_URL]);
      return {
        title: failed.title,
        message: failed.message,
        primaryLabel: failed.buttons[0].label,
        externalUrls: external,
      };
    });
  });

  it("backend returns the missing-package-manager error without a dialog", async () => {
    await scenario("backend-missing-package-manager", async () => {
      const started = Date.now();
      const outcome = await api("installDeno");
      const elapsedMs = Date.now() - started;
      assert.equal(outcome.success, false, JSON.stringify(outcome));
      assert.equal(outcome.cancelled, undefined, "a dialog was answered");
      assert.match(outcome.error ?? "", PLATFORM_ERRORS[process.platform]);
      assert.ok(elapsedMs < 5_000, `installDeno took ${elapsedMs} ms`);
      return { elapsedMs, error: outcome.error };
    });
  });

  it("wizard failure shows the backend error and the official instructions", async () => {
    await scenario("wizard-failure-offers-instructions", async () => {
      if (IS_LINUX) {
        return {
          skipped: true,
          reason: "Linux shows only instructions; no automatic install exists",
        };
      }
      // Skipping the reminder keeps the wizard the only Deno prompt. The
      // dismissal is saved as a settings patch, not by clicking the modal.
      const saved = await api("saveSettings", {
        denoReminderDismissed: true,
        firstLaunch: true,
      });
      assert.equal(saved.ok, true, saved.error?.message);
      await reloadRenderer();
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            document
              .getElementById("setup-wizard")
              ?.classList.contains("active"),
          ),
        { timeout: 10_000, timeoutMsg: "setup wizard did not open" },
      );
      await stubOpenExternal();
      for (let i = 0; i < 4; i += 1) await clickById("wizard-next");
      assert.equal(
        (await wizardState()).step,
        4,
        "wizard did not reach the Deno step",
      );

      const missing = await waitForDenoState("missing");
      assert.equal(missing.action, "Install Deno");
      await clickById("wizard-deno-action");
      const failed = await waitForDenoState("error");
      assert.match(failed.text, /^Automatic install failed: /);
      assert.match(failed.text, PLATFORM_ERRORS[process.platform]);
      assert.equal(failed.action, "Open install instructions");

      await clickById("wizard-deno-action");
      await browser.waitUntil(async () => (await externalCalls()).length > 0, {
        timeout: 10_000,
        timeoutMsg: "wizard instructions button did not open a URL",
      });
      const external = await externalCalls();
      assert.deepEqual(external, [DOCS_URL]);

      await clickById("wizard-skip");
      await browser.waitUntil(async () => !(await wizardState()).open, {
        timeout: 10_000,
        timeoutMsg: "setup wizard did not close",
      });
      return {
        state: failed.state,
        statusText: failed.text,
        actionLabel: failed.action,
        externalUrls: external,
      };
    });
  });
});
