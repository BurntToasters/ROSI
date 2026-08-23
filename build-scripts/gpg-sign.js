const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getReleaseUploadFiles } = require('./release-upload-policy');
const { assertGitHubCliAuthenticated, githubApi, uploadReleaseAsset } = require('./github-cli');

// Environment variables are loaded via the `dotenv -e .env --` prefix in npm scripts.

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const REPO_OWNER = 'BurntToasters';
const REPO_NAME = 'ROSI';
const GH_REQUEST_RETRIES = Number.parseInt(process.env.GH_REQUEST_RETRIES || '3', 10);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || '1500',
  10
);

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;

const args = process.argv.slice(2);
const archArgIndex = args.findIndex((arg) => arg === '--arch');
const TARGET_ARCH = archArgIndex !== -1 && args[archArgIndex + 1] ? args[archArgIndex + 1] : null;

const SIGNABLE_EXTENSIONS = [
  '.dmg',
  '.zip',
  '.exe',
  '.msi',
  '.appimage',
  '.deb',
  '.rpm',
  '.appx',
  '.msix',
];

const ARCH_PATTERNS = {
  x64: ['-x86_64', '-amd64', '-x64', '_x64', '_amd64'],
  arm64: ['-arm64', '-aarch64', '_arm64', '_aarch64'],
};

function getPlatformName(arch) {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return arch ? 'Linux-' + arch : 'Linux';
    default:
      return process.platform;
  }
}

function getFileArch(filename) {
  const lowerFile = filename.toLowerCase();
  for (const [arch, patterns] of Object.entries(ARCH_PATTERNS)) {
    if (patterns.some((pattern) => lowerFile.includes(pattern))) {
      return arch;
    }
  }
  return null;
}

function getFilesToSign() {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.error('ERROR: Release directory not found:', RELEASE_DIR);
    console.error('   Run a build command first, e.g.: npm run release:win');
    process.exit(1);
  }

  const files = fs.readdirSync(RELEASE_DIR);
  return files.filter((file) => {
    const fullPath = path.join(RELEASE_DIR, file);

    if (!fs.statSync(fullPath).isFile()) return false;

    const lowerFile = file.toLowerCase();
    const hasSignableExt = SIGNABLE_EXTENSIONS.some((ext) => lowerFile.endsWith(ext));

    if (!hasSignableExt) return false;
    if (TARGET_ARCH) {
      const fileArch = getFileArch(file);
      return fileArch === TARGET_ARCH || fileArch === null;
    }

    return true;
  });
}

