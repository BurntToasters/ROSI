  function isMac() {
    return navigator.platform.toLowerCase().includes('mac');
  }

  function getModifierKey() {
    return isMac() ? 'metaKey' : 'ctrlKey';
  }

  function getModifierKeyName() {
    return isMac() ? 'Cmd' : 'Ctrl';
  }

  // toggles console output visibility
  function updateConsoleVisibility(show) {
    const outputEl = document.getElementById('output');
    outputEl.style.display = show ? 'block' : 'none';
  }

  // handles loader in button, swaps text for spinner, click cancels
  function setButtonLoading(button, isLoading, onCancel) {
    if (!button) return;
    if (isLoading) {
      button.classList.add('loading');
      button.innerHTML = `<img src="loader.svg" class="loader-icon" alt="Loading...">`;
      button.disabled = false;
      button.onclick = onCancel;
    } else {
      button.classList.remove('loading');
      button.innerHTML = button.dataset.defaultText || button.textContent;
      button.disabled = false;
      button.onclick = button._originalClick;
    }
  }

  function toggleSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    if (modal.style.display !== 'flex') {
      modal.classList.add('showing');
      modal.style.display = 'flex';
      // Force reflow
      void modal.offsetWidth;
      requestAnimationFrame(() => {
        modal.classList.remove('showing');
      });
    } else {
      modal.classList.add('hiding');
      setTimeout(() => {
        modal.style.display = 'none';
        modal.classList.remove('hiding');
      }, 150);
    }
  }
  function toggleAdvancedUI(show) {
    const formatSection = document.getElementById('formatOptions');
    if (formatSection) {
      formatSection.style.display = show ? 'block' : 'none';
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
    modal.style.display = 'flex';
    
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
      modal.style.display = 'none';
      modal.classList.remove('hiding');
      if (typeof action === 'function') action();
    }, 150);
  }
  
  function updateKeepOriginalToggleState() {
    const keepOriginalToggle = document.getElementById('keepOriginalToggle');
    const keepOriginalLabel = keepOriginalToggle ? keepOriginalToggle.closest('label') : null;
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
    if (!btn || !videoUrl || videoUrl.trim() === "") {
      showModal({ title: "Input Error", message: "Please enter a video URL first.", buttons: [{ label: "OK" }] });
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
  }

  // handles download button logic
  let isDownloading = false;
  let downloadAbort = null;

  // Version compare helper
  function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

function testmsg () {
          showModal({
          title: "Test!",
          message: `ATest`,
          buttons: [
            { label: "Action", action: () => window.api.openExternal('https://google.com') },
            { label: "No thanks" },
            { label: "Test 3" }
          ]
        });
}

  // Check updates
  async function checkForUpdates() {
    try {
      const res = await fetch('https://api.github.com/repos/BurntToasters/ROSI/releases/latest', {
        headers: { 'User-Agent': 'ROSI-Updater' }
      });
      if (!res.ok) throw new Error('Failed to fetch release info');
      const release = await res.json();
      const latestVersion = release.tag_name.replace(/^v/, '');
      const currentVersion = await window.api.getAppVersion();
      if (compareVersions(latestVersion, currentVersion) > 0) {
        showModal({
          title: "Update Available!",
          message: `A new version (v${latestVersion}) of ROSI is available!`,
          buttons: [
            { label: "Update", action: () => window.api.openExternal(release.html_url) },
            { label: "No thanks" }
          ]
        });
      } else {
        showModal({
          title: "ROSI is up to date!",
          message: `You are running the latest version (v${currentVersion}).`,
          buttons: [{ label: "OK" }]
        });
      }
    } catch (e) {
      showModal({
        title: "Update Check Failed",
        message: "Could not check for updates. Please try again later.",
        buttons: [{ label: "OK" }]
      });
    }
  }
/*
      // License popup
function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

function hideLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.style.display = 'none';
    document.body.style.overflow = ''; // Restore scrolling
  }
}

*/

function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.classList.add('showing');
    licensesOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    void licensesOverlay.offsetWidth;
    requestAnimationFrame(() => {
      licensesOverlay.classList.remove('showing');
    });
  }
}

function hideLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesOverlay.classList.add('hiding');
    setTimeout(() => {
      licensesOverlay.style.display = 'none';
      licensesOverlay.classList.remove('hiding');
      document.body.style.overflow = '';
    }, 300);
  }
}

  function showAdditionalOptions() {
    const modal = document.getElementById('additional-options-modal');
    if (!modal) return;
    
    modal.classList.add('showing');
    modal.style.display = 'flex';
    
    void modal.offsetWidth;
    
    requestAnimationFrame(() => {
      modal.classList.remove('showing');
    });
  }

  function hideAdditionalOptions() {
    const modal = document.getElementById('additional-options-modal');
    if (!modal) return;
    
    modal.classList.add('hiding');
    setTimeout(() => {
      modal.style.display = 'none';
      modal.classList.remove('hiding');
    }, 150);
  }

  function updateBackgroundAnimation(animate) {
    const body = document.body;
    if (animate) {
      body.style.animation = 'gradientFlow 30s ease infinite alternate';
    } else {
      body.style.animation = 'none';
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
    const outputEl = document.getElementById('output');
    const settingsButton = document.getElementById('settings');
    const settingsModal = document.getElementById('settings-modal');
    const resetSettingsBtn = document.getElementById('resetSettings');
    const fetchFormatsBtn = document.getElementById('fetchFormatsBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const additionalOptionsBtn = document.getElementById('additionalOptionsBtn');
    const closeAdditionalOptionsBtn = document.getElementById('closeAdditionalOptions');
    const animateBackgroundToggle = document.getElementById('animateBackgroundToggle');
    
    if (fetchFormatsBtn) fetchFormatsBtn._originalClick = fetchFormats;
    if (downloadBtn) downloadBtn._originalClick = null;

    // userAgent
    const isWindows = navigator.userAgent.includes('Windows');

    // Filter browser options for Windows
    if (isWindows && browserChoiceSelect) {
      // Only keep Firefox
      Array.from(browserChoiceSelect.options).forEach(opt => {
        if (opt.value !== "Firefox") browserChoiceSelect.removeChild(opt);
      });
      //Firefox
      browserChoiceSelect.value = "Firefox";
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
      convertFormatContainer.style.display = convertToggle.checked ? 'block' : 'none';
      keepOriginalLabel.style.display = convertToggle.checked ? 'inline-block' : 'none';
      browserChoiceContainer.style.display = settings.hookBrowser ? 'block' : 'none';
      updateConsoleVisibility(settings.showConsoleOutput);
      toggleAdvancedUI(settings.advancedOptions);
      
      // Update additional options
      if (animateBackgroundToggle) {
        animateBackgroundToggle.checked = settings.animateBackground ?? true;
        updateBackgroundAnimation(settings.animateBackground ?? true);
      }
    };
    updateUIFromSettings();


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


    if (settingsButton) settingsButton.addEventListener('click', toggleSettingsModal);
    document.addEventListener('click', (event) => {
      if (settingsModal && settingsButton && settingsModal.style.display === 'flex' &&
          !settingsModal.contains(event.target) &&
          !settingsButton.contains(event.target)) {
        settingsModal.style.display = 'none';
      }
    });
    document.addEventListener('keydown', (event) => {
      if (settingsModal && event.key === 'Escape' && settingsModal.style.display === 'flex') {
        settingsModal.style.display = 'none';
      }
    });
    if (consoleToggle) consoleToggle.addEventListener('change', (e) => {
      settings.showConsoleOutput = e.target.checked;
      window.api.saveSettings(settings);
      updateConsoleVisibility(settings.showConsoleOutput);
    });
    if (advancedToggle) advancedToggle.addEventListener('change', (e) => {
      settings.advancedOptions = e.target.checked;
      toggleAdvancedUI(e.target.checked);
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
      if (browserChoiceContainer) browserChoiceContainer.style.display = e.target.checked ? 'block' : 'none';
      window.api.saveSettings(settings);
    });
    if (browserChoiceSelect) browserChoiceSelect.addEventListener('change', (e) => {
      settings.browserChoice = e.target.value;
      window.api.saveSettings(settings);
    });
    if (convertToggle) convertToggle.addEventListener('change', (e) => {
      settings.convertEnabled = e.target.checked;
      convertFormatContainer.style.display = e.target.checked ? 'block' : 'none';
      keepOriginalLabel.style.display = e.target.checked ? 'inline-block' : 'none';
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
    if (keepOriginalToggle) keepOriginalToggle.addEventListener('change', (e) => {
      settings.keepOriginalAfterConvert = e.target.checked;
      window.api.saveSettings(settings);
    });
    
    // Additional Options button
    if (additionalOptionsBtn) {
      additionalOptionsBtn.addEventListener('click', showAdditionalOptions);
    }
    
    // Close Additional Options modal
    if (closeAdditionalOptionsBtn) {
      closeAdditionalOptionsBtn.addEventListener('click', hideAdditionalOptions);
    }
    
    // Animate Background toggle
    if (animateBackgroundToggle) {
      animateBackgroundToggle.addEventListener('change', (e) => {
        settings.animateBackground = e.target.checked;
        updateBackgroundAnimation(e.target.checked);
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
        if (isDownloading) return;
        const urlInput = document.getElementById('url');
        const url = urlInput ? urlInput.value : null;
        if (!url || url.trim() === "") {
          showModal({ title: "Input Error", message: "Please enter a video URL.", buttons: [{ label: "OK" }] });
          return;
        }
        const videoSelect = document.getElementById('videoFormat');
        const audioSelect = document.getElementById('audioFormat');
        if (settings.advancedOptions && (!videoSelect || !audioSelect || !videoSelect.value || !audioSelect.value)) {
          showModal({ title: "Format Selection Needed", message: "Please check resolutions and select video/audio formats first.", buttons: [{ label: "OK" }] });
          return;
        }
        const savePath = await window.api.selectDownloadLocation();
        if (!savePath) {
          if (outputEl) outputEl.textContent = "⚠️ Download cancelled: No save location selected.";
          return;
        }
        if (outputEl) outputEl.textContent = "";
        isDownloading = true;
        downloadAbort = () => {
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
        };
        setButtonLoading(downloadBtn, true, () => {
          window.api.cancelDownload();
          downloadAbort();
        });
        const videoFormat = settings.advancedOptions ? videoSelect.value : null;
        const audioFormat = settings.advancedOptions ? audioSelect.value : null;
        const convertFormat = settings.convertEnabled ? convertFormatSelect.value : null;
        const keepOriginal = settings.convertEnabled ? keepOriginalToggle.checked : null;
        window.api.downloadVideo({ url, videoFormat, audioFormat, outputPath: savePath, convertFormat, keepOriginal });
      };
      downloadBtn.onclick = downloadBtn._originalClick;
    }


    if (checkUpdateBtn) {
      checkUpdateBtn.onclick = checkForUpdates;
    }


    window.api.onProgress((message) => {
      if (!outputEl) return;
      outputEl.textContent += message + '\n';
      outputEl.scrollTop = outputEl.scrollHeight;
    });
    window.api.onComplete((statusMessage) => {
      if (downloadBtn) {
        isDownloading = false;
        setButtonLoading(downloadBtn, false);
        
        const originalText = downloadBtn.dataset.defaultText || "Download";
        downloadBtn.innerHTML = "✅ Download Complete!";
        downloadBtn.disabled = true;
        setTimeout(() => {
          downloadBtn.innerHTML = originalText;
          downloadBtn.disabled = false;
        }, 4000);
      }
      if (fetchFormatsBtn) setButtonLoading(fetchFormatsBtn, false);
      if (outputEl) {
        outputEl.textContent += statusMessage + '\n';
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    });


    if (settings.firstLaunch) {
      showModal({
        title: "Dependency FFMPEG is Required for this app.",
        message: "ROSI uses FFMPEG for yt-dlp and converting files to MP4.<br>For intended use and stability, Please ensure FFMPEG is installed and accessible in your system's PATH.<br>Click 'More Info' for guidance.",
        buttons: [
          { label: "More Info", action: () => window.api.openExternal('https://help.rosie.run/installing-ffmpeg') },
          { label: "OK", action: () => checkDenoInstallation(settings) }
        ]
      });
      settings.firstLaunch = false;
      window.api.saveSettings(settings);
    } else {
      // check Deno
      checkDenoInstallation(settings);
    }




const closeBtn = document.getElementById('close-licenses');
if (closeBtn) {
  closeBtn.addEventListener('click', hideLicenses);
}

// esc key
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideLicenses();
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
  const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
  
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
  
  /*
  if (modifierPressed && event.key === 'o') {
    event.preventDefault();
    if (downloadBtn && !isDownloading) downloadBtn._originalClick();
  }
 Test for possible future use
  */
  
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
    toggleSettingsModal();
  }
  
});
  });