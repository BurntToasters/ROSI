//! Publication of downloaded and converted outputs: no-replace installs,
//! caption sidecars, and retirement of staged originals.

use super::conversion::ConversionFailure;
use super::{active_not_cancelled, send_progress, with_session};
use crate::staging::{
    file_identity, install_no_replace, sync_staged_file, DownloadStage, FileIdentity,
};
use std::path::{Path, PathBuf};

pub(super) fn install_download_output(temp: &Path, download_dir: &Path) -> Result<PathBuf, String> {
    let file_name = temp
        .file_name()
        .ok_or_else(|| "Downloaded output has no file name.".to_string())?;
    install_download_output_named(temp, download_dir, &file_name.to_string_lossy())
}

fn install_download_output_named(
    temp: &Path,
    download_dir: &Path,
    preferred_name: &str,
) -> Result<PathBuf, String> {
    let preferred = Path::new(preferred_name)
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Downloaded output has an invalid destination name.".to_string())?;
    let preferred = preferred.to_string_lossy();
    let preferred_path = Path::new(preferred.as_ref());
    let extension = preferred_path
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    let stem = preferred_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| preferred.to_string());
    sync_staged_file(temp)
        .map_err(|error| format!("Could not sync downloaded file {}: {error}", temp.display()))?;
    for suffix in 0..10_000u32 {
        let name = if suffix == 0 {
            preferred.to_string()
        } else if let Some(extension) = extension.as_deref() {
            format!("{stem} ({suffix}).{extension}")
        } else {
            format!("{stem} ({suffix})")
        };
        let destination = download_dir.join(name);
        match install_no_replace(temp, &destination) {
            Ok(()) => {
                crate::fs_util::sync_directory(download_dir).map_err(|error| {
                    format!(
                        "Could not sync download directory {} after installing {}: {error}",
                        download_dir.display(),
                        destination.display()
                    )
                })?;
                return Ok(destination);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not atomically install downloaded output {} without replacing it: {error}",
                    destination.display()
                ));
            }
        }
    }
    Err("Could not find an unused name for a downloaded output.".to_string())
}

const CAPTION_EXTENSIONS: &[&str] = &[
    "ass", "json3", "lrc", "srt", "ssa", "srv1", "srv2", "srv3", "ttml", "vtt",
];

fn caption_sidecar_paths(
    input: &Path,
    stage: &DownloadStage,
) -> Result<Vec<(PathBuf, FileIdentity)>, String> {
    let parent = input
        .parent()
        .ok_or_else(|| format!("Caption source has no parent: {}", input.display()))?;
    let stem = input
        .file_stem()
        .ok_or_else(|| format!("Caption source has no filename: {}", input.display()))?;
    let prefix = format!("{}.", stem.to_string_lossy());
    let owned_entries = stage.owned_entries.as_ref().ok_or_else(|| {
        format!(
            "Could not enumerate captions without an ownership snapshot for {}",
            parent.display()
        )
    })?;
    let mut paths = Vec::new();
    for (relative, expected_identity) in owned_entries {
        let path = stage.directory.join(relative);
        if path.parent() != Some(parent) {
            continue;
        }
        let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        let extension = path
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
        if !name.starts_with(&prefix)
            || !extension
                .as_deref()
                .is_some_and(|extension| CAPTION_EXTENSIONS.contains(&extension))
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Could not inspect staged caption {}: {error}",
                path.display()
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "Staged caption is not a regular file: {}",
                path.display()
            ));
        }
        if file_identity(&path) != Some(*expected_identity) {
            return Err(format!(
                "Staged caption changed after ownership was recorded: {}",
                path.display()
            ));
        }
        paths.push((path, *expected_identity));
    }
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(paths)
}

fn publish_owned_caption_sidecar(
    sidecar: &Path,
    expected_identity: FileIdentity,
    download_dir: &Path,
    preferred_name: &str,
    stage: &mut DownloadStage,
) -> Result<PathBuf, String> {
    if file_identity(sidecar) != Some(expected_identity) {
        stage.preserve_on_drop = true;
        return Err(format!(
            "Staged caption changed before publication: {}",
            sidecar.display()
        ));
    }
    let mut quarantined = None;
    for _ in 0..32 {
        let quarantine = sidecar
            .parent()
            .ok_or_else(|| format!("Staged caption has no parent: {}", sidecar.display()))?
            .join(format!(
                ".rosi-caption-publish-{}",
                crate::fs_util::uuid_v4()
            ));
        match install_no_replace(sidecar, &quarantine) {
            Ok(()) => {
                crate::staging::hide_on_windows(&quarantine);
                quarantined = Some(quarantine);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                stage.preserve_on_drop = true;
                return Err(format!(
                    "Could not quarantine staged caption {} for identity verification: {error}",
                    sidecar.display()
                ));
            }
        }
    }
    let Some(quarantine) = quarantined else {
        stage.preserve_on_drop = true;
        return Err(format!(
            "Could not reserve a caption identity-check path for {}.",
            sidecar.display()
        ));
    };
    if file_identity(&quarantine) != Some(expected_identity) {
        stage.preserve_on_drop = true;
        let restore = install_no_replace(&quarantine, sidecar);
        return Err(match restore {
            Ok(()) => format!(
                "A replacement caption was restored to staging and was not published: {}",
                sidecar.display()
            ),
            Err(error) => format!(
                "A replacement caption was not published and remains in recovery staging at {}: {error}",
                quarantine.display()
            ),
        });
    }

    match install_download_output_named(&quarantine, download_dir, preferred_name) {
        Ok(published) if file_identity(&published) == Some(expected_identity) => Ok(published),
        Ok(published) => {
            stage.preserve_on_drop = true;
            Err(format!(
                "Caption identity changed during publication; inspect the staged recovery at {} (destination {}).",
                sidecar.display(),
                published.display()
            ))
        }
        Err(error) => {
            stage.preserve_on_drop = true;
            if quarantine.exists() {
                let _ = install_no_replace(&quarantine, sidecar);
            }
            Err(format!(
                "Could not preserve requested caption sidecar {}: {error}",
                sidecar.display()
            ))
        }
    }
}

