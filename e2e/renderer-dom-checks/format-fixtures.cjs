// Typed get_formats payloads (FormatList in src-tauri media_info.rs).
function videoFormat(formatId, resolution) {
  return { formatId, streamKind: "video", resolution };
}

function audioFormat(formatId) {
  return { formatId, streamKind: "audio" };
}

function formatList(formats) {
  return { formats };
}

module.exports = { audioFormat, formatList, videoFormat };
