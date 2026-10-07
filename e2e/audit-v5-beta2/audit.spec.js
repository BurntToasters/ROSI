import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../helpers/app-bridge.js";

const directory = process.env.ROSI_AUDIT_DIRECTORY;
const downloads = process.env.ROSI_AUDIT_DOWNLOADS;
const media = process.env.ROSI_AUDIT_MEDIA;
const observations = [];
const securityOnly = process.env.ROSI_AUDIT_SECURITY_ONLY === "1";
const uiOnly = process.env.ROSI_AUDIT_UI_ONLY === "1";
const terminationOnly = process.env.ROSI_AUDIT_TERMINATION_ONLY === "1";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(name, details) {
  observations.push({ name, ...details });
  fs.writeFileSync(
    path.join(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}
async function activity(url, oldId) {
  let found;
  await browser.waitUntil(
    async () => {
      const response = await api("getDownloadActivity");
      found = response.data.find(
        (item) => item.url === url && item.id !== oldId,
      );
      return Boolean(found);
    },
    { timeout: 60_000, interval: 100, timeoutMsg: `No completion for ${url}` },
  );
  return found;
}
async function download(url, overrides = {}, oldId) {
  const response = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: false,
    hookBrowser: false,
    gpuAcceleration: false,
    ...overrides,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return activity(url, oldId);
}
function files() {
  return fs
    .readdirSync(downloads)
    .filter((name) => !name.startsWith(".rosi-"))
    .map((name) => ({
      name,
      sha256: hash(fs.readFileSync(path.join(downloads, name))),
    }));
}
function processes(marker) {
  const result = spawnSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes("rosi-yt-dlp") &&
        line.includes(marker) &&
        line.includes(`${media}/`),
    )
    .map((line) => ({
      pid: Number(line.trim().split(/\s+/)[0]),
      command: line.trim(),
    }));
}

(securityOnly || uiOnly || terminationOnly ? describe.skip : describe)(
  "V5 beta 2 adversarial native audit",
  () => {
    before(waitForAppReady);

    it("records a stale settings response erasing a later UI choice", async () => {
      const initial = await api("getSettings");
      await browser.execute(() => {
        const original = window.api.saveSettings;
        window.auditOriginalSave = original;
        window.auditSaveCalls = [];
        let held = false;
        window.api.saveSettings = async (settings) => {
          window.auditSaveCalls.push(JSON.parse(JSON.stringify(settings)));
          const response = await original(settings);
          if (!held) {
            held = true;
            window.auditSaveHeld = true;
            await new Promise((resolve) => {
              window.auditReleaseSave = resolve;
            });
          }
          return response;
        };
        const toggle = document.getElementById("notificationsToggle");
        toggle.checked = !toggle.checked;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await browser.waitUntil(
        () => browser.execute(() => Boolean(window.auditSaveHeld)),
        { timeout: 10_000 },
      );
      const desired = initial.theme === "dark" ? "light" : "dark";
      await browser.execute((theme) => {
        const control = document.getElementById("themeSelect");
        control.value = theme;
        control.dispatchEvent(new Event("change", { bubbles: true }));
        window.auditReleaseSave();
      }, desired);
      await browser.waitUntil(
        () => browser.execute(() => window.auditSaveCalls.length >= 2),
        { timeout: 10_000 },
      );
      await pause(500);
      const saved = await api("getSettings");
      const state = await browser.execute(() => ({
        calls: window.auditSaveCalls,
        visibleTheme: document.getElementById("themeSelect").value,
      }));
      await browser.saveScreenshot(path.join(directory, "settings-race.png"));
      record("settings-response-race", {
        initialTheme: initial.theme,
        desiredTheme: desired,
        persistedTheme: saved.theme,
        visibleTheme: state.visibleTheme,
        saveThemes: state.calls.map((value) => value.theme),
        invariantPassed: saved.theme === desired,
      });
      await browser.execute(() => {
        window.api.saveSettings = window.auditOriginalSave;
      });
    });

    it("records whether failed conversion preserves an existing target", async () => {
      const url = `${media}/broken.mp4`;
      const original = await download(url);
      assert.equal(original.outcome, "success", original.statusMessage);
      const target = original.outputPath.replace(/\.mp4$/, ".m4a");
      const sentinel = Buffer.from(
        "Existing user file: must survive a failed conversion.\n",
      );
      fs.writeFileSync(target, sentinel);
      const completed = await download(
        url,
        { convertEnabled: true, convertFormat: "m4a", keepOriginal: true },
        original.id,
      );
      const exists = fs.existsSync(target);
      record("conversion-target-preservation", {
        outcome: completed.outcome,
        target: path.basename(target),
        beforeSha256: hash(sentinel),
        afterSha256: exists ? hash(fs.readFileSync(target)) : null,
        targetExists: exists,
        invariantPassed: exists && fs.readFileSync(target).equals(sentinel),
      });
      await browser.saveScreenshot(
        path.join(directory, "conversion-failure.png"),
      );
    });

    it("records VP8 to MP4 conversion without GPU acceleration", async () => {
      const url = `${media}/vp8.webm`;
      const original = await download(url, { profile: "compatible" });
      assert.equal(original.outcome, "success", original.statusMessage);
      record("compatible-profile-output", {
        profile: original.profile,
        outcome: original.outcome,
        filename: original.filename,
        invariantPassed: original.filename.endsWith(".mp4"),
      });
      const completion = await download(
        url,
        {
          convertEnabled: true,
          convertFormat: "mp4",
          keepOriginal: true,
        },
        original.id,
      );
      const console = await browser.execute(
        () => document.getElementById("output")?.textContent ?? "",
      );
      record("vp8-cpu-conversion", {
        outcome: completion.outcome,
        message: completion.statusMessage,
        invariantPassed: completion.outcome === "success",
        codecError: console
          .split("\n")
          .filter((line) => /codec|header|Invalid argument/i.test(line))
          .slice(-8),
      });
    });

    it("records conversion output for every playlist entry", async () => {
      const completion = await download(`${media}/list.html`, {
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
      });
      const output = files();
      const converted = output.filter((file) =>
        /\[list-[12]\]\.m4a$/.test(file.name),
      );
      const unconverted = output.filter((file) =>
        /\[list-[12]\]\.mp4$/.test(file.name),
      );
      record("playlist-conversion", {
        outcome: completion.outcome,
        reportedOutput: completion.filename,
        files: output,
        convertedCount: converted.length,
        unconvertedCount: unconverted.length,
        invariantPassed: converted.length === 2 && unconverted.length === 0,
      });
    });

    it("records isolated rendered controls and Activity focus", async () => {
      const samples = [];
      for (const theme of ["dark", "light", "purple"]) {
        for (const flat of [false, true]) {
          await browser.execute(
            (name, enabled) => {
              document.documentElement.dataset.theme = name;
              document.documentElement.dataset.flatUi = String(enabled);
              document.getElementById("downloadBtn").disabled = true;
            },
            theme,
            flat,
          );
          await pause(350);
          samples.push(
            await browser.execute(() => {
              const button = document.getElementById("downloadBtn");
              const root = getComputedStyle(document.documentElement);
              const style = getComputedStyle(button);
              return {
                theme: document.documentElement.dataset.theme,
                flat: document.documentElement.dataset.flatUi,
                addShadow: getComputedStyle(
                  document.getElementById("addToQueueBtn"),
                ).boxShadow,
                rootNeutralShadow: root.getPropertyValue(
                  "--button-neutral-shadow",
                ),
                color: style.color,
                background: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                opacity: style.opacity,
              };
            }),
          );
        }
      }
      await browser.execute(() => {
        document.documentElement.dataset.flatUi = "false";
        window.rosiModules.dock.selectTab("activity");
        document
          .querySelector("#history-list .history-item-actions button")
          .focus();
      });
      await pause(500);
      const focus = await browser.execute(() => {
        const button = document.querySelector(
          "#history-list .history-item-actions button",
        );
        const row = button.closest(".history-item");
        return {
          activeElement: document.activeElement?.outerHTML.slice(0, 500),
          buttonFocused: document.activeElement === button,
          focusWithin: row.matches(":focus-within"),
          opacity: getComputedStyle(button).opacity,
          sidebarOpen: document
            .getElementById("sidebar")
            .classList.contains("open"),
          inertAncestors: [...document.querySelectorAll("[inert]")].map(
            (node) => node.id,
          ),
        };
      });
      record("isolated-control-styles", {
        samples,
        focus,
        invariantPassed:
          samples
            .filter((value) => value.flat === "true")
            .every((value) => value.addShadow === "none") &&
          focus.opacity === "1",
      });
      await browser.saveScreenshot(
        path.join(directory, "isolated-controls.png"),
      );
    });

    it("records cancellation after concurrent native manual starts", async () => {
      const marker = "audit-race=1";
      const outcomes = await browser.executeAsync(
        (baseUrl, output, done) => {
          Promise.all(
            Array.from({ length: 10 }, (_, index) =>
              window.api.downloadVideo({
                url: `${baseUrl}/slow.mp4?audit-race=1&n=${index}`,
                outputPath: output,
                convertEnabled: false,
              }),
            ),
          ).then(
            (results) => done(JSON.stringify(results)),
            (error) => done(JSON.stringify({ error: String(error) })),
          );
        },
        media,
        downloads,
      );
      await pause(600);
      const before = processes(marker);
      await api("cancelDownload");
      await pause(6500);
      const after = processes(marker);
      record("concurrent-start-cancel", {
        starts: JSON.parse(outcomes),
        processesBefore: before,
        processesAfter: after,
        invariantPassed: after.length === 0,
      });
      for (const child of after) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {}
        }
      }
    });

    it("records cancellation after concurrent native preview requests", async () => {
      const marker = "audit-preview=1";
      await browser.execute((baseUrl) => {
        window.auditPreviewResults = [];
        for (let index = 0; index < 10; index += 1) {
          window.api
            .getVideoInfo(`${baseUrl}/slow.html?audit-preview=1&n=${index}`)
            .then(
              (result) => window.auditPreviewResults.push(result),
              (error) =>
                window.auditPreviewResults.push({ error: String(error) }),
            );
        }
      }, media);
      await pause(1500);
      const before = processes(marker);
      await api("cancelVideoInfo");
      await pause(6500);
      const after = processes(marker);
      record("concurrent-preview-cancel", {
        processesBefore: before,
        processesAfter: after,
        invariantPassed: after.length === 0,
      });
      for (const child of after) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {}
        }
      }
    });
  },
);

