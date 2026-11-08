//! In-app updater orchestration. Failure modes: `e2e/v5-fixes/updater-engine/failure-modes.md`.
//!
//! One state thread owns the update identity, the generation fences, and the
//! single-flight locks, the same way `coordinator.rs` owns the queue. It only
//! decides and emits; it never waits on the network, the settings file, or a
//! download. Feed checks, settings reads, downloads and installs run on worker
//! threads, which ask the state thread for each decision through `request` or
//! report results through `submit`.
//!
//! The renderer draws `updater-status` and `updater-progress` and calls the
//! commands at the bottom of this file. It never talks to the updater plugin.

use crate::app_state;
use crate::ipc::FalliblePayload;
use crate::logging;
use crate::platform;
use crate::settings;
use crate::types::{
    CheckRefusal, CheckRefusalReason, DownloadOutcome, UpdateChannel, UpdaterErrorKind,
    UpdaterProgressEvent, UpdaterStatusEvent,
};
use serde_json::{json, Map};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
// Bundles carry yt-dlp and FFmpeg, so allow slow connections to finish.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const COMPACT_TARGET_SUFFIX: &str = "-app-zst";
const FLATPAK_MANUAL_INSTALL_MESSAGE: &str = "Flatpak builds cannot download or install updates in the app. Install the latest bundle from the release page.";
const RETIRED_PACKAGE_MESSAGE: &str = "DEB and RPM packages are no longer published for ROSI 5. Install the AppImage or Flatpak manually from the latest release to continue receiving updates.";
const CHANNEL_NOT_SAVED: &str =
    "The selected update channel could not be saved before revalidation.";
const DEV_MODE_MESSAGE: &str = "Update checking is not available in development mode.";
const MSSTORE_MESSAGE: &str =
    "Updates for the Microsoft Store version are managed through the Microsoft Store app.";

/// A feed answer the user may install. `bytes` is set once the download
/// completed and its target was confirmed; install consumes them.
struct Candidate {
    update: Update,
    version: String,
    target: Option<String>,
    sequence: u64,
    bytes: Option<Arc<Vec<u8>>>,
}

struct ActiveDownload {
    candidate: u64,
    generation: u64,
    cancelled: bool,
    recheck_target: bool,
    started_at: Instant,
    last_emit: Option<Instant>,
}

#[derive(Default)]
struct State {
    /// Bumped by every check, channel change, download start and cancel.
    checks: u64,
    /// Bumped by download start and cancel; a download is current only while it matches.
    downloads: u64,
    sequence: u64,
    pending: Option<Candidate>,
    /// Sequence of the candidate whose install already ran; restart retries use it.
    installed: Option<u64>,
    active: Option<ActiveDownload>,
    installing: bool,
    install_started: bool,
    recheck_after_install: bool,
    /// The channel the update identity was last validated for.
    known_channel: Option<UpdateChannel>,
    channel_unsaved: bool,
    flatpak: bool,
}

enum DownloadStart {
    Refused(DownloadOutcome),
    Start {
        generation: u64,
        update: Box<Update>,
    },
}

enum InstallStart {
    Quiet,
    Proceed {
        sequence: u64,
        update: Box<Update>,
        bytes: Arc<Vec<u8>>,
        already_installed: bool,
    },
}

enum InstallGate {
    Stop,
    Fail(String),
    Proceed,
}

enum InstallOutcome {
    Quiet,
    Failed(String),
    Restarted,
}

/// What a check does next: finish, or start over with a new generation.
enum Step {
    Finished(Option<CheckRefusal>),
    Recheck,
}

enum Command {
    BeginCheck {
        reply: Sender<Option<u64>>,
    },
    CheckCurrent {
        generation: u64,
        reply: Sender<bool>,
    },
    SetFlatpak(bool),
    ChannelReady {
        reply: Sender<Result<(), String>>,
    },
    TargetKnown {
        generation: u64,
        target: Option<String>,
        reply: Sender<bool>,
    },
    Decide {
        generation: u64,
        target: Option<String>,
        confirmed: Option<String>,
        candidate: Option<Box<Update>>,
        current_version: String,
        reply: Sender<bool>,
    },
    CheckFailed {
        generation: u64,
        checked: Option<Option<String>>,
        confirmed: Option<Result<Option<String>, String>>,
        message: String,
        reply: Sender<bool>,
    },
    BeginDownload {
        candidate_id: u64,
        reply: Sender<DownloadStart>,
    },
    DownloadProgress {
        generation: u64,
        transferred: u64,
        total: u64,
    },
    FinishDownload {
        generation: u64,
        result: Result<Vec<u8>, String>,
        confirmed: Option<Result<Option<String>, String>>,
        reply: Sender<DownloadOutcome>,
    },
    CancelDownload,
    ChannelChanged {
        channel: UpdateChannel,
        saved: Result<(), String>,
    },
    BeginInstall {
        candidate_id: u64,
        reply: Sender<InstallStart>,
    },
    ConfirmInstall {
        sequence: u64,
        confirmed: Result<Option<String>, String>,
        reply: Sender<InstallGate>,
    },
    InstallWritten {
        sequence: u64,
        reply: Sender<bool>,
    },
    FinishInstall {
        sequence: u64,
        outcome: InstallOutcome,
    },
}

