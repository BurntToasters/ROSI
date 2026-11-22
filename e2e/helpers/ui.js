import { isDeepStrictEqual } from "node:util";
import { browser } from "@wdio/globals";
import { api, clickById, waitForAppReady } from "./app-bridge.js";

// One implementation each: the bridge call, the strict click and the ready wait.
export { api, clickById, waitForAppReady };

/**
 * Options must be an object literal or omitted. A number, boolean, array or
 * class instance passed by mistake would otherwise be ignored by destructuring.
 */
function assertOptionsObject(helper, options, allowed) {
  if (options === undefined) return {};
  const proto = options === null ? undefined : Object.getPrototypeOf(options);
  const plain =
    options !== null &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    (proto === Object.prototype || proto === null);
  if (!plain) {
    const kind =
      options === null
        ? "null"
        : Array.isArray(options)
          ? "array"
          : typeof options;
    throw new TypeError(
      `${helper} takes an options object or nothing, got ${kind}`,
    );
  }
  // A misspelled key would otherwise be ignored and its default used silently.
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `${helper} does not accept option(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`,
    );
  }
  return options;
}

/**
 * Poll `predicate` in the page until it returns truthy. The message is
 * required, so a timeout always says what was awaited. A predicate that throws
 * in the page fails the wait.
 */
export async function waitFor(
  predicate,
  message,
  timeout = 10_000,
  argument = undefined,
) {
  if (typeof message !== "string" || message === "") {
    throw new TypeError("waitFor needs a non-empty timeout message");
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(
      `waitFor needs a finite positive timeout, got ${timeout}`,
    );
  }
  await browser.waitUntil(async () => browser.execute(predicate, argument), {
    timeout,
    interval: 100,
    timeoutMsg: message,
  });
}

/** Reload the webview and wait for the renderer to come back. */
export async function reloadRenderer() {
  // Defer the reload: WebView2 tears down the script context before the
  // embedded WebDriver can answer a synchronous execute that navigates.
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await waitForAppReady();
}

/**
 * Set a control and fire `change` (and `input` first when asked). Checkboxes
 * need a boolean. A missing control, an undefined value, or a select that
 * refuses the value throws.
 */
