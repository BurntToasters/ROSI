const fs = require('fs');
const path = require('path');

const defaultRepoRoot = path.join(__dirname, '..');

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function updateSplash({ repoRoot = defaultRepoRoot, version, fsImpl = fs, logger = console }) {
  const splashPath = path.join(repoRoot, 'src', 'renderer', 'splash.html');
  if (!fsImpl.existsSync(splashPath)) {
    logger.warn(`⚠ splash.html not found at ${splashPath}`);
    return;
  }
  const splashHtml = fsImpl.readFileSync(splashPath, 'utf8');
  const splashRegex = /(<div class="version" id="version-display">)v[^<]*(<\/div>)/;
  if (!splashRegex.test(splashHtml)) {
    logger.warn('⚠ Could not locate version-display element in splash.html');
    return;
  }
  const updatedSplash = splashHtml.replace(splashRegex, `$1v${version}$2`);
  if (updatedSplash === splashHtml) {
    logger.log('✓ Splash screen version already up to date');
    return;
  }
  fsImpl.writeFileSync(splashPath, updatedSplash, 'utf8');
  logger.log(`✓ Updated splash screen version to v${version}`);
}

function updateMetainfo({
  repoRoot = defaultRepoRoot,
  now = new Date(),
  fsImpl = fs,
  logger = console,
} = {}) {
  const pkgPath = path.join(repoRoot, 'package.json');
  const xmlPath = path.join(repoRoot, 'com.burnttoasters.rosi.metainfo.xml');

  if (!fsImpl.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }

  if (!fsImpl.existsSync(xmlPath)) {
    throw new Error(`AppStream metadata not found at ${xmlPath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(fsImpl.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    logger.error('✗ Failed to parse package.json');
    throw error;
  }

  const version = pkg.version;
  if (!version) {
    throw new Error('package.json has no version field');
  }

  const dateStr = formatDate(now);
  const xml = fsImpl.readFileSync(xmlPath, 'utf8');

  const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
  if (!releasesLineMatch) {
    throw new Error('Could not find <releases> block in AppStream metadata');
  }

  const baseIndent = releasesLineMatch[1] || '';
  const releaseIndent = `${baseIndent}  `;
  const newReleaseTag = `${releaseIndent}<release version="${version}" date="${dateStr}"/>`;

  const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
  const releasesSectionMatch = xml.match(releasesSectionRegex);
  if (!releasesSectionMatch) {
    throw new Error('Could not locate releases section');
  }

  const releasesSection = releasesSectionMatch[0];
  const releaseSelfClosingRegex = /<release\b[^>]*\/>/;
  const currentReleaseMatch =
    releasesSection.match(releaseSelfClosingRegex) || releasesSection.match(/<release\b[^>]*>/);

  let updatedSection = releasesSection;
  if (currentReleaseMatch) {
    const currentReleaseTag = currentReleaseMatch[0];
    const currentVersionMatch = currentReleaseTag.match(/version="([^"]+)"/);
    const currentVersion = currentVersionMatch ? currentVersionMatch[1] : null;

    if (currentVersion === version) {
      updatedSection = releasesSection.replace(currentReleaseTag, newReleaseTag.trim());
    } else {
      // Prepend the new release so version history is preserved (AppStream /
      // Flathub expect a newest-first history).
      updatedSection = releasesSection.replace(/<releases>/, `<releases>\n${newReleaseTag}`);
    }
  }

  if (updatedSection === releasesSection) {
    logger.log('✓ AppStream metadata already up to date');
    updateSplash({ repoRoot, version, fsImpl, logger });
    return { updated: false, version, date: dateStr };
  }

  const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
  fsImpl.writeFileSync(xmlPath, updatedXml, 'utf8');

  logger.log(`✓ Updated AppStream release to ${version} (${dateStr})`);
  updateSplash({ repoRoot, version, fsImpl, logger });
  return { updated: true, version, date: dateStr };
}

function run() {
  try {
    updateMetainfo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  formatDate,
  updateMetainfo,
  updateSplash,
  run,
};