pub(super) fn publish_caption_sidecars(
    input: &Path,
    output_media: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<Vec<PathBuf>, String> {
    let input_stem = input
        .file_stem()
        .ok_or_else(|| format!("Caption source has no filename: {}", input.display()))?
        .to_string_lossy();
    let output_stem = output_media
        .file_stem()
        .ok_or_else(|| {
            format!(
                "Caption destination has no filename: {}",
                output_media.display()
            )
        })?
        .to_string_lossy();
    let sidecars = match caption_sidecar_paths(input, stage) {
        Ok(sidecars) => sidecars,
        Err(error) => {
            stage.preserve_on_drop = true;
            return Err(error);
        }
    };
    let mut published = Vec::new();
    for (sidecar, expected_identity) in sidecars {
        let Some(name) = sidecar.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(&format!("{input_stem}")) else {
            continue;
        };
        let preferred = format!("{output_stem}{suffix}");
        match publish_owned_caption_sidecar(
            &sidecar,
            expected_identity,
            download_dir,
            &preferred,
            stage,
        ) {
            Ok(path) => published.push(path),
            Err(error) => {
                stage.preserve_on_drop = true;
                return Err(format!(
                    "Could not preserve requested caption sidecar {}: {error}",
                    sidecar.display()
                ));
            }
        }
    }
    Ok(published)
}

#[derive(Debug)]
pub(super) struct PublicationFailure {
    pub(super) media_path: Option<PathBuf>,
    pub(super) detail: String,
}

fn find_published_identity(download_dir: &Path, identity: FileIdentity) -> Option<PathBuf> {
    std::fs::read_dir(download_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
                && file_identity(path) == Some(identity)
        })
}

pub(super) fn publish_staged_source(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<PathBuf, PublicationFailure> {
    match install_download_output(input, download_dir) {
        Ok(path) => Ok(path),
        Err(error) => {
            if input.exists() {
                stage.preserve_on_drop = true;
                Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "{error} The original remains in owned staging at {}.",
                        input.display()
                    ),
                })
            } else {
                // A post-install directory sync can fail after the no-replace
                // move succeeded. In that case the source is already present
                // at its final path, so preserving the now-empty staging
                // directory would add no protection.
                let media_path = stage
                    .identity_for(input)
                    .and_then(|identity| find_published_identity(download_dir, identity));
                Err(PublicationFailure {
                    media_path,
                    detail: error,
                })
            }
        }
    }
}

pub(super) fn publish_staged_source_with_captions(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
    write_subtitles: bool,
) -> Result<PathBuf, PublicationFailure> {
    let published = publish_staged_source(input, download_dir, stage)?;
    if write_subtitles {
        if let Err(detail) = publish_caption_sidecars(input, &published, download_dir, stage) {
            stage.preserve_on_drop = true;
            return Err(PublicationFailure {
                media_path: Some(published),
                detail,
            });
        }
    }
    Ok(published)
}

pub(super) fn push_completed_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

pub(super) fn publish_same_extension_for_session(
    id: u64,
    input: &Path,
    target: &str,
    download_dir: &Path,
    stage: &mut DownloadStage,
    write_subtitles: bool,
) -> Result<PathBuf, ConversionFailure> {
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    // Publication runs without the session lock; see
    // install_conversion_output_for_session.
    match publish_staged_source_with_captions(input, download_dir, stage, write_subtitles) {
        Ok(published) => {
            let target = target.to_string();
            let recorded = published.clone();
            with_session(id, move |session| {
                session.conversion_format = Some(target);
                session.completed_paths.push(recorded);
            });
            Ok(published)
        }
        Err(failure) => {
            if let Some(path) = failure.media_path {
                let recorded = path.clone();
                with_session(id, move |session| session.completed_paths.push(recorded));
                return Err(ConversionFailure::SetupPublished {
                    message: failure.detail,
                    path,
                });
            }
            Err(ConversionFailure::Setup(failure.detail))
        }
    }
}

