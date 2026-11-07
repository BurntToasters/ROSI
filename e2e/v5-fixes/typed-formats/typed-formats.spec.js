import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const HAS_FFMPEG = process.env.ROSI_E2E_HAS_FFMPEG === "1";

async function setUrlAndFetch(url) {
  await browser.execute((value) => {
    const input = document.getElementById("url");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("fetchFormatsBtn").click();
  }, url);
}

async function readFormatPickers() {
  return browser.execute(() => {
    const read = (id) => {
      const select = document.getElementById(id);
      return [...select.options].map((option) => ({
        value: option.value,
        text: option.textContent,
      }));
    };
    return {
      video: read("videoFormat"),
      audio: read("audioFormat"),
    };
  });
}

describe("typed format discovery", () => {
  before(async () => {
    await waitForAppReady();
  });

  after(async () => {
    await browser.execute(() => {
      const original = window.__typedFormatsOriginalApi;
      if (!original) return;
      window.api.getFormats = original.getFormats;
      window.api.cancelFormats = original.cancelFormats;
      delete window.__typedFormatsOriginalApi;
      delete window.__typedFormatsPending;
    });
  });

  it("returns typed entries and renders their exact IDs in the matching picker", async () => {
    const url = HAS_FFMPEG
      ? `${MEDIA}/dash/manifest.mpd`
      : `${MEDIA}/clip-one.mp4`;
    const result = await api("getFormats", url);
    assert.equal(result.ok, true, result.error?.message);
    assert.ok(Array.isArray(result.data.formats));
    assert.ok(
      result.data.formats.length > 0,
      "yt-dlp returned no media formats",
    );
    assert.ok(
      result.data.formats.every(
        (format) =>
          typeof format.formatId === "string" &&
          ["audio", "video", "audioVideo"].includes(format.streamKind),
      ),
      JSON.stringify(result.data.formats),
    );

    const wrappedUrl = HAS_FFMPEG
      ? `${MEDIA}/dash/manifest.mpd?list=local-wrapper`
      : `${MEDIA}/clip-one.mp4?list=local-wrapper`;
    const wrapped = await api("getFormats", wrappedUrl);
    assert.equal(wrapped.ok, true, wrapped.error?.message);
    assert.ok(Array.isArray(wrapped.data.formats));
    if (HAS_FFMPEG) {
      assert.ok(
        wrapped.data.formats.length > 0,
        "playlist-like URL did not return the current manifest's formats",
      );
    }

    await setUrlAndFetch(url);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !document
              .getElementById("fetchFormatsBtn")
              .classList.contains("loading"),
        ),
      { timeout: 60_000, timeoutMsg: "format picker did not finish loading" },
    );
    const pickers = await readFormatPickers();
    for (const format of result.data.formats) {
      const expectedPicker =
        format.streamKind === "audio" ? pickers.audio : pickers.video;
      assert.ok(
        expectedPicker.some((option) => option.value === format.formatId),
        `format ${format.formatId} was not rendered as an exact option value`,
      );
    }
  });

  it("clears cancelled and stale replies before they can restore selections", async () => {
    await browser.execute(() => {
      window.__typedFormatsOriginalApi = {
        getFormats: window.api.getFormats,
        cancelFormats: window.api.cancelFormats,
      };
      window.__typedFormatsPending = [];
      window.api.getFormats = () =>
        new Promise((resolve) => window.__typedFormatsPending.push(resolve));
    });

    await setUrlAndFetch(`${MEDIA}/clip-one.mp4`);
    await browser.waitUntil(
      async () =>
        browser.execute(() => window.__typedFormatsPending?.length === 1),
      {
        timeout: 10_000,
        timeoutMsg: "controlled format request did not start",
      },
    );
    await browser.execute(() =>
      document.getElementById("fetchFormatsBtn").click(),
    );
    await browser.execute(() =>
      window.__typedFormatsPending[0]({
        ok: true,
        data: {
          formats: [
            {
              formatId: "stale-cancelled",
              streamKind: "video",
              vcodec: "avc1",
            },
          ],
        },
      }),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.getElementById("videoFormat").options].every(
            (option) => option.value !== "stale-cancelled",
          ),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "cancelled reply restored a format option",
      },
    );

    await setUrlAndFetch(`${MEDIA}/clip-one.mp4`);
    await browser.waitUntil(
      async () =>
        browser.execute(() => window.__typedFormatsPending?.length === 2),
      {
        timeout: 10_000,
        timeoutMsg: "second controlled format request did not start",
      },
    );
    await browser.execute((value) => {
      const input = document.getElementById("url");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, `${MEDIA}/clip-two.mp4`);
    await browser.execute(() =>
      window.__typedFormatsPending[1]({
        ok: true,
        data: {
          formats: [
            { formatId: "stale-url", streamKind: "audio", acodec: "mp4a" },
          ],
        },
      }),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.getElementById("audioFormat").options].every(
            (option) => option.value !== "stale-url",
          ),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "stale URL reply restored a format option",
      },
    );
    const pickers = await readFormatPickers();
    assert.ok(
      [...pickers.video, ...pickers.audio].every((option) => !option.value),
    );
  });

  it("shows explicit empty and failure states without usable selections", async () => {
    await browser.execute(() => {
      window.api.getFormats = async () => ({ ok: true, data: { formats: [] } });
    });
    await setUrlAndFetch(`${MEDIA}/clip-one.mp4`);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !document
              .getElementById("fetchFormatsBtn")
              .classList.contains("loading"),
        ),
      { timeout: 10_000, timeoutMsg: "empty format lookup did not finish" },
    );
    let pickers = await readFormatPickers();
    assert.equal(pickers.video[0].text, "No video formats found");
    assert.equal(pickers.audio[0].text, "No audio formats found");

    await browser.execute(() => {
      window.api.getFormats = async () => ({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "fixture failure" },
      });
    });
    await setUrlAndFetch(`${MEDIA}/clip-one.mp4`);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !document
              .getElementById("fetchFormatsBtn")
              .classList.contains("loading"),
        ),
      { timeout: 10_000, timeoutMsg: "failed format lookup did not finish" },
    );
    pickers = await readFormatPickers();
    assert.equal(pickers.video[0].text, "Error loading formats");
    assert.equal(pickers.audio[0].text, "Error loading formats");
    assert.ok(
      [...pickers.video, ...pickers.audio].every((option) => !option.value),
    );
  });
});