function generateChecksum(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function signFile(filePath) {
  const fileName = path.basename(filePath);
  const ascFile = filePath + '.asc';

  console.log('Signing: ' + fileName);

  try {
    if (fs.existsSync(ascFile)) {
      fs.unlinkSync(ascFile);
    }

    const gpgArgs = ['--batch', '--yes', '--armor', '--detach-sign'];

    if (GPG_KEY_ID) {
      gpgArgs.push('--local-user', GPG_KEY_ID);
    }

    // Pass the passphrase over stdin (--passphrase-fd 0) instead of argv so it
    // never appears in the process table or in any error.message (which, for
    // execFileSync, embeds the full argv).
    const execOptions = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (GPG_PASSPHRASE) {
      gpgArgs.push('--pinentry-mode', 'loopback', '--passphrase-fd', '0');
      execOptions.input = GPG_PASSPHRASE + '\n';
    }

    gpgArgs.push('--output', ascFile, filePath);

    execFileSync('gpg', gpgArgs, execOptions);
    console.log('   ✓ Created ' + path.basename(ascFile));
    return ascFile;
  } catch (error) {
    // Do not log error.message: it can contain the full gpg argv. Surface only
    // the exit status so a secret on the command line can never reach the log.
    const status = typeof error.status === 'number' ? ` (exit code ${error.status})` : '';
    console.error('   ✗ FAILED to sign ' + fileName + status);
    return null;
  }
}

function generateChecksumFile(files, platform) {
  const checksumFile = path.join(RELEASE_DIR, 'SHA256SUMS-' + platform + '.txt');
  const checksums = [];

  console.log('\nGenerating SHA256 checksums for ' + platform + '...');

  for (const file of files) {
    const filePath = path.join(RELEASE_DIR, file);
    const checksum = generateChecksum(filePath);
    checksums.push(checksum + '  ' + file);
    console.log('   ' + file);
    console.log('   → ' + checksum);
  }

  fs.writeFileSync(checksumFile, checksums.join('\n') + '\n');
  console.log('\n✓ Checksums written to: SHA256SUMS-' + platform + '.txt');

  return checksumFile;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGithubError(error) {
  if (!error) return false;

  const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EPIPE',
  ]);

  if (typeof error.statusCode === 'number' && retryableStatusCodes.has(error.statusCode)) {
    return true;
  }

  if (typeof error.code === 'string' && retryableCodes.has(error.code)) {
    return true;
  }

  const msg = String(error.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('aborted');
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      const canRetry = attempt < attempts && isRetryableGithubError(error);
      if (!canRetry) {
        throw error;
      }

      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        '   Retry ' +
          attempt +
          '/' +
          (attempts - 1) +
          ' in ' +
          backoffMs +
          'ms (' +
          error.message +
          ')'
      );
      await sleep(backoffMs);
    }
  }
}

async function getOrCreateRelease() {
  console.log('\nLooking for release: ' + TAG_NAME);

  try {
    const release = await githubRequestWithRetry(
      'GET',
      '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/tags/' + TAG_NAME
    );
    console.log('   Found published release: ' + (release.name || TAG_NAME));
    return release;
  } catch (error) {
    if (error.statusCode === 404) {
      console.log('   Tag not published, searching draft releases...');
    } else {
      throw error;
    }

    const releases = await githubRequestWithRetry(
      'GET',
      '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=100'
    );

    if (!Array.isArray(releases)) {
      throw new Error('Unexpected releases payload type', { cause: error });
    }

    const matchingReleases = releases.filter(function (r) {
      return r.tag_name === TAG_NAME;
    });

    if (matchingReleases.length > 0) {
      matchingReleases.sort(function (a, b) {
        return b.assets.length - a.assets.length;
      });
      const release = matchingReleases[0];
      console.log(
        '   Found draft release: ' + release.name + ' (' + release.assets.length + ' assets)'
      );
      return release;
    }

    console.log('   Creating draft release for ' + TAG_NAME + '...');
    try {
      const release = await githubRequestWithRetry(
        'POST',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases',
        {
          tag_name: TAG_NAME,
          name: 'ROSI ' + VERSION,
          draft: true,
          prerelease: VERSION.includes('beta') || VERSION.includes('alpha'),
        }
      );
      console.log('   ✓ Created draft release: ' + release.name);
      return release;
    } catch (createError) {
      if (createError.statusCode === 422) {
        console.log('   Draft may already exist. Retrying release list...');
        await sleep(2000);

        const releases = await githubRequestWithRetry(
          'GET',
          '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=100'
        );

        if (Array.isArray(releases)) {
          const release = releases.find((r) => r.tag_name === TAG_NAME);
          if (release) {
            console.log('   Found release after retry: ' + (release.name || TAG_NAME));
            return release;
          }
        }
      }

      console.error('   ✗ FAILED: Could not create release:', createError.message);
      throw createError;
    }
  }
}

