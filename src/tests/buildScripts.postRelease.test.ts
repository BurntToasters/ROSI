import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  cleanReleaseArtifacts,
  copyReleaseAssets,
  getAfterPackLocation,
  pathsEqual,
  run,
  verifyCopiedPath,
} = require('../../build-scripts/post-release-assets.js');

function makeTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('post-release-assets helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads AFTER_PACK_LOC from the environment', () => {
    expect(getAfterPackLocation({})).toBe('');
    expect(getAfterPackLocation({ AFTER_PACK_LOC: '  /tmp/rosi-mirror  ' })).toBe(
      '/tmp/rosi-mirror'
    );
  });

  it('cleans build-only release artifacts', () => {
    const releaseDir = makeTempDir('rosi-release-clean-');
    tempDirs.push(releaseDir);
    fs.mkdirSync(path.join(releaseDir, 'win-unpacked'));
    fs.writeFileSync(path.join(releaseDir, 'builder-debug.yml'), 'debug');

    cleanReleaseArtifacts(releaseDir);

    expect(fs.existsSync(path.join(releaseDir, 'win-unpacked'))).toBe(false);
    expect(fs.existsSync(path.join(releaseDir, 'builder-debug.yml'))).toBe(false);
  });

  it('mirrors cleaned release assets to AFTER_PACK_LOC', () => {
    const releaseDir = makeTempDir('rosi-release-src-');
    const destination = makeTempDir('rosi-release-dest-');
    tempDirs.push(releaseDir, destination);
    fs.writeFileSync(path.join(releaseDir, 'ROSI-Linux-amd64.deb'), 'deb');

    const result = run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
    });

    expect(result).toEqual({
      mirrored: true,
      destination: path.resolve(destination),
      copiedEntries: 1,
    });
    expect(fs.existsSync(path.join(destination, 'ROSI-Linux-amd64.deb'))).toBe(true);
    expect(fs.existsSync(path.join(releaseDir, 'ROSI-Linux-amd64.deb'))).toBe(true);
  });

  it('rejects mirroring into a subdirectory of the release folder', () => {
    const releaseDir = makeTempDir('rosi-release-nested-');
    tempDirs.push(releaseDir);
    fs.writeFileSync(path.join(releaseDir, 'artifact.txt'), 'data');

    expect(() => copyReleaseAssets(releaseDir, path.join(releaseDir, 'mirror'))).toThrow(
      'AFTER_PACK_LOC cannot be inside the release directory'
    );
  });

  it('compares Windows paths without case sensitivity', () => {
    expect(pathsEqual('C:/Users/Main/ROSI/release', 'c:/users/main/rosi/release', 'win32')).toBe(
      true
    );
  });

  it('fails when the release directory is missing', () => {
    const root = makeTempDir('rosi-release-missing-');
    tempDirs.push(root);
    expect(() => copyReleaseAssets(path.join(root, 'missing'), path.join(root, 'mirror'))).toThrow(
      'release directory does not exist'
    );
  });

  it('fails when the release directory is empty', () => {
    const releaseDir = makeTempDir('rosi-release-empty-');
    tempDirs.push(releaseDir);
    expect(() => copyReleaseAssets(releaseDir, path.join(releaseDir, '..', 'mirror'))).toThrow(
      'release directory is empty'
    );
  });

  it('rejects the release directory as its own mirror', () => {
    const releaseDir = makeTempDir('rosi-release-same-');
    tempDirs.push(releaseDir);
    fs.writeFileSync(path.join(releaseDir, 'artifact.txt'), 'data');
    expect(() => copyReleaseAssets(releaseDir, releaseDir)).toThrow(
      'AFTER_PACK_LOC cannot be the release directory'
    );
  });

  it('detects a mirrored file with the wrong size', () => {
    const root = makeTempDir('rosi-release-size-');
    tempDirs.push(root);
    const source = path.join(root, 'source.bin');
    const destination = path.join(root, 'destination.bin');
    fs.writeFileSync(source, 'expected');
    fs.writeFileSync(destination, 'bad');
    expect(() => verifyCopiedPath(source, destination)).toThrow('mirrored file size differs');
  });
});
