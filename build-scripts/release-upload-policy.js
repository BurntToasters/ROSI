'use strict';

const path = require('node:path');

function isReleaseUploadName(name) {
  return (
    /\.(?:dmg|zip|exe|msi|appimage|deb|rpm|appx|msix|flatpak|blockmap|asc)$/i.test(name) ||
    /^SHA256SUMS-[A-Za-z0-9_-]+\.txt$/.test(name) ||
    /^(?:latest|beta|alpha)(?:-[A-Za-z0-9_-]+)?\.ya?ml$/i.test(name)
  );
}

function getReleaseUploadFiles(releaseEntries, releaseDir) {
  return releaseEntries
    .filter(isReleaseUploadName)
    .sort()
    .map((name) => path.join(releaseDir, name));
}

module.exports = { getReleaseUploadFiles, isReleaseUploadName };
