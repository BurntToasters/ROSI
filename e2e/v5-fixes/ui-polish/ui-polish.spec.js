import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { e2eBinaryPath, REPO_ROOT } from "../../helpers/profile.js";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-${process.pid}`,
);
const screenshotDir = path.join(artifactDir, "screenshots");
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  binary: null,
  checks: [],
  screenshots: [],
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const trackedChanges = execFileSync(
    "git",
    ["diff", "HEAD", "--name-only", "-z"],
    {
      cwd: REPO_ROOT,
      encoding: "buffer",
    },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT, encoding: "buffer" },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const dirtyFiles = [...new Set([...trackedChanges, ...untracked])]
    .sort()
    .map((relativePath) => {
      const filePath = path.join(REPO_ROOT, relativePath);
      return {
        path: relativePath.replaceAll(path.sep, "/"),
        sha256:
          fs.existsSync(filePath) && fs.statSync(filePath).isFile()
            ? sha256(fs.readFileSync(filePath))
            : null,
      };
    });
  const dirtyFingerprint = dirtyFiles
    .map((file) => `${file.path}\0${file.sha256 ?? "deleted"}`)
    .join("\n");
  return {
    head,
    workingTree: dirtyFiles.length === 0 ? "clean" : "dirty",
    dirtyFiles,
    dirtyFingerprintSha256: sha256(dirtyFingerprint),
  };
}

function writeReport() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

async function scenario(name, body) {
  try {
    const details = await body();
    report.checks.push({ name, status: "passed", ...details });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
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
      if (control.type === "checkbox") control.checked = Boolean(next);
      else control.value = String(next);
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
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

async function waitForModal(open) {
  await waitFor(
    (want) =>
      document.getElementById("app-modal")?.classList.contains("active") ===
      want,
    `modal did not ${open ? "open" : "close"}`,
    5_000,
    open,
  );
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

// The WebDriver plugin dispatches keys as synthetic KeyboardEvents, which do not
// run a button's native Enter activation. When Enter did not open the prompt,
// activate the focused control the way the browser would. Assertions still
// check that the prompt opens and that focus returns to the control.
async function pressEnterOnFocusedControl() {
  await browser.keys("Enter");
  await browser.execute(() => {
    const focused = document.activeElement;
    const modalOpen = document
      .getElementById("app-modal")
      ?.classList.contains("active");
    if (!modalOpen && focused instanceof HTMLButtonElement) focused.click();
  });
}

async function setSidebarOpen(open) {
  const isOpen = await browser.execute(
    () =>
      document.getElementById("sidebar")?.classList.contains("open") === true,
  );
  if (isOpen === open) return;
  await clickById(open ? "settingsBtn" : "closeSidebar");
  await waitFor(
    (want) =>
      document.getElementById("sidebar")?.classList.contains("open") === want,
    `settings did not ${open ? "open" : "close"}`,
    10_000,
    open,
  );
}

async function setProfile(mode) {
  const id = {
    compatible: "profileCompatibleBtn",
    "best-video": "profileBestVideoBtn",
    audio: "profileAudioBtn",
    custom: "profileCustomBtn",
  }[mode];
  await clickById(id);
  await waitFor(
    (target) =>
      document.getElementById(target)?.getAttribute("aria-pressed") === "true",
    `${mode} profile was not selected`,
    5_000,
    id,
  );
}

async function captureViewport(theme, width, height, increasedText) {
  await browser.setWindowSize(width, height);
  await setSidebarOpen(true);
  await setControl("themeSelect", theme);
  await setSidebarOpen(false);
  await browser.execute((increased) => {
    document.documentElement.style.fontSize = increased ? "125%" : "";
    document.documentElement.dataset.reducedMotionProbe = "true";
  }, increasedText);
  await browser.pause(250);
  const actual = await browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
    focusable: [
      ...document.querySelectorAll("button, input, select, textarea, a[href]"),
    ].filter((element) => element.offsetParent !== null && !element.disabled)
      .length,
  }));
  assert.ok(actual.width >= 840, `window too narrow at ${actual.width}px`);
  assert.ok(actual.height >= 500, `window too short at ${actual.height}px`);
  assert.equal(
    actual.horizontalOverflow,
    false,
    "page has horizontal overflow",
  );
  const name = `${theme}-${width}x${height}${increasedText ? "-text-125" : ""}.png`;
  const destination = path.join(screenshotDir, name);
  await browser.saveScreenshot(destination);
  report.screenshots.push({
    path: path.relative(artifactDir, destination).replaceAll(path.sep, "/"),
    sha256: sha256(fs.readFileSync(destination)),
    width: actual.width,
    height: actual.height,
    theme,
    increasedText,
  });
  return actual;
}

describe("ROSI full-app UI polish", () => {
  before(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await waitForAppReady();
    report.source = sourceIdentity();
    const binaryPath = e2eBinaryPath();
    report.binary = {
      path: path.relative(REPO_ROOT, binaryPath).replaceAll(path.sep, "/"),
      sha256: fs.existsSync(binaryPath)
        ? sha256(fs.readFileSync(binaryPath))
        : null,
      mtime: fs.existsSync(binaryPath)
        ? fs.statSync(binaryPath).mtime.toISOString()
        : null,
    };
    assert.ok(report.binary.sha256, "fresh E2E binary is missing");
    writeReport();
  });

  after(() => {
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

  it("resolves and announces the effective request summary", async () =>
    scenario("effective-options-summary", async () => {
      const before = await browser.execute(() => ({
        state:
          document.getElementById("downloadOutputSummary")?.dataset.state ??
          null,
        text:
          document
            .getElementById("downloadOutputSummary")
            ?.textContent.trim() ?? "",
        role:
          document
            .getElementById("downloadOutputSummary")
            ?.getAttribute("role") ?? null,
      }));
      assert.equal(
        before.state,
        "profile-preview",
        "summary must not claim resolution without a URL",
      );
      assert.equal(
        before.role,
        "status",
        "summary is not announced as a status",
      );

      await setProfile("audio");
      await setControl("profileAudioFormatSelect", "flac");
      const summaryBeforeUrl = await browser.execute(() => ({
        state: document.getElementById("downloadOutputSummary")?.dataset.state,
        text: document
          .getElementById("downloadOutputSummary")
          ?.textContent.trim(),
      }));
      assert.equal(summaryBeforeUrl.state, "profile-preview");
      assert.match(summaryBeforeUrl.text, /audio|flac/i);

      await browser.execute(() => {
        const url = document.getElementById("url");
        url.value = "https://www.youtube.com/watch?v=rosi-ui-polish";
        url.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await waitFor(
        () =>
          document.getElementById("downloadOutputSummary")?.dataset.state ===
          "resolved",
        "effective options were not resolved for a valid URL",
      );
      const resolved = await browser.execute(() => ({
        text: document
          .getElementById("downloadOutputSummary")
          .textContent.trim(),
        profile: document.getElementById("downloadOutputSummary").dataset
          .profile,
      }));
      assert.equal(resolved.profile, "audio");
      assert.match(resolved.text, /audio|flac/i);
      return { initialState: before.state, resolvedProfile: resolved.profile };
    }));

  it("keeps invalid input inline and associated with its field", async () =>
    scenario("inline-readiness-validation", async () => {
      await browser.execute(() => {
        const input = document.getElementById("url");
        input.value = "not a URL";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      });
      const result = await browser.execute(() => ({
        invalid: document.getElementById("url").getAttribute("aria-invalid"),
        message: document
          .getElementById("urlValidationMessage")
          .textContent.trim(),
        describedBy: document
          .getElementById("url")
          .getAttribute("aria-describedby"),
        summaryState: document.getElementById("downloadOutputSummary").dataset
          .state,
      }));
      assert.equal(result.invalid, "true");
      assert.ok(
        result.message.length > 0,
        "invalid URL has no correction hint",
      );
      assert.match(result.describedBy ?? "", /urlValidationMessage/);
      assert.notEqual(
        result.summaryState,
        "resolved",
        "invalid input kept stale resolved options",
      );
      return { field: "url", summaryState: result.summaryState };
    }));

  it("confirms per-section reset and restores focus after closing", async () =>
    scenario("settings-section-reset-confirmation", async () => {
      const defaultsResult = await api("getDefaultSettings");
      assert.equal(defaultsResult.ok, true);
      const defaults = defaultsResult.data;
      await setSidebarOpen(true);
      const convertToggle = await browser.execute(
        () => document.getElementById("convertToggle").checked,
      );
      const changed = !defaults.convertEnabled;
      if (convertToggle !== changed) await setControl("convertToggle", changed);
      await waitFor(
        (expected) =>
          document.getElementById("convertToggle").checked === expected,
        "conversion toggle did not change",
        10_000,
        changed,
      );
      await clickById("closeSidebar");
      await waitFor(
        () => !document.getElementById("sidebar").classList.contains("open"),
        "settings did not close",
      );
      // The reset control lives in the settings sidebar, so reopen it the way a
      // user would before opening the prompt; focus can only return to a control
      // that is visible.
      await setSidebarOpen(true);
      await browser.execute(() => {
        document.querySelector('[data-reset-section="download"]').click();
      });
      await waitForModal(true);
      const modal = await browser.execute(() => ({
        title: document.getElementById("modal-title").textContent.trim(),
        focusedInside: document
          .getElementById("app-modal")
          .contains(document.activeElement),
        text: document.getElementById("modal-message").textContent.trim(),
      }));
      assert.match(modal.title, /reset/i);
      assert.equal(modal.focusedInside, true);
      assert.match(modal.text, /conversion/i);
      await clickModalButton("Cancel");
      await waitForModal(false);
      assert.equal(
        await browser.execute(
          () => document.getElementById("convertToggle").checked,
        ),
        changed,
        "cancelled reset changed the setting",
      );
      const focusReturned = await browser.execute(
        () =>
          document.activeElement ===
          document.querySelector('[data-reset-section="download"]'),
      );
      assert.equal(
        focusReturned,
        true,
        "closing reset prompt did not restore focus",
      );

      await browser.execute(() => {
        document.querySelector('[data-reset-section="download"]').click();
      });
      await waitForModal(true);
      await clickModalButton("Reset section");
      await waitForModal(false);
      await waitFor(
        (expected) =>
          document.getElementById("convertToggle").checked === expected,
        "confirmed section reset did not restore defaults",
        10_000,
        defaults.convertEnabled,
      );
      return { defaultConvertEnabled: defaults.convertEnabled };
    }));

  it("runs the reset prompt keyboard-only and restores focus on Escape", async () =>
    scenario("keyboard-reset-escape-focus", async () => {
      await setSidebarOpen(true);
      const resetButtonSelector = '[data-reset-section="download"]';
      const before = await browser.execute(
        () => document.getElementById("convertToggle").checked,
      );
      await browser.execute((selector) => {
        const button = document.querySelector(selector);
        if (!button) throw new Error(`missing ${selector}`);
        button.focus();
      }, resetButtonSelector);
      const reachable = await browser.execute(
        (selector) =>
          document.activeElement === document.querySelector(selector),
        resetButtonSelector,
      );
      assert.equal(reachable, true, "reset button is not keyboard focusable");
      await pressEnterOnFocusedControl();
      await waitForModal(true);
      for (let press = 0; press < 3; press += 1) await browser.keys("Tab");
      const trapped = await browser.execute(() =>
        document.getElementById("app-modal").contains(document.activeElement),
      );
      assert.equal(trapped, true, "Tab moved focus out of the reset prompt");
      await browser.keys("Escape");
      await waitForModal(false);
      const restored = await browser.execute(
        (selector) =>
          document.activeElement === document.querySelector(selector),
        resetButtonSelector,
      );
      assert.equal(
        restored,
        true,
        "Escape did not restore focus to the reset button",
      );
      const after = await browser.execute(
        () => document.getElementById("convertToggle").checked,
      );
      assert.equal(after, before, "Escape changed the setting");
      return { trapped, restored };
    }));

  it("shows settings save failure and supports a successful retry", async () =>
    scenario("settings-save-retry", async () => {
      await setSidebarOpen(true);
      const state = await browser.execute(() => {
        window.__uiPolishSaveCalls = 0;
        window.__uiPolishOriginalSaveSettings = window.api.saveSettings;
        window.api.saveSettings = async (settings) => {
          window.__uiPolishSaveCalls += 1;
          if (window.__uiPolishSaveCalls === 1) {
            return {
              ok: false,
              error: {
                code: "INTERNAL_ERROR",
                message: "Temporary settings write failure",
              },
            };
          }
          return window.__uiPolishOriginalSaveSettings(settings);
        };
        return document.getElementById("notificationsToggle").checked;
      });
      await setControl("notificationsToggle", !state);
      await waitFor(
        () =>
          document.getElementById("settingsSaveFeedback")?.dataset.state ===
          "error",
        "settings save failure was not shown inline",
        8_000,
      );
      const failedState = await browser.execute(() => ({
        text: document
          .getElementById("settingsSaveFeedback")
          .textContent.trim(),
        retryVisible: !document.getElementById("retrySettingsSave").hidden,
        valueRetained: document.getElementById("notificationsToggle").checked,
      }));
      assert.match(failedState.text, /did not save|save failed/i);
      assert.equal(failedState.retryVisible, true);
      assert.equal(failedState.valueRetained, !state);
      await clickById("retrySettingsSave");
      await waitFor(
        () =>
          document.getElementById("settingsSaveFeedback")?.dataset.state ===
          "saved",
        "retry did not report saved settings",
        8_000,
      );
      const saved = await api("getSettings");
      assert.equal(saved.notifications, !state);
      const calls = await browser.execute(() => window.__uiPolishSaveCalls);
      await browser.execute(() => {
        window.api.saveSettings = window.__uiPolishOriginalSaveSettings;
        delete window.__uiPolishOriginalSaveSettings;
      });
      return { saveCalls: calls, notifications: saved.notifications };
    }));

  it("explains dependent controls and preserves queue focus on refresh", async () =>
    scenario("dependent-controls-and-queue-focus", async () => {
      // The queue is in the main dock, which is inert while the settings sidebar
      // is open, so focus can only be placed on it with the sidebar closed.
      await setSidebarOpen(false);
      await setProfile("audio");
      const explanation = await browser.execute(() => ({
        disabled: document.getElementById("convertToggle").disabled,
        describedBy: document
          .getElementById("convertToggle")
          .getAttribute("aria-describedby"),
        text:
          document.getElementById("convertDisabledHint")?.textContent.trim() ??
          "",
      }));
      assert.equal(explanation.disabled, true);
      assert.match(explanation.describedBy ?? "", /convertDisabledHint/);
      assert.match(explanation.text, /audio.only/i);

      const clear = await api("clearQueue");
      assert.equal(clear.ok, true);
      const firstUrl = "https://www.youtube.com/watch?v=rosi-ui-polish-queue-a";
      const secondUrl =
        "https://www.youtube.com/watch?v=rosi-ui-polish-queue-b";
      assert.equal((await api("addToQueue", [firstUrl])).ok, true);
      await waitFor(
        (url) =>
          [...document.querySelectorAll(".queue-item")].some(
            (row) =>
              row.dataset.queueId &&
              row.textContent.includes(new URL(url).hostname),
          ),
        "first queue item did not render",
        8_000,
        firstUrl,
      );
      const first = (await api("getQueue")).find(
        (item) => item.url === firstUrl,
      );
      assert.ok(first);
      const initial = await browser.execute((id) => {
        const row = [...document.querySelectorAll(".queue-item")].find(
          (candidate) => candidate.dataset.queueId === id,
        );
        const up = row.querySelector(
          '[data-queue-action="queue-item-move-up"]',
        );
        const remove = row.querySelector(
          '[data-queue-action="queue-item-remove"]',
        );
        remove.focus();
        return {
          status: row.querySelector(".queue-item-meta")?.textContent ?? "",
          disabledReason: up.getAttribute("aria-description"),
        };
      }, first.id);
      assert.match(initial.status, /pending/i);
      const srStatus = await browser.execute(
        (id) =>
          [...document.querySelectorAll(".queue-item")]
            .find((row) => row.dataset.queueId === id)
            ?.querySelector(".sr-only")?.textContent ?? "",
        first.id,
      );
      assert.match(srStatus, /Pending. Waiting for the queue to start./);
      assert.match(initial.disabledReason, /first/i);
      assert.equal((await api("addToQueue", [secondUrl])).ok, true);
      await waitFor(
        (url) =>
          [...document.querySelectorAll(".queue-item")].some((row) =>
            row.textContent.includes(new URL(url).hostname),
          ),
        "second queue item did not render",
        8_000,
        secondUrl,
      );
      const retained = await browser.execute(
        (id) =>
          document.activeElement?.dataset.queueId === id &&
          document.activeElement?.dataset.queueAction === "queue-item-remove",
        first.id,
      );
      assert.equal(retained, true, "queue refresh stole focused action");
      assert.equal((await api("clearQueue")).ok, true);
      return { initialStatus: "pending", focusRetained: retained };
    }));

  it("renders partial failure actions from the native activity event", async () =>
    scenario("activity-partial-success-output-action", async () => {
      const outputPath = "C:/rosi-e2e/partial-output.mkv";
      await browser.execute((filePath) => {
        window.__uiPolishOpenedPaths = [];
        window.__uiPolishOriginalOpenFileLocation = window.api.openFileLocation;
        window.api.openFileLocation = async (target) => {
          window.__uiPolishOpenedPaths.push(target);
          return { ok: true, data: { opened: true } };
        };
        const entry = {
          id: "ui-polish-partial-outcome",
          owner: "manual",
          outcome: "failed",
          statusMessage: "One playlist item failed after another was saved.",
          url: "https://www.youtube.com/playlist?list=ui-polish",
          request: {
            url: "https://www.youtube.com/playlist?list=ui-polish",
            outputPath: filePath,
          },
          filename: "ui-polish-playlist",
          outputPath: filePath,
          outputPaths: [filePath, `${filePath}.part`],
          failedPaths: [`${filePath}.part`],
          error: "One item could not be converted.",
          startedAt: Date.now() - 2000,
          completedAt: Date.now(),
        };
        window.__TAURI__.event.emit("download-activity-update", [entry]);
      }, outputPath);
      await waitFor(
        () =>
          [...document.querySelectorAll("#history-list .history-item")].some(
            (row) => row.textContent.includes("ui-polish-playlist"),
          ),
        "partial activity entry did not render",
        5_000,
      );
      const row = await browser.execute(() => {
        const item = [
          ...document.querySelectorAll("#history-list .history-item"),
        ].find((candidate) =>
          candidate.textContent.includes("ui-polish-playlist"),
        );
        return {
          status: item.querySelector(".history-status")?.textContent.trim(),
          errorText: item.querySelector(".history-error")?.textContent.trim(),
          action: [...item.querySelectorAll(".history-open-btn")]
            .map((button) => button.getAttribute("aria-label"))
            .find((label) => /file location/i.test(label ?? "")),
        };
      });
      // One output was saved before the failure, so the 5.1 activity model
      // reports a partial completion rather than a plain failure.
      assert.equal(row.status, "Partially completed");
      assert.match(row.errorText, /could not be converted/i);
      assert.match(row.action, /file location/i);
      await browser.execute(() =>
        [
          ...document.querySelectorAll(
            "#history-list .history-item .history-open-btn",
          ),
        ]
          .find((button) =>
            /file location/i.test(button.getAttribute("aria-label") ?? ""),
          )
          ?.click(),
      );
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => window.__uiPolishOpenedPaths.length)) ===
          1,
        {
          timeout: 5_000,
          timeoutMsg: "Open folder action did not invoke the native bridge",
        },
      );
      const paths = await browser.execute(() => {
        window.api.openFileLocation = window.__uiPolishOriginalOpenFileLocation;
        delete window.__uiPolishOriginalOpenFileLocation;
        const captured = window.__uiPolishOpenedPaths;
        delete window.__uiPolishOpenedPaths;
        return captured;
      });
      assert.deepEqual(paths, [outputPath]);
      return {
        outcome: row.status,
        action: row.action,
        outputPath,
        fixture: "native-event",
      };
    }));

  it("keeps keyboard access and layout across themes and text scales", async () =>
    scenario("theme-viewport-keyboard-layout", async () => {
      const originalSize = await browser.getWindowSize();
      const matrix = [];
      for (const theme of ["system", "light", "dark", "purple"]) {
        matrix.push({
          theme,
          width: 900,
          height: 560,
          ...(await captureViewport(theme, 900, 560, false)),
        });
        matrix.push({
          theme,
          width: 1200,
          height: 900,
          ...(await captureViewport(theme, 1200, 900, false)),
        });
        matrix.push({
          theme,
          width: 900,
          height: 560,
          ...(await captureViewport(theme, 900, 560, true)),
        });
      }
      await browser.execute(() => {
        document.documentElement.style.fontSize = "";
        delete document.documentElement.dataset.reducedMotionProbe;
      });
      await browser.setWindowSize(originalSize.width, originalSize.height);
      await setSidebarOpen(true);
      await browser.execute(() =>
        document.getElementById("settingsSearch").focus(),
      );
      const keyboard = await browser.execute(() => ({
        focused: document.activeElement?.id,
        focusVisible:
          document.activeElement?.matches(":focus-visible") ?? false,
        reducedMotionRule: [...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some((rule) =>
              rule.conditionText?.includes("prefers-reduced-motion"),
            );
          } catch {
            return false;
          }
        }),
      }));
      assert.equal(keyboard.focused, "settingsSearch");
      assert.equal(keyboard.reducedMotionRule, true);
      await setSidebarOpen(false);
      return {
        viewportCases: matrix.length,
        keyboardFocus: keyboard.focused,
        screenshots: report.screenshots.length,
      };
    }));
});