fn engine() -> &'static Sender<Command> {
    static ENGINE: OnceLock<Sender<Command>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            let mut state = State::default();
            for command in receiver {
                state.handle(command);
            }
        });
        sender
    })
}

/// Send a command and wait for its reply. Never call this from the state thread.
fn request<T>(build: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
    let (reply, answer) = channel();
    engine().send(build(reply)).ok()?;
    answer.recv().ok()
}

fn submit(command: Command) {
    let _ = engine().send(command);
}

fn is_current(generation: u64) -> bool {
    request(|reply| Command::CheckCurrent { generation, reply }).unwrap_or(false)
}

fn spawn_check() {
    std::thread::spawn(|| {
        let _ = start_check();
    });
}

impl State {
    fn handle(&mut self, command: Command) {
        match command {
            Command::BeginCheck { reply } => {
                let _ = reply.send(self.begin_check());
            }
            Command::CheckCurrent { generation, reply } => {
                let _ = reply.send(self.checks == generation);
            }
            Command::SetFlatpak(flatpak) => self.flatpak = flatpak,
            Command::ChannelReady { reply } => {
                let _ = reply.send(if self.channel_unsaved {
                    Err(CHANNEL_NOT_SAVED.into())
                } else {
                    Ok(())
                });
            }
            Command::TargetKnown {
                generation,
                target,
                reply,
            } => {
                let _ = reply.send(self.target_known(generation, target));
            }
            Command::Decide {
                generation,
                target,
                confirmed,
                candidate,
                current_version,
                reply,
            } => {
                let _ = reply.send(self.decide(
                    generation,
                    target,
                    confirmed,
                    candidate,
                    current_version,
                ));
            }
            Command::CheckFailed {
                generation,
                checked,
                confirmed,
                message,
                reply,
            } => {
                let _ = reply.send(self.check_failed(generation, checked, confirmed, message));
            }
            Command::BeginDownload {
                candidate_id,
                reply,
            } => {
                let _ = reply.send(self.begin_download(candidate_id));
            }
            Command::DownloadProgress {
                generation,
                transferred,
                total,
            } => self.download_progress(generation, transferred, total),
            Command::FinishDownload {
                generation,
                result,
                confirmed,
                reply,
            } => {
                let _ = reply.send(self.finish_download(generation, result, confirmed));
            }
            Command::CancelDownload => self.cancel_download(),
            Command::ChannelChanged { channel, saved } => self.channel_changed(channel, saved),
            Command::BeginInstall {
                candidate_id,
                reply,
            } => {
                let _ = reply.send(self.begin_install(candidate_id));
            }
            Command::ConfirmInstall {
                sequence,
                confirmed,
                reply,
            } => {
                let _ = reply.send(self.confirm_install(sequence, confirmed));
            }
            Command::InstallWritten { sequence, reply } => {
                let _ = reply.send(self.install_written(sequence));
            }
            Command::FinishInstall { sequence, outcome } => self.finish_install(sequence, outcome),
        }
    }

    fn busy(&self) -> bool {
        self.active.is_some() || self.installing
    }

    fn pending_sequence(&self) -> Option<u64> {
        self.pending.as_ref().map(|candidate| candidate.sequence)
    }

    /// Drops the candidate and the installed marker together.
    fn release(&mut self) {
        self.pending = None;
        self.installed = None;
    }

    fn begin_check(&mut self) -> Option<u64> {
        self.checks += 1;
        if self.busy() {
            return None;
        }
        emit_status(UpdaterStatusEvent::Checking);
        Some(self.checks)
    }

    /// Returns false when the check must stop. A pending candidate for another
    /// target is released here, before the feed is asked.
    fn target_known(&mut self, generation: u64, target: Option<String>) -> bool {
        if self.checks != generation || self.busy() {
            return false;
        }
        if let (Some(installed), Some(candidate)) = (self.installed, self.pending.as_ref()) {
            if installed == candidate.sequence {
                emit_status(UpdaterStatusEvent::Downloaded {
                    candidate_id: candidate.sequence,
                    version: candidate.version.clone(),
                });
                return false;
            }
        }
        if self.pending.as_ref().is_some_and(|c| c.target != target) {
            self.release();
        }
        true
    }

