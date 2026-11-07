import type { DownloadProfile, DownloadRequestOptions } from '../generated/ipc-types';

export const UI_MESSAGES = {
  options: {
    profilePreview: (description: string) =>
      `${description}. Enter a valid URL and choose a save location to check effective options.`,
    // What each profile produces, shown before a URL exists to resolve it.
    profileDescriptions: {
      compatible:
        'Prefer MP4 when available; otherwise use the best available format. Often low resolution',
      'best-video': 'Highest available video and audio quality, merged into one file',
      audio: (audioFormat: string) => `Audio only, saved as ${audioFormat.toUpperCase()}`,
      custom: 'Pick exact video and audio formats below',
    } satisfies Record<
      DownloadRequestOptions['profile'] & string,
      string | ((format: string) => string)
    >,
    invalidUrl: 'Enter a valid http or https URL to check effective options.',
    destination: 'Choose a save location before effective options can be checked.',
    formats: 'Select a video or audio format before checking custom options.',
    playlist: 'Fix the playlist selection before checking effective options.',
    resolving: 'Checking effective options…',
    settingsSaving: 'Saving settings before checking effective options…',
    settingsUnsaved:
      'Settings are not saved. Retry the settings save before trusting the effective options preview.',
    unavailable:
      'Effective options are unavailable. ROSI will validate them when the download starts.',
    failed: (reason: string) => `Could not check effective options. ${reason}`,
    result: (details: string) => `Effective options: ${details}`,
    profiles: {
      compatible: 'Compatible',
      'best-video': 'Best video',
      audio: 'Audio only',
      custom: 'Custom formats',
    } satisfies Record<DownloadRequestOptions['profile'] & string, string>,
  },
  settings: {
    saving: 'Saving settings…',
    saved: 'Settings saved.',
    saveFailed: 'Settings did not save. Your choices are still here; retry the save.',
    conflict: 'Settings changed outside ROSI. Close ROSI and resolve that file before retrying.',
    retry: 'Retry save',
    resetTitle: (section: string) => `Reset ${section.toLowerCase()} settings?`,
    resetMessage: (section: string) =>
      `${section} settings will return to their defaults. You can cancel without changing them.`,
    resetConfirm: 'Reset section',
    resetCancel: 'Cancel',
    defaultsFailed: 'Could not load default settings. Nothing was reset.',
    resetSaved: 'Section restored to defaults.',
    resetFailed: 'Could not save the restored settings. Retry the save from Settings.',
  },
  controls: {
    convertAudioOnly: 'Conversion is unavailable while the Audio only profile is selected.',
  },
  queue: {
    pending: 'Waiting for the queue to start.',
    downloading: 'This download is in progress.',
    completed: 'This download completed.',
    failed: 'This download failed. Review its details before retrying.',
    cancelled: 'This download was cancelled. Requeue it to try again.',
    first: 'This is the first pending item in the queue.',
    last: 'This is the last pending item in the queue.',
  },
  activity: {
    completed: 'Completed',
    partial: 'Partially completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    partialCount: (successes: number, total: number) =>
      `${successes} of ${total} entries completed`,
    filesSaved: (count: number) => `${count} files saved`,
  },
  readiness: {
    formats:
      'Choose a video or audio format before downloading. Check available formats, then select one.',
    playlist: 'Fix the playlist range before downloading. Choose a valid start and end entry.',
    askEachTime: 'ROSI will ask where to save this download.',
    defaultFolder:
      'No download folder is set, so this download will save to your Downloads folder. Use Change… to pick another folder.',
    resolveFailed: (reason: string) =>
      `${UI_MESSAGES.options.failed(reason)} Download still checks these options when it starts.`,
    runtimeCheckFailed:
      "Couldn't check for Deno, so some YouTube downloads may fail. Open the install instructions, then restart ROSI to check again.",
  },
  wizard: {
    folderCancelled: 'No folder was chosen. Choose a folder or ask ROSI before each download.',
    folderFailed: 'ROSI could not open the folder picker. Try again or ask before each download.',
    saveFailed: 'ROSI could not save setup. Your choices are still here; try Finish or Skip again.',
    defaultsFailed: 'ROSI could not load default settings, so setup was not skipped. Try again.',
    denoMissing: "Deno isn't installed. Some YouTube videos may not download until it is.",
    denoChecking: 'Checking for Deno…',
    denoInstalling: 'Installing Deno. This may take a moment…',
    denoInstalled: 'Deno is installed. YouTube downloads are fully supported.',
    denoInstalledRestart: 'Deno is installed. Restart ROSI after setup to use it.',
    denoCheckFailed: "Couldn't check for Deno. Open the official install instructions for help.",
    denoInstallFailed: (reason: string) => `Automatic install failed: ${reason}`,
    flatpakRuntime:
      'This Flatpak build includes its own JavaScript runtime. YouTube downloads are fully supported.',
    installInstructions: 'Open install instructions',
    installDeno: 'Install Deno',
    denoCheckUnavailableTitle: 'Deno check unavailable',
    later: 'Later',
  },
} as const;

