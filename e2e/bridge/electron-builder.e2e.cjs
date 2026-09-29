/**
 * electron-builder config for bridge E2E builds: the normal ROSI 4 config,
 * but with the ROSI 4 update feed on the local test server, output in a
 * scratch folder, and ad-hoc macOS signing. Never used for releases.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const output = process.env.ROSI_BRIDGE_E2E_OUT;
if (!output) throw new Error('ROSI_BRIDGE_E2E_OUT is required.');
const feed = process.env.ROSI_BRIDGE_E2E_V4_FEED;
if (!feed) throw new Error('ROSI_BRIDGE_E2E_V4_FEED is required.');

const base =
  process.platform === 'win32'
    ? require(path.join(ROOT, 'build-scripts', 'electron-builder.windows.cjs'))
    : { extends: path.join(ROOT, 'electron-builder.base.yml') };

module.exports = {
  ...base,
  directories: { output },
  // An array replaces the base GitHub publish entry instead of merging into it.
  publish: [{ provider: 'generic', url: feed }],
  ...(process.platform === 'darwin'
    ? { mac: { identity: '-', target: 'dir', hardenedRuntime: false, notarize: false } }
    : {}),
};
