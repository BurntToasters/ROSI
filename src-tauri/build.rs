use std::path::Path;

const SIDECARS: &[&str] = &["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"];
const STUB_MARKER: &str = "ROSI-SIDECAR-STUB";

const COMMANDS: &[&str] = &[
    "get_settings",
    "get_default_settings",
    "save_settings",
    "reset_settings",
    "export_settings",
    "import_settings",
    "get_stats",
    "reset_stats",
    "get_download_activity",
    "clear_download_activity",
    "get_formats",
    "cancel_formats",
    "get_video_info",
    "cancel_video_info",
    "download_video",
    "cancel_download",
    "add_to_queue",
    "remove_from_queue",
    "retry_queue_item",
    "reorder_queue_item",
    "clear_queue",
    "get_queue",
    "start_queue",
    "cancel_queue",
    "select_download_location",
    "open_external",
    "open_file_location",
    "show_notification",
    "check_deno_installed",
    "install_deno",
    "detect_gpu",
    "is_packaged",
    "is_flatpak",
    "get_app_platform",
    "get_distribution_channel",
    "get_beta_updater_target",
    "restart_app",
    "log_error",
    "notify_settings_flushed",
    "mark_main_window_ready",
];

fn sha256_file(path: &Path) -> String {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .unwrap_or_else(|e| panic!("failed to open {} for checksum: {e}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// Minimal SHA-256 implementation for build script (avoids adding a dep to build-dependencies).
/// Based on FIPS 180-4.
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        self.total_len += data.len() as u64;
        if self.buf_len > 0 {
            let space = 64 - self.buf_len;
            let take = space.min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            offset += take;
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while offset + 64 <= data.len() {
            let block: [u8; 64] = data[offset..offset + 64].try_into().unwrap();
            self.compress(&block);
            offset += 64;
        }
        if offset < data.len() {
            let remaining = data.len() - offset;
            self.buf[..remaining].copy_from_slice(&data[offset..]);
            self.buf_len = remaining;
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len * 8;
        // Padding
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for i in self.buf_len..64 {
                self.buf[i] = 0;
            }
            let block = self.buf;
            self.compress(&block);
            self.buf = [0u8; 64];
            self.buf_len = 0;
        }
        for i in self.buf_len..56 {
            self.buf[i] = 0;
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        self.compress(&block);

        let mut out = [0u8; 32];
        for (i, &word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        #[rustfmt::skip]
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
            0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
            0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];

        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

/// Minimal reader for the flat prepared-sidecar manifest written by
/// scripts/prepare-sidecars.js: `{ "<file>": { "sha256": "..", "stub": bool } }`.
fn manifest_entry(contents: &str, file_name: &str) -> Option<(String, bool)> {
    let key = format!("\"{file_name}\"");
    let start = contents.find(&key)? + key.len();
    let rest = &contents[start..];
    let block_end = rest.find('}')?;
    let block = &rest[..block_end];
    let sha_key = "\"sha256\"";
    let sha_start = block.find(sha_key)? + sha_key.len();
    let sha_rest = &block[sha_start..];
    let first_quote = sha_rest.find('"')? + 1;
    let sha_len = sha_rest[first_quote..].find('"')?;
    let sha = sha_rest[first_quote..first_quote + sha_len].to_string();
    let stub = block.contains("\"stub\": true") || block.contains("\"stub\":true");
    Some((sha, stub))
}

fn verify_sidecars() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set by Cargo");
    let binaries = Path::new(&manifest_dir).join("binaries");
    let manifest_path = binaries.join(".sidecar-manifest.json");
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_default();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let allow_stub_release = std::env::var("ROSI_ALLOW_STUB_SIDECARS").as_deref() == Ok("1");
    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };

    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-env-changed=ROSI_ALLOW_STUB_SIDECARS");
    println!("cargo:rerun-if-env-changed=TARGET");

    let manifest = std::fs::read_to_string(&manifest_path).unwrap_or_else(|error| {
        panic!(
            "Missing prepared sidecar manifest {} ({error}).\nRun `npm run prepare:sidecars` (release) or `npm run prepare:rust-tests` (development) first.",
            manifest_path.display()
        )
    });

    for name in SIDECARS {
        let file_name = format!("{name}-{target}{ext}");
        let path = binaries.join(&file_name);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.exists() {
            panic!(
                "Missing sidecar {} for target {target}. Run `npm run prepare:sidecars`.",
                path.display()
            );
        }
        let (expected, stub) = manifest_entry(&manifest, &file_name).unwrap_or_else(|| {
            panic!(
                "Sidecar {file_name} is not recorded in {}.",
                manifest_path.display()
            )
        });
        let actual = sha256_file(&path);
        assert_eq!(
            actual, expected,
            "Sidecar {file_name} changed after preparation. Re-run `npm run prepare:sidecars`."
        );
        let contents_are_stub = std::fs::read(&path)
            .map(|bytes| {
                bytes.len() < 4096 && String::from_utf8_lossy(&bytes).contains(STUB_MARKER)
            })
            .unwrap_or(false);
        if (stub || contents_are_stub) && profile == "release" && !allow_stub_release {
            panic!(
                "Release builds must bundle real sidecars, but {file_name} is a development stub.\nFetch FFmpeg with `npm run get:ffmpeg` and run `npm run prepare:sidecars`."
            );
        }
        if stub || contents_are_stub {
            println!(
                "cargo:warning={file_name} is a development stub; conversions using the bundled FFmpeg will fail."
            );
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=ROSI_DISTRIBUTION_CHANNEL");
    verify_sidecars();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
