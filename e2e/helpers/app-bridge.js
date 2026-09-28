import { browser } from "@wdio/globals";

/** Call a `window.api` method in the app and return its resolved value. */
export async function api(method, ...args) {
  // The WebDriver bridge fails on script results containing non-ASCII text,
  // so the page returns ASCII-escaped JSON and Node parses it.
  const encoded = await browser.executeAsync(
    (name, params, done) => {
      const ascii = (value) =>
        JSON.stringify(value).replace(
          /[\u0080-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
      Promise.resolve()
        .then(() => window.api[name](...params))
        .then(
          (value) => done(ascii({ ok: true, value: value ?? null })),
          (error) =>
            done(
              ascii({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
    },
    method,
    args,
  );
  const outcome = JSON.parse(encoded);
  if (!outcome.ok)
    throw new Error(`window.api.${method} failed: ${outcome.error}`);
  return outcome.value;
}

/** Wait until the page and the E2E hook are ready. */
export async function waitForAppReady() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          Boolean(window.__ROSI_E2E__?.ready) &&
          Boolean(window.api) &&
          Boolean(document.getElementById("url")),
      ),
    { timeout: 60_000, timeoutMsg: "E2E hook / window.api not installed" },
  );
}
