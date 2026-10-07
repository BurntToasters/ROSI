use std::{
    fs::{self, Metadata, OpenOptions},
    io::{self, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static WORK_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn invalid_appimage(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn expected_elf_target() -> Option<(u8, u16)> {
    if cfg!(target_arch = "x86_64") {
        Some((2, 62))
    } else if cfg!(target_arch = "aarch64") {
        Some((2, 183))
    } else if cfg!(target_arch = "x86") {
        Some((1, 3))
    } else if cfg!(target_arch = "arm") {
        Some((1, 40))
    } else if cfg!(target_arch = "riscv64") {
        Some((2, 243))
    } else if cfg!(all(target_arch = "powerpc64", target_endian = "little")) {
        Some((2, 21))
    } else {
        None
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    Some(u16::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    Some(u32::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    Some(u64::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn checked_end(start: u64, length: u64) -> Option<u64> {
    start.checked_add(length)
}

fn both_endian_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let little = u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?);
    let big = u16::from_be_bytes(bytes.get(offset + 2..offset + 4)?.try_into().ok()?);
    (little == big).then_some(little)
}

fn both_endian_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let little = u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?);
    let big = u32::from_be_bytes(bytes.get(offset + 4..offset + 8)?.try_into().ok()?);
    (little == big).then_some(little)
}

fn elf_table_end(bytes: &[u8], class: u8, header_size: u16) -> io::Result<Option<u64>> {
    let (section_offset, section_entry_size, section_count, min_entry_size) = if class == 2 {
        (
            read_u64(bytes, 40).unwrap_or(0),
            read_u16(bytes, 58).unwrap_or(0),
            read_u16(bytes, 60).unwrap_or(0),
            64_u64,
        )
    } else {
        (
            u64::from(read_u32(bytes, 32).unwrap_or(0)),
            read_u16(bytes, 46).unwrap_or(0),
            read_u16(bytes, 48).unwrap_or(0),
            40_u64,
        )
    };
    if section_offset == 0 {
        return Ok(None);
    }
    if u64::from(section_entry_size) < min_entry_size || section_offset < u64::from(header_size) {
        return Err(invalid_appimage("AppImage ELF section table is invalid"));
    }

    let section_start = usize::try_from(section_offset)
        .map_err(|_| invalid_appimage("AppImage ELF section offset overflows"))?;
    let count = if section_count != 0 {
        u64::from(section_count)
    } else if class == 2 {
        let extended_count_offset = section_start
            .checked_add(32)
            .ok_or_else(|| invalid_appimage("AppImage ELF section offset overflows"))?;
        read_u64(bytes, extended_count_offset)
            .ok_or_else(|| invalid_appimage("AppImage ELF extended section count is truncated"))?
    } else {
        let extended_count_offset = section_start
            .checked_add(20)
            .ok_or_else(|| invalid_appimage("AppImage ELF section offset overflows"))?;
        u64::from(
            read_u32(bytes, extended_count_offset).ok_or_else(|| {
                invalid_appimage("AppImage ELF extended section count is truncated")
            })?,
        )
    };
    if count == 0 {
        return Err(invalid_appimage("AppImage ELF section table is empty"));
    }
    let table_bytes = u64::from(section_entry_size)
        .checked_mul(count)
        .ok_or_else(|| invalid_appimage("AppImage ELF section table overflows"))?;
    let end = checked_end(section_offset, table_bytes)
        .ok_or_else(|| invalid_appimage("AppImage ELF section table overflows"))?;
    if end > bytes.len() as u64 {
        return Err(invalid_appimage("AppImage ELF section table is truncated"));
    }
    Ok(Some(end))
}

fn validate_elf_executable(bytes: &[u8], class: u8, expected_machine: u16) -> io::Result<u64> {
    let minimum_header_size = if class == 2 { 64 } else { 52 };
    if bytes.len() < minimum_header_size {
        return Err(invalid_appimage("AppImage ELF header is truncated"));
    }
    let read16 = |offset| read_u16(bytes, offset).unwrap_or(0);
    let read32 = |offset| read_u32(bytes, offset).unwrap_or(0);
    let read64 = |offset| read_u64(bytes, offset).unwrap_or(0);

    if !matches!(read16(16), 2 | 3) || read16(18) != expected_machine || read32(20) != 1 {
        return Err(invalid_appimage(
            "AppImage ELF type, target architecture, or version is invalid",
        ));
    }

    let (entry, program_header_offset, header_size, program_header_size, program_header_count) =
        if class == 2 {
            (read64(24), read64(32), read16(52), read16(54), read16(56))
        } else {
            (
                u64::from(read32(24)),
                u64::from(read32(28)),
                read16(40),
                read16(42),
                read16(44),
            )
        };
    let minimum_program_header_size = if class == 2 { 56 } else { 32 };
    let table_end = program_header_offset
        .checked_add(u64::from(program_header_size) * u64::from(program_header_count));
    if u64::from(header_size) < minimum_header_size as u64
        || u64::from(program_header_size) < minimum_program_header_size
        || program_header_count == 0
        || program_header_offset < u64::from(header_size)
        || table_end.map_or(true, |end| end > bytes.len() as u64)
    {
        return Err(invalid_appimage(
            "AppImage ELF program-header table is truncated or incomplete",
        ));
    }

    let mut runtime_end = table_end.unwrap_or(0);
    let mut found_load = false;
    let mut entry_is_mapped = false;
    for index in 0..program_header_count {
        let header_offset = program_header_offset
            .checked_add(u64::from(index) * u64::from(program_header_size))
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| invalid_appimage("AppImage ELF program-header offset overflows"))?;
        let program_type = read_u32(bytes, header_offset).unwrap_or(0);
        if program_type != 1 {
            continue;
        }

        found_load = true;
        let (flags, file_offset, virtual_address, file_size, memory_size, alignment) = if class == 2
        {
            (
                read_u32(bytes, header_offset + 4).unwrap_or(0),
                read_u64(bytes, header_offset + 8).unwrap_or(u64::MAX),
                read_u64(bytes, header_offset + 16).unwrap_or(u64::MAX),
                read_u64(bytes, header_offset + 32).unwrap_or(u64::MAX),
                read_u64(bytes, header_offset + 40).unwrap_or(u64::MAX),
                read_u64(bytes, header_offset + 48).unwrap_or(0),
            )
        } else {
            (
                read_u32(bytes, header_offset + 24).unwrap_or(0),
                u64::from(read_u32(bytes, header_offset + 4).unwrap_or(u32::MAX)),
                u64::from(read_u32(bytes, header_offset + 8).unwrap_or(u32::MAX)),
                u64::from(read_u32(bytes, header_offset + 16).unwrap_or(u32::MAX)),
                u64::from(read_u32(bytes, header_offset + 20).unwrap_or(u32::MAX)),
                u64::from(read_u32(bytes, header_offset + 28).unwrap_or(0)),
            )
        };
        if file_size > memory_size {
            return Err(invalid_appimage(
                "AppImage ELF load segment has p_filesz greater than p_memsz",
            ));
        }
        let file_end = checked_end(file_offset, file_size)
            .ok_or_else(|| invalid_appimage("AppImage ELF load segment overflows"))?;
        let virtual_end = checked_end(virtual_address, memory_size)
            .ok_or_else(|| invalid_appimage("AppImage ELF virtual segment overflows"))?;
        if file_end > bytes.len() as u64
            || (alignment > 1
                && (!alignment.is_power_of_two()
                    || file_offset % alignment != virtual_address % alignment))
        {
            return Err(invalid_appimage(
                "AppImage ELF load segment is invalid or truncated",
            ));
        }
        runtime_end = runtime_end.max(file_end);

        if flags & 1 != 0
            && entry >= virtual_address
            && entry < virtual_end
            && entry - virtual_address < file_size
        {
            let entry_file_offset = file_offset
                .checked_add(entry - virtual_address)
                .ok_or_else(|| invalid_appimage("AppImage ELF entry point overflows"))?;
            entry_is_mapped = entry_file_offset < file_end;
        }
    }
    if !found_load || !entry_is_mapped {
        return Err(invalid_appimage(
            "AppImage ELF entry point is not file-backed by an executable PT_LOAD segment",
        ));
    }
    if let Some(section_end) = elf_table_end(bytes, class, header_size)? {
        runtime_end = runtime_end.max(section_end);
    }
    Ok(runtime_end)
}

fn validate_squashfs_at(bytes: &[u8], offset: usize) -> bool {
    const SUPERBLOCK_SIZE: usize = 96;
    const METADATA_LIMIT: u64 = 8192;
    let Some(filesystem) = bytes.get(offset..) else {
        return false;
    };
    if filesystem.len() < SUPERBLOCK_SIZE || filesystem.get(0..4) != Some(b"hsqs") {
        return false;
    }
    let Some(inodes) = read_u32(filesystem, 4) else {
        return false;
    };
    let Some(block_size) = read_u32(filesystem, 12) else {
        return false;
    };
    let Some(fragments) = read_u32(filesystem, 16) else {
        return false;
    };
    let Some(compression) = read_u16(filesystem, 20) else {
        return false;
    };
    let Some(block_log) = read_u16(filesystem, 22) else {
        return false;
    };
    let Some(id_count) = read_u16(filesystem, 26) else {
        return false;
    };
    let Some(major) = read_u16(filesystem, 28) else {
        return false;
    };
    let Some(minor) = read_u16(filesystem, 30) else {
        return false;
    };
    let Some(root_inode) = read_u64(filesystem, 32) else {
        return false;
    };
    let Some(bytes_used) = read_u64(filesystem, 40) else {
        return false;
    };
    let Some(id_table_start) = read_u64(filesystem, 48) else {
        return false;
    };
    let Some(xattr_table_start) = read_u64(filesystem, 56) else {
        return false;
    };
    let Some(inode_table_start) = read_u64(filesystem, 64) else {
        return false;
    };
    let Some(directory_table_start) = read_u64(filesystem, 72) else {
        return false;
    };
    let Some(fragment_table_start) = read_u64(filesystem, 80) else {
        return false;
    };
    let Some(lookup_table_start) = read_u64(filesystem, 88) else {
        return false;
    };

    if inodes == 0
        || id_count == 0
        || !(1..=6).contains(&compression)
        || major != 4
        || minor != 0
        || block_size < 4096
        || block_size > 1_048_576
        || !block_size.is_power_of_two()
        || block_log > 20
        || block_size != (1_u32 << block_log)
        || (root_inode & 0xffff) > METADATA_LIMIT
        || bytes_used < (SUPERBLOCK_SIZE + 32) as u64
        || bytes_used > filesystem.len() as u64
        || inode_table_start < SUPERBLOCK_SIZE as u64
        || inode_table_start >= directory_table_start
        || directory_table_start >= id_table_start
        || id_table_start
            .checked_add(8)
            .map_or(true, |end| end > bytes_used)
    {
        return false;
    }

    for optional_table in [xattr_table_start, fragment_table_start, lookup_table_start] {
        if optional_table != u64::MAX && optional_table >= bytes_used {
            return false;
        }
    }
    if fragments > 0 && fragment_table_start == u64::MAX {
        return false;
    }

    let root_block = root_inode >> 16;
    let root_metadata_start = match inode_table_start.checked_add(root_block) {
        Some(start) if start < directory_table_start => start,
        _ => return false,
    };
    if !valid_squashfs_metadata_block(filesystem, root_metadata_start, bytes_used)
        || !valid_squashfs_metadata_block(filesystem, directory_table_start, bytes_used)
    {
        return false;
    }
    let root_offset = (root_inode & 0xffff) as usize;
    let root_metadata_offset = match usize::try_from(root_metadata_start) {
        Ok(offset) => offset,
        Err(_) => return false,
    };
    let metadata_header = match read_u16(filesystem, root_metadata_offset) {
        Some(header) => header,
        None => return false,
    };
    if metadata_header & 0x8000 != 0 {
        let raw_size = u64::from(metadata_header & 0x7fff);
        let Some(inode_type_offset) = root_metadata_offset
            .checked_add(2)
            .and_then(|offset| offset.checked_add(root_offset))
        else {
            return false;
        };
        let Some(inode_type) = read_u16(filesystem, inode_type_offset) else {
            return false;
        };
        let inode_size = match inode_type {
            1 => 32_u64, // SQUASHFS_DIR_TYPE / squashfs_dir_inode
            8 => 40_u64, // SQUASHFS_LDIR_TYPE / squashfs_ldir_inode
            _ => return false,
        };
        if raw_size < root_offset as u64 + inode_size {
            return false;
        }
    }
    true
}

fn valid_squashfs_metadata_block(bytes: &[u8], offset: u64, bytes_used: u64) -> bool {
    let Ok(offset) = usize::try_from(offset) else {
        return false;
    };
    let Some(header) = read_u16(bytes, offset) else {
        return false;
    };
    let size = u64::from(header & 0x7fff);
    let block_end = (offset as u64)
        .checked_add(2)
        .and_then(|start| start.checked_add(size));
    size > 0 && size <= 8192 && block_end.map_or(false, |end| end <= bytes_used)
}

fn validate_type2_filesystem(bytes: &[u8], runtime_end: u64) -> io::Result<()> {
    let start = usize::try_from(runtime_end)
        .map_err(|_| invalid_appimage("AppImage ELF runtime size overflows"))?;
    if start >= bytes.len() {
        return Err(invalid_appimage(
            "Type 2 AppImage has no appended SquashFS filesystem",
        ));
    }
    for offset in start..bytes.len().saturating_sub(3) {
        if bytes.get(offset..offset + 4) == Some(b"hsqs") && validate_squashfs_at(bytes, offset) {
            return Ok(());
        }
    }
    Err(invalid_appimage(
        "Type 2 AppImage has no complete, bounded SquashFS filesystem",
    ))
}

fn validate_iso9660(bytes: &[u8]) -> io::Result<()> {
    const BLOCK: usize = 2048;
    const FIRST_DESCRIPTOR: usize = 16;
    const MAX_DESCRIPTORS: usize = 256;
    if bytes.len() < (FIRST_DESCRIPTOR + 2) * BLOCK {
        return Err(invalid_appimage(
            "Type 1 AppImage ISO 9660 volume is truncated",
        ));
    }
    let mut primary_volume = None;
    let mut terminator = None;
    let last_descriptor = bytes.len() / BLOCK;
    for block in FIRST_DESCRIPTOR..last_descriptor.min(FIRST_DESCRIPTOR + MAX_DESCRIPTORS) {
        let start = block * BLOCK;
        let descriptor = &bytes[start..start + BLOCK];
        if descriptor.get(1..6) != Some(b"CD001") || descriptor[6] != 1 {
            return Err(invalid_appimage(
                "Type 1 AppImage ISO volume descriptor is invalid",
            ));
        }
        match descriptor[0] {
            1 => primary_volume = Some((start, descriptor)),
            255 => {
                terminator = Some(block);
                break;
            }
            _ => {}
        }
    }
    let terminator = terminator
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO descriptor set is unterminated"))?;
    let (pvd_offset, pvd) = primary_volume
        .ok_or_else(|| invalid_appimage("Type 1 AppImage has no ISO primary volume descriptor"))?;
    let volume_blocks = both_endian_u32(pvd, 80)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO volume size is invalid"))?;
    let logical_block = both_endian_u16(pvd, 128)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO block size is invalid"))?;
    let volume_bytes = u64::from(volume_blocks)
        .checked_mul(BLOCK as u64)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO volume size overflows"))?;
    if logical_block != BLOCK as u16
        || volume_blocks <= terminator as u32 + 1
        || volume_bytes > bytes.len() as u64
    {
        return Err(invalid_appimage(
            "Type 1 AppImage ISO volume is truncated or inconsistent",
        ));
    }

    let root = pvd
        .get(156..190)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root record is truncated"))?;
    if root[0] < 34 || root[32] != 1 || root[33] != 0 || root[25] & 2 == 0 {
        return Err(invalid_appimage(
            "Type 1 AppImage ISO root directory record is invalid",
        ));
    }
    let root_extent = both_endian_u32(root, 2)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root extent is invalid"))?;
    let root_length = both_endian_u32(root, 10)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root length is invalid"))?;
    let root_blocks = (u64::from(root_length) + BLOCK as u64 - 1) / BLOCK as u64;
    let root_end = u64::from(root_extent)
        .checked_add(root_blocks)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root extent overflows"))?;
    if root_extent <= terminator as u32 || root_length == 0 || root_end > u64::from(volume_blocks) {
        return Err(invalid_appimage(
            "Type 1 AppImage ISO root directory is outside the volume",
        ));
    }

    let root_data_start = usize::try_from(u64::from(root_extent) * BLOCK as u64)
        .map_err(|_| invalid_appimage("Type 1 AppImage ISO root offset overflows"))?;
    let root_data_end = root_data_start
        .checked_add(root_length as usize)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root length overflows"))?;
    let root_data = bytes
        .get(root_data_start..root_data_end)
        .ok_or_else(|| invalid_appimage("Type 1 AppImage ISO root directory is truncated"))?;
    if !valid_iso_directory_record(root_data, 0, 0)
        || !valid_iso_directory_record(
            root_data,
            root_data.first().copied().unwrap_or(0) as usize,
            1,
        )
    {
        return Err(invalid_appimage(
            "Type 1 AppImage ISO root directory entries are invalid",
        ));
    }
    let _ = pvd_offset;
    Ok(())
}

fn valid_iso_directory_record(directory: &[u8], offset: usize, identifier: u8) -> bool {
    let Some(length) = directory.get(offset).copied().map(usize::from) else {
        return false;
    };
    if length < 34 || offset % 2048 + length > 2048 {
        return false;
    }
    let Some(record) = directory.get(offset..offset + length) else {
        return false;
    };
    record[32] == 1 && record[33] == identifier && record[25] & 2 != 0
}

/// Reject updater data that cannot be an executable AppImage for this build.
/// Type 1 and Type 2 markers are accepted so existing supported AppImages can
/// still move between releases; both formats require an ELF executable.
pub(crate) fn validate_appimage_bytes(bytes: &[u8]) -> io::Result<()> {
    let Some((expected_class, expected_machine)) = expected_elf_target() else {
        return Err(invalid_appimage(
            "AppImage architecture is not supported by this updater build",
        ));
    };
    if bytes.len() < 20 || bytes.get(0..4) != Some(&b"\x7fELF"[..]) {
        return Err(invalid_appimage("update is not a complete ELF AppImage"));
    }
    if bytes.get(8..11) != Some(&b"AI\x01"[..]) && bytes.get(8..11) != Some(&b"AI\x02"[..]) {
        return Err(invalid_appimage(
            "update has no recognized Type 1 or Type 2 AppImage marker",
        ));
    }
    if bytes[4] != expected_class || bytes[5] != 1 || bytes[6] != 1 {
        return Err(invalid_appimage(
            "AppImage ELF class, byte order, or version does not match this updater",
        ));
    }
    let runtime_end = validate_elf_executable(bytes, expected_class, expected_machine)?;
    match bytes[10] {
        1 => validate_iso9660(bytes),
        2 => validate_type2_filesystem(bytes, runtime_end),
        _ => Err(invalid_appimage("AppImage type marker is invalid")),
    }
}

fn validate_appimage_file(path: &Path) -> io::Result<Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(invalid_appimage(
            "live or staged AppImage must be a nonempty regular file",
        ));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(invalid_appimage("AppImage file is not executable"));
    }
    validate_appimage_bytes(&fs::read(path)?)?;
    Ok(metadata)
}

fn create_private_work_directory(root: &Path) -> io::Result<PathBuf> {
    for _ in 0..128 {
        let sequence = WORK_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!(
            ".tauri-appimage-update-{}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => {
                if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o700)) {
                    let _ = fs::remove_dir(&path);
                    return Err(error);
                }
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a private AppImage update directory",
    ))
}

