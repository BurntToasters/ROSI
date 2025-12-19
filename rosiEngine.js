  function isMac() {
    return navigator.platform.toLowerCase().includes('mac');
  }

  function getModifierKey() {
    return isMac() ? 'metaKey' : 'ctrlKey';
  }

  function getModifierKeyName() {
    return isMac() ? 'Cmd' : 'Ctrl';
  }

  function isValidUrl(string) {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  // toggles console output visibility
  function updateConsoleVisibility(show) {
    const consoleSection = document.getElementById('console-section');
    if (consoleSection) {
      if (show) {
        consoleSection.classList.add('visible');
      } else {
        consoleSection.classList.remove('visible');
      }
    }
  }

  // handles loader in button, swaps text for spinner, click cancels
  function setButtonLoading(button, isLoading, onCancel) {
    if (!button) return;
    if (isLoading) {
      if (!button.dataset.defaultText) {
        button.dataset.defaultText = button.textContent.trim();
      }
      button.classList.add('loading');
      button.innerHTML = `<img src="loader.svg" class="loader-icon" alt="Loading...">`;
      button.disabled = false;
      button.onclick = onCancel;
    } else {
      button.classList.remove('loading');
      button.innerHTML = button.dataset.defaultText || 'Action';
      button.disabled = false;
      button.onclick = button._originalClick;
    }
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar) return;
    
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
      sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
    } else {
      sidebar.classList.add('open');
      if (overlay) overlay.classList.add('active');
    }
  }
  
  function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }
  function toggleAdvancedUI(show) {
    const formatSection = document.getElementById('formatOptions');
    if (formatSection) {
      if (show) {
        formatSection.classList.add('visible');
      } else {
        formatSection.classList.remove('visible');
      }
    }
  }
  
  function showModal({ title, message, buttons = [] }) {
    const modal = document.getElementById('app-modal');
    const titleEl = document.getElementById('modal-title');
    const msgEl = document.getElementById('modal-message');
    const btnContainer = document.getElementById('modal-buttons');
    if (!modal || !titleEl || !msgEl || !btnContainer) return;
    
    titleEl.textContent = title;
    msgEl.innerHTML = message.replace(/\n/g, '<br>');
    btnContainer.innerHTML = '';
    
    modal.classList.add('showing');
    modal.classList.add('active');

    void modal.offsetWidth;
    requestAnimationFrame(() => {
      modal.classList.remove('showing');
    });
    
    buttons.forEach(({ label, action }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.onclick = () => {
        hideModal(modal, action);
      };
      btnContainer.appendChild(btn);
    });
  }

  function hideModal(modal, action) {
    modal.classList.add('hiding');
    setTimeout(() => {
      modal.classList.remove('active', 'hiding');
      if (typeof action === 'function') action();
    }, 200);
  }
  
  function showKeyboardShortcuts() {
    const modKey = getModifierKeyName();
    showModal({
      title: "Keyboard Shortcuts",
      message: `
        <ul style="text-align: left; list-style: none;">
          <li><strong>${modKey}+D:</strong> Restart application</li>
          <li><strong>${modKey}+F:</strong> Focus URL input field</li>
          <li><strong>${modKey}+,:</strong> Open settings</li>
        </ul>
      `,
      buttons: [{ label: "OK" }]
    });
  }

  let isFetchingFormats = false;
  let fetchFormatsAbort = null;
  async function fetchFormats() {
    const btn = document.getElementById('fetchFormatsBtn');
    const urlInput = document.getElementById('url');
    const videoUrl = urlInput ? urlInput.value : null;
    
    try {
      if (!btn || !videoUrl || videoUrl.trim() === "") {
        showModal({ title: "Input Error", message: "Please enter a video URL first.", buttons: [{ label: "OK" }] });
        return;
      }
      
      // Validate URL format
      if (!isValidUrl(videoUrl.trim())) {
        showModal({ 
          title: "Invalid URL", 
          message: "Please enter a valid URL starting with http:// or https://", 
          buttons: [{ label: "OK" }] 
        });
        return;
      }
      
      if (isFetchingFormats) return;
      isFetchingFormats = true;
      fetchFormatsAbort = () => {
        isFetchingFormats = false;
        setButtonLoading(btn, false);
      };
      setButtonLoading(btn, true, () => {
        window.api.cancelDownload();
        fetchFormatsAbort();
      });
      const videoSelect = document.getElementById('videoFormat');
      const audioSelect = document.getElementById('audioFormat');
      if (videoSelect) videoSelect.innerHTML = '<option value="">Loading...</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Loading...</option>';
      try {
        const output = await window.api.getFormats(videoUrl);
        const lines = output.split('\n');
        if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
        if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
        let videoFormatsFound = 0, audioFormatsFound = 0;
        lines.forEach(line => {
          if (/^\s*\d+\s+[a-zA-Z0-9]+/.test(line.trim())) {
            const parts = line.trim().split(/\s+/);
            const formatId = parts[0];
            const option = document.createElement('option');
            option.value = formatId;
            let labelText = line.trim();
            const resolutionMatch = labelText.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)/);
            const fpsMatch = labelText.match(/@\s*(\d+fps)/);
            const sizeMatch = labelText.match(/(\d+(\.\d+)?(MiB|GiB|KiB))/);
            const codecMatch = line.match(/(avc1|vp9|av01|h264|h265|opus|mp4a|aac|vorbis)/i);
            let cleanLabel = `ID: ${formatId}`;
            if (resolutionMatch) cleanLabel += ` ${resolutionMatch[0]}`;
            if (fpsMatch) cleanLabel += ` ${fpsMatch[1]}`;
            if (codecMatch) cleanLabel += ` (${codecMatch[0]})`;
            if (sizeMatch) cleanLabel += ` ~${sizeMatch[0]}`;
            option.text = cleanLabel;
            option.title = line.trim();
            const isVideo = /video/.test(line.toLowerCase()) && !/audio only/i.test(line);
            const isAudio = /audio/.test(line.toLowerCase()) && !/video only/i.test(line);
            const isVideoOnly = /video only/i.test(line);
            const isAudioOnly = /audio only/i.test(line);
            if (isVideoOnly || (isVideo && !isAudio)) {
              if (videoSelect) videoSelect.appendChild(option);
              videoFormatsFound++;
            } else if (isAudioOnly || (isAudio && !isVideo)) {
              if (audioSelect) audioSelect.appendChild(option);
              audioFormatsFound++;
            } else if (isVideo && isAudio) {
              if (videoSelect) videoSelect.appendChild(option);
              videoFormatsFound++;
            }
          }
        });
        if (videoFormatsFound === 0 && videoSelect) videoSelect.innerHTML = '<option value="">No video formats found</option>';
        if (audioFormatsFound === 0 && audioSelect) audioSelect.innerHTML = '<option value="">No audio formats found</option>';
      } catch (e) {
        const errorMessage = typeof e === 'string' ? e : (e.message || 'Unknown error');
        if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
        if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
        showModal({
          title: "Format Fetch Failed",
          message: `Could not retrieve formats.\nError: ${errorMessage}`,
          buttons: [{ label: "OK" }]
        });
      } finally {
        isFetchingFormats = false;
        setButtonLoading(btn, false);
      }
    } catch (outerError) {
      console.error('Unexpected error in fetchFormats:', outerError);
      isFetchingFormats = false;
      if (btn) setButtonLoading(btn, false);
      showModal({
        title: "Unexpected Error",
        message: "An unexpected error occurred while fetching formats. Please try again.",
        buttons: [{ label: "OK" }]
      });
    }
  }

  // handles download button logic
  let isDownloading = false;
  let downloadAbort = null;
  let lastDownloadedFilePath = null;

  function showProgressBar(status = 'Downloading...') {
    const container = document.getElementById('progress-container');
    const statusEl = document.getElementById('progress-status');
    const percentEl = document.getElementById('progress-percent');
    const bar = document.getElementById('progress-bar');
    const details = document.getElementById('progress-details');
    
    if (container) {
      container.classList.add('visible');
    }
    if (statusEl) statusEl.textContent = status;
    if (percentEl) percentEl.textContent = '0%';
    if (bar) {
      bar.style.width = '0%';
      bar.classList.remove('indeterminate');
    }
    if (details) details.textContent = '';
  }

  function updateProgressBar(percent, statusText = null, detailsText = null) {
    const statusEl = document.getElementById('progress-status');
    const percentEl = document.getElementById('progress-percent');
    const bar = document.getElementById('progress-bar');
    const details = document.getElementById('progress-details');
    
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
    if (bar) {
      bar.style.width = `${percent}%`;
      bar.classList.remove('indeterminate');
    }
    if (statusText && statusEl) statusEl.textContent = statusText;
    if (detailsText && details) details.textContent = detailsText;
  }

  function setProgressIndeterminate(status = 'Processing...') {
    const statusEl = document.getElementById('progress-status');
    const percentEl = document.getElementById('progress-percent');
    const bar = document.getElementById('progress-bar');
    const details = document.getElementById('progress-details');
    
    if (statusEl) statusEl.textContent = status;
    if (percentEl) percentEl.textContent = '';
    if (bar) bar.classList.add('indeterminate');
    if (details) details.textContent = '';
  }

  function hideProgressBar() {
    const container = document.getElementById('progress-container');
    if (container) {
      container.classList.remove('visible');
    }
  }

  function parseYtdlpProgress(message) {
    const progressMatch = message.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
    if (progressMatch) {
      return {
        percent: parseFloat(progressMatch[1]),
        totalSize: progressMatch[2],
        speed: progressMatch[3],
        eta: progressMatch[4]
      };
    }

    const simpleMatch = message.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)/);
    if (simpleMatch) {
      return {
        percent: parseFloat(simpleMatch[1]),
        totalSize: simpleMatch[2],
        speed: null,
        eta: null
      };
    }
    
    return null;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async function checkForUpdates() {
    const channel = window.api.getChannel();

    if (channel === 'msstore') {
      showModal({
        title: "Microsoft Store Version",
        message: "Updates for the Microsoft Store version are managed through the Microsoft Store app.",
        buttons: [
          { label: "Open Store", action: () => window.api.openExternal('ms-windows-store://pdp/?ProductId=9N0BQSTFL4SV') },
          { label: "OK" }
        ]
      });
      return;
    }

    try {
      showModal({
        title: "Checking for Updates",
        message: "Please wait while we check for updates...",
        buttons: []
      });
      
      const result = await window.api.checkForUpdates();

      if (result && result.error === 'dev-mode') {
        showModal({
          title: "Development Mode",
          message: "Update checking is not available when running in development mode.<br><br>Build and package the app to test auto-updates.",
          buttons: [{ label: "OK" }]
        });
        return;
      }

      if (result && result.error && result.error !== 'dev-mode') {
        showModal({
          title: "Update Check Failed",
          message: `Could not check for updates.<br><br>Error: ${result.error}`,
          buttons: [{ label: "OK" }]
        });
        return;
      }
    } catch (e) {
      showModal({
        title: "Update Check Failed",
        message: "Could not check for updates. Please try again later.",
        buttons: [{ label: "OK" }]
      });
    }
  }

  let updaterCleanupFunctions = [];
  
  function setupAutoUpdater() {
    let updateVersion = '';
    
    updaterCleanupFunctions.push(
      window.api.onUpdaterStatus((data) => {
        switch (data.status) {
          case 'checking':
            break;
            
          case 'available':
            updateVersion = data.version;
            showModal({
              title: "Update Available!",
              message: `A new version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`,
              buttons: [
                { 
                  label: "Download & Install", 
                  action: async () => {
                    showModal({
                      title: "Downloading Update",
                      message: `<div class="update-progress-container">
                        <div class="update-progress-bar-wrapper">
                          <div id="update-progress-bar" class="update-progress-bar"></div>
                        </div>
                        <div id="update-progress-info" class="update-progress-info">Starting download...</div>
                      </div>`,
                      buttons: []
                    });
                    await window.api.downloadUpdate();
                  }
                },
                { label: "Later" }
              ]
            });
            break;
            
          case 'not-available':
            showModal({
              title: "ROSI is up to date!",
              message: `You are running the latest version (v${data.version}).`,
              buttons: [{ label: "OK" }]
            });
            break;
            
          case 'error':
            showModal({
              title: "Update Error",
              message: `An error occurred while checking for updates:\n${data.message}`,
              buttons: [{ label: "OK" }]
            });
            break;
            
          case 'downloaded':
            showModal({
              title: "Update Ready!",
              message: `Version ${data.version} has been downloaded.\n\nThe update will be installed when you restart ROSI.`,
              buttons: [
                { 
                  label: "Restart Now", 
                  action: () => window.api.installUpdate()
                },
                { label: "Later" }
              ]
            });
            break;
        }
      })
    );
    
    updaterCleanupFunctions.push(
      window.api.onUpdaterProgress((data) => {
        const progressBar = document.getElementById('update-progress-bar');
        const progressInfo = document.getElementById('update-progress-info');
        
        if (progressBar) {
          progressBar.style.width = `${data.percent}%`;
        }
        
        if (progressInfo) {
          const speed = formatBytes(data.bytesPerSecond) + '/s';
          const downloaded = formatBytes(data.transferred);
          const total = formatBytes(data.total);
          progressInfo.textContent = `${downloaded} / ${total} (${speed}) - ${Math.round(data.percent)}%`;
        }
      })
    );
  }

  function cleanupUpdaterListeners() {
    updaterCleanupFunctions.forEach(cleanup => {
      if (typeof cleanup === 'function') {
        try { cleanup(); } catch (e) { /* ignore */ }
      }
    });
    updaterCleanupFunctions = [];
  }

