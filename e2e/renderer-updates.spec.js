import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";
import { startUpdaterFixture } from "./helpers/updater-engine-fixture.js";

const RESULT_PATH =
  process.env.ROSI_ROUND2_RENDERER_RESULTS || process.env.ROSI_E2E_RESULTS;
const observations = [];

function record(name, details) {
  observations.push({ name, status: "passed", ...details });
  if (RESULT_PATH) {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(observations, null, 2)}\n`);
  }
}

async function waitForModal(titleText) {
  try {
    await browser.waitUntil(
      () =>
        browser.execute((expectedTitle) => {
          const modal = document.getElementById("app-modal");
          return (
            modal?.classList.contains("active") &&
            document
              .getElementById("modal-title")
              ?.textContent?.includes(expectedTitle)
          );
        }, titleText),
      {
        timeout: 10_000,
        timeoutMsg: `modal ${titleText} did not appear`,
      },
    );
  } catch (error) {
    const currentModal = await browser.execute(() => {
      const modal = document.getElementById("app-modal");
      return {
        active: modal?.classList.contains("active") ?? false,
        showing: modal?.classList.contains("showing") ?? false,
        hiding: modal?.classList.contains("hiding") ?? false,
        title: document.getElementById("modal-title")?.textContent ?? "",
        message: document.getElementById("modal-message")?.textContent ?? "",
      };
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; current modal=${JSON.stringify(currentModal)}`);
  }
  return browser.execute(() => ({
    title: document.getElementById("modal-title")?.textContent ?? "",
    message: document.getElementById("modal-message")?.textContent ?? "",
  }));
}

async function clickModalButton(label) {
  await browser.execute((expectedLabel) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === expectedLabel,
    );
    if (!button) throw new Error(`modal button ${expectedLabel} was not found`);
    button.click();
  }, label);
}

async function dismissModal(titleText, label) {
  await waitForModal(titleText);
  await clickModalButton(label);
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !document.getElementById("app-modal")?.classList.contains("active"),
      ),
    {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: `modal ${titleText} did not finish dismissing`,
    },
  );
}

