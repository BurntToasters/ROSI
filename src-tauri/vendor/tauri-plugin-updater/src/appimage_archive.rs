use super::{appimage_install, Error, Result};
use flate2::read::MultiGzDecoder;
use std::io::{self, Cursor, Read};
use tar::{Archive, EntryType};

const MAX_ARCHIVE_ENTRIES: usize = 4096;
const ARCHIVE_OVERHEAD_ALLOWANCE: u64 = 4 * 1024 * 1024;
const TAR_BLOCK_SIZE: usize = 512;

pub(crate) fn extract_appimage_from_archive(
    bytes: &[u8],
    max_payload_bytes: u64,
) -> Result<Vec<u8>> {
    extract_appimage_from_archive_with_limits(
        bytes,
        max_payload_bytes,
        max_payload_bytes.saturating_add(ARCHIVE_OVERHEAD_ALLOWANCE),
        MAX_ARCHIVE_ENTRIES,
    )
}

fn extract_appimage_from_archive_with_limits(
    bytes: &[u8],
    max_payload_bytes: u64,
    max_total_bytes: u64,
    max_entries: usize,
) -> Result<Vec<u8>> {
    let decoder = MultiGzDecoder::new(Cursor::new(bytes));
    let mut decompressed = BoundedArchiveReader::new(decoder, max_total_bytes);
    let mut appimage = None;
    {
        let mut archive = Archive::new(&mut decompressed);
        let entries = archive.entries().map_err(|_| Error::InvalidUpdaterFormat)?;
        let mut entry_count = 0_usize;
        for entry in entries {
            entry_count = entry_count.saturating_add(1);
            if entry_count > max_entries {
                return Err(Error::InvalidUpdaterFormat);
            }
            let mut entry = entry.map_err(|_| Error::InvalidUpdaterFormat)?;
            let path = entry
                .path()
                .map_err(|_| Error::InvalidUpdaterFormat)?
                .into_owned();
            if path.extension() != Some(std::ffi::OsStr::new("AppImage")) {
                continue;
            }
            if entry.header().entry_type() != EntryType::Regular || appimage.is_some() {
                return Err(Error::InvalidUpdaterFormat);
            }
            let expected_size = entry
                .header()
                .size()
                .map_err(|_| Error::InvalidUpdaterFormat)?;
            if expected_size == 0 || expected_size > max_payload_bytes {
                return Err(Error::InvalidUpdaterFormat);
            }
            let capacity =
                usize::try_from(expected_size).map_err(|_| Error::InvalidUpdaterFormat)?;
            let mut contents = Vec::with_capacity(capacity);
            let mut limited = (&mut entry).take(max_payload_bytes.saturating_add(1));
            limited
                .read_to_end(&mut contents)
                .map_err(|_| Error::InvalidUpdaterFormat)?;
            if contents.len() as u64 != expected_size || contents.len() as u64 > max_payload_bytes {
                return Err(Error::InvalidUpdaterFormat);
            }
            appimage_install::validate_appimage_bytes(&contents)
                .map_err(|_| Error::InvalidUpdaterFormat)?;
            appimage = Some(contents);
        }
    }

    // `tar::Archive` accepts EOF without an end marker. Drain the complete gzip
    // stream, then require both tar zero blocks and validate CRC/trailer errors,
    // hidden trailing entries, and decompression caps.
    decompressed.begin_trailer_check();
    io::copy(&mut decompressed, &mut io::sink()).map_err(|_| Error::InvalidUpdaterFormat)?;
    if !decompressed.reached_eof
        || decompressed.consecutive_zero_blocks < 2
        || decompressed.trailing_nonzero
    {
        return Err(Error::InvalidUpdaterFormat);
    }

    appimage.ok_or(Error::BinaryNotFoundInArchive)
}

struct BoundedArchiveReader<R> {
    inner: R,
    max_bytes: u64,
    bytes_read: u64,
    block_bytes: usize,
    block_is_zero: bool,
    consecutive_zero_blocks: u8,
    reached_eof: bool,
    trailer_check: bool,
    trailing_nonzero: bool,
}

