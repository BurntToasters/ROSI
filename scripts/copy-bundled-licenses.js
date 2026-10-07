/**
 * Copy notices for bundled third-party binaries to public/ so the in-app
 * licenses view can display the exact shipped text.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const YT_DLP_VERSION = "2026.08.19";

export function copyBundledNotices(root = defaultRoot) {
  const publicDir = join(root, "public");
  const notices = [
    {
      label: "yt-dlp",
      source: join(root, "assets", "YT-DLP-NOTICES.txt"),
      destination: join(publicDir, "yt-dlp-notices.txt"),
    },
    {
      label: `yt-dlp bundled component licenses (${YT_DLP_VERSION})`,
      source: join(
        root,
        "assets",
        `yt-dlp-${YT_DLP_VERSION}-THIRD_PARTY_LICENSES.txt`,
      ),
      destination: join(publicDir, "yt-dlp-third-party-licenses.txt"),
    },
    {
      label: "FFmpeg notice",
      source: join(root, "resources", "ffmpeg", "NOTICE.txt"),
      destination: join(publicDir, "ffmpeg-notice.txt"),
    },
    {
      label: "FFmpeg license (GPL-2.0-or-later)",
      source: join(root, "resources", "ffmpeg", "ffmpeg_license.txt"),
      destination: join(publicDir, "ffmpeg-license.txt"),
    },
    {
      label: "FFmpeg written source offer",
      source: join(root, "resources", "ffmpeg", "SOURCE_OFFER.txt"),
      destination: join(publicDir, "ffmpeg-source-offer.txt"),
    },
  ];

  mkdirSync(publicDir, { recursive: true });
  const index = [];
  for (const notice of notices) {
    if (!existsSync(notice.source)) {
      throw new Error(`Missing bundled license notice: ${notice.source}`);
    }
    copyFileSync(notice.source, notice.destination);
    index.push({
      label: notice.label,
      file: notice.destination.slice(publicDir.length + 1),
      bytes: readFileSync(notice.source).length,
    });
  }
  writeFileSync(
    join(publicDir, "bundled-licenses.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
  return index;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const notices = copyBundledNotices();
    console.log(
      `[licenses:bundled] Copied ${notices.length} bundled binary notices to public/`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