/// Remove only the source that was present in this session's ownership
/// snapshot. Moving it to a fresh private quarantine first makes the identity
/// recheck apply to the entry we actually remove. A replacement is instead
/// installed with no-replace semantics in the user's selected folder.
pub(super) fn retire_staged_source(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<Option<PathBuf>, PublicationFailure> {
    let Some(expected_identity) = stage.identity_for(input) else {
        return publish_staged_source(input, download_dir, stage).map(Some);
    };
    let Some(parent) = input.parent() else {
        stage.preserve_on_drop = true;
        return Err(PublicationFailure {
            media_path: None,
            detail: format!("Staged source has no parent: {}", input.display()),
        });
    };
    let Some(file_name) = input.file_name() else {
        stage.preserve_on_drop = true;
        return Err(PublicationFailure {
            media_path: None,
            detail: format!("Staged source has no filename: {}", input.display()),
        });
    };

    for _ in 0..32 {
        let quarantine_dir =
            parent.join(format!(".rosi-source-retire-{}", crate::fs_util::uuid_v4()));
        match crate::fs_util::private_dir_builder().create(&quarantine_dir) {
            Ok(()) => crate::staging::hide_on_windows(&quarantine_dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                stage.preserve_on_drop = input.exists();
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "Could not reserve a private quarantine for staged original {}: {error}",
                        input.display()
                    ),
                });
            }
        }
        let quarantine = quarantine_dir.join(file_name);
        match install_no_replace(input, &quarantine) {
            Ok(()) => {
                if file_identity(&quarantine) == Some(expected_identity) {
                    if let Err(error) = std::fs::remove_file(&quarantine) {
                        stage.preserve_on_drop = true;
                        return Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "Could not remove verified original {} from private quarantine {}: {error}",
                                input.display(),
                                quarantine.display()
                            ),
                        });
                    }
                    if let Err(error) = std::fs::remove_dir(&quarantine_dir) {
                        stage.preserve_on_drop = true;
                        return Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "Could not remove empty source quarantine {}: {error}",
                                quarantine_dir.display()
                            ),
                        });
                    }
                    return Ok(None);
                }
                return match install_download_output(&quarantine, download_dir) {
                    Ok(path) => match std::fs::remove_dir(&quarantine_dir) {
                        Ok(()) => Ok(Some(path)),
                        Err(error) => {
                            stage.preserve_on_drop = true;
                            Err(PublicationFailure {
                                media_path: Some(path.clone()),
                                detail: format!(
                                    "Preserved replaced source at {} but could not retire its empty quarantine {}: {error}",
                                    path.display(),
                                    quarantine_dir.display()
                                ),
                            })
                        }
                    },
                    Err(error) => {
                        let source_remains = quarantine.exists();
                        if !source_remains {
                            let _ = std::fs::remove_dir(&quarantine_dir);
                        }
                        stage.preserve_on_drop = source_remains || quarantine_dir.exists();
                        Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "A replaced source was retained in private staging at {}: {error}",
                                quarantine.display()
                            ),
                        })
                    }
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                stage.preserve_on_drop = true;
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "The private source quarantine path was claimed unexpectedly: {}",
                        quarantine.display()
                    ),
                });
            }
            Err(error) => {
                let _ = std::fs::remove_dir(&quarantine_dir);
                if input.exists() {
                    stage.preserve_on_drop = true;
                }
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "Could not quarantine staged original {}: {error}",
                        input.display()
                    ),
                });
            }
        }
    }
    stage.preserve_on_drop = input.exists();
    Err(PublicationFailure {
        media_path: None,
        detail: format!(
            "Could not reserve a private quarantine for staged original {}.",
            input.display()
        ),
    })
}

pub(super) struct PendingSourcePublication<'a> {
    pub(super) id: u64,
    pub(super) inputs: &'a [PathBuf],
    pub(super) download_dir: &'a Path,
    pub(super) stage: &'a mut DownloadStage,
    pub(super) write_subtitles: bool,
    pub(super) completed: &'a mut Vec<PathBuf>,
    pub(super) failed: &'a mut Vec<PathBuf>,
    pub(super) failures: &'a mut Vec<String>,
}

pub(super) fn publish_pending_sources(publication: PendingSourcePublication<'_>) {
    for input in publication.inputs {
        if !input.exists() {
            continue;
        }
        match publish_staged_source_with_captions(
            input,
            publication.download_dir,
            publication.stage,
            publication.write_subtitles,
        ) {
            Ok(path) => {
                send_progress(
                    publication.id,
                    format!("ℹ️ Preserved original download: {}", path.display()),
                );
                if !publication.completed.contains(&path) {
                    publication.completed.push(path);
                }
            }
            Err(error) => {
                let failed_path = error.media_path.unwrap_or_else(|| input.clone());
                crate::logging::error(&format!(
                    "Could not fully publish staged original {}: {}",
                    input.display(),
                    error.detail
                ));
                if !publication.completed.contains(&failed_path)
                    && failed_path != *input
                    && failed_path.exists()
                {
                    publication.completed.push(failed_path.clone());
                }
                publication.failed.push(failed_path.clone());
                publication
                    .failures
                    .push(format!("{}: {}", failed_path.display(), error.detail));
            }
        }
    }
}