impl<R> BoundedArchiveReader<R> {
    fn new(inner: R, max_bytes: u64) -> Self {
        Self {
            inner,
            max_bytes,
            bytes_read: 0,
            block_bytes: 0,
            block_is_zero: true,
            consecutive_zero_blocks: 0,
            reached_eof: false,
            trailer_check: false,
            trailing_nonzero: false,
        }
    }

    fn begin_trailer_check(&mut self) {
        self.trailer_check = true;
    }
}

impl<R: Read> Read for BoundedArchiveReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.bytes_read >= self.max_bytes {
            let mut probe = [0_u8; 1];
            return match self.inner.read(&mut probe)? {
                0 => {
                    self.reached_eof = true;
                    Ok(0)
                }
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "AppImage archive exceeds the decompressed size limit",
                )),
            };
        }

        let remaining = self.max_bytes - self.bytes_read;
        let allowed = if remaining < buffer.len() as u64 {
            remaining as usize
        } else {
            buffer.len()
        };
        let bytes_read = self.inner.read(&mut buffer[..allowed])?;
        if bytes_read == 0 {
            self.reached_eof = true;
            return Ok(0);
        }
        if self.trailer_check && buffer[..bytes_read].iter().any(|byte| *byte != 0) {
            self.trailing_nonzero = true;
        }

        self.bytes_read = self
            .bytes_read
            .checked_add(bytes_read as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "archive size overflows"))?;
        for byte in &buffer[..bytes_read] {
            self.block_is_zero &= *byte == 0;
            self.block_bytes += 1;
            if self.block_bytes == TAR_BLOCK_SIZE {
                self.consecutive_zero_blocks = if self.block_is_zero {
                    self.consecutive_zero_blocks.saturating_add(1)
                } else {
                    0
                };
                self.block_bytes = 0;
                self.block_is_zero = true;
            }
        }
        Ok(bytes_read)
    }
}

#[cfg(test)]
mod tests {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tar::{EntryType, Header};

