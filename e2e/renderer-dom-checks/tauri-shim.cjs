// Fake Tauri IPC for the jsdom renderer diagnostics. Commands are recorded;
// events are emitted by the caller. The updater engine is not run here: its
// behaviour is covered by the real-app scenarios in e2e/v5-fixes/updater-engine.

/** The modules the renderer imports from Tauri, plus the recording hooks. */
function createTauriShim() {
  const invocations = [];
  const listeners = new Map();
  function invoke(command, args) {
    invocations.push({ command, args: args ?? null });
    if (command === "download_update") {
      return Promise.resolve({ success: true, cancelled: false, error: null });
    }
    if (command === "check_for_updates") return Promise.resolve(null);
    return Promise.resolve(undefined);
  }
  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
      handler({ event, payload });
    }
  }
  const externals = {
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/api/event": {
      listen: (event, handler) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return Promise.resolve(() => set.delete(handler));
      },
    },
  };
  return { externals, invocations, emit };
}

module.exports = { createTauriShim };
