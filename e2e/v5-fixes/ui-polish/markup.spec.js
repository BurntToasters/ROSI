import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const CANCEL_LABEL = "Cancel queue";
const CANCEL_MESSAGE =
  "Stops the active download and marks every pending item as cancelled.";
const REMOVE_FINISHED_MESSAGE = "Removed 4 finished items.";
const PROXY = "http://markup-proxy.example:8080";
// Success toast of a settings section reset (UI_MESSAGES.settings.resetSaved).
const RESET_SAVED_TOAST = "Section restored to defaults.";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-markup-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-markup",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Source identity for this report: HEAD, a hash of the tracked diff, and the
// hash of each untracked file. Enough to tell which working tree produced it.
function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    head,
    workingTree:
      diff.length === 0 && untracked.length === 0 ? "clean" : "dirty",
    dirtyPatchSha256: sha256(diff),
    untrackedFiles: untracked.map((file) => ({
      path: file,
      sha256: sha256(fs.readFileSync(path.join(REPO_ROOT, file))),
    })),
  };
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

// One check per failure-mode row of markup.failure-modes.md. A check that
// throws is recorded as failed and rethrown so the case fails.
async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    report.checks.push({
      name,
      failureModes,
      status: "passed",
      invariantPassed: true,
      ...details,
    });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      failureModes,
      status: "failed",
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

async function waitFor(
  predicate,
  message,
  timeout = 10_000,
  argument = undefined,
) {
  await browser.waitUntil(async () => browser.execute(predicate, argument), {
    timeout,
    interval: 100,
    timeoutMsg: message,
  });
}

async function clickById(id) {
  await browser.execute((target) => {
    const element = document.getElementById(target);
    if (!element) throw new Error(`missing element ${target}`);
    element.click();
  }, id);
}

async function setControl(id, value) {
  await browser.execute(
    (target, next) => {
      const control = document.getElementById(target);
      if (!control) throw new Error(`missing control ${target}`);
      control.value = String(next);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
}

async function waitForModal(open) {
  await waitFor(
    (want) =>
      document.getElementById("app-modal")?.classList.contains("active") ===
      want,
    `modal did not ${open ? "open" : "close"}`,
    10_000,
    open,
  );
}

async function modalState() {
  return browser.execute(() => ({
    title: document.getElementById("modal-title")?.textContent.trim() ?? "",
    message: document.getElementById("modal-message")?.textContent.trim() ?? "",
    describedBy:
      document.getElementById("app-modal")?.getAttribute("aria-describedby") ??
      null,
    buttons: [...document.querySelectorAll("#modal-buttons button")].map(
      (button) => button.textContent.trim(),
    ),
  }));
}

async function clickModalButton(label) {
  await browser.execute((wantedLabel) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === wantedLabel,
    );
    if (!button) throw new Error(`missing modal action ${wantedLabel}`);
    button.click();
  }, label);
}

async function setSidebarOpen(open) {
  const isOpen = await browser.execute(
    () =>
      document.getElementById("sidebar")?.classList.contains("open") === true,
  );
  if (isOpen !== open) {
    await clickById(open ? "settingsBtn" : "closeSidebar");
    await waitFor(
      (want) =>
        document.getElementById("sidebar")?.classList.contains("open") === want,
      `settings did not ${open ? "open" : "close"}`,
      10_000,
      open,
    );
  }
  if (open) {
    // A hidden page runs no animation frames, so finish the slide there.
    const visibility = await browser.execute(() => document.visibilityState);
    if (visibility !== "visible") {
      await browser.execute(() => {
        document
          .getElementById("sidebar")
          ?.getAnimations()
          .forEach((animation) => animation.finish());
      });
    }
    await waitFor(
      () => {
        const sidebar = document.getElementById("sidebar");
        if (!sidebar) return false;
        const rect = sidebar.getBoundingClientRect();
        const restingLeft = parseFloat(getComputedStyle(sidebar).left);
        return Math.abs(rect.left - restingLeft) < 1;
      },
      "settings sidebar did not finish opening",
      10_000,
    );
  }
}

