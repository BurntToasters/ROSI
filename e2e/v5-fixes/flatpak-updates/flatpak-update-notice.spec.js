import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import {
  captureUpdaterStatuses,
  clickManualCheck,
  setUpdateChannel,
  startUpdaterFixture,
} from "../../helpers/updater-engine-fixture.js";

// Flatpak update notice. A Flatpak build checks the feed like other builds.
// A newer version shows a prompt that opens the GitHub release page, and
// download and install never run. The Rust updater runs for real; its feed is
// a local signed server, and the engine probe counts installs and restarts.
const RELEASE_URL_BASE = "https://github.com/BurntToasters/ROSI/releases/tag/v";
const BETA_TARGET = "linux-beta-x86_64";
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
let fixture = null;

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

// Without an explicit target the engine requests latest-{os}.json, then looks
// up {os}-{arch} inside that manifest.
function osName() {
  return { darwin: "darwin", linux: "linux", win32: "windows" }[
    process.platform
  ];
}

function stableTarget() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  return `${osName()}-${arch}`;
}

async function freshRenderer() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await waitForAppReady();
}

async function installScenario({ flatpak, channel, version }) {
  if (fixture) await fixture.close();
  // The channel is set before the feed is configured, so no stale check runs.
  await setUpdateChannel(channel);
  fixture = await startUpdaterFixture({
    isPackaged: true,
    isFlatpak: flatpak,
    betaTarget: BETA_TARGET,
  });
  const route = channel === "beta" ? BETA_TARGET : osName();
  if (version) {
    fixture.server.publish({
      target: channel === "beta" ? BETA_TARGET : stableTarget(),
      route,
      version,
      payload: Buffer.from(`flatpak scenario ${version}`),
      fileName: `ROSI-${version}.bin`,
    });
  } else {
    // 204 No Content: the feed answers, and there is no newer version.
    fixture.server.respond(route, 204);
  }
  await browser.execute(() => {
    window.flatpakUpdateProbe = { opened: [] };
    window.api.openExternal = async (url) => {
      window.flatpakUpdateProbe.opened.push(url);
      return { ok: true, data: { opened: true } };
    };
  });
  await captureUpdaterStatuses("flatpakStatuses");
}

async function readProbe() {
  const opened = await browser.execute(() =>
    window.flatpakUpdateProbe.opened.slice(),
  );
  const engine = await browser.executeAsync((done) => {
    window.__TAURI__.core.invoke("e2e_updater_probe").then(
      (data) => done(data),
      (error) => done({ error: String(error) }),
    );
  });
  const requests = fixture.server.requests.map((request) => request.path);
  return {
    opened,
    downloads: requests.filter((item) => item.startsWith("/artifacts/")).length,
    installs: engine.installs,
    restarts: engine.restarts,
    checkTargets: requests
      .filter((item) => item.startsWith("/latest-"))
      .map((item) => item.slice("/latest-".length, -".json".length)),
  };
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

async function invokeEngine(command, args) {
  return browser.executeAsync(
    (name, payload, done) => {
      window.__TAURI__.core.invoke(name, payload).then(
        (data) => done({ ok: true, data: data ?? null }),
        (error) => done({ error: String(error) }),
      );
    },
    command,
    args,
  );
}

describe("Flatpak update notice E2E", () => {
  before(waitForAppReady);
  after(async () => {
    if (fixture) await fixture.close();
    writeReport();
  });

  it("prompts with the release page for a newer Flatpak build and never downloads or installs", async () => {
    const current = await api("getAppVersion");
    const version = newerVersionThan(current);
    await freshRenderer();
    await installScenario({ flatpak: true, channel: "stable", version });

    await clickManualCheck();
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
      opened.checkTargets.every((target) => target === osName()),
      JSON.stringify(opened),
    );

    // Refusals hold even when the UI cannot reach them.
    const candidateId = await browser.execute(
      () =>
        window.flatpakStatuses
          .filter((event) => event.status === "available")
          .at(-1)?.candidateId,
    );
    const download = await invokeEngine("download_update", { candidateId });
    assert.ok(download.data?.error, JSON.stringify(download));
    await invokeEngine("install_update", { candidateId });
    const refused = await waitForModal("Update Error");
    assert.ok(refused.message.includes("Flatpak"), refused.message);
    await clickModalButton("OK");

    const probe = await readProbe();
    assert.equal(probe.downloads, 0);
    assert.equal(probe.installs, 0);
    assert.equal(probe.restarts, 0);
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

    await clickManualCheck();
    const prompt = await waitForModal("Update Available!");
    assert.deepEqual(prompt.buttons, ["Open Release Page", "Later"]);
    const probe = await readProbe();
    assert.ok(probe.checkTargets.length > 0, "the feed was not checked");
    assert.ok(
      probe.checkTargets.every((target) => target === BETA_TARGET),
      JSON.stringify(probe.checkTargets),
    );
    await clickModalButton("Later");
    const finalProbe = await readProbe();
    assert.deepEqual(finalProbe.opened, []);
    assert.equal(finalProbe.downloads, 0);
    record("flatpak-beta-feed-target", {
      target: BETA_TARGET,
      version,
    });
  });

  it("reports the normal up-to-date result in a Flatpak build with no newer version", async () => {
    const current = await api("getAppVersion");
    await freshRenderer();
    await installScenario({ flatpak: true, channel: "stable", version: null });

    await clickManualCheck();
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

    await clickManualCheck();
    const prompt = await waitForModal("Update Available!");
    assert.deepEqual(prompt.buttons, ["Download & Install", "Later"]);
    await clickModalButton("Download & Install");
    await browser.waitUntil(async () => (await readProbe()).downloads === 1, {
      timeout: 15_000,
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