    struct ArchiveEntry<'a> {
        name: &'a str,
        kind: EntryType,
        payload: &'a [u8],
    }

    fn host_machine() -> u16 {
        #[cfg(target_arch = "x86_64")]
        {
            return 62;
        }
        #[cfg(target_arch = "aarch64")]
        {
            return 183;
        }
        #[cfg(target_arch = "x86")]
        {
            return 3;
        }
        #[cfg(target_arch = "arm")]
        {
            return 40;
        }
        panic!("add an AppImage archive fixture for this target architecture");
    }

    fn archive(entries: &[ArchiveEntry<'_>]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for item in entries {
            let regular = item.kind.is_file();
            let mut header = Header::new_gnu();
            header.set_entry_type(item.kind);
            header.set_mode(0o755);
            header.set_size(if regular {
                item.payload.len() as u64
            } else {
                0
            });
            if item.kind.is_symlink() || item.kind.is_hard_link() {
                header.set_link_name("target.AppImage").unwrap();
            }
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    item.name,
                    if regular { item.payload } else { &[][..] },
                )
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn compressed(raw: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn truncated_candidate_archive(payload: &[u8]) -> Vec<u8> {
        let declared_size = payload.len() as u64 + 512;
        let mut header = Header::new_gnu();
        header.set_path("ROSI.AppImage").unwrap();
        header.set_entry_type(EntryType::Regular);
        header.set_mode(0o755);
        header.set_size(declared_size);
        header.set_cksum();
        let mut raw = header.as_bytes().to_vec();
        raw.extend_from_slice(payload);
        let padded_len = raw.len().div_ceil(512) * 512;
        raw.resize(padded_len, 0);
        compressed(&raw)
    }

    fn truncated_tar_end_archive(payload: &[u8]) -> Vec<u8> {
        let mut header = Header::new_gnu();
        header.set_path("ROSI.AppImage").unwrap();
        header.set_entry_type(EntryType::Regular);
        header.set_mode(0o755);
        header.set_size(payload.len() as u64);
        header.set_cksum();
        let mut raw = header.as_bytes().to_vec();
        raw.extend_from_slice(payload);
        let padded_len = raw.len().div_ceil(512) * 512;
        raw.resize(padded_len, 0);
        compressed(&raw)
    }

    fn extract_with_limits(
        bytes: &[u8],
        max_payload_bytes: u64,
        max_total_bytes: u64,
        max_entries: usize,
    ) -> crate::Result<Vec<u8>> {
        super::extract_appimage_from_archive_with_limits(
            bytes,
            max_payload_bytes,
            max_total_bytes,
            max_entries,
        )
    }

    #[test]
    fn production_archive_extractor_accepts_one_regular_appimage_and_rejects_tar_links() {
        let payload =
            super::super::appimage_install::test_fixtures::valid_appimage(2, host_machine(), b'a');
        let valid = archive(&[ArchiveEntry {
            name: "ROSI.AppImage",
            kind: EntryType::Regular,
            payload: &payload,
        }]);
        assert_eq!(
            extract_with_limits(&valid, 1 << 20, 2 << 20, 128).unwrap(),
            payload
        );

        for kind in [EntryType::Directory, EntryType::Symlink, EntryType::Link] {
            let invalid = archive(&[ArchiveEntry {
                name: "ROSI.AppImage",
                kind,
                payload: &[],
            }]);
            assert!(extract_with_limits(&invalid, 1 << 20, 2 << 20, 128).is_err());
        }
    }

    #[test]
    fn production_archive_extractor_rejects_duplicate_invalid_and_truncated_candidates() {
        let payload =
            super::super::appimage_install::test_fixtures::valid_appimage(2, host_machine(), b'd');
        let duplicate = archive(&[
            ArchiveEntry {
                name: "one.AppImage",
                kind: EntryType::Regular,
                payload: &payload,
            },
            ArchiveEntry {
                name: "two.AppImage",
                kind: EntryType::Regular,
                payload: &payload,
            },
        ]);
        assert!(extract_with_limits(&duplicate, 1 << 20, 2 << 20, 128).is_err());

        let invalid_payload = b"not an ELF AppImage";
        let invalid = archive(&[ArchiveEntry {
            name: "bad.AppImage",
            kind: EntryType::Regular,
            payload: invalid_payload,
        }]);
        assert!(extract_with_limits(&invalid, 1 << 20, 2 << 20, 128).is_err());

        let truncated = truncated_candidate_archive(&payload);
        assert!(extract_with_limits(&truncated, 1 << 20, 2 << 20, 128).is_err());

        let mut truncated_gzip = archive(&[ArchiveEntry {
            name: "ROSI.AppImage",
            kind: EntryType::Regular,
            payload: &payload,
        }]);
        truncated_gzip.truncate(truncated_gzip.len() - 4);
        assert!(extract_with_limits(&truncated_gzip, 1 << 20, 2 << 20, 128).is_err());

        assert!(
            extract_with_limits(&truncated_tar_end_archive(&payload), 1 << 20, 2 << 20, 128)
                .is_err()
        );
    }

    #[test]
    fn production_archive_extractor_caps_total_decompression_and_entry_traversal() {
        let payload =
            super::super::appimage_install::test_fixtures::valid_appimage(2, host_machine(), b'l');
        let expanded_non_candidate = archive(&[ArchiveEntry {
            name: "notes.txt",
            kind: EntryType::Regular,
            payload: &[0_u8; 4096],
        }]);
        assert!(extract_with_limits(&expanded_non_candidate, 1 << 20, 2048, 128).is_err());

        let too_many_entries = archive(&[
            ArchiveEntry {
                name: "one.txt",
                kind: EntryType::Regular,
                payload: &[],
            },
            ArchiveEntry {
                name: "two.txt",
                kind: EntryType::Regular,
                payload: &[],
            },
            ArchiveEntry {
                name: "three.txt",
                kind: EntryType::Regular,
                payload: &[],
            },
            ArchiveEntry {
                name: "candidate.AppImage",
                kind: EntryType::Regular,
                payload: &payload,
            },
        ]);
        assert!(extract_with_limits(&too_many_entries, 1 << 20, 2 << 20, 2).is_err());
    }
}
