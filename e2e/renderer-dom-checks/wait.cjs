// Waits for the jsdom diagnostics. Each one names the state it needs, so a
// missing state fails with a message instead of passing on a fixed delay.
const POLL_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Polls `predicate` until it is truthy. A timeout throws with `message`. */
async function until(predicate, message, timeout = DEFAULT_TIMEOUT_MS) {
  if (typeof message !== "string" || message === "") {
    throw new TypeError("until needs a non-empty message");
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout} ms: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Yields one macrotask. Every promise chain that has no timer in it has
 * finished by then, because the mock replies resolve at once. Use it after a
 * stale reply, where there is no state to poll for.
 */
function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolves after the window runs one animation frame. */
function nextFrame(window) {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
}

/** Awaits `promise`, or throws with `message` after `timeout`. */
async function within(promise, message, timeout = DEFAULT_TIMEOUT_MS) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeout} ms: ${message}`)),
      timeout,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { until, turn, nextFrame, within };
