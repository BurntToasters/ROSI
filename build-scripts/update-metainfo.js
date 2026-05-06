const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const xmlPath = path.join(repoRoot, 'com.burnttoasters.rosi.metainfo.xml');

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

if (!fs.existsSync(pkgPath)) {
  console.error(`✗ package.json not found at ${pkgPath}`);
  process.exit(1);
}

if (!fs.existsSync(xmlPath)) {
  console.error(`✗ AppStream metadata not found at ${xmlPath}`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (error) {
  console.error('✗ Failed to parse package.json');
  throw error;
}

const version = pkg.version;
if (!version) {
  console.error('✗ package.json has no version field');
  process.exit(1);
}

const dateStr = formatDate(new Date());
const xml = fs.readFileSync(xmlPath, 'utf8');

const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
if (!releasesLineMatch) {
  console.error('✗ Could not find <releases> block in AppStream metadata');
  process.exit(1);
}

const baseIndent = releasesLineMatch[1] || '';
const releaseIndent = `${baseIndent}  `;
const newReleaseTag = `${releaseIndent}<release version="${version}" date="${dateStr}"/>`;

const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
const releasesSectionMatch = xml.match(releasesSectionRegex);
if (!releasesSectionMatch) {
  console.error('✗ Could not locate releases section');
  process.exit(1);
}

const releaseSelfClosingRegex = /<release\b[^>]*\/>/;
const releasePairedRegex = /<release\b[^>]*>[\s\S]*?<\/release>/;

const currentReleaseMatch =
  releasesSectionMatch[0].match(releaseSelfClosingRegex) ||
  releasesSectionMatch[0].match(/<release\b[^>]*>/);

if (currentReleaseMatch) {
  const currentReleaseTag = currentReleaseMatch[0];
  const currentVersionMatch = currentReleaseTag.match(/version="([^"]+)"/);
  const currentDateMatch = currentReleaseTag.match(/date="([^"]+)"/);
  const currentVersion = currentVersionMatch ? currentVersionMatch[1] : null;
  const currentDate = currentDateMatch ? currentDateMatch[1] : null;

  if (currentVersion === version && currentDate === dateStr) {
    console.log('✓ AppStream metadata already up to date');
    updateSplash();
    process.exit(0);
  }
}

let updatedSection = releasesSectionMatch[0];
if (releaseSelfClosingRegex.test(updatedSection)) {
  updatedSection = updatedSection.replace(releaseSelfClosingRegex, newReleaseTag);
} else if (releasePairedRegex.test(updatedSection)) {
  updatedSection = updatedSection.replace(releasePairedRegex, newReleaseTag);
} else {
  updatedSection = updatedSection.replace(
    /<releases>\s*/,
    `<releases>\n${newReleaseTag}\n${baseIndent}`
  );
}

if (updatedSection === releasesSectionMatch[0]) {
  console.log('✓ AppStream metadata already up to date');
  updateSplash();
  process.exit(0);
}

const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
fs.writeFileSync(xmlPath, updatedXml, 'utf8');

console.log(`✓ Updated AppStream release to ${version} (${dateStr})`);

updateSplash();

function updateSplash() {
  const splashPath = path.join(repoRoot, 'src', 'renderer', 'splash.html');
  if (!fs.existsSync(splashPath)) {
    console.warn(`⚠ splash.html not found at ${splashPath}`);
    return;
  }
  const splashHtml = fs.readFileSync(splashPath, 'utf8');
  const splashRegex = /(<div class="version" id="version-display">)v[^<]*(<\/div>)/;
  if (!splashRegex.test(splashHtml)) {
    console.warn('⚠ Could not locate version-display element in splash.html');
    return;
  }
  const updatedSplash = splashHtml.replace(splashRegex, `$1v${version}$2`);
  if (updatedSplash === splashHtml) {
    console.log('✓ Splash screen version already up to date');
    return;
  }
  fs.writeFileSync(splashPath, updatedSplash, 'utf8');
  console.log(`✓ Updated splash screen version to v${version}`);
}