    fn decide(
        &mut self,
        generation: u64,
        target: Option<String>,
        confirmed: Option<String>,
        candidate: Option<Box<Update>>,
        current_version: String,
    ) -> bool {
        if self.checks != generation || self.busy() {
            return false;
        }
        if confirmed != target {
            // The channel moved during the feed request; this result is for the old one.
            if self.pending.as_ref().is_some_and(|c| c.target != confirmed) {
                self.release();
            }
            return true;
        }
        let Some(update) = candidate else {
            if self.pending.as_ref().is_some_and(|c| c.target == target) {
                if let Some(pending) = self.pending.as_ref().filter(|c| c.bytes.is_some()) {
                    emit_status(UpdaterStatusEvent::Downloaded {
                        candidate_id: pending.sequence,
                        version: pending.version.clone(),
                    });
                    return false;
                }
                self.release();
            }
            emit_status(UpdaterStatusEvent::NotAvailable {
                is_beta: is_beta_version(&current_version),
                version: current_version,
            });
            return false;
        };
        let version = update.version.clone();
        if let Some(pending) = self.pending.as_ref() {
            if pending.version == version && pending.target == target && pending.bytes.is_some() {
                emit_status(UpdaterStatusEvent::Downloaded {
                    candidate_id: pending.sequence,
                    version: pending.version.clone(),
                });
                return false;
            }
        }
        self.release();
        self.sequence += 1;
        let sequence = self.sequence;
        let release_notes = update.body.clone();
        self.pending = Some(Candidate {
            update: *update,
            version: version.clone(),
            target,
            sequence,
            bytes: None,
        });
        emit_status(UpdaterStatusEvent::Available {
            candidate_id: sequence,
            is_beta: is_beta_version(&version),
            version,
            release_notes,
            manual_install: self.flatpak,
        });
        false
    }

    /// A feed or target error. Re-resolves the target when the check had one,
    /// and restarts the check if the channel moved meanwhile.
    fn check_failed(
        &mut self,
        generation: u64,
        checked: Option<Option<String>>,
        confirmed: Option<Result<Option<String>, String>>,
        message: String,
    ) -> bool {
        if self.checks != generation {
            return false;
        }
        if let Some(checked) = checked {
            match confirmed {
                Some(Ok(target)) if target != checked => {
                    if self.pending.as_ref().is_some_and(|c| c.target != target) {
                        self.release();
                    }
                    return true;
                }
                Some(Ok(_)) => {}
                // A failed re-resolve ends the check without a report.
                Some(Err(_)) | None => return false,
            }
        }
        emit_status(UpdaterStatusEvent::Error {
            message,
            kind: UpdaterErrorKind::Feed,
        });
        false
    }

    fn begin_download(&mut self, candidate_id: u64) -> DownloadStart {
        if self.flatpak {
            return DownloadStart::Refused(DownloadOutcome::error(FLATPAK_MANUAL_INSTALL_MESSAGE));
        }
        let Some(pending) = self.pending.as_ref() else {
            return DownloadStart::Refused(DownloadOutcome::cancelled());
        };
        if pending.sequence != candidate_id {
            return DownloadStart::Refused(DownloadOutcome::cancelled());
        }
        if self.active.is_some() {
            return DownloadStart::Refused(DownloadOutcome::error(
                "A download is already in progress.",
            ));
        }
        if self.installing || self.installed == Some(pending.sequence) {
            return DownloadStart::Refused(DownloadOutcome::error(
                "This update is already being installed.",
            ));
        }
        let sequence = pending.sequence;
        let update = pending.update.clone();
        self.checks += 1;
        self.downloads += 1;
        let generation = self.downloads;
        self.active = Some(ActiveDownload {
            candidate: sequence,
            generation,
            cancelled: false,
            recheck_target: false,
            started_at: Instant::now(),
            last_emit: None,
        });
        DownloadStart::Start {
            generation,
            update: Box::new(update),
        }
    }

    /// The download's generation is still the latest and its candidate is still pending.
    fn download_is_current(&self, generation: u64, sequence: u64) -> bool {
        self.downloads == generation && self.pending_sequence() == Some(sequence)
    }

