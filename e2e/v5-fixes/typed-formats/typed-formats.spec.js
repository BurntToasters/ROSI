import assert from "node:assert/strict";
import http from "node:http";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const HAS_FFMPEG = process.env.ROSI_E2E_HAS_FFMPEG === "1";

// HLS master with a combined variant, a video-only variant with a fractional
// frame rate (23.976 rounds to 23.98), an integer fps variant without a
// resolution, and an audio-only variant. yt-dlp lists these without fetching
// the variant playlists, so the spec serves only this master.
const HLS_MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,FRAME-RATE=23.976,CODECS="avc1.64001f,mp4a.40.2"',
  "hi.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,FRAME-RATE=29.970,CODECS="avc1.4d401e"',
  "mid.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=300000,FRAME-RATE=25.000,CODECS="avc1.42c01e"',
  "lo.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
  "aud.m3u8",
  "",
].join("\n");

// Exact text the pre-5.1 renderer (formatFormatEntry) produced for these entries.
const LEGACY_LABELS = {
  128: "ID: 128 (mp4a.40.2)",
  300: "ID: 300 25fps (avc1.42c01e)",
  600: "ID: 600 640x360 29.97fps (avc1.4d401e)",
  1200: "ID: 1200 1280x720 23.98fps (avc1.64001f + mp4a.40.2) (video + audio)",
};

async function startManifestServer() {
  const server = http.createServer((request, response) => {
    if (request.url?.split("?")[0] !== "/master.m3u8") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/vnd.apple.mpegurl" })
      .end(HLS_MASTER);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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

  it("labels each option with the backend displayLabel, matching the pre-5.1 text", async () => {
    const server = await startManifestServer();
    try {
      const url = `${server.baseUrl}/master.m3u8`;
      const result = await api("getFormats", url);
      assert.equal(result.ok, true, result.error?.message);
      const formats = result.data.formats;
      const byId = new Map(formats.map((format) => [format.formatId, format]));

      for (const [formatId, legacy] of Object.entries(LEGACY_LABELS)) {
        const format = byId.get(formatId);
        assert.ok(format, `manifest format ${formatId} was not listed`);
        assert.equal(
          format.displayLabel,
          legacy,
          `displayLabel for ${formatId}`,
        );
      }
      assert.equal(byId.get("128").streamKind, "audio");
      assert.equal(byId.get("300").streamKind, "video");
      assert.equal(byId.get("1200").streamKind, "audioVideo");

      // Fixtures report no byte sizes, so no label may carry a size or "~".
      for (const format of formats) {
        assert.equal(typeof format.displayLabel, "string", format.formatId);
        assert.ok(
          format.displayLabel.startsWith(`ID: ${format.formatId}`),
          format.displayLabel,
        );
        assert.doesNotMatch(
          format.displayLabel,
          /~| (B|KB|MB|GB|TB|PB)$/,
          format.displayLabel,
        );
      }

      const clip = await api("getFormats", `${MEDIA}/clip-one.mp4`);
      assert.equal(clip.ok, true, clip.error?.message);
      const mp4 = clip.data.formats.find((format) => format.formatId === "mp4");
      assert.ok(mp4, "direct MP4 fixture was not listed");
      assert.equal(mp4.displayLabel, "ID: mp4 (video + audio)");

      await setUrlAndFetch(url);
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              !document
                .getElementById("fetchFormatsBtn")
                .classList.contains("loading"),
          ),
        {
          timeout: 60_000,
          timeoutMsg: "manifest format lookup did not finish",
        },
      );
      const pickers = await readFormatPickers();
      for (const format of formats) {
        const picker =
          format.streamKind === "audio" ? pickers.audio : pickers.video;
        const option = picker.find((entry) => entry.value === format.formatId);
        assert.ok(option, `format ${format.formatId} has no picker option`);
        assert.equal(option.text, format.displayLabel);
      }
    } finally {
      await server.close();
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