async function uploadSignatures(release, filesToUpload) {
  if (!release || !release.upload_url) {
    throw new Error('No release found for tag ' + TAG_NAME + ', cannot upload signatures');
  }
  if (!release.draft && process.env.ALLOW_ASSET_REPLACE !== 'true') {
    throw new Error(
      'Refusing to upload assets to published release ' +
        TAG_NAME +
        '. Set ALLOW_ASSET_REPLACE=true to override.'
    );
  }

  console.log('\nUploading to GitHub release...');
  const uploadFailures = [];

  for (const filePath of filesToUpload) {
    if (!filePath) continue;

    const fileName = path.basename(filePath);
    process.stdout.write('   Uploading: ' + fileName + '... ');

    try {
      uploadReleaseAsset(REPO_OWNER + '/' + REPO_NAME, release.tag_name || TAG_NAME, filePath);
      console.log('✓');
    } catch (error) {
      console.log('✗ ' + error.message);
      uploadFailures.push(fileName + ': ' + error.message);
    }
  }

  if (uploadFailures.length > 0) {
    throw new Error(
      'One or more uploads failed:\n' + uploadFailures.map((item) => '  - ' + item).join('\n')
    );
  }
}

async function main() {
  const platform = getPlatformName(TARGET_ARCH);
  let uploadFailed = false;

  console.log('═'.repeat(60));
  assertGitHubCliAuthenticated();
  console.log('GPG Sign & Upload - ROSI ' + VERSION);
  console.log('Platform: ' + platform);
  if (TARGET_ARCH) {
    console.log('Target Arch: ' + TARGET_ARCH + ' (filtering files)');
  }
  console.log('═'.repeat(60));

  try {
    execSync('gpg --version', { stdio: 'pipe' });
  } catch (e) {
    console.error('\n✗ ERROR: GPG not found!');
    console.error('   Install with:');
    console.error('   - macOS:   brew install gnupg');
    console.error('   - Windows: https://gpg4win.org/');
    console.error('   - Linux:   sudo apt install gnupg');
    process.exit(1);
  }

  if (!GPG_KEY_ID) {
    console.warn('\n⚠ WARN: GPG_KEY_ID not set - will use default key');
  } else {
    console.log('\nGPG Key: ' + GPG_KEY_ID);
  }

  const files = getFilesToSign();

  if (files.length === 0) {
    console.log('\n✗ ERROR: No release artifacts found to sign.');
    console.log('   Run a build command first, e.g.: npm run release:win');
    process.exit(1);
  }

  console.log('\nFound ' + files.length + ' artifacts to sign:');
  files.forEach((f) => console.log('   • ' + f));

  const checksumFile = generateChecksumFile(files, platform);
  console.log('\nSigning artifacts...\n');

  const signatureFiles = [];

  for (const file of files) {
    const filePath = path.join(RELEASE_DIR, file);
    const sigFile = signFile(filePath);
    if (sigFile) signatureFiles.push(sigFile);
  }

  const checksumSig = signFile(checksumFile);
  if (checksumSig) signatureFiles.push(checksumSig);

  const expectedSignatureCount = files.length + 1;
  if (signatureFiles.length !== expectedSignatureCount) {
    throw new Error(
      `Signing failed for one or more artifacts. Expected ${expectedSignatureCount} signatures, generated ${signatureFiles.length}.`
    );
  }

  const releaseEntries = fs
    .readdirSync(RELEASE_DIR)
    .filter((name) => fs.statSync(path.join(RELEASE_DIR, name)).isFile());
  const filesToUpload = getReleaseUploadFiles(releaseEntries, RELEASE_DIR);

  console.log('\nFiles queued for upload:');
  filesToUpload.forEach((f) => console.log('   • ' + path.basename(f)));

  try {
    const release = await getOrCreateRelease();
    await uploadSignatures(release, filesToUpload);
  } catch (error) {
    console.error('\n✗ ERROR: GitHub upload failed:', error.message);
    uploadFailed = true;
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✓ COMPLETE');
  console.log('═'.repeat(60));
  console.log('\nGenerated files in release/:');

  const generatedFiles = fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.endsWith('.asc') || f.startsWith('SHA256SUMS'));
  generatedFiles.forEach((f) => console.log('   • ' + f));

  if (uploadFailed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