    fn download_progress(&mut self, generation: u64, transferred: u64, total: u64) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        if active.generation != generation
            || !self.download_is_current(generation, active.candidate)
        {
            return;
        }
        let Some(active) = self.active.as_mut() else {
            return;
        };
        let now = Instant::now();
        if active
            .last_emit
            .is_some_and(|last| now.duration_since(last) < PROGRESS_EMIT_INTERVAL)
        {
            return;
        }
        active.last_emit = Some(now);
        let elapsed = now
            .duration_since(active.started_at)
            .as_secs_f64()
            .max(0.001);
        let percent = if total > 0 {
            (transferred as f64 / total as f64 * 100.0).min(100.0)
        } else {
            0.0
        };
        emit_progress(UpdaterProgressEvent {
            percent,
            bytes_per_second: transferred as f64 / elapsed,
            transferred,
            total: if total > 0 { total } else { transferred },
        });
    }

    /// Decides the outcome of a download that finished, failed, or was cancelled.
    fn finish_download(
        &mut self,
        generation: u64,
        result: Result<Vec<u8>, String>,
        confirmed: Option<Result<Option<String>, String>>,
    ) -> DownloadOutcome {
        let Some(active) = self.active.take() else {
            return DownloadOutcome::cancelled();
        };
        let sequence = active.candidate;
        let current =
            generation == active.generation && self.download_is_current(generation, sequence);
        let mut recheck = false;
        let outcome = match result {
            Err(message) => {
                if current {
                    emit_status(UpdaterStatusEvent::Error {
                        message: message.clone(),
                        kind: UpdaterErrorKind::Download,
                    });
                    DownloadOutcome::error(message)
                } else {
                    DownloadOutcome::cancelled()
                }
            }
            Ok(bytes) => match (current, confirmed) {
                (true, Some(Ok(effective))) => {
                    let target = self.pending.as_ref().and_then(|c| c.target.clone());
                    if effective != target {
                        // The channel moved while the bytes arrived; drop them and recheck.
                        self.release();
                        recheck = true;
                        DownloadOutcome::cancelled()
                    } else {
                        if let Some(candidate) = self.pending.as_mut() {
                            candidate.bytes = Some(Arc::new(bytes));
                            emit_status(UpdaterStatusEvent::Downloaded {
                                candidate_id: candidate.sequence,
                                version: candidate.version.clone(),
                            });
                        }
                        DownloadOutcome::success()
                    }
                }
                (true, Some(Err(message))) => {
                    self.release();
                    emit_status(UpdaterStatusEvent::Error {
                        message: message.clone(),
                        kind: UpdaterErrorKind::Download,
                    });
                    DownloadOutcome::error(message)
                }
                _ => DownloadOutcome::cancelled(),
            },
        };
        // The finally block: a download that was cancelled or saw a target change
        // releases its candidate; a recheck starts once nothing else runs.
        if self.pending_sequence() == Some(sequence)
            && (active.cancelled || active.recheck_target || recheck)
        {
            self.release();
        }
        if (recheck || active.recheck_target) && !self.installing {
            spawn_check();
        }
        outcome
    }

    fn cancel_download(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        if active.cancelled {
            return;
        }
        // The plugin cannot abort a transfer; its result is discarded instead.
        active.cancelled = true;
        self.downloads += 1;
        self.checks += 1;
        emit_status(UpdaterStatusEvent::Cancelled);
    }

    fn channel_changed(&mut self, channel: UpdateChannel, saved: Result<(), String>) {
        // A save that failed earlier counts as a change once it finally succeeds.
        let was_unsaved = self.channel_unsaved;
        self.channel_unsaved = saved.is_err();
        let changed = self.known_channel != Some(channel) || (was_unsaved && saved.is_ok());
        self.known_channel = Some(channel);
        if !changed {
            return;
        }
        self.checks += 1;
        if self.installing {
            self.recheck_after_install = true;
            if !self.install_started && self.pending.is_some() {
                self.release();
            }
            return;
        }
        if let Some(active) = self.active.as_mut() {
            active.recheck_target = true;
            if !active.cancelled {
                active.cancelled = true;
                self.downloads += 1;
                emit_status(UpdaterStatusEvent::Cancelled);
            }
            return;
        }
        if self.pending.is_some() {
            self.release();
        }
        spawn_check();
    }

    fn begin_install(&mut self, candidate_id: u64) -> InstallStart {
        if self.flatpak {
            emit_status(UpdaterStatusEvent::Error {
                message: FLATPAK_MANUAL_INSTALL_MESSAGE.into(),
                kind: UpdaterErrorKind::Install,
            });
            return InstallStart::Quiet;
        }
        let Some(pending) = self.pending.as_ref() else {
            return InstallStart::Quiet;
        };
        if pending.sequence != candidate_id {
            return InstallStart::Quiet;
        }
        let Some(bytes) = pending.bytes.clone() else {
            emit_status(UpdaterStatusEvent::Error {
                message: "No downloaded update is ready to install.".into(),
                kind: UpdaterErrorKind::Install,
            });
            return InstallStart::Quiet;
        };
        if self.installing || self.active.is_some() {
            return InstallStart::Quiet;
        }
        let sequence = pending.sequence;
        let update = pending.update.clone();
        let already_installed = self.installed == Some(sequence);
        self.checks += 1;
        self.installing = true;
        self.install_started = already_installed;
        InstallStart::Proceed {
            sequence,
            update: Box::new(update),
            bytes,
            already_installed,
        }
    }

    fn downloaded_candidate_is(&self, sequence: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|c| c.sequence == sequence && c.bytes.is_some())
    }

    fn confirm_install(
        &mut self,
        sequence: u64,
        confirmed: Result<Option<String>, String>,
    ) -> InstallGate {
        if !self.downloaded_candidate_is(sequence) {
            return InstallGate::Stop;
        }
        match confirmed {
            Err(message) => InstallGate::Fail(message),
            Ok(effective) => {
                let target = self.pending.as_ref().and_then(|c| c.target.clone());
                if effective != target {
                    self.release();
                    self.recheck_after_install = true;
                    InstallGate::Stop
                } else {
                    self.install_started = true;
                    InstallGate::Proceed
                }
            }
        }
    }

    fn install_written(&mut self, sequence: u64) -> bool {
        if !self.downloaded_candidate_is(sequence) {
            return false;
        }
        self.installed = Some(sequence);
        true
    }

    fn finish_install(&mut self, sequence: u64, outcome: InstallOutcome) {
        match outcome {
            InstallOutcome::Quiet => {}
            InstallOutcome::Failed(message) => {
                if self.pending_sequence() == Some(sequence) {
                    emit_status(UpdaterStatusEvent::Error {
                        message,
                        kind: UpdaterErrorKind::Install,
                    });
                }
            }
            InstallOutcome::Restarted => {
                if self.pending_sequence() == Some(sequence) {
                    self.release();
                }
            }
        }
        self.installing = false;
        self.install_started = false;
        if self.recheck_after_install && self.active.is_none() {
            self.recheck_after_install = false;
            spawn_check();
        }
    }
}

