// Typed map of the Rust commands the renderer calls. Argument and result shapes
// come from src/generated/ipc-types.ts; src/tests/commands.contract.test.ts
// checks the names against the command list in src-tauri/build.rs.
import { invoke } from '@tauri-apps/api/core';
import type * as Ipc from './generated/ipc-types';

type Envelope<T> = { ok: true; data: T } | { ok: false; error: Ipc.IpcError };

export interface Commands {
  get_settings: { args: void; result: Ipc.Settings };
  get_default_settings: { args: void; result: Envelope<Ipc.Settings> };
  save_settings: { args: { settings: Partial<Ipc.Settings> }; result: Envelope<Ipc.Settings> };
  reset_settings: { args: void; result: void };
  export_settings: { args: void; result: Envelope<Ipc.Exported> };
  import_settings: { args: void; result: Envelope<Ipc.Imported> };
  get_stats: { args: void; result: Ipc.DownloadStats };
  reset_stats: { args: void; result: Envelope<void> };
  get_download_activity: { args: void; result: Envelope<Ipc.DownloadCompletion[]> };
  clear_download_activity: { args: void; result: Envelope<void> };
  get_formats: {
    args: { url: string; hookBrowser?: boolean; browserChoice?: string };
    result: Envelope<Ipc.FormatList>;
  };
  cancel_formats: { args: void; result: void };
  get_video_info: {
    args: {
      url: string;
      playlistMode: 'current' | 'all' | null;
      hookBrowser?: boolean;
      browserChoice?: string;
    };
    result: Envelope<Ipc.VideoInfo>;
  };
  cancel_video_info: { args: void; result: void };
  download_video: {
    args: { options: Ipc.DownloadRequestInput };
    result: Envelope<Ipc.DownloadStarted>;
  };
  resolve_download_options: {
    args: { options: Ipc.DownloadRequestInput };
    result: Envelope<Ipc.DownloadRequestOptions>;
  };
  resolve_preset_options: {
    args: { options: Ipc.PresetOptionsInput };
    result: Envelope<Ipc.DownloadRequestOptions>;
  };
  cancel_download: { args: void; result: void };
  add_to_queue: {
    args: { urls: string[]; options: Ipc.DownloadRequestInput | null };
    result: Envelope<Ipc.AddResult>;
  };
  extract_queue_urls: {
    args: { input: Ipc.QueueTextInput };
    result: Envelope<Ipc.ExtractedQueueUrls>;
  };
  remove_from_queue: { args: { id: string }; result: Envelope<void> };
  retry_queue_item: { args: { id: string }; result: Envelope<void> };
  reorder_queue_item: { args: { request: Ipc.QueueReorderInput }; result: Envelope<void> };
  clear_queue: { args: void; result: Envelope<void> };
  clear_finished_queue: { args: void; result: Envelope<Ipc.RemovedCount> };
  get_queue: { args: void; result: Ipc.QueueItem[] };
  start_queue: { args: void; result: Envelope<Ipc.QueueStarted> };
  cancel_queue: { args: void; result: Envelope<void> };
  select_download_location: { args: void; result: string | null };
  open_external: { args: { url: string }; result: Envelope<Ipc.Opened> };
  open_file_location: { args: { filePath: string }; result: Envelope<Ipc.Opened> };
  show_notification: { args: { options: Ipc.NotificationInput }; result: Envelope<Ipc.Shown> };
  check_deno_installed: { args: void; result: boolean };
  install_deno: { args: void; result: Ipc.InstallResult };
  detect_gpu: { args: void; result: Ipc.GpuDetectionResult };
  is_packaged: { args: void; result: boolean };
  is_flatpak: { args: void; result: boolean };
  get_app_platform: { args: void; result: NodeJS.Platform };
  check_for_updates: { args: void; result: Ipc.CheckRefusal | null };
  download_update: { args: { candidateId: number }; result: Ipc.DownloadOutcome };
  install_update: { args: { candidateId: number }; result: void };
  cancel_update_download: { args: void; result: void };
  set_update_channel: { args: { channel: Ipc.UpdateChannel }; result: void };
  restart_app: { args: void; result: void };
  log_error: { args: { message: string }; result: void };
  notify_settings_flushed: { args: { generation: number }; result: void };
  mark_main_window_ready: { args: void; result: void };
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K]['args'] extends void
  ? []
  : [Commands[K]['args']];

// E2E-only seam: the WebDriver probe registers stubs here. A stub receives the
// command arguments and `next`, which performs the real invoke with the same
// arguments. A stub answers the call (resolve or reject) or passes it through.
type E2eIpcStub = (args: unknown, next: () => Promise<unknown>) => Promise<unknown>;
type E2eWindow = Window & {
  __ROSI_E2E_IPC_STUBS__?: Partial<Record<CommandName, E2eIpcStub>>;
};

function e2eStubFor(command: CommandName): E2eIpcStub | null {
  const stub = (window as E2eWindow).__ROSI_E2E_IPC_STUBS__?.[command];
  return typeof stub === 'function' ? stub : null;
}

/** Calls a Rust command with its typed arguments and result. */
export function call<K extends CommandName>(
  command: K,
  ...args: CommandArgs<K>
): Promise<Commands[K]['result']> {
  const [payload] = args;
  const invokeCommand = (): Promise<Commands[K]['result']> =>
    payload === undefined
      ? invoke<Commands[K]['result']>(command)
      : invoke<Commands[K]['result']>(command, payload as Record<string, unknown>);
  // Compared against the Vite define directly, so production builds drop this branch.
  if (import.meta.env.VITE_ROSI_E2E === '1') {
    const stub = e2eStubFor(command);
    if (stub) return stub(payload, invokeCommand) as Promise<Commands[K]['result']>;
  }
  return invokeCommand();
}

/** Calls a Rust command without waiting; failures are logged to the console. */
export function fire<K extends CommandName>(command: K, ...args: CommandArgs<K>): void {
  call(command, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[rosi] ${command}: ${message}`);
  });
}
