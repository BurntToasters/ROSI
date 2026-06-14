import { describe, expect, it } from 'vitest';

const {
  parseArgs,
  selectBranchesToDelete,
  stripRemotePrefix,
} = require('../../build-scripts/git-prune-local-branches.js');

describe('git-prune-local-branches helpers', () => {
  it('parseArgs reads remote, dry-run, and force flags', () => {
    expect(parseArgs(['node', 'script.js'])).toEqual({
      remote: 'origin',
      dryRun: false,
      force: false,
    });
    expect(parseArgs(['node', 'script.js', '--remote', 'upstream', '-n', '--force'])).toEqual({
      remote: 'upstream',
      dryRun: true,
      force: true,
    });
  });

  it('stripRemotePrefix removes the remote prefix', () => {
    expect(stripRemotePrefix('origin/main', 'origin')).toBe('main');
    expect(stripRemotePrefix('origin/HEAD', 'origin')).toBeNull();
    expect(stripRemotePrefix('main', 'origin')).toBeNull();
  });

  it('selectBranchesToDelete keeps current and remote-tracking branches', () => {
    const result = selectBranchesToDelete(
      ['main', 'feature/a', 'feature/b'],
      ['main', 'feature/a'],
      'main'
    );
    expect(result).toEqual(['feature/b']);
  });
});