fn emit_status(event: UpdaterStatusEvent) {
    app_state::emit("updater-status", event);
}

fn emit_progress(event: UpdaterProgressEvent) {
    app_state::emit("updater-progress", event);
}

/// `true` for the prerelease channels the renderer used to match with a regex.
pub fn is_beta_version(version: &str) -> bool {
    let lower = version.to_ascii_lowercase();
    lower.contains("-beta") || lower.contains("-alpha") || lower.contains("-rc")
}

/// The target a packaged macOS app used before per-arch zstd feeds existed.
fn legacy_target(compact: &str) -> Option<String> {
    compact
        .contains("-beta-")
        .then(|| compact[..compact.len() - "-zst".len()].to_string())
}

/// `linux-beta-<arch>-(deb|rpm)`: packages retired in ROSI 5.
fn retired_package_message(beta_target: &str) -> Option<&'static str> {
    let lower = beta_target.to_ascii_lowercase();
    let rest = lower.strip_prefix("linux-beta-")?;
    let (arch, kind) = rest.rsplit_once('-')?;
    let arch_ok = !arch.is_empty()
        && arch
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    (arch_ok && (kind == "deb" || kind == "rpm")).then_some(RETIRED_PACKAGE_MESSAGE)
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn beta_target() -> String {
    e2e_override(|config| config.beta_target.clone())
        .unwrap_or_else(platform::get_beta_updater_target)
}

fn compact_target(beta: bool) -> Option<String> {
    if e2e_override(|config| config.disable_compact.then_some(())).is_some() {
        return None;
    }
    e2e_override(|config| config.compact_target.clone())
        .or_else(|| platform::get_compact_updater_target(beta))
}

/// The channel's target, as the renderer used to compute it. The channel is
/// read from settings, which `set_update_channel` writes before it revalidates.
fn resolve_target(app: &AppHandle) -> Result<Option<String>, String> {
    request(|reply| Command::ChannelReady { reply })
        .unwrap_or_else(|| Err("The update engine is not running.".into()))?;
    let channel = settings::load().update_channel;
    let beta = match channel {
        UpdateChannel::Beta => true,
        UpdateChannel::Auto => is_beta_version(&current_version(app)),
        UpdateChannel::Stable => false,
    };
    if let Some(target) = compact_target(beta) {
        return Ok(Some(target));
    }
    Ok(beta.then(beta_target))
}

fn build_updater(app: &AppHandle, target: Option<String>) -> Result<Updater, String> {
    let mut builder = app.updater_builder().timeout(check_timeout());
    if let Some(target) = target {
        builder = builder.target(target);
    }
    if let Some((endpoint, pubkey)) =
        e2e_override(|config| Some((config.endpoint.clone(), config.pubkey.clone())))
    {
        let url: url::Url = endpoint
            .parse()
            .map_err(|error: url::ParseError| error.to_string())?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|error| error.to_string())?
            .pubkey(pubkey);
    }
    builder.build().map_err(|error| error.to_string())
}

/// One feed request. Returns `Ok(None)` when the check is no longer current.
async fn check_target(
    app: &AppHandle,
    target: Option<String>,
    generation: u64,
    retry_on_error: bool,
) -> Result<Option<Update>, String> {
    let updater = build_updater(app, target.clone())?;
    let mut update = match updater.check().await {
        Ok(update) => update,
        Err(error) => {
            if !is_current(generation) {
                return Ok(None);
            }
            if target.is_none() || !retry_on_error {
                return Err(error.to_string());
            }
            // One in-place retry for an explicit target.
            updater.check().await.map_err(|error| error.to_string())?
        }
    };
    if !is_current(generation) {
        return Ok(None);
    }
    // Beta manifests are swapped onto the stable release through two adjacent
    // asset renames; a second lookup masks that short window.
    if update.is_none() && target.is_some() {
        update = updater.check().await.map_err(|error| error.to_string())?;
    }
    Ok(update)
}

