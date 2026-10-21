import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

// Flatpak update notice. A Flatpak build checks the feed like other builds.
// A newer version shows a prompt that opens the GitHub release page, and
// download and install never run. The E2E updater adapter stands in for the
// Tauri plugin: it reports is_flatpak, picks the feed result, and returns a
// fake update whose download and install calls are counted.
const RELEASE_URL_BASE = "https://github.com/BurntToasters/ROSI/releases/tag/v";
const EXPECTED_CHECKS = 4;
const here = path.dirname(fileURLToPath(import.meta.url));
const runDirectory = path.join(
  here,
  "..",
  "..",
  "artifacts",
  "v5-fixes-flatpak-updates",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const checks = [];

function record(name, details) {
  checks.push({ name, passed: true, ...details });
}

function writeReport() {
  fs.mkdirSync(runDirectory, { recursive: true });
  const passed =
    checks.length === EXPECTED_CHECKS && checks.every((check) => check.passed);
  fs.writeFileSync(
    path.join(runDirectory, "report.json"),
    `${JSON.stringify({ area: "flatpak-updates", passed, checks }, null, 2)}\n`,
  );
}

function newerVersionThan(current) {
  const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

async function freshRenderer() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await waitForAppReady();
}

async function installScenario(config) {
  await browser.execute((scenario) => {
    const probe = {
      invokes: [],
      checkTargets: [],
      downloads: 0,
      installs: 0,
      restarts: 0,
      closes: 0,
      opened: [],
    };
    window.flatpakUpdateProbe = probe;
    window.api.openExternal = async (url) => {
      probe.opened.push(url);
      return { ok: true, data: { opened: true } };
    };
    window.__ROSI_E2E__.updaterAdapter = {
      invoke: async (command, args = {}) => {
        probe.invokes.push(command);
        if (command === "is_packaged") return true;
        if (command === "is_flatpak") return scenario.flatpak;
        if (command === "get_settings")
          return { updateChannel: scenario.channel };
        if (command === "get_beta_updater_target") return "linux-beta-x86_64";
        if (command === "restart_app") {
          probe.restarts += 1;
          return undefined;
        }
        return window.__TAURI__.core.invoke(command, args);
      },
      check: async (target) => {
        probe.checkTargets.push(target ?? null);
        if (!scenario.version) return null;
        return {
          version: scenario.version,
          body: `Scenario ${scenario.version}`,
          async download() {
            probe.downloads += 1;
          },
          async install() {
            probe.installs += 1;
          },
          async close() {
            probe.closes += 1;
          },
        };
      },
    };
  }, config);
}

async function readProbe() {
  return browser.execute(() =>
    JSON.parse(JSON.stringify(window.flatpakUpdateProbe)),
  );
}

function readModal() {
  const modal = document.getElementById("app-modal");
  return {
    active: modal?.classList.contains("active") === true,
    title: document.getElementById("modal-title")?.textContent?.trim() ?? "",
    message: document.getElementById("modal-message")?.textContent ?? "",
    buttons: [...document.querySelectorAll("#modal-buttons button")].map(
      (button) => button.textContent.trim(),
    ),
  };
}

async function waitForModal(title) {
  await browser.waitUntil(
    async () => {
      const modal = await browser.execute(readModal);
      return modal.active && modal.title === title;
    },
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `modal "${title}" did not appear`,
    },
  );
  return browser.execute(readModal);
}

async function clickModalButton(label) {
  await browser.execute((expected) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === expected,
    );
    if (!button) throw new Error(`modal button "${expected}" was not found`);
    button.click();
  }, label);
}

async function runManualCheck() {
  await browser.execute(() =>
    document.getElementById("checkUpdateBtn").click(),
  );
}

