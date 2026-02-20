import { describe, it, expect } from 'vitest';
import * as lifecycle from '../utils/downloadLifecycle';

describe('download lifecycle helpers', () => {
  it('starts as not-cancelled and not-completed', () => {
    const state = lifecycle.createDownloadLifecycleState();
    expect(state.cancelled).toBe(false);
    expect(state.completed).toBe(false);
    expect(lifecycle.shouldEmitTerminalEvent(state)).toBe(true);
  });

  it('maps cancelled non-zero exits to cancelled', () => {
    let state = lifecycle.createDownloadLifecycleState();
    state = lifecycle.markDownloadCancelled(state);
    expect(lifecycle.classifyDownloadExit(state, 1)).toBe('cancelled');
  });

  it('maps cancelled zero exits to cancelled', () => {
    let state = lifecycle.createDownloadLifecycleState();
    state = lifecycle.markDownloadCancelled(state);
    expect(lifecycle.classifyDownloadExit(state, 0)).toBe('cancelled');
  });

  it('maps non-cancelled non-zero exits to failed', () => {
    const state = lifecycle.createDownloadLifecycleState();
    expect(lifecycle.classifyDownloadExit(state, 1)).toBe('failed');
  });

  it('maps successful exits to success', () => {
    const state = lifecycle.createDownloadLifecycleState();
    expect(lifecycle.classifyDownloadExit(state, 0)).toBe('success');
  });

  it('suppresses duplicate terminal event emission', () => {
    let state = lifecycle.createDownloadLifecycleState();
    expect(lifecycle.shouldEmitTerminalEvent(state)).toBe(true);
    state = lifecycle.markTerminalEventEmitted(state);
    expect(lifecycle.shouldEmitTerminalEvent(state)).toBe(false);
  });

  it('preserves completed state when cancellation is marked late', () => {
    let state = lifecycle.createDownloadLifecycleState();
    state = lifecycle.markTerminalEventEmitted(state);
    state = lifecycle.markDownloadCancelled(state);
    expect(state.cancelled).toBe(true);
    expect(state.completed).toBe(true);
    expect(lifecycle.shouldEmitTerminalEvent(state)).toBe(false);
  });
});
