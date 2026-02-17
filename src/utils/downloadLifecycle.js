function createDownloadLifecycleState() {
  return { cancelled: false, completed: false };
}

function markDownloadCancelled(state) {
  return {
    ...state,
    cancelled: true
  };
}

function shouldEmitTerminalEvent(state) {
  return Boolean(state) && state.completed !== true;
}

function markTerminalEventEmitted(state) {
  return {
    ...state,
    completed: true
  };
}

function classifyDownloadExit(state, exitCode) {
  if (state && state.cancelled) return 'cancelled';
  return exitCode === 0 ? 'success' : 'failed';
}

module.exports = {
  createDownloadLifecycleState,
  markDownloadCancelled,
  shouldEmitTerminalEvent,
  markTerminalEventEmitted,
  classifyDownloadExit
};
