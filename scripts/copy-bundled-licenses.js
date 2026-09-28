#!/usr/bin/env node
/**
 * Copy the notices for bundled third-party binaries (yt-dlp and FFmpeg) into
 * public/ so the in-app licenses view can display the exact shipped text.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");
const notices = [
  {
    label: "yt-dlp",
    source: join(root, "assets", "YT-DLP-NOTICES.txt"),
    destination: join(publicDir, "yt-dlp-notices.txt"),
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
console.log(
  `[licenses:bundled] Copied ${notices.length} bundled binary notices to public/`,
);
