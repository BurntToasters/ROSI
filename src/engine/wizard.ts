// First-run setup wizard.
import {
  RosiSettings,
  iconsModule,
  isValidSubtitleLangs,
  logError,
  renderFolderSummary,
} from './core';
import { DENO_INSTALL_DOCS, isLinuxPlatform } from './deno';
import {
  focusFirstElement,
  focusTopOverlayOr,
  getFocusableElements,
  getTopActiveOverlayId,
  setMainContentInert,
  showModal,
  syncModalAccessibility,
} from './overlays';
import { applyFlatUi, updateBackgroundAnimation } from './theme';

/** Settings the setup wizard asks about; Skip resets exactly these. */
export const WIZARD_SETTING_KEYS = [
  'theme',
  'flatUi',
  'animateBackground',
  'askDownloadLocation',
  'downloadMode',
  'bestQuality',
  'audioOnly',
  'advancedOptions',
  'embedMetadata',
  'embedThumbnail',
  'sponsorblockRemove',
  'writeSubtitles',
  'subtitleLangs',
  'notifications',
  'checkUpdatesOnStartup',
] as const satisfies readonly (keyof RosiSettings)[];

export interface WizardOutcome {
  skipped: boolean;
  /** The user already saw the Deno step, so no follow-up prompt is needed. */
  denoReviewed: boolean;
}