/// Stage and validate the payload before moving the current executable. The
/// returned path names the retained previous AppImage on successful replacement.
pub(crate) fn install_appimage_at(
    extract_path: &Path,
    bytes: &[u8],
    temporary_roots: &[PathBuf],
) -> io::Result<PathBuf> {
    validate_appimage_bytes(bytes)?;
    let live_metadata = validate_appimage_file(extract_path)?;
    let live_mode = live_metadata.permissions().mode() & 0o777;
    if live_mode & 0o111 == 0 {
        return Err(invalid_appimage("current AppImage is not executable"));
    }

    let mut last_error = None;
    for root in temporary_roots {
        let work_directory = match create_private_work_directory(root) {
            Ok(path) => path,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let work_metadata = match fs::metadata(&work_directory) {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = fs::remove_dir_all(&work_directory);
                last_error = Some(error);
                continue;
            }
        };
        if work_metadata.dev() != live_metadata.dev() {
            let _ = fs::remove_dir_all(&work_directory);
            last_error = Some(io::Error::new(
                io::ErrorKind::InvalidInput,
                "temporary AppImage directory is not on the install filesystem",
            ));
            continue;
        }

        let staged_path = work_directory.join("next_app.AppImage");
        let staged_result = (|| -> io::Result<()> {
            let mut staged = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_path)?;
            staged.write_all(bytes)?;
            staged.sync_all()?;
            fs::set_permissions(&staged_path, fs::Permissions::from_mode(live_mode))?;
            validate_appimage_file(&staged_path)?;
            Ok(())
        })();
        if let Err(error) = staged_result {
            let _ = fs::remove_dir_all(&work_directory);
            last_error = Some(error);
            continue;
        }

        match replace_appimage_with_backup(
            extract_path,
            &staged_path,
            &work_directory,
            |from, to| fs::rename(from, to),
        ) {
            Ok(backup_path) => return Ok(backup_path),
            Err(error) => {
                let retained_backup = work_directory.join("current_app.AppImage");
                if !retained_backup.exists() {
                    let _ = fs::remove_dir_all(&work_directory);
                }
                return Err(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "no temporary AppImage directory is on the install filesystem",
        )
    }))
}

