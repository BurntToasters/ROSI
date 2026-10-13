// Lucide icons, bundled from the official lucide-static package. Markup holds
// `<span data-icon="name" data-size="16">` placeholders that are swapped for
// real SVG elements before the window is shown; scripts build icons with
// `icon()`. SVGs are parsed with DOMParser, so no markup goes through innerHTML.
import bookmark from 'lucide-static/icons/bookmark.svg?raw';
import captions from 'lucide-static/icons/captions.svg?raw';
import chartColumn from 'lucide-static/icons/chart-column.svg?raw';
import check from 'lucide-static/icons/check.svg?raw';
import chevronDown from 'lucide-static/icons/chevron-down.svg?raw';
import circleCheck from 'lucide-static/icons/circle-check.svg?raw';
import circleHelp from 'lucide-static/icons/circle-help.svg?raw';
import circleStop from 'lucide-static/icons/circle-stop.svg?raw';
import circleX from 'lucide-static/icons/circle-x.svg?raw';
import clapperboard from 'lucide-static/icons/clapperboard.svg?raw';
import clipboardPaste from 'lucide-static/icons/clipboard-paste.svg?raw';
import clock from 'lucide-static/icons/clock.svg?raw';
import download from 'lucide-static/icons/download.svg?raw';
import eye from 'lucide-static/icons/eye.svg?raw';
import folder from 'lucide-static/icons/folder.svg?raw';
import folderOpen from 'lucide-static/icons/folder-open.svg?raw';
import heart from 'lucide-static/icons/heart.svg?raw';
import hourglass from 'lucide-static/icons/hourglass.svg?raw';
import image from 'lucide-static/icons/image.svg?raw';
import info from 'lucide-static/icons/info.svg?raw';
import keyboard from 'lucide-static/icons/keyboard.svg?raw';
import link from 'lucide-static/icons/link.svg?raw';
import list from 'lucide-static/icons/list.svg?raw';
import monitor from 'lucide-static/icons/monitor.svg?raw';
import music from 'lucide-static/icons/music.svg?raw';
import partyPopper from 'lucide-static/icons/party-popper.svg?raw';
import play from 'lucide-static/icons/play.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import refreshCw from 'lucide-static/icons/refresh-cw.svg?raw';
import rocket from 'lucide-static/icons/rocket.svg?raw';
import rotateCcw from 'lucide-static/icons/rotate-ccw.svg?raw';
import search from 'lucide-static/icons/search.svg?raw';
import settings from 'lucide-static/icons/settings.svg?raw';
import skipForward from 'lucide-static/icons/skip-forward.svg?raw';
import square from 'lucide-static/icons/square.svg?raw';
import tag from 'lucide-static/icons/tag.svg?raw';
import terminal from 'lucide-static/icons/terminal.svg?raw';
import trash2 from 'lucide-static/icons/trash-2.svg?raw';
import triangleAlert from 'lucide-static/icons/triangle-alert.svg?raw';
import upload from 'lucide-static/icons/upload.svg?raw';
import video from 'lucide-static/icons/video.svg?raw';
import x from 'lucide-static/icons/x.svg?raw';

const registry: Record<string, string> = {
  bookmark,
  captions,
  'chart-column': chartColumn,
  check,
  'chevron-down': chevronDown,
  'circle-check': circleCheck,
  'circle-help': circleHelp,
  'circle-stop': circleStop,
  'circle-x': circleX,
  clapperboard,
  'clipboard-paste': clipboardPaste,
  clock,
  download,
  eye,
  folder,
  'folder-open': folderOpen,
  heart,
  hourglass,
  image,
  info,
  keyboard,
  link,
  list,
  monitor,
  music,
  'party-popper': partyPopper,
  play,
  plus,
  'refresh-cw': refreshCw,
  rocket,
  'rotate-ccw': rotateCcw,
  search,
  settings,
  'skip-forward': skipForward,
  square,
  tag,
  terminal,
  'trash-2': trash2,
  'triangle-alert': triangleAlert,
  upload,
  video,
  x,
};