/// Compact `-app-zst` targets fall back, once, to the universal feed.
async fn check_feed(
    app: &AppHandle,
    target: Option<String>,
    generation: u64,
) -> Result<Option<Update>, String> {
    let compact = target
        .as_deref()
        .filter(|target| target.ends_with(COMPACT_TARGET_SUFFIX))
        .map(str::to_owned);
    let Some(compact) = compact else {
        return check_target(app, target, generation, true).await;
    };
    match check_target(app, Some(compact.clone()), generation, false).await {
        Ok(update) => Ok(update),
        Err(error) => {
            if !is_current(generation) {
                return Ok(None);
            }
            // A release published without per-arch zstd archives still updates
            // through the universal .app.tar.gz feed. Logging never changes the check.
            let fallback = legacy_target(&compact);
            logging::warn(&format!(
                "updater: {compact} check failed, falling back to {} target: {error}",
                fallback.as_deref().unwrap_or("the default")
            ));
            check_target(app, fallback, generation, true).await
        }
    }
}

/// Report a check failure to the state thread. Re-resolves the target first
/// when the check already had one, as the renderer did before.
fn fail(generation: u64, checked: Option<Option<String>>, message: String) -> Step {
    let confirmed = match (&checked, app_state::app().cloned()) {
        (Some(_), Some(app)) if is_current(generation) => Some(resolve_target(&app)),
        _ => None,
    };
    let recheck = request(|reply| Command::CheckFailed {
        generation,
        checked,
        confirmed,
        message,
        reply,
    })
    .unwrap_or(false);
    if recheck {
        Step::Recheck
    } else {
        Step::Finished(None)
    }
}

fn check_once(generation: u64) -> Step {
    let Some(app) = app_state::app().cloned() else {
        return Step::Finished(None);
    };
    if platform::distribution_channel() == "msstore" {
        return Step::Finished(Some(CheckRefusal {
            reason: CheckRefusalReason::Message,
            message: MSSTORE_MESSAGE.into(),
        }));
    }
    let packaged = e2e_override(|config| config.is_packaged).unwrap_or_else(platform::is_packaged);
    if !is_current(generation) {
        return Step::Finished(None);
    }
    if !packaged {
        return Step::Finished(Some(CheckRefusal {
            reason: CheckRefusalReason::DevMode,
            message: DEV_MODE_MESSAGE.into(),
        }));
    }
    let flatpak = e2e_override(|config| config.is_flatpak).unwrap_or_else(platform::is_flatpak);
    submit(Command::SetFlatpak(flatpak));
    if !is_current(generation) {
        return Step::Finished(None);
    }
    if let Some(message) = retired_package_message(&beta_target()) {
        let refusal = CheckRefusal {
            reason: CheckRefusalReason::Message,
            message: message.into(),
        };
        return Step::Finished(is_current(generation).then_some(refusal));
    }

    let target = match resolve_target(&app) {
        Ok(target) => target,
        Err(message) => return fail(generation, None, message),
    };
    let known = request(|reply| Command::TargetKnown {
        generation,
        target: target.clone(),
        reply,
    })
    .unwrap_or(false);
    if !known {
        return Step::Finished(None);
    }
    let candidate =
        match tauri::async_runtime::block_on(check_feed(&app, target.clone(), generation)) {
            Ok(candidate) => candidate,
            Err(message) => return fail(generation, Some(target), message),
        };
    let confirmed = match resolve_target(&app) {
        Ok(confirmed) => confirmed,
        Err(message) => return fail(generation, Some(target), message),
    };
    let current_version = current_version(&app);
    let recheck = request(|reply| Command::Decide {
        generation,
        target,
        confirmed,
        candidate: candidate.map(Box::new),
        current_version,
        reply,
    })
    .unwrap_or(false);
    if recheck {
        Step::Recheck
    } else {
        Step::Finished(None)
    }
}

/// Runs a check to its decision. `None` means nothing to report to the caller.
fn start_check() -> Option<CheckRefusal> {
    loop {
        let generation = request(|reply| Command::BeginCheck { reply }).flatten()?;
        match check_once(generation) {
            Step::Finished(refusal) => return refusal,
            Step::Recheck => continue,
        }
    }
}

fn download_flow(candidate_id: u64) -> DownloadOutcome {
    let Some(app) = app_state::app().cloned() else {
        return DownloadOutcome::error("The update engine is not running.");
    };
    let start = request(|reply| Command::BeginDownload {
        candidate_id,
        reply,
    });
    let (generation, mut update) = match start {
        None => return DownloadOutcome::error("The update engine is not running."),
        Some(DownloadStart::Refused(outcome)) => return outcome,
        Some(DownloadStart::Start { generation, update }) => (generation, update),
    };
    update.timeout = Some(download_timeout());
    let mut transferred: u64 = 0;
    let mut total: u64 = 0;
    let result = tauri::async_runtime::block_on(update.download(
        |chunk, content_length| {
            transferred += chunk as u64;
            total = content_length.unwrap_or(0);
            submit(Command::DownloadProgress {
                generation,
                transferred,
                total,
            });
        },
        || {},
    ))
    .map_err(|error| error.to_string());
    let confirmed = result.is_ok().then(|| resolve_target(&app));
    request(|reply| Command::FinishDownload {
        generation,
        result,
        confirmed,
        reply,
    })
    .unwrap_or_else(|| DownloadOutcome::error("The update engine is not running."))
}