/// Move the already-validated old image to a recoverable path, then atomically
/// rename the already-validated stage into place. `rename` is injectable for
/// deterministic rollback-failure verification.
pub(crate) fn replace_appimage_with_backup(
    extract_path: &Path,
    staged_path: &Path,
    work_directory: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    let live_metadata = validate_appimage_file(extract_path)?;
    let staged_metadata = validate_appimage_file(staged_path)?;
    let work_metadata = fs::metadata(work_directory)?;
    if live_metadata.dev() != staged_metadata.dev() || live_metadata.dev() != work_metadata.dev() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "AppImage stage and recovery copy must share the install filesystem",
        ));
    }

    let backup_path = work_directory.join("current_app.AppImage");
    if backup_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "private AppImage recovery path already exists",
        ));
    }
    rename(extract_path, &backup_path)?;

    if let Err(swap_error) = rename(staged_path, extract_path) {
        if fs::symlink_metadata(extract_path).is_ok() {
            return Err(io::Error::other(format!(
                "AppImage replacement failed ({swap_error}); live path is occupied and the previous image backup is retained at {}",
                backup_path.display()
            )));
        }
        return match rename(&backup_path, extract_path) {
            Ok(()) => Err(swap_error),
            Err(restore_error) => Err(io::Error::other(format!(
                "AppImage replacement failed ({swap_error}); restoring the previous image failed ({restore_error}); backup retained at {}",
                backup_path.display()
            ))),
        };
    }

    match validate_appimage_file(extract_path) {
        Ok(installed_metadata)
            if installed_metadata.dev() == staged_metadata.dev()
                && installed_metadata.ino() == staged_metadata.ino() =>
        {
            Ok(backup_path)
        }
        validation => {
            let primary_error = match validation {
                Ok(_) => invalid_appimage("installed AppImage changed during replacement"),
                Err(error) => error,
            };
            let live_after = fs::symlink_metadata(extract_path).ok();
            if live_after.as_ref().is_some_and(|metadata| {
                metadata.dev() == staged_metadata.dev() && metadata.ino() == staged_metadata.ino()
            }) {
                if let Err(remove_error) = fs::remove_file(extract_path) {
                    return Err(io::Error::other(format!(
                        "installed AppImage validation failed ({primary_error}); removing it failed ({remove_error}); backup retained at {}",
                        backup_path.display()
                    )));
                }
            } else if live_after.is_some() {
                return Err(io::Error::other(format!(
                    "installed AppImage validation failed ({primary_error}); live path changed and backup retained at {}",
                    backup_path.display()
                )));
            }
            match rename(&backup_path, extract_path) {
                Ok(()) => Err(primary_error),
                Err(restore_error) => Err(io::Error::other(format!(
                    "installed AppImage validation failed ({primary_error}); restoring the previous image failed ({restore_error}); backup retained at {}",
                    backup_path.display()
                ))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Path, PathBuf},
    };

    const RUNTIME_SIZE: usize = 4096;
    const SQUASHFS_SIZE: usize = 256;
    const ISO_BLOCK_SIZE: usize = 2048;
    const ISO_BLOCK_COUNT: usize = 19;

    fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn write_both_endian_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        bytes[offset + 2..offset + 4].copy_from_slice(&value.to_be_bytes());
    }

    fn write_both_endian_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        bytes[offset + 4..offset + 8].copy_from_slice(&value.to_be_bytes());
    }

    fn write_iso_directory_record(bytes: &mut [u8], offset: usize, extent: u32, id: u8) {
        bytes[offset] = 34;
        write_both_endian_u32(bytes, offset + 2, extent);
        write_both_endian_u32(bytes, offset + 10, ISO_BLOCK_SIZE as u32);
        bytes[offset + 25] = 2;
        write_both_endian_u16(bytes, offset + 28, 1);
        bytes[offset + 32] = 1;
        bytes[offset + 33] = id;
    }

    pub(super) fn appimage(marker: u8, machine: u16, suffix: u8) -> Vec<u8> {
        let total_size = if marker == 1 {
            ISO_BLOCK_SIZE * ISO_BLOCK_COUNT
        } else {
            RUNTIME_SIZE + SQUASHFS_SIZE
        };
        let mut bytes = vec![0_u8; total_size];
        bytes[0..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2; // ELFCLASS64 for ROSI's released Linux targets.
        bytes[5] = 1; // little-endian
        bytes[6] = 1; // current ELF identification version
        bytes[8..11].copy_from_slice(&[b'A', b'I', marker]);
        write_u16(&mut bytes, 16, 3); // ET_DYN
        write_u16(&mut bytes, 18, machine);
        write_u32(&mut bytes, 20, 1);
        write_u64(&mut bytes, 24, 0x400100); // entry point
        write_u64(&mut bytes, 32, 64); // program-header offset
        write_u16(&mut bytes, 52, 64);
        write_u16(&mut bytes, 54, 56);
        write_u16(&mut bytes, 56, 1);

        // A real executable PT_LOAD segment covering the ELF header and entry.
        write_u32(&mut bytes, 64, 1); // PT_LOAD
        write_u32(&mut bytes, 68, 5); // PF_R | PF_X
        write_u64(&mut bytes, 72, 0); // p_offset
        write_u64(&mut bytes, 80, 0x400000); // p_vaddr
        write_u64(&mut bytes, 96, RUNTIME_SIZE as u64); // p_filesz
        write_u64(&mut bytes, 104, RUNTIME_SIZE as u64); // p_memsz
        write_u64(&mut bytes, 112, 4096); // p_align
        bytes[1000] = suffix;

        if marker == 1 {
            // ISO 9660 volume descriptor sequence: primary descriptor, then
            // terminator, with a bounded root-directory extent.
            let pvd = ISO_BLOCK_SIZE * 16;
            bytes[pvd] = 1;
            bytes[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
            bytes[pvd + 6] = 1;
            write_both_endian_u32(&mut bytes, pvd + 80, ISO_BLOCK_COUNT as u32);
            write_both_endian_u16(&mut bytes, pvd + 128, ISO_BLOCK_SIZE as u16);
            write_iso_directory_record(&mut bytes, pvd + 156, 18, 0);

            let terminator = pvd + ISO_BLOCK_SIZE;
            bytes[terminator] = 255;
            bytes[terminator + 1..terminator + 6].copy_from_slice(b"CD001");
            bytes[terminator + 6] = 1;
            write_iso_directory_record(&mut bytes, ISO_BLOCK_SIZE * 18, 18, 0);
            write_iso_directory_record(&mut bytes, ISO_BLOCK_SIZE * 18 + 34, 18, 1);
        } else {
            // SquashFS 4.0 superblock and bounded metadata-table extents.
            let fs = RUNTIME_SIZE;
            write_u32(&mut bytes, fs, 0x7371_7368); // "hsqs"
            write_u32(&mut bytes, fs + 4, 1); // inode count
            write_u32(&mut bytes, fs + 12, 4096); // block size
            write_u16(&mut bytes, fs + 20, 1); // zlib compression
            write_u16(&mut bytes, fs + 22, 12); // log2(block size)
            write_u16(&mut bytes, fs + 26, 1); // one uid/gid
            write_u16(&mut bytes, fs + 28, 4); // major version
            write_u16(&mut bytes, fs + 30, 0); // minor version
            write_u64(&mut bytes, fs + 32, 0); // root inode in first block
            write_u64(&mut bytes, fs + 40, SQUASHFS_SIZE as u64);
            write_u64(&mut bytes, fs + 48, 224); // id table
            write_u64(&mut bytes, fs + 56, u64::MAX); // no xattrs
            write_u64(&mut bytes, fs + 64, 96); // inode table
            write_u64(&mut bytes, fs + 72, 160); // directory table
            write_u64(&mut bytes, fs + 80, u64::MAX); // no fragments
            write_u64(&mut bytes, fs + 88, u64::MAX); // no export lookup table
            write_u16(&mut bytes, fs + 96, 0x8020); // raw 32-byte inode block
            write_u16(&mut bytes, fs + 98, 1); // root is a directory inode
            write_u16(&mut bytes, fs + 100, 0x41ed); // directory permissions
            write_u32(&mut bytes, fs + 110, 1); // root inode number
            write_u32(&mut bytes, fs + 118, 2); // root link count
            write_u16(&mut bytes, fs + 122, 34); // header + dot entries + 3
            write_u32(&mut bytes, fs + 126, 1); // parent is root
            write_u16(&mut bytes, fs + 160, 0x801f); // raw 31-byte directory block
                                                     // SquashFS directory header followed by "." and ".." entries.
            write_u32(&mut bytes, fs + 162, 1); // entry count minus one
            write_u32(&mut bytes, fs + 170, 1); // directory inode number
            write_u16(&mut bytes, fs + 174, 0); // "." inode offset
            write_u16(&mut bytes, fs + 178, 1); // directory inode type
            bytes[fs + 182] = b'.';
            write_u16(&mut bytes, fs + 183, 0); // ".." inode offset
            write_u16(&mut bytes, fs + 187, 1); // directory inode type
            write_u16(&mut bytes, fs + 189, 1); // name length minus one
            bytes[fs + 191..fs + 193].copy_from_slice(b"..");
            write_u64(&mut bytes, fs + 224, 240); // bounded id index
            write_u16(&mut bytes, fs + 240, 0x8008); // raw uid/gid id block
        }
        bytes
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
        #[allow(unreachable_code)]
        panic!("add an AppImage fixture for this target architecture");
    }

    fn temporary_directory(label: &str) -> PathBuf {
        for attempt in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "rosi-appimage-audit3-{}-{label}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                    return path;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create test directory: {error}"),
            }
        }
        panic!("could not allocate unique test directory");
    }

    #[test]
    fn rejects_empty_invalid_marker_truncated_and_wrong_architecture_payloads() {
        let machine = host_machine();
        let valid = appimage(2, machine, b'n');
        assert!(super::validate_appimage_bytes(&valid).is_ok());
        assert!(super::validate_appimage_bytes(&appimage(1, machine, b'1')).is_ok());

        for invalid in [
            Vec::new(),
            b"ordinary data".to_vec(),
            appimage(0, machine, b'0'),
            appimage(2, u16::MAX, b'w'),
            appimage(2, machine, b't')[..63].to_vec(),
        ] {
            assert!(super::validate_appimage_bytes(&invalid).is_err());
        }
    }

    #[test]
    fn rejects_nonloadable_or_unmapped_elf_entrypoints_and_segments() {
        let machine = host_machine();
        let mut invalid_entry = appimage(2, machine, b'e');
        invalid_entry[24..32].fill(0);
        assert!(super::validate_appimage_bytes(&invalid_entry).is_err());

        let mut non_executable_segment = appimage(2, machine, b'x');
        write_u32(&mut non_executable_segment, 68, 4); // PF_R only
        assert!(super::validate_appimage_bytes(&non_executable_segment).is_err());

        let mut out_of_bounds_segment = appimage(2, machine, b'o');
        write_u64(&mut out_of_bounds_segment, 96, u64::MAX);
        write_u64(&mut out_of_bounds_segment, 104, u64::MAX);
        assert!(super::validate_appimage_bytes(&out_of_bounds_segment).is_err());

        let mut no_load_segments = appimage(2, machine, b'p');
        write_u32(&mut no_load_segments, 64, 0); // PT_NULL, not PT_LOAD
        assert!(super::validate_appimage_bytes(&no_load_segments).is_err());

        let mut filesz_exceeds_memsz = appimage(2, machine, b'f');
        write_u64(&mut filesz_exceeds_memsz, 96, 2048);
        write_u64(&mut filesz_exceeds_memsz, 104, 1024);
        assert!(super::validate_appimage_bytes(&filesz_exceeds_memsz).is_err());

        let mut unmapped_entry = appimage(2, machine, b'u');
        write_u64(&mut unmapped_entry, 24, 0x500100);
        assert!(super::validate_appimage_bytes(&unmapped_entry).is_err());
    }

    #[test]
    fn rejects_missing_or_truncated_appimage_filesystems_but_keeps_type_one_and_two() {
        let machine = host_machine();
        assert!(super::validate_appimage_bytes(&appimage(2, machine, b'2')).is_ok());
        assert!(super::validate_appimage_bytes(&appimage(1, machine, b'1')).is_ok());

        let mut no_squashfs = appimage(2, machine, b'n');
        no_squashfs.truncate(RUNTIME_SIZE);
        assert!(super::validate_appimage_bytes(&no_squashfs).is_err());

        let mut truncated_squashfs = appimage(2, machine, b't');
        truncated_squashfs.truncate(RUNTIME_SIZE + 96);
        assert!(super::validate_appimage_bytes(&truncated_squashfs).is_err());

        let mut invalid_squashfs = appimage(2, machine, b'i');
        write_u32(&mut invalid_squashfs, RUNTIME_SIZE + 40, 1024);
        assert!(super::validate_appimage_bytes(&invalid_squashfs).is_err());

        let mut invalid_compression = appimage(2, machine, b'c');
        write_u16(&mut invalid_compression, RUNTIME_SIZE + 20, 0);
        assert!(super::validate_appimage_bytes(&invalid_compression).is_err());

        let mut invalid_tables = appimage(2, machine, b't');
        write_u64(&mut invalid_tables, RUNTIME_SIZE + 64, u64::MAX);
        assert!(super::validate_appimage_bytes(&invalid_tables).is_err());

        let mut missing_iso = appimage(1, machine, b'm');
        missing_iso[ISO_BLOCK_SIZE * 16 + 1..ISO_BLOCK_SIZE * 16 + 6].fill(0);
        assert!(super::validate_appimage_bytes(&missing_iso).is_err());

        let mut truncated_iso = appimage(1, machine, b't');
        truncated_iso.truncate(ISO_BLOCK_SIZE * 18);
        assert!(super::validate_appimage_bytes(&truncated_iso).is_err());

        let mut oversized_iso_volume = appimage(1, machine, b'v');
        write_both_endian_u32(
            &mut oversized_iso_volume,
            ISO_BLOCK_SIZE * 16 + 80,
            u32::MAX,
        );
        assert!(super::validate_appimage_bytes(&oversized_iso_volume).is_err());
    }

    #[test]
    fn validates_replacement_before_moving_live_image_and_keeps_old_image_after_success() {
        let directory = temporary_directory("success");
        let live = directory.join("ROSI.AppImage");
        let old = appimage(2, host_machine(), b'o');
        let new = appimage(2, host_machine(), b'n');
        fs::write(&live, &old).unwrap();
        fs::set_permissions(&live, fs::Permissions::from_mode(0o751)).unwrap();

        assert!(super::install_appimage_at(&live, b"", &[directory.clone()]).is_err());
        assert_eq!(fs::read(&live).unwrap(), old);

        let backup = super::install_appimage_at(&live, &new, &[directory.clone()]).unwrap();
        assert_eq!(fs::read(&live).unwrap(), new);
        assert_eq!(fs::read(&backup).unwrap(), old);
        assert_eq!(
            fs::symlink_metadata(&live).unwrap().permissions().mode() & 0o777,
            0o751
        );
        assert!(
            backup.exists(),
            "successful replacement must retain recovery copy"
        );
        assert!(
            fs::symlink_metadata(&live).unwrap().file_type().is_file(),
            "the live path must remain a regular file"
        );
        let live_metadata = fs::symlink_metadata(&live).unwrap();
        assert!(live_metadata.ino() > 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn swap_failure_restores_live_image_and_failed_restore_keeps_reported_backup() {
        let directory = temporary_directory("rollback");
        let live = directory.join("ROSI.AppImage");
        let stage = directory.join("next.AppImage");
        let old = appimage(2, host_machine(), b'o');
        let new = appimage(2, host_machine(), b'n');
        fs::write(&live, &old).unwrap();
        fs::set_permissions(&live, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&stage, &new).unwrap();
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o755)).unwrap();

        let backup_directory = directory.join("work-restore");
        fs::create_dir(&backup_directory).unwrap();
        let mut renames = 0;
        let error = super::replace_appimage_with_backup(
            &live,
            &stage,
            &backup_directory,
            |from: &Path, to: &Path| {
                renames += 1;
                if renames == 2 {
                    return Err(std::io::Error::other("forced staged rename failure"));
                }
                fs::rename(from, to)
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("forced staged rename failure"));
        assert_eq!(fs::read(&live).unwrap(), old);

        let backup_directory = directory.join("work-retain");
        fs::create_dir(&backup_directory).unwrap();
        let mut renames = 0;
        let error = super::replace_appimage_with_backup(
            &live,
            &stage,
            &backup_directory,
            |from: &Path, to: &Path| {
                renames += 1;
                if renames == 2 || renames == 3 {
                    return Err(std::io::Error::other("forced swap and restore failure"));
                }
                fs::rename(from, to)
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("backup retained at "));
        let backup = error
            .to_string()
            .split("backup retained at ")
            .nth(1)
            .expect("retained backup path is part of the failure")
            .to_owned();
        assert_eq!(fs::read(backup).unwrap(), old);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
pub(crate) mod test_fixtures {
    pub(crate) fn valid_appimage(marker: u8, machine: u16, suffix: u8) -> Vec<u8> {
        super::tests::appimage(marker, machine, suffix)
    }
}