export type EffectiveOptionsReadiness =
  | { state: 'profile-preview'; profile: DownloadProfile; audioFormat?: string }
  | { state: 'invalid-url' }
  | { state: 'destination' }
  | { state: 'formats' }
  | { state: 'playlist' }
  | { state: 'settings-saving' }
  | { state: 'settings-unsaved' }
  | { state: 'ready'; request: Partial<DownloadRequestOptions>; usesDefaultFolder: boolean };

type EffectiveOptionsRequestBuilder = () => EffectiveOptionsReadiness;

let requestBuilder: EffectiveOptionsRequestBuilder = () => ({
  state: 'profile-preview',
  profile: 'compatible',
});
let requestGeneration = 0;
let requestTimer: ReturnType<typeof setTimeout> | null = null;
let lastRequestKey: string | null = null;
// Readiness that the Download button hint explains, kept beside the summary state.
let lastReadiness: EffectiveOptionsReadiness | null = null;
let lastResolveError: string | null = null;
let runtimeCheckFailed = false;

function describeProfileOutput(profile: DownloadProfile, audioFormat?: string) {
  const description = UI_MESSAGES.options.profileDescriptions[profile];
  return typeof description === 'function' ? description(audioFormat || 'mp3') : description;
}

function setSummaryState(summary: HTMLElement, state: string, text: string, busy = false) {
  summary.dataset.state = state;
  summary.textContent = text;
  summary.setAttribute('aria-busy', String(busy));
}

type ReadinessHint = { text: string; tone: 'blocked' | 'error' | 'warning' | 'info' };

function currentReadinessHint(): ReadinessHint | null {
  const state = lastReadiness?.state;
  if (state === 'formats') return { text: UI_MESSAGES.readiness.formats, tone: 'blocked' };
  if (state === 'playlist') return { text: UI_MESSAGES.readiness.playlist, tone: 'blocked' };
  if (lastResolveError) {
    return { text: UI_MESSAGES.readiness.resolveFailed(lastResolveError), tone: 'error' };
  }
  if (runtimeCheckFailed)
    return { text: UI_MESSAGES.readiness.runtimeCheckFailed, tone: 'warning' };
  if (state === 'destination') return { text: UI_MESSAGES.readiness.askEachTime, tone: 'info' };
  if (state === 'ready' && lastReadiness?.usesDefaultFolder) {
    return { text: UI_MESSAGES.readiness.defaultFolder, tone: 'info' };
  }
  return null;
}

/** Keep the reason and next action next to the Download button, not only in the summary. */
function renderReadinessHint() {
  const hint = document.getElementById('downloadReadiness');
  if (!(hint instanceof HTMLElement)) return;
  const next = currentReadinessHint();
  hint.textContent = next?.text ?? '';
  hint.hidden = !next;
  if (next) hint.dataset.tone = next.tone;
  else delete hint.dataset.tone;
}

/** The Deno check runs once at startup; its outcome feeds the Download hint. */
export function setRuntimeCheckFailed(failed: boolean) {
  if (runtimeCheckFailed === failed) return;
  runtimeCheckFailed = failed;
  renderReadinessHint();
}