export function launchSetupWizard(
  settings: RosiSettings,
  applyThemeFn: (preference: string) => void,
  persistSettingsFn: (silent?: boolean, immediate?: boolean) => Promise<boolean>,
  onComplete: (outcome: WizardOutcome) => void,
  isFlatpak = false
) {
  let currentStep = 0;

  const overlay = document.getElementById('setup-wizard');
  const progressBar = document.getElementById('wizard-progress-bar') as HTMLElement | null;
  const backBtn = document.getElementById('wizard-back') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('wizard-next');
  const dotsContainer = document.getElementById('wizard-dots');
  const steps = overlay
    ? overlay.querySelectorAll<HTMLElement>('.wizard-step')
    : ([] as unknown as NodeListOf<HTMLElement>);

  if (!overlay || !progressBar || !backBtn || !nextBtn || !dotsContainer || steps.length === 0) {
    settings.firstLaunch = false;
    void persistSettingsFn(false, true).then((saved) => {
      if (saved) onComplete({ skipped: true, denoReviewed: false });
    });
    return;
  }
  const TOTAL_STEPS = steps.length;

  const overlayEl = overlay;
  const progressBarEl = progressBar;
  const wizardProgress = overlayEl.querySelector<HTMLElement>('.wizard-progress');
  wizardProgress?.setAttribute('aria-valuemax', String(TOTAL_STEPS));
  const skipBtn = document.getElementById('wizard-skip') as HTMLButtonElement | null;
  const stepAnnounce = document.getElementById('wizard-step-announce');
  const backBtnEl = backBtn;
  const nextBtnEl = nextBtn;
  const dotsContainerEl = dotsContainer;

  // Build dots
  dotsContainerEl.innerHTML = '';
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = document.createElement('span');
    dot.className = 'wizard-dot' + (i === 0 ? ' active' : '');
    dotsContainerEl.appendChild(dot);
  }

  // Live theme preview
  const themeRadios = overlayEl.querySelectorAll<HTMLInputElement>('input[name="wizard-theme"]');
  themeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      applyThemeFn(radio.value);
    });
  });

  // Destination step: the folder is optional when asking every time.
  let wizardChosenFolder = settings.downloadFolder?.trim() || '';
  const wizardFolderSummary = document.getElementById('wizard-folder-summary');
  const wizardChooseFolderBtn = document.getElementById(
    'wizard-choose-folder'
  ) as HTMLButtonElement | null;
  const wizardAskLocation = document.getElementById(
    'wizard-ask-location'
  ) as HTMLInputElement | null;

  const syncWizardFolderSummary = () => {
    if (!wizardFolderSummary) return;
    if (wizardAskLocation?.checked) {
      wizardFolderSummary.textContent = 'ROSI will ask before every download';
      return;
    }
    wizardFolderSummary.textContent = wizardChosenFolder || 'Choose a folder or ask each time';
  };
  if (wizardAskLocation) {
    wizardAskLocation.checked = !!settings.askDownloadLocation;
    wizardAskLocation.addEventListener('change', syncWizardFolderSummary);
  }
  if (wizardChooseFolderBtn) {
    wizardChooseFolderBtn.addEventListener('click', async () => {
      wizardChooseFolderBtn.disabled = true;
      try {
        const chosen = await window.api.selectDownloadLocation();
        if (chosen) {
          wizardChosenFolder = chosen;
          if (wizardAskLocation) wizardAskLocation.checked = false;
          syncWizardFolderSummary();
        }
      } finally {
        wizardChooseFolderBtn.disabled = false;
      }
    });
  }
  const initialProfileValue =
    settings.downloadMode === 'best-video' || settings.downloadMode === 'audio'
      ? settings.downloadMode
      : 'compatible';
  const initialProfileRadio = overlayEl.querySelector<HTMLInputElement>(
    `input[name="wizard-profile"][value="${initialProfileValue}"]`
  );
  if (initialProfileRadio) initialProfileRadio.checked = true;
  syncWizardFolderSummary();

  const wizardCheckbox = (id: string) => document.getElementById(id) as HTMLInputElement | null;

  // Look and feel: preview live, like the theme cards.
  const flatUiInput = wizardCheckbox('wizard-flat-ui');
  const animateBgInput = wizardCheckbox('wizard-animate-bg');
  if (flatUiInput) {
    flatUiInput.checked = !!settings.flatUi;
    flatUiInput.addEventListener('change', () => applyFlatUi(flatUiInput.checked));
  }
  if (animateBgInput) {
    animateBgInput.checked = settings.animateBackground ?? true;
    animateBgInput.addEventListener('change', () =>
      updateBackgroundAnimation(animateBgInput.checked)
    );
  }

  // Download extras.
  const extraInputs: [
    HTMLInputElement | null,
    'embedMetadata' | 'embedThumbnail' | 'sponsorblockRemove' | 'writeSubtitles',
  ][] = [
    [wizardCheckbox('wizard-embed-metadata'), 'embedMetadata'],
    [wizardCheckbox('wizard-embed-thumbnail'), 'embedThumbnail'],
    [wizardCheckbox('wizard-sponsorblock'), 'sponsorblockRemove'],
    [wizardCheckbox('wizard-subtitles'), 'writeSubtitles'],
  ];
  extraInputs.forEach(([input, key]) => {
    if (input) input.checked = !!settings[key];
  });
  const subtitlesInput = wizardCheckbox('wizard-subtitles');
  const subtitleLangsRow = document.getElementById('wizard-subtitle-langs-row');
  const subtitleLangsInput = wizardCheckbox('wizard-subtitle-langs');
  const subtitleLangsError = document.getElementById('wizard-subtitle-langs-error');
  if (subtitleLangsInput) subtitleLangsInput.value = settings.subtitleLangs || 'en';
  const setSubtitleLangsError = (message: string) => {
    if (subtitleLangsError) subtitleLangsError.textContent = message;
    if (message) subtitleLangsInput?.setAttribute('aria-invalid', 'true');
    else subtitleLangsInput?.removeAttribute('aria-invalid');
  };
  const syncSubtitleRow = () => {
    if (subtitleLangsRow) subtitleLangsRow.hidden = !subtitlesInput?.checked;
    if (!subtitlesInput?.checked) setSubtitleLangsError('');
  };
  subtitlesInput?.addEventListener('change', syncSubtitleRow);
  subtitleLangsInput?.addEventListener('input', () => setSubtitleLangsError(''));
  syncSubtitleRow();

  /** Block leaving the extras step with languages the backend would reject. */
  function subtitleLangsValid() {
    if (!subtitlesInput?.checked || !subtitleLangsInput) return true;
    if (isValidSubtitleLangs(subtitleLangsInput.value.trim())) return true;
    setSubtitleLangsError('Enter language codes such as en,es, or use all.');
    subtitleLangsInput.focus();
    return false;
  }

  // YouTube helper: check for Deno the first time the step is shown.
  const stepIndex = (name: string) =>
    Array.from(steps).findIndex((step) => step.dataset.wizardStep === name);
  const extrasStepIndex = stepIndex('extras');
  const denoStepIndex = stepIndex('deno');
  const denoStatus = document.getElementById('wizard-deno-status');
  const denoDescription = document.getElementById('wizard-deno-description');
  const denoAction = document.getElementById('wizard-deno-action') as HTMLButtonElement | null;
  let denoChecked = false;
  let denoReviewed = false;

  function setDenoStatus(
    state: 'checking' | 'installed' | 'missing' | 'installing' | 'error',
    text: string
  ) {
    if (!denoStatus) return;
    denoStatus.dataset.state = state;
    const iconName = {
      checking: 'hourglass',
      installing: 'hourglass',
      installed: 'circle-check',
      missing: 'triangle-alert',
      error: 'circle-x',
    }[state];
    const iconSlot = denoStatus.querySelector<HTMLElement>('.wizard-status-icon');
    const textSlot = denoStatus.querySelector<HTMLElement>('.wizard-status-text');
    const svg = iconsModule?.icon(iconName, 18) ?? null;
    if (iconSlot) iconSlot.replaceChildren(...(svg ? [svg] : []));
    if (textSlot) textSlot.textContent = text;
  }

  function setDenoAction(label: string | null, action: (() => void) | null) {
    if (!denoAction) return;
    denoAction.hidden = !label;
    denoAction.disabled = false;
    denoAction.textContent = label ?? '';
    denoAction.onclick = action;
  }

  function showDenoMissing() {
    setDenoStatus(
      'missing',
      "Deno isn't installed. Some YouTube videos may not download until it is."
    );
    if (isLinuxPlatform()) {
      setDenoAction('Open install instructions', () => {
        void window.api.openExternal(DENO_INSTALL_DOCS);
      });
    } else {
      setDenoAction('Install Deno', () => void installDenoFromWizard());
    }
  }

  async function installDenoFromWizard() {
    setDenoStatus('installing', 'Installing Deno. This may take a moment…');
    if (denoAction) denoAction.disabled = true;
    try {
      const result = await window.api.installDeno();
      if (result && result.cancelled) {
        showDenoMissing();
        return;
      }
      if (result?.success !== true) {
        throw new Error(result?.error || 'Deno installation did not complete successfully.');
      }
      setDenoStatus('installed', 'Deno is installed. Restart ROSI after setup to use it.');
      setDenoAction(null, null);
    } catch (error) {
      const message =
        (error as { error?: string })?.error ||
        (error instanceof Error ? error.message : 'Unknown error');
      setDenoStatus('error', `Automatic install failed: ${message}`);
      setDenoAction('Open Deno website', () => {
        void window.api.openExternal('https://deno.land');
      });
    }
  }

  async function checkDenoForWizard() {
    if (denoChecked) return;
    denoChecked = true;
    setDenoAction(null, null);
    if (isFlatpak) {
      // The Flatpak bundles Node.js for yt-dlp, so no host Deno is needed.
      if (denoDescription) {
        denoDescription.textContent =
          'yt-dlp uses a small JavaScript runtime for full YouTube support. This Flatpak build includes its own.';
      }
      setDenoStatus(
        'installed',
        'This Flatpak build includes its own JavaScript runtime. YouTube downloads are fully supported.'
      );
      return;
    }
    setDenoStatus('checking', 'Checking for Deno…');
    try {
      if (await window.api.checkDenoInstalled()) {
        setDenoStatus('installed', 'Deno is installed. YouTube downloads are fully supported.');
      } else {
        showDenoMissing();
      }
    } catch (error) {
      logError('Wizard Deno check failed', error);
      setDenoStatus('error', "Couldn't check for Deno.");
      setDenoAction('Open install instructions', () => {
        void window.api.openExternal(DENO_INSTALL_DOCS);
      });
    }
  }

  function updateUI() {
    // Steps
    steps.forEach((step, i) => {
      step.classList.toggle('active', i === currentStep);
    });

    progressBarEl.style.width = ((currentStep + 1) / TOTAL_STEPS) * 100 + '%';
    if (wizardProgress) {
      wizardProgress.setAttribute('aria-valuenow', String(currentStep + 1));
    }
    if (stepAnnounce) {
      stepAnnounce.textContent = `Step ${currentStep + 1} of ${TOTAL_STEPS}`;
    }

    const dots = dotsContainerEl.querySelectorAll('.wizard-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === currentStep);
    });

    if (currentStep === 0) {
      backBtnEl.setAttribute('hidden', '');
      backBtnEl.disabled = true;
      backBtnEl.setAttribute('tabindex', '-1');
    } else {
      backBtnEl.removeAttribute('hidden');
      backBtnEl.disabled = false;
      backBtnEl.removeAttribute('tabindex');
    }

    if (skipBtn) skipBtn.hidden = currentStep === TOTAL_STEPS - 1;
    if (currentStep === denoStepIndex) {
      denoReviewed = true;
      void checkDenoForWizard();
    }

    // Next button text
    if (currentStep === 0) {
      nextBtnEl.textContent = 'Get Started';
    } else if (currentStep === TOTAL_STEPS - 1) {
      nextBtnEl.textContent = 'Finish';
    } else {
      nextBtnEl.textContent = 'Next';
    }
  }

  function gatherSettings() {
    // Theme
    const selectedTheme = overlayEl.querySelector<HTMLInputElement>(
      'input[name="wizard-theme"]:checked'
    );
    if (selectedTheme) {
      settings.theme = selectedTheme.value as RosiSettings['theme'];
      applyThemeFn(settings.theme);
    }

    // Destination
    const askLocation = document.getElementById('wizard-ask-location') as HTMLInputElement | null;
    if (askLocation) settings.askDownloadLocation = askLocation.checked;
    if (wizardChosenFolder) settings.downloadFolder = wizardChosenFolder;

    // Default profile
    const selectedProfile = overlayEl.querySelector<HTMLInputElement>(
      'input[name="wizard-profile"]:checked'
    );
    const profile = selectedProfile?.value;
    const mode = profile === 'best-video' || profile === 'audio' ? profile : 'compatible';
    settings.downloadMode = mode;
    settings.bestQuality = mode === 'best-video';
    settings.audioOnly = mode === 'audio';
    settings.advancedOptions = false;
    if (mode === 'audio') settings.convertEnabled = false;

    // Download prefs
    const notifications = document.getElementById(
      'wizard-notifications'
    ) as HTMLInputElement | null;
    const autoUpdates = document.getElementById('wizard-auto-updates') as HTMLInputElement | null;

    if (notifications) settings.notifications = notifications.checked;
    if (autoUpdates) settings.checkUpdatesOnStartup = autoUpdates.checked;

    // Look and feel
    if (flatUiInput) settings.flatUi = flatUiInput.checked;
    if (animateBgInput) settings.animateBackground = animateBgInput.checked;

    // Download extras
    extraInputs.forEach(([input, key]) => {
      if (input) settings[key] = input.checked;
    });
    const langs = subtitleLangsInput?.value.trim() ?? '';
    if (settings.writeSubtitles && isValidSubtitleLangs(langs)) settings.subtitleLangs = langs;
  }

  /** Skip: put every wizard-managed setting back to its default. */
  async function applyWizardDefaults() {
    let defaults: Partial<RosiSettings> | null = null;
    try {
      const result = await window.api.getDefaultSettings();
      if (result && result.ok) defaults = result.data as Partial<RosiSettings>;
    } catch (error) {
      logError('Could not load default settings for setup skip', error);
    }
    if (defaults) {
      const target = settings as unknown as Record<string, unknown>;
      const source = defaults as unknown as Record<string, unknown>;
      WIZARD_SETTING_KEYS.forEach((key) => {
        if (key in source) target[key] = source[key];
      });
    }
    applyThemeFn(settings.theme || 'system');
    applyFlatUi(!!settings.flatUi);
    updateBackgroundAnimation(settings.animateBackground ?? true);
  }

  async function finalizeWizard(skipped: boolean): Promise<boolean> {
    if (!skipped) gatherSettings();
    settings.firstLaunch = false;
    const saved = await persistSettingsFn(false, true);
    if (!saved) return false;

    const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement | null;
    if (themeSelect) themeSelect.value = settings.theme || 'system';
    const notificationsToggle = document.getElementById(
      'notificationsToggle'
    ) as HTMLInputElement | null;
    if (notificationsToggle) notificationsToggle.checked = settings.notifications;
    const checkUpdatesToggle = document.getElementById(
      'checkUpdatesOnStartupToggle'
    ) as HTMLInputElement | null;
    if (checkUpdatesToggle) checkUpdatesToggle.checked = settings.checkUpdatesOnStartup;
    const askLocationToggle = document.getElementById(
      'askDownloadLocationToggle'
    ) as HTMLInputElement | null;
    if (askLocationToggle) askLocationToggle.checked = settings.askDownloadLocation;
    const folderSummary = document.getElementById('downloadFolderSummary');
    if (folderSummary) renderFolderSummary(folderSummary, settings.downloadFolder);

    return true;
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep === extrasStepIndex && !subtitleLangsValid()) return;
    if (currentStep < TOTAL_STEPS - 1) {
      currentStep++;
      updateUI();
    } else {
      void closeWizard(false);
    }
  });

  backBtnEl.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep--;
      updateUI();
    }
  });

  // Set initial selected theme radio to match current settings
  const initialTheme = settings.theme || 'system';
  const matchingRadio = overlayEl.querySelector<HTMLInputElement>(
    `input[name="wizard-theme"][value="${initialTheme}"]`
  );
  if (matchingRadio) matchingRadio.checked = true;

  let wizardPreviousFocus: Element | null = null;
  let wizardTrapHandler: ((e: KeyboardEvent) => void) | null = null;
  let wizardFocusinHandler: ((e: FocusEvent) => void) | null = null;

  let wizardSkipping = false;
  let wizardClosed = false;
  let wizardSaving = false;

  async function skipWizard() {
    if (wizardSkipping || wizardClosed) return;
    wizardSkipping = true;
    if (skipBtn) skipBtn.disabled = true;
    await applyWizardDefaults();
    await closeWizard(true);
  }
  skipBtn?.addEventListener('click', () => void skipWizard());

  async function closeWizard(skipped = false) {
    if (wizardClosed || wizardSaving) return;
    wizardSaving = true;
    const nextButton = nextBtn as HTMLButtonElement;
    nextButton.disabled = true;
    backBtnEl.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    const saved = await finalizeWizard(skipped);
    if (!saved) {
      wizardSaving = false;
      wizardSkipping = false;
      nextButton.disabled = false;
      backBtnEl.disabled = false;
      if (skipBtn) skipBtn.disabled = false;
      return;
    }
    wizardClosed = true;
    if (wizardTrapHandler) {
      overlayEl.removeEventListener('keydown', wizardTrapHandler);
      wizardTrapHandler = null;
    }
    if (wizardFocusinHandler) {
      document.removeEventListener('focusin', wizardFocusinHandler, true);
      wizardFocusinHandler = null;
    }
    overlayEl.classList.remove('active');
    overlayEl.setAttribute('aria-hidden', 'true');
    syncModalAccessibility();
    setMainContentInert(false);
    focusTopOverlayOr(wizardPreviousFocus);
    wizardPreviousFocus = null;
    onComplete({ skipped, denoReviewed: !skipped && denoReviewed });
  }

  wizardPreviousFocus = document.activeElement;
  overlayEl.setAttribute('aria-hidden', 'false');
  setMainContentInert(true);

  wizardTrapHandler = (e: KeyboardEvent) => {
    if (getTopActiveOverlayId() !== 'setup-wizard') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      showModal({
        title: 'Skip setup?',
        message: 'Skip setup and start with the default settings?',
        buttons: [
          { label: 'Keep setting up', primary: true },
          { label: 'Skip setup', action: () => void skipWizard() },
        ],
      });
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(overlayEl);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (!active || active === first) {
        e.preventDefault();
        last?.focus();
      }
    } else if (!active || active === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  overlayEl.addEventListener('keydown', wizardTrapHandler);

  wizardFocusinHandler = (e: FocusEvent) => {
    if (!overlayEl.classList.contains('active') || getTopActiveOverlayId() !== 'setup-wizard') {
      return;
    }
    const target = e.target;
    if (target instanceof Node && overlayEl.contains(target)) return;
    if (!focusFirstElement(overlayEl) && typeof overlayEl.focus === 'function') {
      overlayEl.focus();
    }
  };
  document.addEventListener('focusin', wizardFocusinHandler, true);

  updateUI();
  overlayEl.classList.add('active');
  syncModalAccessibility();
  requestAnimationFrame(() => {
    if (getTopActiveOverlayId() !== 'setup-wizard') return;
    if (!focusFirstElement(overlayEl)) {
      nextBtnEl.focus();
    }
  });
}