describe("renderer round-two repairs", () => {
  before(waitForAppReady);

  it("waits for startup settings before reporting the window ready", async () => {
    const saved = await api("getSettings");
    const rendered = await browser.execute(() => ({
      theme: document.getElementById("themeSelect")?.value,
      updateChannel: document.getElementById("updateChannelSelect")?.value,
      selectedProfiles: Object.fromEntries(
        ["compatible", "best-video", "audio", "custom"].map((mode) => [
          mode,
          document
            .getElementById(
              `profile${mode === "best-video" ? "BestVideo" : mode[0].toUpperCase() + mode.slice(1)}Btn`,
            )
            ?.classList.contains("selected"),
        ]),
      ),
    }));
    assert.equal(rendered.theme, saved.theme);
    assert.equal(rendered.updateChannel, saved.updateChannel ?? "auto");
    const downloadMode = saved.downloadMode ?? "compatible";
    assert.equal(rendered.selectedProfiles[downloadMode], true);
    record("renderer-startup-settings-ready", {
      theme: rendered.theme,
      updateChannel: rendered.updateChannel,
      downloadMode,
      closeListenerReadyBeforeReveal: true,
    });
  });

  it("keeps updater downloads single-flight and revalidates the target through install", async () => {
    const platformOs =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : "windows";
    const stableTarget = `${platformOs}-aarch64`;
    const betaTarget = "darwin-beta-round2-app";
    const engine = async (command, args) =>
      browser.executeAsync(
        (name, payload, done) => {
          window.__TAURI__.core.invoke(name, payload).then(
            (data) => done({ ok: true, data: data ?? null }),
            (error) => done({ error: String(error) }),
          );
        },
        command,
        args,
      );
    const probe = async () => {
      const result = await engine("e2e_updater_probe");
      assert.ok(result.ok, JSON.stringify(result));
      return result.data;
    };
    const statuses = () => browser.execute(() => window.round2Statuses.slice());
    const latestAvailable = async (version) =>
      (await statuses())
        .filter(
          (event) => event.status === "available" && event.version === version,
        )
        .at(-1);
    const waitForAvailable = (version, after = 0) =>
      browser.waitUntil(
        async () =>
          (await statuses()).filter(
            (event) =>
              event.status === "available" && event.version === version,
          ).length > after,
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: `update ${version} was not offered`,
        },
      );

    // The beta channel is set before the feed; its background recheck settles first.
    await engine("set_update_channel", { channel: "beta" });
    await browser.pause(1_500);
    const fixture = await startUpdaterFixture({
      betaTarget,
      disableCompact: true,
      restartRefusals: 1,
    });
    await browser.execute(() => {
      window.round2Statuses = [];
      window.__TAURI__.event.listen("updater-status", (event) =>
        window.round2Statuses.push(event.payload),
      );
    });
    const artifactRequests = () =>
      fixture.server.requests.filter((request) =>
        request.path.startsWith("/artifacts/"),
      ).length;
    const probeBefore = await probe();
    const checkManually = () =>
      browser.execute(() => document.getElementById("checkUpdateBtn").click());

    try {
      // One transfer at a time: a second download is refused while the first runs.
      let releaseFirst;
      fixture.server.publish({
        target: betaTarget,
        version: "9.0.0-beta.1",
        payload: Buffer.from("single-flight first payload"),
        fileName: "ROSI-round2-1.bin",
        gate: new Promise((resolve) => {
          releaseFirst = resolve;
        }),
      });
      await checkManually();
      await waitForAvailable("9.0.0-beta.1");
      const first = await latestAvailable("9.0.0-beta.1");
      await dismissModal("Update Available", "Later");
      await browser.execute((id) => {
        window.round2FirstDownload = undefined;
        window.__TAURI__.core
          .invoke("download_update", { candidateId: id })
          .then((data) => {
            window.round2FirstDownload = data;
          });
      }, first.candidateId);
      await browser.waitUntil(() => artifactRequests() === 1, {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "first transfer did not start",
      });
      const second = await engine("download_update", {
        candidateId: first.candidateId,
      });
      assert.equal(second.data?.error, "A download is already in progress.");

      // Cancel, then let the held response finish: its bytes are discarded.
      await engine("cancel_update_download");
      await dismissModal("Download Cancelled", "OK");
      releaseFirst();
      await browser.waitUntil(
        () => browser.execute(() => window.round2FirstDownload !== undefined),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "cancelled transfer did not settle",
        },
      );
      assert.deepEqual(
        await browser.execute(() => window.round2FirstDownload),
        {
          success: false,
          cancelled: true,
          error: null,
        },
      );
      assert.ok(
        !(await statuses()).some(
          (event) =>
            event.status === "downloaded" &&
            event.candidateId === first.candidateId,
        ),
        "a cancelled late transfer was reported as downloaded",
      );

      // A downloaded candidate is released when the channel changes before Restart Now.
      fixture.server.publish({
        target: betaTarget,
        version: "9.0.0-beta.2",
        payload: Buffer.from("target revalidation payload"),
        fileName: "ROSI-round2-2.bin",
      });
      await checkManually();
      await waitForAvailable("9.0.0-beta.2");
      const second2 = await latestAvailable("9.0.0-beta.2");
      await dismissModal("Update Available", "Later");
      await browser.execute((id) => {
        window.__TAURI__.core.invoke("download_update", { candidateId: id });
      }, second2.candidateId);
      await dismissModal("Update Ready", "Later");
      const installsBeforeStale = (await probe()).installs;
      const checkingBefore = (await statuses()).filter(
        (event) => event.status === "checking",
      ).length;
      await engine("set_update_channel", { channel: "stable" });
      await browser.waitUntil(
        async () =>
          (await statuses()).filter((event) => event.status === "checking")
            .length > checkingBefore,
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "channel change did not recheck",
        },
      );
      await engine("install_update", { candidateId: second2.candidateId });
      await browser.pause(800);
      assert.equal(
        (await probe()).installs,
        installsBeforeStale,
        "a candidate from the former channel was installed",
      );
      assert.equal(
        await browser.execute(() =>
          document.getElementById("app-modal")?.classList.contains("active"),
        ),
        false,
      );
      record("updater-channel-and-singleflight", {
        singleflightRefused: second.data.error,
        lateCancelledTransferDiscarded: true,
        staleChannelInstallCalls:
          (await probe()).installs - installsBeforeStale,
        stableTargetChecked: stableTarget,
      });

      // Background feed errors stay quiet; a manual feed error is shown.
      fixture.server.respond(betaTarget, 500, "boom");
      await engine("set_update_channel", { channel: "beta" });
      await browser.waitUntil(
        async () =>
          (await statuses()).some(
            (event) => event.status === "error" && event.kind === "feed",
          ),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "background feed error was not reported",
        },
      );
      await browser.pause(400);
      assert.equal(
        await browser.execute(() =>
          document.getElementById("app-modal")?.classList.contains("active"),
        ),
        false,
        "a background feed error opened a dialog",
      );
      await checkManually();
      const manualError = await waitForModal("Update Error");
      assert.ok(
        manualError.message.length > 0,
        "manual feed error showed no message",
      );
      await dismissModal("Update Error", "OK");

      // Installation errors stay visible with no manual check active.
      fixture.server.publish({
        target: betaTarget,
        version: "9.0.0-beta.3",
        payload: Buffer.from("install error payload"),
        fileName: "ROSI-round2-3.bin",
      });
      await checkManually();
      await waitForAvailable("9.0.0-beta.3");
      const third = await latestAvailable("9.0.0-beta.3");
      await dismissModal("Update Available", "Later");
      await engine("download_update", { candidateId: third.candidateId });
      await engine("install_update", { candidateId: third.candidateId });
      const installError = await waitForModal("Update Error");
      assert.match(installError.message, /refused/);
      await dismissModal("Update Error", "OK");
      const probeAfter = await probe();
      assert.equal(probeAfter.refusedRestarts - probeBefore.refusedRestarts, 1);
      record("updater-channel-and-singleflight-install-error", {
        installErrorVisible: installError.message.includes("refused"),
        manualFeedErrorVisible: manualError.title,
      });
    } finally {
      await fixture.close();
      await browser.execute(() => {
        if (
          document.getElementById("app-modal")?.classList.contains("active")
        ) {
          const dismiss = [
            ...document.querySelectorAll("#modal-buttons button"),
          ].find((button) =>
            ["Later", "OK"].includes(button.textContent.trim()),
          );
          dismiss?.click();
        }
      });
    }
  });

  it("keeps legacy activity until the backend confirms a clear", async () => {
    const initialClear = await api("clearDownloadActivity");
    assert.equal(initialClear.ok, true);
    const legacy = [
      {
        filename: "round-two-legacy.mp4",
        path: "/tmp/round-two-legacy.mp4",
        timestamp: Date.now(),
        status: "success",
      },
    ];
    await browser.execute(() => {
      window.round2OriginalClearActivity = window.api.clearDownloadActivity;
    });

    try {
      await browser.execute((entries) => {
        window.localStorage.setItem(
          "rosi-download-history",
          JSON.stringify(entries),
        );
        window.api.clearDownloadActivity = async () => ({
          ok: false,
          error: {
            code: "controlled-failure",
            message: "controlled history clear failure",
          },
        });
        document.getElementById("clearHistory").click();
      }, legacy);
      await dismissModal("Clear Activity", "Clear");
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            [...document.querySelectorAll(".toast-message")].some((node) =>
              node.textContent.includes("controlled history clear failure"),
            ),
          ),
        {
          timeout: 10_000,
          timeoutMsg: "activity clear failure was not visible",
        },
      );
      const afterFailure = await browser.execute(() => ({
        stored: window.localStorage.getItem("rosi-download-history"),
        visible: document.querySelector(".toast-message")?.textContent ?? "",
      }));
      assert.ok(afterFailure.stored);
      const normalizeEntries = (entries) =>
        entries.map((entry) =>
          Object.fromEntries(
            Object.entries(entry).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        );
      assert.deepEqual(
        normalizeEntries(JSON.parse(afterFailure.stored)),
        normalizeEntries(legacy),
      );

      await browser.execute(() => {
        window.api.clearDownloadActivity = window.round2OriginalClearActivity;
        document.getElementById("clearHistory").click();
      });
      await dismissModal("Clear Activity", "Clear");
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.localStorage.getItem("rosi-download-history") === null,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "legacy activity remained after a successful clear",
        },
      );
      assert.deepEqual((await api("getDownloadActivity")).data, []);
      record("activity-clear-commits-after-backend", {
        legacyRetainedOnFailure: true,
        failureToast: afterFailure.visible,
        legacyRemovedAfterSuccess: true,
      });
    } finally {
      await browser.execute(() => {
        if (window.round2OriginalClearActivity) {
          window.api.clearDownloadActivity = window.round2OriginalClearActivity;
        }
        window.localStorage.removeItem("rosi-download-history");
      });
    }
  });
});