function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function hideLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.classList.remove('active');
    setTimeout(() => {
      document.body.style.overflow = '';
    }, 300);
  }
}

  function updateBackgroundAnimation(animate) {
    const body = document.body;
    if (animate) {
      body.classList.add('animate-bg');
    } else {
      body.classList.remove('animate-bg');
    }
  }

  // check for Deno
  async function checkDenoInstallation(settings) {
    if (settings.denoReminderDismissed) {
      return;
    }
    
    try {
      const isInstalled = await window.api.checkDenoInstalled();
      
      if (!isInstalled) {
        showModal({
          title: "Deno Required for Full YouTube Functionality",
          message: "Recent updates to yt-dlp require Deno for full YouTube functionality.<br><br>Would you like to install Deno now?<br><br> ℹ️If you have NodeJS installed, you can ignore this message (yt-dlp will use nodejs instead).",
          buttons: [
            { 
              label: "Install", 
              action: async () => {
                showModal({
                  title: "Installing Deno...",
                  message: "Please wait while Deno is being installed. This may take a moment.",
                  buttons: []
                });
                
                try {
                  await window.api.installDeno();
                  showModal({
                    title: "Installation Complete",
                    message: "Deno has been successfully installed!<br>You may need to restart your terminal or system for changes to take effect.",
                    buttons: [{ label: "OK" }]
                  });
                } catch (error) {
                  showModal({
                    title: "Installation Failed",
                    message: `Failed to install Deno automatically.<br><br>Please install manually:<br>Mac/Linux: curl -fsSL https://deno.land/install.sh | sh<br>Windows: irm https://deno.land/install.ps1 | iex<br><br>Error: ${error.error || 'Unknown error'}`,
                    buttons: [
                      { label: "Open Deno Website", action: () => window.api.openExternal('https://deno.land') },
                      { label: "OK" }
                    ]
                  });
                }
              }
            },
            { label: "Later" },
            { 
              label: "No, don't remind me", 
              action: () => {
                settings.denoReminderDismissed = true;
                window.api.saveSettings(settings);
              }
            }
          ]
        });
      }
    } catch (error) {
      console.error("Error checking Deno installation:", error);
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    let settings;
    try {
      settings = await window.api.getSettings();
    } catch (error) {
      settings = {
        showConsoleOutput: false, advancedOptions: false,
        convertToMp4: false, keepOriginalAfterConvert: true, firstLaunch: true
      };
      showModal({ title: "Settings Error", message: "Could not load settings. Using defaults.", buttons: [{ label: "OK" }] });
    }

    try {
      const version = await window.api.getAppVersion();
      const versionLink = document.getElementById('versionLink');
      if (versionLink && version) {
        versionLink.textContent = `v${version}`;
        versionLink.onclick = () => {
          window.api.openExternal(`https://github.com/BurntToasters/ROSI/releases/tag/v${version}`);
          return false;
        };
      }
    } catch (e) {
      console.error('Could not get app version:', e);
    }
    
    try {
      setupAutoUpdater();
    } catch (e) {
      console.error('Failed to setup auto-updater:', e);
    }
    
    const consoleToggle = document.getElementById('consoleToggle');
    const advancedToggle = document.getElementById('advancedToggle');
    const keepOriginalToggle = document.getElementById('keepOriginalToggle');
    const hookBrowserToggle = document.getElementById('hookBrowserToggle');
    const browserChoiceContainer = document.getElementById('browserChoiceContainer');
    const browserChoiceSelect = document.getElementById('browserChoice');
    const convertToggle = document.getElementById('convertToggle');
    const convertFormatContainer = document.getElementById('convertFormatContainer');
    const convertFormatSelect = document.getElementById('convertFormat');
    const keepOriginalLabel = document.getElementById('keepOriginalLabel');
    const gpuAccelerationToggle = document.getElementById('gpuAccelerationToggle');
    const gpuAccelerationLabel = document.getElementById('gpuAccelerationLabel');
    const gpuTypeContainer = document.getElementById('gpuTypeContainer');
    const gpuTypeSelect = document.getElementById('gpuType');
    const outputEl = document.getElementById('output');
    const resetSettingsBtn = document.getElementById('resetSettings');
    const fetchFormatsBtn = document.getElementById('fetchFormatsBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const animateBackgroundToggle = document.getElementById('animateBackgroundToggle');
    const audioOnlyToggle = document.getElementById('audioOnlyToggle');
    const notificationsToggle = document.getElementById('notificationsToggle');
    const checkUpdatesOnStartupToggle = document.getElementById('checkUpdatesOnStartupToggle');
    const checkUpdatesOnStartupLabel = document.getElementById('checkUpdatesOnStartupLabel');
    
    const settingsBtn = document.getElementById('settingsBtn');
    const closeSidebarBtn = document.getElementById('closeSidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const shortcutsBtn = document.getElementById('shortcutsBtn');
    const clearUrlBtn = document.getElementById('clearUrl');
    const clearConsoleBtn = document.getElementById('clearConsole');
    const urlInput = document.getElementById('url');
    
    if (fetchFormatsBtn) fetchFormatsBtn._originalClick = fetchFormats;
    if (downloadBtn) downloadBtn._originalClick = null;

    const isWindows = navigator.userAgent.includes('Windows');
    if (isWindows && browserChoiceSelect) {
      Array.from(browserChoiceSelect.options).forEach(opt => {
        if (opt.value !== "Firefox") {
          browserChoiceSelect.removeChild(opt);
        }
      });
      browserChoiceSelect.value = "Firefox";
      if (settings.browserChoice !== "Firefox") {
        settings.browserChoice = "Firefox";
        window.api.saveSettings(settings);
      }
    }

    // update UI from settings
    const updateUIFromSettings = () => {
      if (
        !consoleToggle || !advancedToggle || !keepOriginalToggle ||
        !hookBrowserToggle || !browserChoiceContainer || !browserChoiceSelect ||
        !convertToggle || !convertFormatContainer || !convertFormatSelect || !keepOriginalLabel
      ) return;
      consoleToggle.checked = settings.showConsoleOutput ?? false;
      advancedToggle.checked = settings.advancedOptions ?? false;
      keepOriginalToggle.checked = settings.keepOriginalAfterConvert ?? true;
      hookBrowserToggle.checked = settings.hookBrowser ?? false;
      browserChoiceSelect.value = settings.browserChoice ?? "Chrome";
      convertToggle.checked = settings.convertEnabled ?? false;
      convertFormatSelect.value = settings.convertFormat ?? "mp4";
      keepOriginalToggle.checked = settings.keepOriginalAfterConvert ?? true;
      
      if (convertToggle.checked) {
        convertFormatContainer.classList.add('visible');
        keepOriginalLabel.classList.add('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
      } else {
        convertFormatContainer.classList.remove('visible');
        keepOriginalLabel.classList.remove('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
      }
      
      // GPU acceleration settings
      if (gpuAccelerationToggle) {
        gpuAccelerationToggle.checked = settings.gpuAcceleration ?? false;
      }
      if (gpuTypeSelect) {
        gpuTypeSelect.value = settings.gpuType ?? 'auto';
      }
      if (gpuTypeContainer) {
        if (settings.gpuAcceleration) {
          gpuTypeContainer.classList.add('visible');
        } else {
          gpuTypeContainer.classList.remove('visible');
        }
      }
      
      if (settings.hookBrowser) {
        browserChoiceContainer.classList.add('visible');
      } else {
        browserChoiceContainer.classList.remove('visible');
      }
      
      updateConsoleVisibility(settings.showConsoleOutput);
      toggleAdvancedUI(settings.advancedOptions);
      
      // Update additional options
      if (animateBackgroundToggle) {
        animateBackgroundToggle.checked = settings.animateBackground ?? true;
        updateBackgroundAnimation(settings.animateBackground ?? true);
      }
      if (audioOnlyToggle) {
        audioOnlyToggle.checked = settings.audioOnly ?? false;
        audioOnlyToggle.disabled = settings.advancedOptions ?? false;
        if (audioOnlyToggle.disabled) {
          audioOnlyToggle.parentElement.classList.add('disabled');
          audioOnlyToggle.parentElement.title = 'Disabled when Advanced format selection is enabled';
        } else {
          audioOnlyToggle.parentElement.classList.remove('disabled');
          audioOnlyToggle.parentElement.title = '';
        }
      }
      // disable convert when audio-only is enabled
      if (convertToggle) {
        convertToggle.disabled = settings.audioOnly ?? false;
        if (settings.audioOnly) {
          convertToggle.parentElement.classList.add('disabled');
          convertToggle.parentElement.title = 'Disabled when Audio-only mode is enabled (audio already extracted as MP3)';
        } else {
          convertToggle.parentElement.classList.remove('disabled');
          convertToggle.parentElement.title = '';
        }
      }
      if (notificationsToggle) {
        notificationsToggle.checked = settings.notifications ?? true;
      }

      const channel = window.api.getChannel();
      if (checkUpdatesOnStartupToggle) {
        checkUpdatesOnStartupToggle.checked = settings.checkUpdatesOnStartup ?? true;
        if (channel === 'msstore' && checkUpdatesOnStartupLabel) {
          checkUpdatesOnStartupLabel.style.display = 'none';
        }
      }
    };
    
    try {
      updateUIFromSettings();
    } catch (e) {
      console.error('Failed to update UI from settings:', e);
    }


    if (!settings.hideSupportModal) {
      showModal({
        title: "Support This Project?",
        message: "Would you like to support the development of ROSI?<br>Your help keeps this project alive!",
        buttons: [
          { label: "❤️ Yes Support!", action: () => { 
            window.api.openExternal('https://rosie.run/support')
            settings.hideSupportModal = true;
              window.api.saveSettings(settings);
           }},
          { label: "No thanks", action: () => {
              settings.hideSupportModal = true;
              window.api.saveSettings(settings);
            }
          }
        ]
      });
    }

    // Sidebar controls
    if (settingsBtn) settingsBtn.addEventListener('click', toggleSidebar);
    if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeSidebar);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
    if (shortcutsBtn) shortcutsBtn.addEventListener('click', showKeyboardShortcuts);

    if (clearUrlBtn && urlInput) {
      clearUrlBtn.addEventListener('click', () => {
        urlInput.value = '';
        urlInput.focus();
        clearUrlBtn.style.display = 'none';
      });
      urlInput.addEventListener('input', () => {
        clearUrlBtn.style.display = urlInput.value.length > 0 ? 'flex' : 'none';
      });
      clearUrlBtn.style.display = urlInput.value.length > 0 ? 'flex' : 'none';
    }

    if (clearConsoleBtn && outputEl) {
      clearConsoleBtn.addEventListener('click', () => {
        outputEl.textContent = '';
      });
    }

    if (consoleToggle) consoleToggle.addEventListener('change', (e) => {
      settings.showConsoleOutput = e.target.checked;
      window.api.saveSettings(settings);
      updateConsoleVisibility(settings.showConsoleOutput);
    });
    if (advancedToggle) advancedToggle.addEventListener('change', (e) => {
      settings.advancedOptions = e.target.checked;
      toggleAdvancedUI(e.target.checked);
      
      if (audioOnlyToggle) {
        audioOnlyToggle.disabled = e.target.checked;
        if (e.target.checked) {
          audioOnlyToggle.checked = false;
          settings.audioOnly = false;
          audioOnlyToggle.parentElement.classList.add('disabled');
          audioOnlyToggle.parentElement.title = 'Disabled when Advanced format selection is enabled';

          if (convertToggle) {
            convertToggle.disabled = false;
            convertToggle.parentElement.classList.remove('disabled');
            convertToggle.parentElement.title = '';
          }
        } else {
          audioOnlyToggle.parentElement.classList.remove('disabled');
          audioOnlyToggle.parentElement.title = '';
        }
      }
      
      window.api.saveSettings(settings);
    });
    if (keepOriginalToggle) keepOriginalToggle.addEventListener('change', (e) => {
      if (!e.target.disabled) {
        settings.keepOriginalAfterConvert = e.target.checked;
        window.api.saveSettings(settings);
      } else {
        e.preventDefault();
      }
    });
    if (hookBrowserToggle) hookBrowserToggle.addEventListener('change', (e) => {
      settings.hookBrowser = e.target.checked;
      if (browserChoiceContainer) {
        if (e.target.checked) {
          browserChoiceContainer.classList.add('visible');
        } else {
          browserChoiceContainer.classList.remove('visible');
        }
      }
      window.api.saveSettings(settings);
    });
    if (browserChoiceSelect) browserChoiceSelect.addEventListener('change', (e) => {
      settings.browserChoice = e.target.value;
      window.api.saveSettings(settings);
    });
    if (convertToggle) convertToggle.addEventListener('change', (e) => {
      settings.convertEnabled = e.target.checked;
      if (e.target.checked) {
        convertFormatContainer.classList.add('visible');
        keepOriginalLabel.classList.add('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
      } else {
        convertFormatContainer.classList.remove('visible');
        keepOriginalLabel.classList.remove('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
        if (gpuTypeContainer) gpuTypeContainer.classList.remove('visible');
      }
      if (!e.target.checked) {
        settings.keepOriginalAfterConvert = true;
        if (keepOriginalToggle) keepOriginalToggle.checked = true;
      }
      window.api.saveSettings(settings);
    });
    if (convertFormatSelect) convertFormatSelect.addEventListener('change', (e) => {
      settings.convertFormat = e.target.value;
      window.api.saveSettings(settings);
    });
    // GPU acceleration toggle
    if (gpuAccelerationToggle) {
      gpuAccelerationToggle.addEventListener('change', (e) => {
        settings.gpuAcceleration = e.target.checked;
        if (gpuTypeContainer) {
          if (e.target.checked) {
            gpuTypeContainer.classList.add('visible');
          } else {
            gpuTypeContainer.classList.remove('visible');
          }
        }
        window.api.saveSettings(settings);
      });
    }
    if (gpuTypeSelect) {
      gpuTypeSelect.addEventListener('change', (e) => {
        settings.gpuType = e.target.value;
        window.api.saveSettings(settings);
      });
    }
    // Animate Background toggle
    if (animateBackgroundToggle) {
      animateBackgroundToggle.addEventListener('change', (e) => {
        settings.animateBackground = e.target.checked;
        updateBackgroundAnimation(e.target.checked);
        window.api.saveSettings(settings);
      });
    }
    
    // Audio-only toggle
    if (audioOnlyToggle) {
      audioOnlyToggle.addEventListener('change', (e) => {
        settings.audioOnly = e.target.checked;

        if (convertToggle) {
          convertToggle.disabled = e.target.checked;
          if (e.target.checked) {
            convertToggle.checked = false;
            settings.convertEnabled = false;
            convertToggle.parentElement.classList.add('disabled');
            convertToggle.parentElement.title = 'Disabled when Audio-only mode is enabled (audio already extracted as MP3)';
            if (convertFormatContainer) convertFormatContainer.classList.remove('visible');
            if (keepOriginalLabel) keepOriginalLabel.classList.remove('visible');
          } else {
            convertToggle.parentElement.classList.remove('disabled');
            convertToggle.parentElement.title = '';
          }
        }
        
        window.api.saveSettings(settings);
      });
    }
    
    // Notifications toggle
    if (notificationsToggle) {
      notificationsToggle.addEventListener('change', (e) => {
        settings.notifications = e.target.checked;
        window.api.saveSettings(settings);
      });
    }
    
    // Check updates on startup
    if (checkUpdatesOnStartupToggle) {
      checkUpdatesOnStartupToggle.addEventListener('change', (e) => {
        settings.checkUpdatesOnStartup = e.target.checked;
        window.api.saveSettings(settings);
      });
    }
    
    if (resetSettingsBtn) resetSettingsBtn.addEventListener('click', () => {
      showModal({
        title: "Confirm Reset",
        message: "Are you sure you want to reset all settings to default? Rosi will restart.",
        buttons: [
          { label: "Cancel" },
          { label: "⟳ Reset & Restart", action: () => window.api.resetSettings() }
        ]
      });
    });


    if (fetchFormatsBtn) {
      fetchFormatsBtn.onclick = fetchFormats;
    }

    // download button
    if (downloadBtn) {
      downloadBtn._originalClick = async function () {
        try {
          if (isDownloading) return;

          isDownloading = true;
          
          const urlInput = document.getElementById('url');
          const url = urlInput ? urlInput.value : null;
          if (!url || url.trim() === "") {
            isDownloading = false;
            showModal({ title: "Input Error", message: "Please enter a video URL.", buttons: [{ label: "OK" }] });
            return;
          }
          
          // Validate URL format
          if (!isValidUrl(url.trim())) {
            isDownloading = false;
            showModal({ 
              title: "Invalid URL", 
              message: "Please enter a valid URL starting with http:// or https://", 
              buttons: [{ label: "OK" }] 
            });
            return;
          }
          
          const videoSelect = document.getElementById('videoFormat');
          const audioSelect = document.getElementById('audioFormat');
          if (settings.advancedOptions && (!videoSelect || !audioSelect || !videoSelect.value || !audioSelect.value)) {
            isDownloading = false;
            showModal({ title: "Format Selection Needed", message: "Please check resolutions and select video/audio formats first.", buttons: [{ label: "OK" }] });
            return;
          }
          
          let savePath;
          try {
            savePath = await window.api.selectDownloadLocation();
          } catch (dialogError) {
            console.error('Error opening save dialog:', dialogError);
            isDownloading = false;
            showModal({ title: "Error", message: "Could not open the save location dialog. Please try again.", buttons: [{ label: "OK" }] });
            return;
          }
          
          if (!savePath) {
            isDownloading = false;
            if (outputEl) outputEl.textContent = "⚠️ Download cancelled: No save location selected.";
            return;
          }
          if (outputEl) outputEl.textContent = "";
          downloadAbort = () => {
            isDownloading = false;
            setButtonLoading(downloadBtn, false);
          };
          setButtonLoading(downloadBtn, true, () => {
            window.api.cancelDownload();
            downloadAbort();
            hideProgressBar();
          });

        showProgressBar('Starting download...');
        
        const videoFormat = settings.advancedOptions ? videoSelect.value : null;
        const audioFormat = settings.advancedOptions ? audioSelect.value : null;
        const convertFormat = settings.convertEnabled ? convertFormatSelect.value : null;
        const keepOriginal = settings.convertEnabled ? keepOriginalToggle.checked : null;
        window.api.downloadVideo({ url, videoFormat, audioFormat, outputPath: savePath, convertFormat, keepOriginal });
        } catch (downloadError) {
          console.error('Unexpected error starting download:', downloadError);
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
          hideProgressBar();
          showModal({
            title: "Download Error",
            message: "An unexpected error occurred while starting the download. Please try again.",
            buttons: [{ label: "OK" }]
          });
        }
      };
      downloadBtn.onclick = downloadBtn._originalClick;
    }


    if (checkUpdateBtn) {
      checkUpdateBtn.onclick = checkForUpdates;
    }
    const ipcCleanupFunctions = [];

    let saveSettingsTimeout = null;
    const debouncedSaveSettings = (settingsObj) => {
      if (saveSettingsTimeout) {
        clearTimeout(saveSettingsTimeout);
      }
      saveSettingsTimeout = setTimeout(() => {
        window.api.saveSettings(settingsObj);
        saveSettingsTimeout = null;
      }, 300);
    };

    ipcCleanupFunctions.push(
      window.api.onProgress((message) => {
        if (!outputEl) return;
        outputEl.textContent += message + '\n';
        outputEl.scrollTop = outputEl.scrollHeight;

        const progress = parseYtdlpProgress(message);
        if (progress) {
          let detailsText = '';
          if (progress.speed && progress.eta) {
            detailsText = `${progress.totalSize} • ${progress.speed} • ETA: ${progress.eta}`;
          } else if (progress.totalSize) {
            detailsText = `Size: ${progress.totalSize}`;
          }
          updateProgressBar(progress.percent, 'Downloading...', detailsText);
        } else if (message.includes('[download] Destination:')) {
          setProgressIndeterminate('Preparing download...');
        } else if (message.includes('Merging formats')) {
          setProgressIndeterminate('Merging video and audio...');
        } else if (message.includes('Converting') || message.includes('[ffmpeg]')) {
          setProgressIndeterminate('Converting...');
        } else if (message.includes('100%')) {
          updateProgressBar(100, 'Download complete!', '');
        }

        if (message.includes('Identified file:') || message.includes('Successfully converted to')) {
          const fileMatch = message.match(/(?:Identified file:|Successfully converted to)\s*(.+)$/);
          if (fileMatch && fileMatch[1]) {
            lastDownloadedFilePath = fileMatch[1].trim();
          }
        }
      })
    );
    
    ipcCleanupFunctions.push(
      window.api.onComplete((statusMessage) => {
        if (downloadBtn) {
          isDownloading = false;
          setButtonLoading(downloadBtn, false);

          const isSuccess = statusMessage.includes('✅') || statusMessage.includes('complete');
          
          if (isSuccess) {
            updateProgressBar(100, 'Complete!', '');

            if (settings.notifications) {
              window.api.showNotification({
                title: 'Download Complete!',
                body: lastDownloadedFilePath ? `Saved: ${lastDownloadedFilePath.split(/[/\\]/).pop()}` : 'Your download has finished.',
                filePath: lastDownloadedFilePath
              });
            }
          }
          
          setTimeout(() => {
            hideProgressBar();
          }, 2000);
          
          const originalText = downloadBtn.dataset.defaultText || "Download";
          
          if (isSuccess && lastDownloadedFilePath) {
            downloadBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg><span>Open File Location</span>`;
            downloadBtn.disabled = false;
            downloadBtn.onclick = () => {
              window.api.openFileLocation(lastDownloadedFilePath);
            };
            setTimeout(() => {
              downloadBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>${originalText}</span>`;
              downloadBtn.disabled = false;
              downloadBtn.onclick = downloadBtn._originalClick;
              lastDownloadedFilePath = null;
            }, 8000);
          } else {
            downloadBtn.innerHTML = isSuccess ? "✅ Download Complete!" : originalText;
            downloadBtn.disabled = isSuccess;
            setTimeout(() => {
              downloadBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>${originalText}</span>`;
              downloadBtn.disabled = false;
              downloadBtn.onclick = downloadBtn._originalClick;
            }, 4000);
          }
        }
        if (fetchFormatsBtn) setButtonLoading(fetchFormatsBtn, false);
        if (outputEl) {
          outputEl.textContent += statusMessage + '\n';
          outputEl.scrollTop = outputEl.scrollHeight;
        }
      })
    );

    window.addEventListener('beforeunload', () => {
      ipcCleanupFunctions.forEach(cleanup => {
        if (typeof cleanup === 'function') {
          try { cleanup(); } catch (e) {  }
        }
      });
      cleanupUpdaterListeners();
      
      if (saveSettingsTimeout) {
        clearTimeout(saveSettingsTimeout);
        window.api.saveSettings(settings);
      }
    });


    // Check for updates on startup
    async function checkUpdatesOnStartup() {
      const channel = window.api.getChannel();
      if (channel === 'msstore') return;
      if (!settings.checkUpdatesOnStartup) return;
      
      try {
        const isPackaged = await window.api.isPackaged();
        if (!isPackaged) return;

        await new Promise(resolve => setTimeout(resolve, 2000));
        await window.api.checkForUpdates();

      } catch (e) {
        console.error('Startup update check failed:', e);
      }
    }

    if (settings.firstLaunch) {
      // Save immediately - change
      settings.firstLaunch = false;
      window.api.saveSettings(settings);
      
      showModal({
        title: "Dependency FFMPEG is Required for this app.",
        message: "ROSI uses FFMPEG for yt-dlp and converting files to MP4.<br>For intended use and stability, Please ensure FFMPEG is installed and accessible in your system's PATH.<br>Click 'More Info' for guidance.",
        buttons: [
          { label: "More Info", action: () => window.api.openExternal('https://help.rosie.run/installing-ffmpeg') },
          { label: "OK", action: () => {
            checkDenoInstallation(settings);
            checkUpdatesOnStartup();
          }}
        ]
      });
    } else {
      // check Deno
      checkDenoInstallation(settings);
      checkUpdatesOnStartup();
    }




const closeBtn = document.getElementById('close-licenses');
if (closeBtn) {
  closeBtn.addEventListener('click', hideLicenses);
}

document.addEventListener('keydown', (event) => {
  const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
  
  // esc
  if (event.key === 'Escape') {
    const licensesOverlay = document.getElementById('licenses-overlay');
    if (licensesOverlay && licensesOverlay.classList.contains('active')) {
      hideLicenses();
      return;
    }
    
    const appModal = document.getElementById('app-modal');
    if (appModal && appModal.classList.contains('active')) {
      hideModal(appModal);
      return;
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      closeSidebar();
      return;
    }
  }
  
  if (modifierPressed && event.key === 'd') {
    event.preventDefault();
    showModal({
      title: "Restart Application",
      message: "Are you sure you want to restart ROSI?",
      buttons: [
        { label: "Cancel" },
        { label: "Restart", action: () => window.api.restartApp() }
      ]
    });
  }
  
  if (modifierPressed && event.key === 'f') {
    event.preventDefault();
    const urlInput = document.getElementById('url');
    if (urlInput) {
      urlInput.focus();
      urlInput.select();
    }
  }

  if (modifierPressed && event.key === ',') {
    event.preventDefault();
    toggleSidebar();
  }
});
  });