fn install_flow(candidate_id: u64) {
    let Some(app) = app_state::app().cloned() else {
        return;
    };
    let start = request(|reply| Command::BeginInstall {
        candidate_id,
        reply,
    });
    let Some(InstallStart::Proceed {
        sequence,
        update,
        bytes,
        already_installed,
    }) = start
    else {
        return;
    };
    let finish = |outcome: InstallOutcome| submit(Command::FinishInstall { sequence, outcome });
    if !already_installed {
        e2e_hold(|config| config.install_confirm_hold_ms);
        let confirmed = resolve_target(&app);
        let gate = request(|reply| Command::ConfirmInstall {
            sequence,
            confirmed,
            reply,
        })
        .unwrap_or(InstallGate::Stop);
        match gate {
            InstallGate::Stop => return finish(InstallOutcome::Quiet),
            InstallGate::Fail(message) => return finish(InstallOutcome::Failed(message)),
            InstallGate::Proceed => {}
        }
        e2e_hold(|config| config.install_write_hold_ms);
        if let Err(message) = install_bytes(&update, bytes.as_slice()) {
            return finish(InstallOutcome::Failed(message));
        }
        let still_candidate =
            request(|reply| Command::InstallWritten { sequence, reply }).unwrap_or(false);
        if !still_candidate {
            return finish(InstallOutcome::Quiet);
        }
    }
    // Windows installers exit the app themselves. Elsewhere the restart flushes
    // queue state first; a refused restart keeps the installed identity for retry.
    match restart_app(&app) {
        Ok(()) => finish(InstallOutcome::Restarted),
        Err(message) => finish(InstallOutcome::Failed(message)),
    }
}

fn install_bytes(update: &Update, bytes: &[u8]) -> Result<(), String> {
    if e2e_install_probe_active() {
        // Same order as the plugin's install: verify, then the before-exit
        // flush (the hook main.rs registers), then the install. The install
        // itself is only recorded.
        update.verify(bytes).map_err(|error| error.to_string())?;
        crate::window::shutdown()?;
        e2e_record_install();
        return Ok(());
    }
    update.install(bytes).map_err(|error| error.to_string())
}

fn restart_app(app: &AppHandle) -> Result<(), String> {
    if e2e_install_probe_active() {
        // The real shutdown flush still runs, so a refused queue backup refuses
        // the restart. Only the process restart is replaced by the probe.
        crate::window::shutdown()?;
        return e2e_restart_probe();
    }
    crate::window::restart(app)
}

/// `updater-status`: checks for updates and reports the result as events.
/// Returns why a check did not start, or `null` when it started.
#[tauri::command]
pub async fn check_for_updates() -> Option<CheckRefusal> {
    match tauri::async_runtime::spawn_blocking(start_check).await {
        Ok(refusal) => refusal,
        Err(error) => {
            logging::error(&format!("Update check stopped: {error}"));
            None
        }
    }
}

#[tauri::command]
pub async fn download_update(candidate_id: FalliblePayload<u64>) -> DownloadOutcome {
    let Ok(candidate_id) = candidate_id.into_result() else {
        return DownloadOutcome::error("The update candidate id is invalid.");
    };
    match tauri::async_runtime::spawn_blocking(move || download_flow(candidate_id)).await {
        Ok(outcome) => outcome,
        Err(error) => DownloadOutcome::error(error.to_string()),
    }
}

#[tauri::command]
pub async fn install_update(candidate_id: FalliblePayload<u64>) {
    let Ok(candidate_id) = candidate_id.into_result() else {
        emit_status(UpdaterStatusEvent::Error {
            message: "The update candidate id is invalid.".into(),
            kind: UpdaterErrorKind::Install,
        });
        return;
    };
    if let Err(error) =
        tauri::async_runtime::spawn_blocking(move || install_flow(candidate_id)).await
    {
        logging::error(&format!("Update install stopped: {error}"));
    }
}

/// Async so the handler runs off the main thread, which the state thread's
/// event emits also need.
#[tauri::command]
pub async fn cancel_update_download() {
    submit(Command::CancelDownload);
}

/// Persists the channel, then revalidates it. A failed save refuses the next
/// check instead of revalidating against the old channel.
#[tauri::command]
pub async fn set_update_channel(channel: FalliblePayload<UpdateChannel>) {
    let Ok(channel) = channel.into_result() else {
        logging::warn("updater: ignored an update channel outside the closed set");
        return;
    };
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let mut patch = Map::new();
        patch.insert("updateChannel".into(), json!(channel.as_str()));
        settings::save_patch(&patch).map(|_| ())
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    submit(Command::ChannelChanged { channel, saved });
}

