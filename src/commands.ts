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
  get_formats: { args: { url: string }; result: Envelope<string> };
  cancel_formats: { args: void; result: void };
  get_video_info: {
    args: { url: string; playlistMode: 'current' | 'all' | null };
    result: Envelope<Ipc.VideoInfo>;
  };
  cancel_video_info: { args: void; result: void };
  download_video: {
    args: { options: Partial<Ipc.DownloadRequestOptions> };
    result: Envelope<Ipc.DownloadStarted>;
  };
  cancel_download: { args: void; result: void };
  add_to_queue: {
    args: { urls: string[]; options: Partial<Ipc.DownloadRequestOptions> | null };
    result: Envelope<Ipc.AddResult>;
  };
  remove_from_queue: { args: { id: string }; result: Envelope<void> };
  retry_queue_item: { args: { id: string }; result: Envelope<void> };
  reorder_queue_item: {
    args: { request: { id: string; direction: 'up' | 'down' } };
    result: Envelope<void>;
  };
  clear_queue: { args: void; result: Envelope<void> };
  clear_finished_queue: { args: void; result: Envelope<Ipc.RemovedCount> };
  get_queue: { args: void; result: Ipc.QueueItem[] };
  start_queue: { args: void; result: Envelope<Ipc.QueueStarted> };
  cancel_queue: { args: void; result: Envelope<void> };
  select_download_location: { args: void; result: string | null };
  open_external: { args: { url: string }; result: Envelope<Ipc.Opened> };
  open_file_location: { args: { filePath: string }; result: Envelope<Ipc.Opened> };
  show_notification: {
    args: { options: { title?: string; body?: string; filePath?: string } };
    result: Envelope<Ipc.Shown>;
  };
  check_deno_installed: { args: void; result: boolean };
  install_deno: { args: void; result: Ipc.InstallResult };
  detect_gpu: { args: void; result: Ipc.GpuDetectionResult };
  is_packaged: { args: void; result: boolean };
  is_flatpak: { args: void; result: boolean };
  get_app_platform: { args: void; result: NodeJS.Platform };
  get_distribution_channel: { args: void; result: string };
  get_beta_updater_target: { args: void; result: string };
  get_compact_updater_target: { args: { beta: boolean }; result: string | null };
  restart_app: { args: void; result: void };
  log_error: { args: { message: string }; result: void };
  notify_settings_flushed: { args: { generation: number }; result: void };
  mark_main_window_ready: { args: void; result: void };
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K]['args'] extends void
  ? []
  : [Commands[K]['args']];

/** Calls a Rust command with its typed arguments and result. */
export function call<K extends CommandName>(
  command: K,
  ...args: CommandArgs<K>
): Promise<Commands[K]['result']> {
  const [payload] = args;
  return payload === undefined
    ? invoke<Commands[K]['result']>(command)
    : invoke<Commands[K]['result']>(command, payload as Record<string, unknown>);
}

/** Calls a Rust command without waiting; failures are logged to the console. */
export function fire<K extends CommandName>(command: K, ...args: CommandArgs<K>): void {
  call(command, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[rosi] ${command}: ${message}`);
  });
}