// Opens a section's Reset prompt through its header button.
async function openSectionReset(section) {
  await browser.execute((name) => {
    const button = document.querySelector(`[data-reset-section="${name}"]`);
    if (!button) throw new Error(`missing reset button for ${name}`);
    button.click();
  }, section);
  await waitForModal(true);
}

async function waitForBackendSettings(predicate, message) {
  await browser.waitUntil(async () => predicate(await api("getSettings")), {
    timeout: 15_000,
    interval: 150,
    timeoutMsg: message,
  });
}

// Waits briefly for any toast and returns the toast texts seen. Recorded for
// diagnosis; a missing toast does not fail the check on its own.
async function observeToasts(expected) {
  let seen = [];
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(() =>
          [
            ...document.querySelectorAll(
              "#toast-container, #toast-container-assertive",
            ),
          ]
            .map((container) => container.textContent.trim())
            .filter(Boolean),
        );
        return seen.some((text) => text.includes(expected));
      },
      { timeout: 5_000, interval: 150 },
    )
    .catch(() => {});
  return seen;
}

async function queueStatusByUrl() {
  const queue = await api("getQueue");
  return Object.fromEntries(queue.map((item) => [item.url, item.status]));
}

describe("ROSI markup, queue cancel labels, and Remove finished", () => {
  before(async () => {
    await waitForAppReady();
    assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
    report.source = sourceIdentity();
    writeReport();
  });

  after(async () => {
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.result =
      report.failed === 0 && report.checks.length > 0 ? "passed" : "failed";
    writeReport();
  });

  it("names the queue cancel control and its prompt consistently", async () => {
    await api("clearQueue");
    await waitFor(
      () => !document.getElementById("queueSection")?.hidden,
      "queue panel did not open",
      5_000,
    ).catch(async () => {
      await clickById("dockTabQueue");
      await waitFor(
        () => !document.getElementById("queueSection")?.hidden,
        "queue panel did not open",
        5_000,
      );
    });

    // The cancel control is enabled only while a run is active, so start a
    // slow item and leave a second item pending behind it.
    const slow = `${MEDIA}/slow.mp4?markup=cancel`;
    const next = `${MEDIA}/clip-two.mp4?markup=cancel-next`;
    const added = await api("addToQueue", [slow, next]);
    assert.equal(added.ok, true, "could not queue the cancel items");
    await clickById("startQueueBtn");
    await browser.waitUntil(
      async () => (await queueStatusByUrl())[slow] === "downloading",
      { timeout: 30_000, timeoutMsg: "slow item never started" },
    );
    assert.equal(
      (await queueStatusByUrl())[next],
      "pending",
      "second item is not pending behind the active item",
    );

    await scenario("cancel-button-label-matches", [1], async () => {
      const button = await browser.execute(() => {
        const element = document.getElementById("cancelQueueBtn");
        return {
          text: element?.textContent.trim() ?? null,
          title: element?.getAttribute("title") ?? null,
          ariaLabel: element?.getAttribute("aria-label") ?? null,
        };
      });
      assert.equal(button.text, CANCEL_LABEL, "button text differs");
      assert.equal(button.title, CANCEL_LABEL, "button title differs");
      assert.equal(button.ariaLabel, CANCEL_LABEL, "aria-label differs");
      return button;
    });

    await clickById("cancelQueueBtn");
    await waitForModal(true);
    const prompt = await modalState();

    await scenario("cancel-modal-title-matches", [2], async () => {
      assert.equal(prompt.title, CANCEL_LABEL, "modal title differs");
      return { title: prompt.title };
    });

    await scenario("cancel-modal-message-states-effect", [3], async () => {
      assert.equal(prompt.message, CANCEL_MESSAGE, "modal message differs");
      return { message: prompt.message };
    });

    await scenario("cancel-modal-confirm-label", [4], async () => {
      assert.ok(
        prompt.buttons.includes(CANCEL_LABEL),
        `confirm button is not "${CANCEL_LABEL}": ${prompt.buttons.join(", ")}`,
      );
      assert.ok(
        prompt.buttons.includes("Keep Running"),
        "Keep Running missing",
      );
      return { buttons: prompt.buttons };
    });

    await clickModalButton("Keep Running");
    await waitForModal(false);
    await browser.pause(1_000);

    await scenario("keep-running-leaves-queue-unchanged", [5], async () => {
      const statuses = await queueStatusByUrl();
      assert.equal(
        statuses[slow],
        "downloading",
        "Keep Running stopped the item",
      );
      assert.equal(
        statuses[next],
        "pending",
        "Keep Running changed a pending item",
      );
      return { statuses: { active: statuses[slow], pending: statuses[next] } };
    });

    await clickById("cancelQueueBtn");
    await waitForModal(true);
    await clickModalButton(CANCEL_LABEL);
    await browser.waitUntil(
      async () => {
        const statuses = await queueStatusByUrl();
        return statuses[slow] === "cancelled" && statuses[next] === "cancelled";
      },
      {
        timeout: 60_000,
        interval: 300,
        timeoutMsg: "confirm did not cancel the active and pending items",
      },
    );
    await waitForModal(false);

    await scenario("confirm-cancels-active-and-pending", [5], async () => {
      const statuses = await queueStatusByUrl();
      assert.equal(statuses[slow], "cancelled", "active item not cancelled");
      assert.equal(statuses[next], "cancelled", "pending item not cancelled");
      return { statuses: { active: statuses[slow], pending: statuses[next] } };
    });
    await api("clearQueue");
  });

  it("removes finished queue items and keeps pending ones", async () => {
    await api("clearQueue");
    const cancelA = `${MEDIA}/clip-two.mp4?markup=rm-cancel-a`;
    const cancelB = `${MEDIA}/clip-two.mp4?markup=rm-cancel-b`;
    const missing = `${MEDIA}/missing.mp4?markup=rm-failed`;
    const good = `${MEDIA}/clip-two.mp4?markup=rm-completed`;
    const pendingA = `${MEDIA}/clip-two.mp4?markup=rm-pending-a`;
    const pendingB = `${MEDIA}/clip-two.mp4?markup=rm-pending-b`;
    const finished = [cancelA, cancelB, missing, good];

    // Cancelled items: cancel while the queue is idle, which marks each
    // pending item as cancelled without starting a download.
    assert.equal((await api("addToQueue", [cancelA, cancelB])).ok, true);
    assert.equal((await api("cancelQueue")).ok, true);

    // Failed and completed items come from one real run.
    assert.equal((await api("addToQueue", [missing, good])).ok, true);
    assert.equal((await api("startQueue")).ok, true);
    await browser.waitUntil(
      async () => {
        const statuses = await queueStatusByUrl();
        return statuses[missing] === "failed" && statuses[good] === "completed";
      },
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: "seed run did not finish",
      },
    );

    // Pending items are added after the run, so nothing starts them.
    assert.equal((await api("addToQueue", [pendingA, pendingB])).ok, true);

    await scenario(
      "remove-finished-starts-from-seeded-state",
      [21],
      async () => {
        const statuses = await queueStatusByUrl();
        const counts = {};
        Object.values(statuses).forEach((status) => {
          counts[status] = (counts[status] ?? 0) + 1;
        });
        assert.deepEqual(
          counts,
          { cancelled: 2, failed: 1, completed: 1, pending: 2 },
          "seeded queue does not hold the expected mix",
        );
        return { counts };
      },
    );

    await clickById("clearFinishedQueueBtn");
    await browser.waitUntil(async () => (await api("getQueue")).length === 2, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: "Remove finished did not remove the finished items",
    });
    const after = await queueStatusByUrl();

    await scenario("remove-finished-removes-finished-items", [18], async () => {
      const left = finished.filter((url) => url in after);
      assert.deepEqual(left, [], "finished items remain after Remove finished");
      return { removed: finished.length };
    });

    await scenario(
      "remove-finished-keeps-pending-items",
      [17, 20],
      async () => {
        assert.equal(after[pendingA], "pending", "pending item A was removed");
        assert.equal(after[pendingB], "pending", "pending item B was removed");
        return { remaining: Object.keys(after).length };
      },
    );

    await scenario("remove-finished-reports-count", [19], async () => {
      await waitFor(
        (expected) =>
          document.getElementById("queueStatusMessage")?.textContent.trim() ===
          expected,
        `status text did not read "${REMOVE_FINISHED_MESSAGE}"`,
        10_000,
        REMOVE_FINISHED_MESSAGE,
      );
      const text = await browser.execute(() =>
        document.getElementById("queueStatusMessage").textContent.trim(),
      );
      return { statusText: text };
    });

    await api("clearQueue");
  });

  it("applies the upstream proxy reset to Application only", async () => {
    await setSidebarOpen(true);
    const defaults = (await api("getDefaultSettings")).data;
    const marker = defaults.convertFormat === "mov" ? "mp3" : "mov";
    // Seed through the renderer, as a user edit does. A direct saveSettings call
    // skips the renderer's backend baseline, so the next section reset would
    // send no patch for keys that look unchanged to the renderer.
    await setControl("convertFormat", marker);
    await setControl("upstreamProxyInput", PROXY);
    await waitForBackendSettings(
      (settings) =>
        settings.upstreamProxy === PROXY && settings.convertFormat === marker,
      "renderer edits did not reach the backend",
    );

    await scenario("proxy-field-inside-application", [6], async () => {
      const section = await browser.execute(() => {
        const input = document.querySelectorAll("#upstreamProxyInput");
        if (input.length !== 1) return { count: input.length, body: null };
        return {
          count: input.length,
          body: input[0].closest(".settings-section-body")?.id ?? null,
        };
      });
      assert.equal(section.count, 1, "proxy id must match exactly one element");
      assert.equal(
        section.body,
        "settingsSectionBodyApplication",
        "proxy field is outside the Application section",
      );
      return section;
    });

    await scenario("proxy-field-id-and-value-persist", [7], async () => {
      const value = await browser.execute(
        () => document.getElementById("upstreamProxyInput")?.value ?? null,
      );
      assert.equal(value, PROXY, "proxy input does not show the stored value");
      const settings = await api("getSettings");
      assert.equal(settings.upstreamProxy, PROXY, "backend proxy differs");
      return { value };
    });

    await openSectionReset("download");
    const conversionPrompt = await modalState();

    await scenario(
      "conversion-reset-prompt-does-not-mention-proxy",
      [10],
      async () => {
        assert.doesNotMatch(
          `${conversionPrompt.title} ${conversionPrompt.message}`,
          /proxy/i,
          "Conversion reset prompt mentions the proxy",
        );
        return {
          title: conversionPrompt.title,
          message: conversionPrompt.message,
        };
      },
    );

    await scenario("reset-prompt-description-resolves", [11], async () => {
      const described = await browser.execute(() => {
        const id = document
          .getElementById("app-modal")
          ?.getAttribute("aria-describedby");
        const element = id ? document.getElementById(id) : null;
        return {
          id,
          text: element?.textContent.trim() ?? "",
          matchesMessage: element === document.getElementById("modal-message"),
        };
      });
      assert.equal(
        described.id,
        "modal-message",
        "aria-describedby is missing",
      );
      assert.ok(described.text.length > 0, "described element has no text");
      assert.equal(
        described.matchesMessage,
        true,
        "description is not the message",
      );
      return { describedBy: described.id };
    });

    await clickModalButton("Cancel");
    await waitForModal(false);

    await openSectionReset("download");
    await clickModalButton("Reset section");
    await waitForBackendSettings(
      (settings) => settings.convertFormat === defaults.convertFormat,
      "Conversion reset did not reach the backend",
    );
    const conversionToasts = await observeToasts(RESET_SAVED_TOAST);
    await waitForModal(false);

    await scenario("conversion-reset-keeps-proxy", [8], async () => {
      const settings = await api("getSettings");
      assert.equal(
        settings.upstreamProxy,
        PROXY,
        "Conversion reset cleared the proxy",
      );
      const value = await browser.execute(
        () => document.getElementById("upstreamProxyInput")?.value ?? null,
      );
      assert.equal(value, PROXY, "Conversion reset cleared the proxy input");
      return {
        convertFormat: settings.convertFormat,
        proxy: settings.upstreamProxy,
        resetToasts: conversionToasts,
      };
    });

    await openSectionReset("application");
    await clickModalButton("Reset section");
    await waitForBackendSettings(
      (settings) => settings.upstreamProxy === defaults.upstreamProxy,
      "Application reset did not clear the proxy",
    );
    const applicationToasts = await observeToasts(RESET_SAVED_TOAST);
    await waitForModal(false);

    await scenario("application-reset-clears-proxy", [9], async () => {
      const settings = await api("getSettings");
      assert.equal(
        settings.upstreamProxy,
        defaults.upstreamProxy,
        "Application reset did not clear the proxy",
      );
      const value = await browser.execute(
        () => document.getElementById("upstreamProxyInput")?.value ?? null,
      );
      assert.equal(
        value,
        defaults.upstreamProxy,
        "proxy input was not cleared",
      );
      return {
        proxy: settings.upstreamProxy,
        resetToasts: applicationToasts,
      };
    });
    await setSidebarOpen(false);
  });

  it("keeps the ARIA attribute fixes in the live DOM", async () => {
    await scenario("destination-strip-has-no-live-region", [12], async () => {
      const strip = await browser.execute(() => {
        const element = document.querySelector(".download-destination");
        return {
          found: Boolean(element),
          live: element?.getAttribute("aria-live") ?? null,
          hasControl: Boolean(
            element?.querySelector("#changeDownloadFolderBtn"),
          ),
        };
      });
      assert.equal(strip.found, true, "destination strip is missing");
      assert.equal(strip.live, null, "destination strip still has aria-live");
      assert.equal(strip.hasControl, true, "strip lost its folder control");
      return strip;
    });

    await scenario("no-element-has-alert-and-polite", [13], async () => {
      const result = await browser.execute(() => ({
        both: document.querySelectorAll('[role="alert"][aria-live="polite"]')
          .length,
        alerts: document.querySelectorAll('[role="alert"]').length,
        playlistAlert:
          document.getElementById("playlistScopeError")?.getAttribute("role") ??
          null,
        subtitleAlert:
          document.getElementById("subtitleLangsError")?.getAttribute("role") ??
          null,
      }));
      assert.equal(
        result.both,
        0,
        "an element has role=alert and aria-live=polite",
      );
      assert.ok(result.alerts > 0, "no role=alert element remains to check");
      assert.equal(
        result.playlistAlert,
        "alert",
        "playlist error lost role=alert",
      );
      assert.equal(
        result.subtitleAlert,
        "alert",
        "subtitle error lost role=alert",
      );
      return result;
    });

    await scenario("clear-history-title-matches-label", [14], async () => {
      const button = await browser.execute(() => {
        const element = document.getElementById("clearHistory");
        return {
          title: element?.getAttribute("title") ?? null,
          ariaLabel: element?.getAttribute("aria-label") ?? null,
        };
      });
      assert.equal(button.title, "Clear history", "title differs");
      assert.equal(button.ariaLabel, "Clear history", "aria-label differs");
      return button;
    });

    await scenario("update-info-does-not-announce-ticks", [15], async () => {
      const info = await browser.execute(() => {
        const element = document.getElementById("update-banner-info");
        return {
          found: Boolean(element),
          live: element?.getAttribute("aria-live") ?? null,
          role: element?.getAttribute("role") ?? null,
        };
      });
      assert.equal(info.found, true, "update info element is missing");
      assert.equal(info.live, null, "update info still has aria-live");
      assert.equal(info.role, null, "update info still has role=status");
      return info;
    });

    await scenario("update-progressbar-keeps-its-name", [16], async () => {
      const progress = await browser.execute(() => {
        const element = document.getElementById("update-banner-progress");
        const labelId = element?.getAttribute("aria-labelledby") ?? null;
        const label = labelId ? document.getElementById(labelId) : null;
        return {
          role: element?.getAttribute("role") ?? null,
          labelId,
          labelText: label?.textContent.trim() ?? "",
        };
      });
      assert.equal(progress.role, "progressbar", "progress lost its role");
      assert.equal(
        progress.labelId,
        "update-banner-text",
        "progress lost its name",
      );
      assert.ok(progress.labelText.length > 0, "progress name has no text");
      return progress;
    });
  });
});