// E2E-only hooks. The production build never sets them: `e2e_override` returns
// `None` there, so every call site keeps its production answer.

/// Points the updater at a local signed manifest server and overrides the
/// platform answers that differ in an E2E binary, which is never packaged.
/// Always compiled so call sites stay unconditional; only the e2e build fills it.
#[cfg_attr(not(feature = "e2e"), allow(dead_code))]
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eUpdaterConfig {
    /// Endpoint template, e.g. `http://127.0.0.1:8080/latest-{{target}}.json`.
    pub endpoint: String,
    /// Base64 minisign public key, as in tauri.conf.json.
    pub pubkey: String,
    pub is_packaged: Option<bool>,
    pub is_flatpak: Option<bool>,
    pub beta_target: Option<String>,
    pub compact_target: Option<String>,
    #[serde(default)]
    pub disable_compact: bool,
    /// Verify downloads for real, record the install, and skip the restart.
    #[serde(default)]
    pub install_probe: bool,
    /// Restart attempts the probe refuses before it accepts one.
    #[serde(default)]
    pub restart_refusals: u32,
    /// Replaces the 30 s check timeout.
    pub check_timeout_ms: Option<u64>,
    /// Replaces the 30 min download timeout.
    pub download_timeout_ms: Option<u64>,
    /// Pauses an install before it confirms its target.
    pub install_confirm_hold_ms: Option<u64>,
    /// Pauses an install after its target is confirmed, before the bytes are written.
    pub install_write_hold_ms: Option<u64>,
}

#[cfg(feature = "e2e")]
static E2E_CONFIG: std::sync::Mutex<Option<E2eUpdaterConfig>> = std::sync::Mutex::new(None);

#[cfg(feature = "e2e")]
mod e2e_probe {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

    static REFUSALS: AtomicU32 = AtomicU32::new(0);
    static INSTALLS: AtomicU64 = AtomicU64::new(0);
    static RESTARTS: AtomicU64 = AtomicU64::new(0);
    static REFUSED: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProbeState {
        pub installs: u64,
        pub restarts: u64,
        pub refused_restarts: u64,
    }

    pub fn configure(restart_refusals: u32) {
        REFUSALS.store(restart_refusals, Ordering::SeqCst);
    }

    pub fn record_install() {
        INSTALLS.fetch_add(1, Ordering::SeqCst);
    }

    pub fn restart() -> Result<(), String> {
        let refused = REFUSALS
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        if refused {
            REFUSED.fetch_add(1, Ordering::SeqCst);
            return Err("The E2E restart probe refused the restart.".into());
        }
        RESTARTS.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn snapshot() -> ProbeState {
        ProbeState {
            installs: INSTALLS.load(Ordering::SeqCst),
            restarts: RESTARTS.load(Ordering::SeqCst),
            refused_restarts: REFUSED.load(Ordering::SeqCst),
        }
    }
}

/// Reads one E2E override. Production has no overrides.
#[cfg_attr(not(feature = "e2e"), allow(unused_variables))]
fn e2e_override<T>(pick: impl FnOnce(&E2eUpdaterConfig) -> Option<T>) -> Option<T> {
    #[cfg(feature = "e2e")]
    {
        E2E_CONFIG.lock().ok()?.as_ref().and_then(pick)
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = pick;
        None
    }
}

fn check_timeout() -> Duration {
    e2e_override(|config| config.check_timeout_ms.map(Duration::from_millis))
        .unwrap_or(CHECK_TIMEOUT)
}

fn download_timeout() -> Duration {
    e2e_override(|config| config.download_timeout_ms.map(Duration::from_millis))
        .unwrap_or(DOWNLOAD_TIMEOUT)
}

/// Pauses an install at one named point. Production never holds.
fn e2e_hold(pick: impl FnOnce(&E2eUpdaterConfig) -> Option<u64>) {
    if let Some(ms) = e2e_override(pick) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

fn e2e_install_probe_active() -> bool {
    e2e_override(|config| config.install_probe.then_some(())).is_some()
}

fn e2e_record_install() {
    #[cfg(feature = "e2e")]
    e2e_probe::record_install();
}

fn e2e_restart_probe() -> Result<(), String> {
    #[cfg(feature = "e2e")]
    {
        e2e_probe::restart()
    }
    #[cfg(not(feature = "e2e"))]
    {
        Ok(())
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_configure_updater(
    window: tauri::WebviewWindow,
    config: E2eUpdaterConfig,
) -> Result<(), String> {
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may configure the E2E updater.".into());
    }
    e2e_probe::configure(config.restart_refusals);
    let mut slot = E2E_CONFIG
        .lock()
        .map_err(|_| "The E2E updater configuration is poisoned.".to_string())?;
    *slot = Some(config);
    Ok(())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_updater_probe(window: tauri::WebviewWindow) -> Result<e2e_probe::ProbeState, String> {
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may read the E2E updater probe.".into());
    }
    Ok(e2e_probe::snapshot())
}