type StatusTone = 'danger' | 'success' | 'warning' | null;

// Leading emoji in yt-dlp / FFmpeg status lines from the Rust side. The Rust
// strings keep them (completion checks look for ✅); only the display changes.
const STATUS_EMOJI: [string, string, StatusTone][] = [
  ['❌', 'circle-x', 'danger'],
  ['✅', 'circle-check', 'success'],
  ['⚠', 'triangle-alert', 'warning'],
  ['⏹', 'circle-stop', 'warning'],
  ['ℹ', 'info', null],
  ['⏳', 'hourglass', null],
  ['⏭', 'skip-forward', null],
  ['🚀', 'rocket', null],
  ['🎬', 'clapperboard', null],
  ['🎉', 'party-popper', 'success'],
  ['📹', 'video', null],
  ['🎵', 'music', null],
  ['🖼', 'image', null],
  ['🏷', 'tag', null],
  ['💬', 'captions', null],
  ['📂', 'folder', null],
  ['🗑', 'trash-2', null],
  ['🖥', 'monitor', null],
];

const parsed = new Map<string, SVGSVGElement>();

function template(name: string): SVGSVGElement | null {
  const cached = parsed.get(name);
  if (cached) return cached;
  const source = registry[name];
  if (!source) return null;
  const svg = new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('svg');
  if (!svg) return null;
  const node = document.importNode(svg, true);
  node.removeAttribute('class');
  // The source files are pretty-printed; their indentation would otherwise
  // show up in the textContent of every line or label holding an icon.
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const blanks: Node[] = [];
  while (walker.nextNode()) blanks.push(walker.currentNode);
  blanks.forEach((blank) => blank.parentNode?.removeChild(blank));
  parsed.set(name, node);
  return node;
}

/** A decorative Lucide icon, or null for an unknown name. */
function icon(name: string, size = 16, className = ''): SVGSVGElement | null {
  const base = template(name);
  if (!base) return null;
  const svg = base.cloneNode(true) as SVGSVGElement;
  svg.setAttribute('class', `lucide-icon ${className}`.trim());
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.icon = name;
  return svg;
}

/** Swap every `[data-icon]` placeholder under root for its SVG. */
function initializeIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('span[data-icon]').forEach((placeholder) => {
    const name = placeholder.dataset.icon ?? '';
    const svg = icon(name, Number(placeholder.dataset.size) || 16);
    if (!svg) return;
    for (const { name: attr, value } of Array.from(placeholder.attributes)) {
      if (attr === 'data-icon' || attr === 'data-size') continue;
      if (attr === 'class') svg.setAttribute('class', `lucide-icon ${value}`);
      else svg.setAttribute(attr, value);
    }
    placeholder.replaceWith(svg);
  });
}

/** Split a leading status emoji into a Lucide icon name and tone. */
function parseStatus(text: string): { icon: string | null; tone: StatusTone; text: string } {
  const trimmed = text.trimStart();
  for (const [emoji, name, tone] of STATUS_EMOJI) {
    if (trimmed.startsWith(emoji)) {
      const rest = trimmed.slice(emoji.length).replace(/^️/, '').trimStart();
      return { icon: name, tone, text: rest };
    }
  }
  return { icon: null, tone: null, text };
}

/** Write a status line into target, showing its emoji as a Lucide icon. */
function renderStatus(target: HTMLElement, text: string) {
  const status = parseStatus(text);
  const svg = status.icon ? icon(status.icon, 14, 'status-icon') : null;
  if (svg && status.tone) svg.classList.add(`status-icon--${status.tone}`);
  target.replaceChildren(...(svg ? [svg] : []), document.createTextNode(status.text));
}

initializeIcons();

const windowRef = window as Window & typeof globalThis;
windowRef.rosiModules = windowRef.rosiModules ?? {};
windowRef.rosiModules.icons = { icon, initializeIcons, parseStatus, renderStatus };
