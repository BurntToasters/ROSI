const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const gitDir = path.join(repoRoot, '.git');
const hooksDir = path.join(repoRoot, '.husky');

if (!fs.existsSync(gitDir) || !fs.existsSync(hooksDir)) {
  process.exit(0);
}

try {
  execSync('git config core.hooksPath .husky', {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  console.log('Configured Git hooks path: .husky');
} catch (error) {
  console.log(`Skipping hook setup: ${error.message}`);
}