(terminationOnly ? describe : describe.skip)(
  "V5 beta 2 process tree escalation",
  () => {
    before(waitForAppReady);

    it("records a surviving descendant after the parent exits on cancellation", async () => {
      const helper = process.env.ROSI_AUDIT_TERMINATION_HELPER;
      const ready = process.env.ROSI_AUDIT_TERMINATION_READY;
      const response = await api("downloadVideo", {
        url: `${media}/a.mp4`,
        outputPath: downloads,
        ffmpegPath: helper,
        convertEnabled: true,
        convertFormat: "m4a",
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      await browser.waitUntil(() => fs.existsSync(ready), { timeout: 30_000 });
      const child = JSON.parse(fs.readFileSync(ready, "utf8"));
      try {
        await api("cancelDownload");
        await pause(6500);
        const listing = spawnSync(
          "ps",
          ["-p", String(child.pid), "-o", "pid=,stat=,command="],
          { encoding: "utf8" },
        );
        const descendantAlive =
          listing.status === 0 &&
          listing.stdout.includes(helper) &&
          !/^\s*\d+\s+Z/.test(listing.stdout);
        const parent = spawnSync(
          "ps",
          ["-p", String(child.parentPid), "-o", "pid=,command="],
          { encoding: "utf8" },
        );
        record("parent-exits-descendant-survives", {
          child,
          parentAlive: parent.status === 0 && parent.stdout.includes(helper),
          descendantAlive,
          descendantCommand: listing.stdout.trim(),
          invariantPassed: !descendantAlive,
        });
      } finally {
        const listing = spawnSync(
          "ps",
          ["-p", String(child.pid), "-o", "command="],
          { encoding: "utf8" },
        );
        if (listing.status === 0 && listing.stdout.includes(helper)) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {}
        }
        await pause(500);
      }
    });
  },
);

(uiOnly ? describe : describe.skip)("V5 beta 2 rendered UI diagnostics", () => {
  before(waitForAppReady);

  it("records layout and styles through actual settings controls", async () => {
    if (process.env.ROSI_AUDIT_ACTIVATE_WINDOW) {
      const activated = spawnSync(
        process.env.ROSI_AUDIT_ACTIVATE_WINDOW,
        [process.env.ROSI_E2E_BINARY],
        { encoding: "utf8" },
      );
      assert.equal(activated.status, 0, activated.stdout + activated.stderr);
    }
    await pause(2000);
    await download(`${media}/a.mp4`);
    const samples = [];
    for (const theme of ["dark", "light", "purple"]) {
      for (const flat of [false, true]) {
        await browser.execute(
          (name, enabled) => {
            const select = document.getElementById("themeSelect");
            select.value = name;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            const toggle = document.getElementById("flatUiToggle");
            toggle.checked = enabled;
            toggle.dispatchEvent(new Event("change", { bubbles: true }));
            document.getElementById("url").value = "";
            document
              .getElementById("url")
              .dispatchEvent(new Event("input", { bubbles: true }));
          },
          theme,
          flat,
        );
        await pause(2000);
        samples.push(
          await browser.execute(() => {
            const button = document.getElementById("downloadBtn");
            const style = getComputedStyle(button);
            const root = getComputedStyle(document.documentElement);
            const geometry = [
              ...document.querySelectorAll(
                ".main-stage, .download-section, .download-card, #dock",
              ),
            ].map((node) => {
              const css = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return {
                element: node.id || node.className,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                display: css.display,
                visibility: css.visibility,
                opacity: css.opacity,
                transform: css.transform,
              };
            });
            return {
              theme: document.documentElement.dataset.theme,
              flat: document.documentElement.dataset.flatUi,
              accent: root.getPropertyValue("--accent"),
              rootShadow: root.getPropertyValue("--button-neutral-shadow"),
              addShadow: getComputedStyle(
                document.getElementById("addToQueueBtn"),
              ).boxShadow,
              downloadDisabled: button.disabled,
              ariaDisabled: button.getAttribute("aria-disabled"),
              classes: button.className,
              color: style.color,
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              geometry,
              documentFocused: document.hasFocus(),
            };
          }),
        );
      }
    }
    await browser.execute(() => {
      window.rosiModules.dock.selectTab("activity");
      document
        .querySelector("#history-list .history-item-actions button")
        .focus();
    });
    await pause(500);
    const focus = await browser.execute(() => {
      const button = document.querySelector(
        "#history-list .history-item-actions button",
      );
      return {
        documentFocused: document.hasFocus(),
        buttonFocused: document.activeElement === button,
        matchesFocus: button.matches(":focus"),
        focusWithin: button.closest(".history-item").matches(":focus-within"),
        opacity: getComputedStyle(button).opacity,
      };
    });
    record("rendered-ui-diagnostics", { samples, focus });
    await browser.saveScreenshot(
      path.join(directory, "actual-settings-controls.png"),
    );
  });
});

(securityOnly ? describe : describe.skip)(
  "V5 beta 2 production URL boundary",
  () => {
    before(waitForAppReady);

    it("records whether a public DNS alias reaches loopback", async () => {
      const direct = await api("downloadVideo", {
        url: `${media}/audit-private.mp4`,
        outputPath: downloads,
      });
      assert.equal(
        direct.ok,
        false,
        "The E2E loopback override must be disabled.",
      );
      const alias = media.replace("127.0.0.1", "localtest.me");
      const response = await api("downloadVideo", {
        url: `${alias}/audit-private.mp4`,
        outputPath: downloads,
        hookBrowser: false,
      });
      let completion = null;
      if (response.ok)
        completion = await activity(`${alias}/audit-private.mp4`);
      record("dns-loopback-boundary", {
        loopbackOverride: "0",
        direct,
        aliasUrl: `${alias}/audit-private.mp4`,
        response,
        completion,
        files: files(),
        invariantPassed: !response.ok,
      });
    });
  },
);