describe("Flatpak update notice E2E", () => {
  before(waitForAppReady);
  after(writeReport);

  it("prompts with the release page for a newer Flatpak build and never downloads or installs", async () => {
    const current = await api("getAppVersion");
    const version = newerVersionThan(current);
    await freshRenderer();
    await installScenario({ flatpak: true, channel: "stable", version });

    await runManualCheck();
    const prompt = await waitForModal("Update Available!");
    assert.ok(prompt.message.includes(`(v${version})`), prompt.message);
    assert.deepEqual(prompt.buttons, ["Open Release Page", "Later"]);
    fs.mkdirSync(runDirectory, { recursive: true });
    await browser.saveScreenshot(
      path.join(runDirectory, "flatpak-release-prompt.png"),
    );

    await clickModalButton("Open Release Page");
    await browser.waitUntil(
      async () => (await readProbe()).opened.length === 1,
      {
        timeout: 10_000,
        timeoutMsg: "the release page was not requested",
      },
    );
    const opened = await readProbe();
    assert.deepEqual(opened.opened, [`${RELEASE_URL_BASE}${version}`]);
    assert.ok(
      opened.checkTargets.every((target) => target === null),
      JSON.stringify(opened),
    );

    // Refusals hold even when the UI cannot reach them.
    const download = await api("downloadUpdate");
    assert.ok(download?.error, JSON.stringify(download));
    await api("installUpdate");
    const refused = await waitForModal("Update Error");
    assert.ok(refused.message.includes("Flatpak"), refused.message);
    await clickModalButton("OK");

    const probe = await readProbe();
    assert.equal(probe.downloads, 0);
    assert.equal(probe.installs, 0);
    assert.equal(probe.restarts, 0);
    assert.ok(
      !probe.invokes.includes("restart_app"),
      JSON.stringify(probe.invokes),
    );
    record("flatpak-newer-release-prompt", {
      version,
      openedUrl: probe.opened[0],
      buttons: prompt.buttons,
      downloads: probe.downloads,
      installs: probe.installs,
    });
  });

  it("reads the beta feed target in a Flatpak build on the beta channel", async () => {
    const current = await api("getAppVersion");
    const version = newerVersionThan(current);
    await freshRenderer();
    await installScenario({ flatpak: true, channel: "beta", version });

    await runManualCheck();
    const prompt = await waitForModal("Update Available!");
    assert.deepEqual(prompt.buttons, ["Open Release Page", "Later"]);
    const probe = await readProbe();
    assert.ok(probe.checkTargets.length > 0, "the feed was not checked");
    assert.ok(
      probe.checkTargets.every((target) => target === "linux-beta-x86_64"),
      JSON.stringify(probe.checkTargets),
    );
    assert.ok(probe.invokes.includes("get_beta_updater_target"));
    await clickModalButton("Later");
    const finalProbe = await readProbe();
    assert.deepEqual(finalProbe.opened, []);
    assert.equal(finalProbe.downloads, 0);
    record("flatpak-beta-feed-target", {
      target: "linux-beta-x86_64",
      version,
    });
  });

  it("reports the normal up-to-date result in a Flatpak build with no newer version", async () => {
    const current = await api("getAppVersion");
    await freshRenderer();
    await installScenario({ flatpak: true, channel: "stable", version: null });

    await runManualCheck();
    const modal = await waitForModal("ROSI is up to date!");
    assert.ok(modal.message.includes(`(v${current})`), modal.message);
    assert.deepEqual(modal.buttons, ["OK"]);
    await clickModalButton("OK");
    const probe = await readProbe();
    assert.deepEqual(probe.opened, []);
    assert.equal(probe.downloads, 0);
    record("flatpak-no-newer-version", { current, buttons: modal.buttons });
  });

  it("keeps Download & Install for non-Flatpak builds", async () => {
    const current = await api("getAppVersion");
    const version = newerVersionThan(current);
    await freshRenderer();
    await installScenario({ flatpak: false, channel: "stable", version });

    await runManualCheck();
    const prompt = await waitForModal("Update Available!");
    assert.deepEqual(prompt.buttons, ["Download & Install", "Later"]);
    await clickModalButton("Download & Install");
    await browser.waitUntil(async () => (await readProbe()).downloads === 1, {
      timeout: 10_000,
      timeoutMsg: "the update download was not started",
    });
    await waitForModal("Update Ready!");
    await clickModalButton("Later");
    const probe = await readProbe();
    assert.deepEqual(probe.opened, []);
    assert.equal(probe.installs, 0);
    assert.equal(probe.restarts, 0);
    record("non-flatpak-download-path", {
      version,
      downloads: probe.downloads,
    });
  });
});
