import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { githubCliEnvironment } = require('../../build-scripts/github-cli.js');
const { getReleaseUploadFiles } = require('../../build-scripts/release-upload-policy.js');

describe('GitHub CLI release transport', () => {
  it('uses stored authentication instead of token environment variables', () => {
    expect(
      githubCliEnvironment({ PATH: '/bin', GH_TOKEN: 'old', GITHUB_TOKEN: 'old-too' })
    ).toEqual({ PATH: '/bin' });
  });

  it('uploads primary artifacts, updater metadata, checksums, and signatures', () => {
    expect(
      getReleaseUploadFiles(
        [
          'ROSI.exe',
          'ROSI.exe.blockmap',
          'ROSI.exe.asc',
          'latest.yml',
          'SHA256SUMS-Windows.txt',
          'builder-debug.yml',
        ],
        '/release'
      )
    ).toEqual([
      path.join('/release', 'ROSI.exe'),
      path.join('/release', 'ROSI.exe.asc'),
      path.join('/release', 'ROSI.exe.blockmap'),
      path.join('/release', 'SHA256SUMS-Windows.txt'),
      path.join('/release', 'latest.yml'),
    ]);
  });

  it('disables electron-builder publishing in release commands', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    for (const [name, command] of Object.entries<string>(packageJson.scripts)) {
      if (name.startsWith('release:') && command.includes('electron-builder')) {
        expect(command).not.toContain('--publish always');
        expect(command).toContain('--publish never');
      }
    }
  });
});
