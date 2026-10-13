const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const artifactPath = path.join(
  root,
  "e2e/artifacts/round3-renderer/renderer-repairs.json",
);

function runDiagnostic(name) {
  const scriptPath = path.join(__dirname, `${name}.cjs`);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${name} diagnostic failed:\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${name} diagnostic did not return JSON: ${String(error)}\n${result.stdout}`,
    );
  }
}

const renderer = runDiagnostic("renderer");
const updater = runDiagnostic("updater");
const preview = runDiagnostic("preview");
const checks = [];

function verify(name, condition, details) {
  checks.push({ name, status: condition ? "passed" : "failed", details });
}

verify(
  "overlay-focus-ownership",
  renderer.afterOpen.errorCount === 0,
  renderer.afterOpen,
);
verify(
  "sidebar-remains-inert-under-modal",
  renderer.afterClose.sidebarOpen &&
    renderer.afterClose.mainAriaHidden === "true",
  renderer.afterClose,
);
verify("app-modal-stacks-above-licenses", renderer.appModalAboveLicenses, {
  appModalAboveLicenses: renderer.appModalAboveLicenses,
});
verify(
  "licenses-suspends-under-modal-and-restores-focus",
  renderer.licensesWithModal.licensesActive &&
    renderer.licensesWithModal.modalActive &&
    renderer.licensesWithModal.focusedInModal &&
    renderer.licensesWithModal.errorCount === 0 &&
    renderer.modalClosedWithLicenses.licensesActive &&
    !renderer.modalClosedWithLicenses.modalActive &&
    renderer.modalClosedWithLicenses.focusedInLicenses &&
    renderer.modalClosedWithLicenses.mainAriaHidden === "true" &&
    renderer.modalClosedWithLicenses.mainInert === true,
  {
    licensesWithModal: renderer.licensesWithModal,
    modalClosedWithLicenses: renderer.modalClosedWithLicenses,
  },
);
verify(
  "closing-license-under-modal-restores-to-visible-underlay",
  !renderer.licenseClosedUnderModal.licensesActive &&
    renderer.licenseClosedUnderModal.modalActive &&
    renderer.licenseClosedUnderModal.focusedInModal &&
    !renderer.focusAfterLicenseAndModalClose.focusInsideInactiveLicense &&
    renderer.focusAfterLicenseAndModalClose.mainAriaHidden === null,
  {
    licenseClosedUnderModal: renderer.licenseClosedUnderModal,
    focusAfterLicenseAndModalClose: renderer.focusAfterLicenseAndModalClose,
  },
);
verify(
  "old-modal-hide-timer-cannot-dismiss-replacement",
  renderer.promptAfterOldHideTimer.modalActive &&
    renderer.promptAfterOldHideTimer.title === "Update Ready!" &&
    renderer.promptAfterOldHideTimer.focusInsideModal,
  renderer.promptAfterOldHideTimer,
);
verify(
  "format-selections-clear-on-url-change",
  renderer.afterUrlChangeFormats.video === "" &&
    renderer.afterUrlChangeFormats.audio === "" &&
    !renderer.afterUrlChangeFormats.videoOptions.includes("137") &&
    !renderer.afterUrlChangeFormats.audioOptions.includes("140"),
  renderer.afterUrlChangeFormats,
);
verify(
  "stale-format-replies-are-ignored",
  renderer.staleReplyFormats.videoOptions.includes("88") &&
    renderer.staleReplyFormats.audioOptions.includes("89") &&
    !renderer.staleReplyFormats.videoOptions.includes("177") &&
    !renderer.staleReplyFormats.audioOptions.includes("178") &&
    renderer.staleReplyFormats.requests.includes("https://example.com/d") &&
    renderer.staleReplyFormats.cancelFormatsCount > 0 &&
    renderer.staleReplyFormats.fetchButtonLoading === false,
  renderer.staleReplyFormats,
);
verify(
  "download-uses-current-url-formats",
  renderer.manualSubmission?.url === "https://example.com/d" &&
    renderer.manualSubmission.videoFormat === "88" &&
    renderer.manualSubmission.audioFormat === "89",
  renderer.manualSubmission,
);
verify(
  "manual-format-snapshot-survives-url-switch-during-save",
  renderer.manualSubmission?.url === "https://example.com/d" &&
    renderer.manualSubmission.videoFormat === "88" &&
    renderer.manualSubmission.audioFormat === "89" &&
    renderer.manualSubmission.urlValue === "https://example.com/e",
  renderer.manualSubmission,
);
verify(
  "queue-format-snapshot-survives-url-switch-during-save",
  renderer.queuedSubmission?.urls?.[0] === "https://example.com/e" &&
    renderer.queuedSubmission.options.videoFormat === "277" &&
    renderer.queuedSubmission.options.audioFormat === "278",
  renderer.queuedSubmission,
);
verify(
  "explicit-preset-survives-stale-format-reply",
  renderer.presetSurvivesStaleLookup.video === "88" &&
    renderer.presetSurvivesStaleLookup.audio === "89" &&
    !renderer.presetSurvivesStaleLookup.videoOptions.includes("477") &&
    !renderer.presetSurvivesStaleLookup.audioOptions.includes("478"),
  renderer.presetSurvivesStaleLookup,
);
verify(
  "previous-channel-reaches-updater",
  updater.bridgeForwardsPreviousChannel &&
    updater.checksAfterChange.includes("darwin-beta-aarch64-app"),
  {
    bridgeForwardsPreviousChannel: updater.bridgeForwardsPreviousChannel,
    checks: updater.checksAfterChange,
  },
);
verify(
  "updater-prompt-retires-and-binds-candidate",
  updater.activePromptAfterSecondCheck.includes("7.0.0-beta.1") &&
    updater.readyPromptTitle === "Update Ready!" &&
    updater.firstCandidateId !== undefined &&
    updater.currentCandidateId !== undefined &&
    updater.firstCandidateId !== updater.currentCandidateId &&
    updater.oldPromptStillConnected === false &&
    updater.staleCandidateResult?.cancelled === true &&
    updater.staleInstallResult === undefined &&
    updater.installedAfterStaleAction.length === 0 &&
    updater.downloadCalls.at(-1) === updater.currentCandidateId &&
    updater.installCalls.at(-1) === updater.currentCandidateId &&
    updater.downloadedAfterStaleAction.length === 0 &&
    updater.downloaded.filter((version) => version === "7.0.0-beta.1")
      .length === 1 &&
    !updater.downloaded.includes("6.0.0"),
  updater,
);
verify(
  "latest-preview-runs-after-superseded-request",
  preview.previewCalls.includes("https://example.com/b") &&
    preview.input === "https://example.com/b" &&
    preview.previewTitle === "B" &&
    preview.previewVisible &&
    preview.buttonLoading === false,
  preview,
);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  diagnostics: { renderer, updater, preview },
  checks,
};
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
