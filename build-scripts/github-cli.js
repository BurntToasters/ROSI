'use strict';

const { spawnSync } = require('node:child_process');

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || '').match(/\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i);
  return match ? Number(match[1] || match[2]) : undefined;
}

function runGitHub(args, { input } = {}) {
  const result = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    encoding: 'utf8',
    env: githubCliEnvironment(),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        'GitHub CLI is required. Install gh and run `gh auth login` on this release VM.'
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(
      `gh ${args.join(' ')} failed with status ${result.status}${detail ? `:\n${detail}` : ''}`
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result;
}

function githubApi(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  if (body !== undefined) args.push('--input', '-');
  const result = runGitHub(args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : {};
}

function assertGitHubCliAuthenticated() {
  runGitHub(['auth', 'status', '--hostname', 'github.com']);
}

function uploadReleaseAsset(repository, tag, filePath) {
  runGitHub(['release', 'upload', tag, '--repo', repository, '--clobber', filePath]);
}

module.exports = {
  assertGitHubCliAuthenticated,
  githubApi,
  githubCliEnvironment,
  githubStatusCode,
  runGitHub,
  uploadReleaseAsset,
};
