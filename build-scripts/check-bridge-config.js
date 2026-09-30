#!/usr/bin/env node
/**
 * Refuse to build ROSI 4 with a non-production bridge config: E2E settings,
 * a test feed, or a signing key other than ROSI 5's updater key.
 * Runs in prebuild:base, before electron-builder packages dist/.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Key id of plugins.updater.pubkey in ROSI 5's src-tauri/tauri.conf.json.
const ROSI5_UPDATER_KEY_ID = '7434C99B00DB46DA';
const EXPECTED = {
  feedBase: 'https://github.com/BurntToasters/ROSI/releases/latest/download/',
  allowedDownloadPrefixes: ['https://github.com/BurntToasters/ROSI/releases/download/'],
  downloadPage: 'https://github.com/BurntToasters/ROSI/releases/latest',
  macBundleId: 'run.rosie.rosi',
  macTeamId: 'FYJZP8B2KG',
};

function keyId(publicKey) {
  const lines = Buffer.from(publicKey, 'base64').toString('utf8').split('\n');
  const raw = Buffer.from(lines[1] || '', 'base64');
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

function check(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  if ('e2e' in config) problems.push('contains an e2e block');
  for (const [key, want] of Object.entries(EXPECTED)) {
    if (JSON.stringify(config[key]) !== JSON.stringify(want)) {
      problems.push(`${key} is ${JSON.stringify(config[key])}, expected ${JSON.stringify(want)}`);
    }
  }
  const id = typeof config.publicKey === 'string' ? keyId(config.publicKey) : '';
  if (id !== ROSI5_UPDATER_KEY_ID) {
    problems.push(`publicKey id is ${id || 'unreadable'}, expected ${ROSI5_UPDATER_KEY_ID}`);
  }
  return problems;
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.length === 0) files.push(path.join(ROOT, 'src', 'main', 'v5bridge', 'config.json'));
  let failed = false;
  for (const file of files) {
    const problems = check(file);
    if (problems.length > 0) {
      failed = true;
      console.error(`[check-bridge-config] ${path.relative(ROOT, file)}:`);
      for (const problem of problems) console.error(`  - ${problem}`);
    } else {
      console.log(`[check-bridge-config] ${path.relative(ROOT, file)}: production config ok`);
    }
  }
  if (failed) process.exit(1);
}

module.exports = { check, keyId };