function formatResolvedOptions(options: DownloadRequestOptions) {
  const profile = options.profile ?? (options.audioOnly ? 'audio' : 'compatible');
  const details = [UI_MESSAGES.options.profiles[profile]];
  if (options.presetName) details.push(`Preset: ${options.presetName}`);
  if (options.videoFormat) details.push(`Video ${options.videoFormat}`);
  if (options.audioFormat) details.push(`Audio ${options.audioFormat}`);
  if (options.audioOutputFormat) details.push(options.audioOutputFormat.toUpperCase());
  if (options.convertEnabled && options.convertFormat) {
    details.push(`Convert to ${options.convertFormat.toUpperCase()}`);
  }
  if (options.writeSubtitles) details.push('Subtitles');
  if (options.embedMetadata) details.push('Metadata');
  if (options.embedThumbnail) details.push('Thumbnail');
  if (options.sponsorblockRemove) details.push('SponsorBlock');
  if (options.playlist && options.playlist.mode !== 'current') {
    details.push(
      options.playlist.mode === 'all'
        ? 'Entire playlist'
        : `Playlist entries ${options.playlist.start ?? 1}–${options.playlist.end ?? 'last'}`
    );
  }
  return { profile, text: UI_MESSAGES.options.result(details.join(' · ')) };
}

export function configureEffectiveOptionsRequestBuilder(builder: EffectiveOptionsRequestBuilder) {
  requestBuilder = builder;
  lastRequestKey = null;
  refreshEffectiveOptionsSummary();
}

export function refreshEffectiveOptionsSummary(force = false) {
  const summary = document.getElementById('downloadOutputSummary');
  if (!(summary instanceof HTMLElement)) return;

  const readiness = requestBuilder();
  const key = JSON.stringify(readiness);
  if (!force && key === lastRequestKey) return;
  lastRequestKey = key;
  requestGeneration += 1;
  const generation = requestGeneration;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = null;
  delete summary.dataset.profile;
  lastReadiness = readiness;
  lastResolveError = null;
  renderReadinessHint();

  if (readiness.state !== 'ready') {
    const messages: Record<
      Exclude<EffectiveOptionsReadiness['state'], 'ready' | 'profile-preview'>,
      string
    > = {
      'invalid-url': UI_MESSAGES.options.invalidUrl,
      destination: UI_MESSAGES.options.destination,
      formats: UI_MESSAGES.options.formats,
      playlist: UI_MESSAGES.options.playlist,
      'settings-saving': UI_MESSAGES.options.settingsSaving,
      'settings-unsaved': UI_MESSAGES.options.settingsUnsaved,
    };
    const text =
      readiness.state === 'profile-preview'
        ? UI_MESSAGES.options.profilePreview(
            describeProfileOutput(readiness.profile, readiness.audioFormat)
          )
        : messages[readiness.state];
    setSummaryState(summary, readiness.state, text);
    return;
  }

  setSummaryState(summary, 'resolving', UI_MESSAGES.options.resolving, true);
  requestTimer = setTimeout(() => {
    requestTimer = null;
    if (JSON.stringify(requestBuilder()) !== key) {
      lastRequestKey = null;
      refreshEffectiveOptionsSummary();
      return;
    }
    const resolve = window.api.resolveDownloadOptions;
    if (typeof resolve !== 'function') {
      if (generation === requestGeneration) {
        setSummaryState(summary, 'unavailable', UI_MESSAGES.options.unavailable);
      }
      return;
    }
    void resolve(readiness.request).then(
      (result) => {
        if (generation !== requestGeneration || !summary.isConnected) return;
        if (!result || result.ok !== true) {
          const reason = result?.error?.message ?? 'Try again before downloading.';
          lastResolveError = reason;
          renderReadinessHint();
          setSummaryState(summary, 'error', UI_MESSAGES.options.failed(reason));
          return;
        }
        const resolved = formatResolvedOptions(result.data);
        summary.dataset.profile = resolved.profile;
        setSummaryState(summary, 'resolved', resolved.text);
      },
      (error: unknown) => {
        if (generation !== requestGeneration || !summary.isConnected) return;
        const reason = error instanceof Error ? error.message : 'Try again before downloading.';
        lastResolveError = reason;
        renderReadinessHint();
        setSummaryState(summary, 'error', UI_MESSAGES.options.failed(reason));
      }
    );
  }, 180);
}

// Modules are import-free IIFEs, so they read the same strings through this handle.
declare global {
  interface Window {
    rosiMessages?: typeof UI_MESSAGES;
  }
}
if (typeof window !== 'undefined') {
  window.rosiMessages = UI_MESSAGES;
}
