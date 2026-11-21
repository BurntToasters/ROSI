import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { waitFor, waitForAppReady } from "../../helpers/ui.js";
import { REPO_ROOT, e2eBinaryPath } from "../../helpers/profile.js";

// Covers the rows in high-contrast.failure-modes.md. Each check names the rows
// it proves. A row that needs a live media query to match records not-proven
// (invariantPassed null), never passed. The embedded WebDriver has no DevTools
// channel, so forced colors cannot be switched on from here.

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-high-contrast-${process.pid}`,
);
// The gate passes ROSI_E2E_SCREENSHOTS, so the shots land in the folder that
// verifyScreenshots re-hashes. A standalone run keeps them beside its report.
const screenshotDir =
  process.env.ROSI_E2E_SCREENSHOTS || path.join(artifactDir, "screenshots");
const GATE_SCREENSHOT_RECORD = "v5-screenshots";
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-high-contrast",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  binary: null,
  checks: [],
  screenshots: [],
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Source identity for this report: HEAD, a hash of the tracked diff, and the
// hash of each untracked file. Enough to tell which working tree produced it.
function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    head,
    workingTree:
      diff.length === 0 && untracked.length === 0 ? "clean" : "dirty",
    dirtyPatchSha256: sha256(diff),
    untrackedFiles: untracked.map((file) => ({
      path: file,
      sha256: sha256(fs.readFileSync(path.join(REPO_ROOT, file))),
    })),
  };
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

// A body that returns { notProven: true, reason } records the row as
// not-proven. Any thrown error records the row as failed and rethrows.
async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    if (details?.notProven) {
      const rest = { ...details };
      delete rest.notProven;
      report.checks.push({
        name,
        failureModes,
        status: "not-proven",
        invariantPassed: null,
        ...rest,
      });
    } else {
      report.checks.push({
        name,
        failureModes,
        status: "passed",
        invariantPassed: true,
        ...details,
      });
    }
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      failureModes,
      status: "failed",
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

function readCss(name) {
  return fs.readFileSync(path.join(REPO_ROOT, "src", "css", name), "utf8");
}

// The text between the braces of the first block whose opening matches
// `opening`. The pattern must end with the opening brace.
function blockAfter(text, opening) {
  const match = opening.exec(text);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

const SURFACE_TOKENS = [
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-hover",
  "border-subtle",
  "border-default",
  "border-strong",
  "sidebar-bg-start",
  "modal-bg-start",
];

function readTokens(block) {
  const tokens = {};
  for (const match of block.matchAll(
    /--([a-z0-9-]+):\s*([^;]+?)\s*(?:!important)?\s*;/g,
  )) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}

// Runs in the page. Walks every stylesheet and returns the rules the checks
// need: style rules inside forced-colors and contrast media rules, and style
// rules outside any media rule that name a system color.
function inspectStylesheets() {
  const normalizeSelector = (text) =>
    text.replace(/\s+/g, " ").replaceAll("'", '"').trim();
  const system =
    /\b(highlight|highlighttext|canvastext|buttontext|graytext)\b/i;
  const forced = [];
  const prefers = [];
  const leaks = [];
  const mediaTexts = [];
  const describe = (rule) => {
    const props = {};
    for (let index = 0; index < rule.style.length; index += 1) {
      const name = rule.style[index];
      props[name] = rule.style.getPropertyValue(name).trim();
    }
    return {
      selectors: rule.selectorText.split(",").map(normalizeSelector),
      props,
      cssText: rule.style.cssText,
    };
  };
  const walk = (rules, context) => {
    for (const rule of rules) {
      if (rule.selectorText !== undefined) {
        if (context.forced) forced.push(describe(rule));
        if (context.prefers) prefers.push(describe(rule));
        const text = rule.style.cssText;
        if (
          !context.media &&
          (system.test(text) || /forced-color-adjust/.test(text))
        ) {
          leaks.push({ selector: rule.selectorText, text });
        }
      } else if (rule.media && rule.cssRules) {
        const text = rule.media.mediaText;
        mediaTexts.push(text);
        walk(rule.cssRules, {
          media: true,
          forced: context.forced || /forced-colors:\s*active/i.test(text),
          prefers:
            context.prefers ||
            /prefers-contrast|prefers-reduced-transparency/i.test(text),
        });
      } else if (rule.cssRules) {
        walk(rule.cssRules, context);
      }
    }
  };
  try {
    for (const sheet of document.styleSheets) {
      walk(sheet.cssRules, { media: false, forced: false, prefers: false });
    }
  } catch (error) {
    return { error: `stylesheet unreadable: ${error}` };
  }
  return { forced, prefers, leaks, mediaTexts };
}

// Runs in the page. Reports whether this engine can express the two things the
// forced-colors rows read: the forced-color-adjust property, and a parsable
// (forced-colors: active) media query. WebView2 (Chromium) has both; other
// engines may have neither, so those rows are not-proven there rather than failed.
function forcedColorsSupport() {
  let adjustProperty = false;
  try {
    adjustProperty = CSS.supports("forced-color-adjust: none") === true;
  } catch {
    adjustProperty = false;
  }
  let activeQuery = false;
  try {
    activeQuery =
      window.matchMedia("(forced-colors: active)").media !== "not all";
  } catch {
    activeQuery = false;
  }
  return { adjustProperty, activeQuery };
}

// The not-proven reason for a row that reads forced-colors CSSOM text, or null
// when this engine supports what the row reads.
function forcedUnsupportedReason(support, needs) {
  if (needs.includes("adjust") && !support.adjustProperty) {
    return "forced-color-adjust is not supported by this engine (CSS.supports is false)";
  }
  if (needs.includes("query") && !support.activeQuery) {
    return "(forced-colors: active) is not a parsable media query in this engine";
  }
  return null;
}

// Merges the declarations of every rule that lists `selector`.
function propsFor(rules, selector) {
  const merged = {};
  let matches = 0;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    matches += 1;
    Object.assign(merged, rule.props);
  }
  return { matches, props: merged };
}

// [selector, { longhand: system color }]. Values compare in lower case.
const FORCED_TARGETS = [
  [
    ".toggle-slider",
    { "background-color": "canvas", "border-top-color": "buttontext" },
  ],
  [
    ".flat-ui-toggle-slider",
    { "background-color": "canvas", "border-top-color": "buttontext" },
  ],
  [".toggle-slider::after", { "background-color": "buttontext" }],
  [".flat-ui-toggle-slider::after", { "background-color": "buttontext" }],
  [
    ".toggle-switch input:checked + .toggle-slider",
    { "background-color": "highlight" },
  ],
  [
    ".wizard-toggle input:checked + .toggle-slider",
    { "background-color": "highlight" },
  ],
  [
    ".flat-ui-toggle-wrap input:checked + .flat-ui-toggle-slider",
    { "background-color": "highlight" },
  ],
  [
    ".toggle-switch input:checked + .toggle-slider::after",
    { "background-color": "highlighttext" },
  ],
  [
    ".wizard-toggle input:checked + .toggle-slider::after",
    { "background-color": "highlighttext" },
  ],
  [
    ".flat-ui-toggle-wrap input:checked + .flat-ui-toggle-slider::after",
    { "background-color": "highlighttext" },
  ],
  [".progress-bar", { "background-color": "highlight" }],
  [".queue-item-progress-bar", { "background-color": "highlight" }],
  [".wizard-progress-bar", { "background-color": "highlight" }],
  [".update-banner-bar", { "background-color": "highlight" }],
  [
    ".progress-bar-wrapper",
    { "background-color": "canvas", "outline-color": "buttontext" },
  ],
  [
    ".queue-item-progress-track",
    { "background-color": "canvas", "outline-color": "buttontext" },
  ],
  [
    ".wizard-progress",
    { "background-color": "canvas", "outline-color": "buttontext" },
  ],
  [
    ".update-banner-progress",
    { "background-color": "canvas", "outline-color": "buttontext" },
  ],
  [".wizard-theme-card", { "border-top-color": "buttontext" }],
  [
    ".wizard-theme-option input:checked + .wizard-theme-card",
    { "border-top-color": "highlight", "background-color": "highlight" },
  ],
  [
    '.segmented__item[aria-pressed="true"]',
    { "background-color": "highlight" },
  ],
  [
    '.segmented__item[aria-selected="true"]',
    { "background-color": "highlight" },
  ],
  [
    ".wizard-segment input:checked + .segmented__item",
    { "background-color": "highlight" },
  ],
  [".check input:checked", { "background-color": "highlight" }],
];

const SYSTEM_COLOR_VALUE =
  /^(canvas|canvastext|buttontext|buttonface|buttonborder|highlight|highlighttext|graytext|linktext|transparent|currentcolor|inherit|initial|unset|rgba\(0, 0, 0, 0\))$/i;

// Runs in the page. alphaOf reads the alpha channel of a computed color.
function surfaceAlphas() {
  const alphaOf = (value) => {
    const slash = value.match(/\/\s*([\d.]+)\s*\)\s*$/);
    if (slash) return Number(slash[1]);
    const rgba = value.match(/^rgba\(([^)]+)\)$/);
    if (rgba) {
      const parts = rgba[1].split(",").map((part) => part.trim());
      return parts.length > 3 ? Number(parts[3]) : 1;
    }
    return 1;
  };
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:-9999px;width:1px;height:1px;background:var(--surface-1);";
  document.body.appendChild(probe);
  try {
    const surface = getComputedStyle(probe).backgroundColor;
    const box = document.querySelector("#app-modal .modal-box");
    const dialog = box ? getComputedStyle(box).backgroundColor : null;
    return {
      surface,
      surfaceAlpha: alphaOf(surface),
      dialog,
      dialogAlpha: dialog === null ? null : alphaOf(dialog),
      flat: document.documentElement.dataset.flatUi === "true",
      theme: document.documentElement.dataset.theme ?? null,
    };
  } finally {
    probe.remove();
  }
}

async function openDialog(title) {
  await browser.execute((heading) => {
    window.__ROSI_E2E__.modules.overlays.showModal({
      title: heading,
      message: "High contrast surface check.",
      key: "high-contrast-dialog",
      buttons: [{ label: "OK", primary: true, action: () => {} }],
    });
  }, title);
  await waitFor(() => {
    const modal = document.getElementById("app-modal");
    const box = modal?.querySelector(".modal-box");
    return (
      modal?.classList.contains("active") &&
      !modal.classList.contains("showing") &&
      box.getAnimations().length === 0
    );
  }, "dialog did not open and settle");
}

async function closeDialog() {
  await browser.execute(() => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === "OK",
    );
    if (!button) throw new Error("missing OK button in the dialog");
    button.click();
  });
  await waitFor(
    () => !document.getElementById("app-modal")?.classList.contains("active"),
    "dialog did not close",
  );
}

async function screenshot(name) {
  const file = `${name}.png`;
  const destination = path.join(screenshotDir, file);
  await browser.saveScreenshot(destination);
  const bytes = fs.statSync(destination).size;
  assert.ok(bytes > 1000, `${name} screenshot is empty`);
  const shot = {
    name,
    file,
    path: path.relative(REPO_ROOT, destination).replaceAll(path.sep, "/"),
    sha256: sha256(fs.readFileSync(destination)),
    bytes,
  };
  report.screenshots.push(shot);
  writeReport();
  return shot;
}

// Appends this spec's shots to the pass results file (ROSI_E2E_RESULTS). Records
// already in the file come from other specs in the same pass and are kept.
function writeGateScreenshotRecord(shots) {
  const resultsPath = process.env.ROSI_E2E_RESULTS;
  if (!resultsPath) return;
  let records = [];
  try {
    if (fs.existsSync(resultsPath)) {
      const parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      if (Array.isArray(parsed)) records = parsed;
    }
  } catch {
    records = [];
  }
  records.push({ name: GATE_SCREENSHOT_RECORD, status: "passed", shots });
  fs.writeFileSync(resultsPath, `${JSON.stringify(records, null, 2)}\n`);
}

describe("ROSI high contrast, forced colors and reduced transparency", () => {
  let sheets = null;
  let media = null;
  let forcedSupport = null;

  before(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await waitForAppReady();
    report.source = sourceIdentity();
    const binaryPath = e2eBinaryPath();
    report.binary = {
      path: path.relative(REPO_ROOT, binaryPath).replaceAll(path.sep, "/"),
      sha256: fs.existsSync(binaryPath)
        ? sha256(fs.readFileSync(binaryPath))
        : null,
      mtime: fs.existsSync(binaryPath)
        ? fs.statSync(binaryPath).mtime.toISOString()
        : null,
    };
    assert.ok(report.binary.sha256, "fresh E2E binary is missing");
    writeReport();
  });

  after(async () => {
    // One record for the whole spec, written once. The gate reads every
    // v5-screenshots record it finds.
    if (report.screenshots.length > 0) {
      writeGateScreenshotRecord(
        report.screenshots.map((shot) => ({
          name: shot.name,
          file: shot.file,
          sha256: shot.sha256,
          bytes: shot.bytes,
        })),
      );
    }
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.notProven = report.checks.filter(
      (check) => check.status === "not-proven",
    ).length;
    report.result =
      report.failed === 0 && report.checks.length > 0 ? "passed" : "failed";
    writeReport();
  });

  it("ships forced-colors rules that keep state visible", async () => {
    sheets = await browser.execute(inspectStylesheets);
    if (sheets.error) throw new Error(sheets.error);
    forcedSupport = await browser.execute(forcedColorsSupport);

    await scenario("forced-colors-state-rules", [1, 2, 3, 4], async () => {
      const unsupported = forcedUnsupportedReason(forcedSupport, ["query"]);
      if (unsupported)
        return { notProven: true, reason: unsupported, forcedSupport };
      assert.ok(
        sheets.mediaTexts.some((text) => /forced-colors:\s*active/i.test(text)),
        "no @media (forced-colors: active) rule is shipped",
      );
      const checked = [];
      for (const [selector, expected] of FORCED_TARGETS) {
        const { matches, props } = propsFor(sheets.forced, selector);
        assert.ok(
          matches >= 1,
          `forced-colors rule for ${selector} is missing`,
        );
        for (const [name, value] of Object.entries(expected)) {
          assert.equal(
            (props[name] ?? "").toLowerCase(),
            value,
            `${selector} ${name} is ${props[name]}, expected ${value}`,
          );
        }
        checked.push(selector);
      }
      return { selectors: checked };
    });

    await scenario("forced-colors-adjust-scope", [5], async () => {
      const unsupported = forcedUnsupportedReason(forcedSupport, [
        "query",
        "adjust",
      ]);
      if (unsupported)
        return { notProven: true, reason: unsupported, forcedSupport };
      const adjusted = sheets.forced
        .filter((rule) => rule.props["forced-color-adjust"] !== undefined)
        .flatMap((rule) =>
          rule.selectors.map((selector) => ({
            selector,
            value: rule.props["forced-color-adjust"],
          })),
        );
      assert.ok(
        adjusted.some(
          (entry) =>
            entry.selector === ".wizard-theme-preview" &&
            entry.value === "none",
        ),
        "the theme swatches do not opt out of forced colors",
      );
      const others = adjusted.filter(
        (entry) => entry.selector !== ".wizard-theme-preview",
      );
      assert.deepEqual(
        others,
        [],
        "forced-color-adjust is set on selectors other than the swatches",
      );
      return { adjusted };
    });

    await scenario("forced-colors-system-colours-only", [6], async () => {
      const unsupported = forcedUnsupportedReason(forcedSupport, ["query"]);
      if (unsupported)
        return { notProven: true, reason: unsupported, forcedSupport };
      const offenders = [];
      for (const rule of sheets.forced) {
        for (const [name, value] of Object.entries(rule.props)) {
          if (name.startsWith("--")) continue;
          if (
            /(^|-)color$/.test(name) ||
            name === "fill" ||
            name === "stroke"
          ) {
            if (!SYSTEM_COLOR_VALUE.test(value)) {
              offenders.push(`${rule.selectors[0]} ${name}: ${value}`);
            }
          } else if (name === "background-image") {
            // The build writes transparent as #0000, which the page reads
            // back as rgba(0, 0, 0, 0); that is not a literal brand color.
            const literal = value.replaceAll(/rgba\(0, 0, 0, 0\)/g, "");
            if (value !== "none" && /var\(|#|rgb|hsl/i.test(literal)) {
              offenders.push(`${rule.selectors[0]} ${name}: ${value}`);
            }
          } else if (name === "box-shadow" || name === "text-shadow") {
            if (value !== "none") {
              offenders.push(`${rule.selectors[0]} ${name}: ${value}`);
            }
          }
        }
      }
      assert.deepEqual(offenders, [], "non-system color in the forced block");
      return { rules: sheets.forced.length };
    });

    await scenario("forced-colors-confined-to-media", [7], async () => {
      const unsupported = forcedUnsupportedReason(forcedSupport, [
        "query",
        "adjust",
      ]);
      if (unsupported)
        return { notProven: true, reason: unsupported, forcedSupport };
      assert.deepEqual(
        sheets.leaks,
        [],
        "a system color or forced-color-adjust sits outside a media rule",
      );
      return { leaks: 0 };
    });
  });

  it("maps contrast and transparency preferences to opaque flat tokens", async () => {
    if (!sheets) {
      sheets = await browser.execute(inspectStylesheets);
      if (sheets.error) throw new Error(sheets.error);
    }
    const responsive = readCss("06-responsive.css");
    const base = readCss("01-base.css");
    const block = blockAfter(
      responsive,
      /@media\s*\(prefers-contrast:\s*more\)\s*,\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{/,
    );

    await scenario("preference-media-rules", [8], async () => {
      assert.ok(block, "preference media block is missing from the source");
      assert.ok(
        sheets.mediaTexts.some((text) => /prefers-contrast/i.test(text)),
        "the shipped stylesheet has no prefers-contrast media rule",
      );
      assert.ok(
        sheets.prefers.length > 0,
        "the shipped preference media rule holds no style rules",
      );
      return {
        mediaTexts: sheets.mediaTexts.filter((text) =>
          /prefers-contrast|prefers-reduced-transparency/i.test(text),
        ),
        styleRules: sheets.prefers.length,
      };
    });

    await scenario("preference-tokens-match-flat-ui", [9], async () => {
      assert.ok(block, "preference media block is missing from the source");
      const pairs = [
        ["dark", /(^|\n)\s*:root\s*\{/, /html\[data-flat-ui='true'\]\s*\{/],
        [
          "purple",
          /:root\[data-theme='purple'\]\s*\{/,
          /html\[data-flat-ui='true'\]\[data-theme='purple'\]\s*\{/,
        ],
        [
          "light",
          /:root\[data-theme='light'\]\s*\{/,
          /html\[data-flat-ui='true'\]\[data-theme='light'\]\s*\{/,
        ],
      ];
      const compared = {};
      for (const [theme, mediaOpening, flatOpening] of pairs) {
        const mediaBlock = blockAfter(block, mediaOpening);
        const flatBlock = blockAfter(base, flatOpening);
        assert.ok(mediaBlock, `${theme} block is missing from the media rule`);
        assert.ok(
          flatBlock,
          `${theme} flat-UI block is missing in 01-base.css`,
        );
        const mapped = readTokens(mediaBlock);
        const flat = readTokens(flatBlock);
        for (const token of SURFACE_TOKENS) {
          assert.ok(flat[token], `${theme} flat-UI lacks --${token}`);
          assert.equal(
            mapped[token],
            flat[token],
            `${theme} --${token} is ${mapped[token]}, flat UI uses ${flat[token]}`,
          );
        }
        compared[theme] = SURFACE_TOKENS.map((token) => flat[token]);
      }
      return { compared };
    });

    await scenario("preference-panels-opaque", [10], async () => {
      const panels = [
        [
          "modal-bg-start",
          [".modal-box", ".toast", ".wizard-card", ".popover"],
        ],
        ["sidebar-bg-start", [".sidebar"]],
      ];
      for (const [token, selectors] of panels) {
        for (const selector of selectors) {
          const rules = sheets.prefers.filter((rule) =>
            rule.selectors.includes(selector),
          );
          assert.ok(rules.length >= 1, `${selector} has no preference rule`);
          const text = rules.map((rule) => rule.cssText).join(" ");
          assert.ok(
            text.includes(`--${token}`),
            `${selector} does not use --${token} (${text})`,
          );
          assert.ok(
            !/color-mix|transparent/i.test(text),
            `${selector} background is still translucent`,
          );
          assert.ok(
            /backdrop-filter:\s*none/.test(text),
            `${selector} keeps its backdrop filter (${text})`,
          );
        }
      }
      return { panels: panels.flatMap(([, selectors]) => selectors) };
    });
  });

  it("keeps the default look and reports live media state", async () => {
    media = await browser.execute(() => {
      const holds = (query) => window.matchMedia(query).matches;
      const supported = (query) => window.matchMedia(query).media !== "not all";
      return {
        forcedActive: holds("(forced-colors: active)"),
        forcedNone: holds("(forced-colors: none)"),
        contrast: {
          more: holds("(prefers-contrast: more)"),
          less: holds("(prefers-contrast: less)"),
          custom: holds("(prefers-contrast: custom)"),
          noPreference: holds("(prefers-contrast: no-preference)"),
        },
        reducedTransparencySupported: supported(
          "(prefers-reduced-transparency)",
        ),
        reducedTransparency: holds("(prefers-reduced-transparency: reduce)"),
      };
    });

    await scenario("media-queries-consistent", [14], async () => {
      // Only checked where forced-colors queries parse; elsewhere both can be
      // false, which says nothing about the preference queries below.
      if (forcedSupport.activeQuery) {
        assert.notEqual(
          media.forcedActive,
          media.forcedNone,
          "forced-colors active and none are not complements",
        );
      }
      const held = Object.values(media.contrast).filter(Boolean).length;
      assert.equal(held, 1, `prefers-contrast holds ${held} values, not 1`);
      return { media };
    });

    await openDialog("High contrast default look");
    let alphas;
    try {
      alphas = await browser.execute(surfaceAlphas);
    } finally {
      await closeDialog();
    }
    const preferenceActive = media.contrast.more || media.reducedTransparency;

    await scenario("default-look-unchanged", [11], async () => {
      if (preferenceActive || alphas.flat) {
        return {
          notProven: true,
          reason: preferenceActive
            ? "a contrast or transparency preference is active"
            : "flat UI is on, so surfaces are opaque by design",
          alphas,
        };
      }
      assert.ok(
        alphas.surfaceAlpha < 1,
        `--surface-1 is opaque (${alphas.surface}) without a preference`,
      );
      assert.ok(
        alphas.dialogAlpha < 1,
        `the dialog is opaque (${alphas.dialog}) without a preference`,
      );
      return { alphas };
    });

    await scenario("preference-live-opaque", [12], async () => {
      if (!preferenceActive) {
        return {
          notProven: true,
          reason:
            "neither prefers-contrast: more nor prefers-reduced-transparency: reduce matches",
          alphas,
        };
      }
      assert.equal(alphas.surfaceAlpha, 1, "--surface-1 is translucent");
      assert.equal(alphas.dialogAlpha, 1, "the dialog is translucent");
      return { alphas };
    });

    await scenario("forced-colors-live-state", [13], async () => {
      const unsupported = forcedUnsupportedReason(forcedSupport, ["query"]);
      if (unsupported)
        return { notProven: true, reason: unsupported, forcedSupport };
      if (!media.forcedActive) {
        return {
          notProven: true,
          reason:
            "forced-colors: active does not match; the gate has no way to turn it on",
        };
      }
      const live = await browser.execute(() => {
        const holder = document.createElement("div");
        holder.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;";
        holder.innerHTML = `
          <label class="toggle-switch"><input id="hc-off" type="checkbox" /><span class="toggle-slider"></span></label>
          <label class="toggle-switch"><input id="hc-on" type="checkbox" checked /><span class="toggle-slider"></span></label>
          <div class="progress-bar-wrapper"><div class="progress-bar" style="width:50%"></div></div>
          <div class="wizard-theme-option"><input type="radio" name="hc-theme" /><span class="wizard-theme-card"></span></div>
          <div class="wizard-theme-option"><input type="radio" name="hc-theme" checked /><span class="wizard-theme-card"></span></div>`;
        document.body.appendChild(holder);
        try {
          const style = (element) => getComputedStyle(element);
          const slider = (id) =>
            style(holder.querySelector(`#${id} + .toggle-slider`));
          const cards = holder.querySelectorAll(".wizard-theme-card");
          const bar = style(holder.querySelector(".progress-bar"));
          const track = style(holder.querySelector(".progress-bar-wrapper"));
          return {
            offTrack: slider("hc-off").backgroundColor,
            onTrack: slider("hc-on").backgroundColor,
            fill: bar.backgroundColor,
            track: track.backgroundColor,
            cardOff: style(cards[0]).borderTopColor,
            cardOn: style(cards[1]).borderTopColor,
          };
        } finally {
          holder.remove();
        }
      });
      assert.notEqual(live.onTrack, live.offTrack, "toggle states look alike");
      assert.notEqual(live.fill, live.track, "progress fill matches its track");
      assert.notEqual(
        live.cardOn,
        live.cardOff,
        "selected card looks unselected",
      );
      return { live };
    });
  });

  it("records evidence screenshots of the surfaces the rules touch", async () => {
    await scenario("surface-screenshots", [15], async () => {
      // Settings.
      await browser.execute(() =>
        document.getElementById("settingsBtn").click(),
      );
      await waitFor(() => {
        const sidebar = document.getElementById("sidebar");
        return (
          sidebar?.classList.contains("open") &&
          sidebar.getAnimations().length === 0
        );
      }, "settings did not open and settle");
      await screenshot("high-contrast-settings");
      await browser.execute(() =>
        document.getElementById("closeSidebar").click(),
      );
      await waitFor(
        () => !document.getElementById("sidebar")?.classList.contains("open"),
        "settings did not close",
      );

      // Dialog.
      await openDialog("High contrast dialog");
      await screenshot("high-contrast-dialog");
      await closeDialog();

      // Toast.
      await browser.execute(() => {
        window.__ROSI_E2E__.modules.ui.showToast("High contrast toast", {
          type: "info",
          duration: 60_000,
        });
      });
      await waitFor(
        () => {
          const toasts = [...document.querySelectorAll(".toast.visible")];
          return (
            toasts.length >= 1 &&
            toasts.every((toast) => toast.getAnimations().length === 0)
          );
        },
        "toast did not appear and settle",
        5_000,
      );
      await screenshot("high-contrast-toast");
      await browser.execute(() => {
        document
          .querySelectorAll(".toast .toast-dismiss")
          .forEach((button) => button.click());
      });
      await waitFor(
        () => document.querySelectorAll(".toast").length === 0,
        "toast did not close",
        5_000,
      );

      // Wizard, theme step. The overlay is shown by class only, so no
      // settings change and no reload. The classes are restored afterwards.
      const restore = await browser.execute(() => {
        const overlay = document.getElementById("setup-wizard");
        if (!overlay) throw new Error("setup wizard markup is missing");
        const steps = [...overlay.querySelectorAll(".wizard-step")];
        const previous = steps.findIndex((step) =>
          step.classList.contains("active"),
        );
        steps.forEach((step, index) =>
          step.classList.toggle("active", index === 1),
        );
        overlay.classList.add("active");
        // Force layout so the entrance animations exist before the wait.
        void overlay.offsetHeight;
        return { previous };
      });
      try {
        await waitFor(
          () => {
            const overlay = document.getElementById("setup-wizard");
            const card = overlay?.querySelector(".wizard-card");
            const step = overlay?.querySelector(".wizard-step.active");
            // Both entrance animations use fill-mode both, so a finished one
            // stays listed. Settled means every listed one has finished.
            return (
              overlay?.classList.contains("active") &&
              [...card.getAnimations(), ...step.getAnimations()].every(
                (animation) => animation.playState === "finished",
              )
            );
          },
          "wizard did not show and settle",
          5_000,
        );
        await screenshot("high-contrast-wizard");
      } finally {
        await browser.execute((previous) => {
          const overlay = document.getElementById("setup-wizard");
          const steps = [...overlay.querySelectorAll(".wizard-step")];
          steps.forEach((step, index) =>
            step.classList.toggle("active", index === previous),
          );
          overlay.classList.remove("active");
        }, restore.previous);
      }
      assert.equal(
        report.screenshots.length,
        4,
        "screenshot set is incomplete",
      );
      return {
        screenshots: report.screenshots.map((shot) => ({
          name: shot.name,
          sha256: shot.sha256,
        })),
      };
    });
  });
});
