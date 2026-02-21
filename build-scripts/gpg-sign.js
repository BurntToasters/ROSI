const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// Environment variables are loaded via the `dotenv -e .env --` prefix in npm scripts.

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO_OWNER = 'BurntToasters';
const REPO_NAME = 'ROSI';
const GH_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.GH_REQUEST_TIMEOUT_MS || '30000', 10);
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

    if (GPG_PASSPHRASE) {
      gpgArgs.push('--pinentry-mode', 'loopback', '--passphrase', GPG_PASSPHRASE);
    }

    gpgArgs.push('--output', ascFile, filePath);

    execFileSync('gpg', gpgArgs, { stdio: 'pipe' });
    console.log('   ✓ Created ' + path.basename(ascFile));
    return ascFile;
  } catch (error) {
    console.error('   ✗ FAILED: ' + fileName + ':', error.message);
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
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: method,
      headers: {
        Authorization: 'Bearer ' + GH_TOKEN,
        'User-Agent': 'ROSI-Release-Script',
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('aborted', () => {
        const err = new Error('GitHub API response aborted for ' + method + ' ' + endpoint);
        err.code = 'ECONNRESET';
        reject(err);
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        try {
          if (statusCode >= 200 && statusCode < 300) {
            resolve(data ? JSON.parse(data) : {});
          } else {
            const json = data ? JSON.parse(data) : {};
            const err = new Error(
              'GitHub API error ' +
                statusCode +
                ' for ' +
                method +
                ' ' +
                endpoint +
                ': ' +
                (json.message || data || 'unknown error')
            );
            err.statusCode = statusCode;
            reject(err);
          }
        } catch (e) {
          const err = new Error(
            'GitHub API invalid JSON for ' + method + ' ' + endpoint + ': ' + e.message
          );
          err.statusCode = statusCode;
          reject(err);
        }
      });
    });

    req.setTimeout(GH_REQUEST_TIMEOUT_MS, () => {
      const err = new Error(
        'GitHub API timeout after ' + GH_REQUEST_TIMEOUT_MS + 'ms for ' + method + ' ' + endpoint
      );
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
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

function uploadToRelease(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    const contentType =
      fileName.endsWith('.asc') || fileName.endsWith('.txt')
        ? 'text/plain'
        : 'application/octet-stream';

    const url = new URL(uploadUrl.replace('{?name,label}', ''));
    url.searchParams.set('name', fileName);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + GH_TOKEN,
        'User-Agent': 'ROSI-Release-Script',
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': contentType,
        'Content-Length': fileContent.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else if (res.statusCode === 422) {
          console.log('   ⚠ ' + fileName + ' already exists, skipping');
          resolve(null);
        } else {
          reject(new Error('Upload failed ' + res.statusCode + ': ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(fileContent);
    req.end();
  });
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
      console.log('   Could not fetch release by tag: ' + error.message);
      console.log('   Searching draft releases...');
    }

    try {
      const releases = await githubRequestWithRetry(
        'GET',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=100'
      );

      if (!Array.isArray(releases)) {
        throw new Error('Unexpected releases payload type');
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
    } catch (listError) {
      console.log('   Could not list releases: ' + listError.message);
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

  console.log('\nUploading to GitHub release...');

  for (const filePath of filesToUpload) {
    if (!filePath) continue;

    const fileName = path.basename(filePath);
    process.stdout.write('   Uploading: ' + fileName + '... ');

    try {
      const result = await uploadToRelease(release.upload_url, filePath);
      if (result) {
        console.log('✓');
      }
    } catch (error) {
      console.log('✗ ' + error.message);
    }
  }
}

async function main() {
  const platform = getPlatformName(TARGET_ARCH);
  let uploadFailed = false;

  console.log('═'.repeat(60));
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

  if (!GH_TOKEN) {
    console.warn('⚠ WARN: GH_TOKEN not set - signatures will not be uploaded to GitHub');
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

  const filesToUpload = [...signatureFiles, checksumFile];

  console.log('\nFiles queued for upload:');
  filesToUpload.forEach((f) => console.log('   • ' + path.basename(f)));

  if (GH_TOKEN) {
    try {
      const release = await getOrCreateRelease();
      await uploadSignatures(release, filesToUpload);
    } catch (error) {
      console.error('\n✗ ERROR: GitHub upload failed:', error.message);
      uploadFailed = true;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✓ COMPLETE');
  console.log('═'.repeat(60));
  console.log('\nGenerated files in dist/:');

  const generatedFiles = fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.endsWith('.asc') || f.startsWith('SHA256SUMS'));
  generatedFiles.forEach((f) => console.log('   • ' + f));

  if (!GH_TOKEN) {
    console.log('\n💡 TIP: To auto-upload, add GH_TOKEN to your .env file');
  }

  if (uploadFailed) {
    process.exitCode = 1;
  }
}

main().catch(console.error);