export async function setControl(id, value, options) {
  const { input = false } = assertOptionsObject("setControl", options, [
    "input",
  ]);
  if (value === undefined || value === null) {
    throw new TypeError(`setControl(${id}) needs a value, got ${value}`);
  }
  await browser.execute(
    (target, next, fireInput) => {
      const control = document.getElementById(target);
      if (!control) throw new Error(`missing control ${target}`);
      if (control.type === "checkbox") {
        if (typeof next !== "boolean") {
          throw new Error(
            `checkbox ${target} needs a boolean, got ${typeof next}`,
          );
        }
        control.checked = next;
      } else {
        control.value = String(next);
        if (control.tagName === "SELECT" && control.value !== String(next)) {
          throw new Error(`select ${target} has no option ${String(next)}`);
        }
      }
      if (fireInput)
        control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
    input,
  );
}

/** Wait until the backend setting `key` deep-strictly equals `value` (key order does not matter). */
export async function waitForBackendSetting(key, value, message, options) {
  const { timeout = 10_000, interval = 150 } = assertOptionsObject(
    "waitForBackendSetting",
    options,
    ["timeout", "interval"],
  );
  if (typeof message !== "string" || message === "") {
    throw new TypeError("waitForBackendSetting needs a non-empty message");
  }
  const same = (left, right) => isDeepStrictEqual(left, right);
  let last;
  try {
    await browser.waitUntil(
      async () => {
        last = (await api("getSettings"))[key];
        return same(last, value);
      },
      { timeout, interval, timeoutMsg: message },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; last ${key}=${JSON.stringify(last)}`);
  }
}

/** The in-page modal. `open` is shown and not hiding; `active` stays set while it hides. */
export function modalState() {
  return browser.execute(() => {
    const modal = document.getElementById("app-modal");
    const active = modal?.classList.contains("active") === true;
    const hiding = modal?.classList.contains("hiding") === true;
    return {
      active,
      hiding,
      open: active && !hiding,
      title: document.getElementById("modal-title")?.textContent?.trim() ?? "",
      message: document.getElementById("modal-message")?.textContent ?? "",
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  });
}

/**
 * Wait for the modal. A boolean waits for open (true) or fully closed (false);
 * a string waits for an open modal with that title (exact, or `includes` when
 * `match: "includes"`). Returns the modal state. A timeout reports the modal
 * as it stood.
 */
export async function waitForModal(target, options) {
  const {
    timeout = 10_000,
    timeoutMsg = null,
    match = "exact",
  } = assertOptionsObject("waitForModal", options, [
    "timeout",
    "timeoutMsg",
    "match",
  ]);
  const byTitle = typeof target === "string";
  if (!byTitle && typeof target !== "boolean") {
    throw new TypeError("waitForModal needs a boolean or a title string");
  }
  const matches = (state) =>
    byTitle
      ? state.open &&
        (match === "includes"
          ? state.title.includes(target)
          : state.title === target)
      : target
        ? state.open
        : !state.active;
  const expected = byTitle
    ? `modal "${target}" did not appear`
    : `modal did not ${target ? "open" : "close"}`;
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await modalState();
        return matches(state);
      },
      { timeout, interval: 100, timeoutMsg: timeoutMsg ?? expected },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; current modal=${JSON.stringify(state)}`);
  }
  return state;
}

/** Click a modal button by its trimmed label; a missing label throws and lists the buttons. */
export async function clickModalButton(label) {
  await browser.execute((wanted) => {
    const buttons = [...document.querySelectorAll("#modal-buttons button")];
    const button = buttons.find(
      (candidate) => candidate.textContent.trim() === wanted,
    );
    if (!button) {
      const seen = buttons.map((candidate) => candidate.textContent.trim());
      throw new Error(
        `modal has no "${wanted}" button; buttons=${JSON.stringify(seen)}`,
      );
    }
    button.click();
  }, label);
}

async function installStubs(list) {
  await browser.execute((items) => {
    const bridge = window.__ROSI_E2E__.api;
    const registry = (window.__rosiStubs ??= {
      original: {},
      calls: [],
      held: [],
    });
    for (const { name, value, hold, holdMatch } of items) {
      if (typeof bridge[name] !== "function") {
        throw new Error(`cannot stub unknown bridge method ${name}`);
      }
      if (!(name in registry.original)) registry.original[name] = bridge[name];
      bridge[name] = (...args) => {
        registry.calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        const first = typeof args[0] === "string" ? args[0] : "";
        const parked = hold || (holdMatch && first.includes(holdMatch));
        if (!parked) return Promise.resolve(value);
        return new Promise((resolve) =>
          registry.held.push({ name, resolve, value }),
        );
      };
    }
  }, list);
}

/**
 * Stub several bridge methods on window.__ROSI_E2E__.api; `map` is name to
 * resolved value. Each stub records `{ name, args }`. The first original of
 * each method is kept. Throws for an unknown method.
 */
export function stubBridges(map) {
  return installStubs(
    Object.entries(map).map(([name, value]) => ({
      name,
      value: value ?? null,
      hold: false,
      holdMatch: null,
    })),
  );
}

/**
 * Stub one bridge method. `hold` (or `holdMatch`, matched against a string
 * first argument) parks the call until `releaseHeldStubs` or `restoreBridge`.
 */
export function stubBridge(name, value, options) {
  const { hold = false, holdMatch = null } = assertOptionsObject(
    "stubBridge",
    options,
    ["hold", "holdMatch"],
  );
  return installStubs([{ name, value: value ?? null, hold, holdMatch }]);
}

/** Arguments of each recorded stub call, optionally for one method. */
export function stubCalls(name) {
  return browser.execute(
    (target) =>
      (window.__rosiStubs?.calls ?? [])
        .filter((call) => !target || call.name === target)
        .map((call) => call.args),
    name ?? null,
  );
}

/** Resolve every held stub call; returns how many were held. */
export function releaseHeldStubs() {
  return browser.execute(() => {
    const held = (window.__rosiStubs?.held ?? []).splice(0);
    for (const call of held) call.resolve(call.value);
    return held.length;
  });
}

/** Put the real bridge methods back, release held calls, and return every recorded call. */
export function restoreBridge() {
  return browser.execute(() => {
    const stubs = window.__rosiStubs;
    if (!stubs) return [];
    Object.assign(window.__ROSI_E2E__.api, stubs.original);
    for (const call of stubs.held.splice(0)) call.resolve(call.value);
    window.__rosiStubs = undefined;
    return stubs.calls;
  });
}

/** Download activity entries for one URL; a failed or malformed reply throws. */
export async function activityFor(url) {
  if (typeof url !== "string" || url === "") {
    throw new TypeError("activityFor needs a non-empty url");
  }
  const envelope = await api("getDownloadActivity");
  if (envelope?.ok !== true || !Array.isArray(envelope.data)) {
    throw new Error(
      `getDownloadActivity failed: ${JSON.stringify(envelope)?.slice(0, 300)}`,
    );
  }
  return envelope.data.filter((entry) => entry.url === url);
}

// RUNNER_EXIT_WAIT in src-tauri/src/coordinator.rs: with nothing pending,
// startQueue waits up to this long for an exiting runner, then answers "No
// pending items". The runner reports every terminal result before it exits.
const RUNNER_EXIT_WAIT_MS = 2_000;
const RUNNER_EXITED_ANSWER_MS = 1_500;

/**
 * Waits until the queue runner has exited, so every result it sent (and the
 * activity it records) is applied. Call it only when no item is pending:
 * startQueue would otherwise start a run. An answer well inside the exit wait
 * means the runner had exited; a slower one may be the wait timing out, so it
 * asks again.
 */
export async function waitForQueueRunnerExit(message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const started = Date.now();
    const answer = await api("startQueue");
    const elapsed = Date.now() - started;
    if (answer?.ok === true) {
      throw new Error(`${message}: startQueue started a run`);
    }
    if (!/No pending items/.test(answer?.error?.message ?? "")) {
      throw new Error(`${message}: ${JSON.stringify(answer)?.slice(0, 300)}`);
    }
    if (elapsed < RUNNER_EXITED_ANSWER_MS) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${message}: startQueue still waited ${elapsed} ms of ${RUNNER_EXIT_WAIT_MS} ms`,
      );
    }
  }
}
