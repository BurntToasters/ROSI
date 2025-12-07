const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

try {
  require('dotenv').config();
} catch (e) {
  console.log('Note: dotenv not loaded, using system environment variables');
}

const RELEASE_DIR = path.join(__dirname, '..', 'dist');
const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO_OWNER = 'BurntToasters';
const REPO_NAME = 'ROSI';

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;

const SIGNABLE_EXTENSIONS = [
  '.dmg',
  '.zip',
  '.exe',
  '.msi',
  '.appimage',
  '.deb',
  '.rpm',
  '.appx',
  '.msix'
];

function getPlatformName() {
  switch (process.platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return process.platform;
  }
}

function getFilesToSign() {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.error('ERROR: Release directory not found:', RELEASE_DIR);
    console.error('   Run a build command first, e.g.: npm run release:win');
    process.exit(1);
  }

  const files = fs.readdirSync(RELEASE_DIR);
  return files.filter(file => {
    const fullPath = path.join(RELEASE_DIR, file);

    if (!fs.statSync(fullPath).isFile()) return false;

    const lowerFile = file.toLowerCase();
    return SIGNABLE_EXTENSIONS.some(ext => lowerFile.endsWith(ext));
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

    let gpgCmd = 'gpg --batch --yes --armor --detach-sign';
    
    if (GPG_KEY_ID) {
      gpgCmd += ' --local-user "' + GPG_KEY_ID + '"';
    }
    
    if (GPG_PASSPHRASE) {
      gpgCmd += ' --pinentry-mode loopback --passphrase "' + GPG_PASSPHRASE + '"';
    }
    
    gpgCmd += ' --output "' + ascFile + '" "' + filePath + '"';
    
    execSync(gpgCmd, { stdio: 'pipe' });
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

function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'User-Agent': 'ROSI-Release-Script',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error('GitHub API error ' + res.statusCode + ': ' + (json.message || data)));
          }
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function uploadToRelease(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    const contentType = fileName.endsWith('.asc') || fileName.endsWith('.txt') 
      ? 'text/plain' 
      : 'application/octet-stream';

    const url = new URL(uploadUrl.replace('{?name,label}', ''));
    url.searchParams.set('name', fileName);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'User-Agent': 'ROSI-Release-Script',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': contentType,
        'Content-Length': fileContent.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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
    const release = await githubRequest(
      'GET', 
      '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/tags/' + TAG_NAME
    );
    console.log('   Found published release: ' + (release.name || TAG_NAME));
    return release;
  } catch (error) {
    console.log('   Tag not published, searching draft releases...');

    try {
      const releases = await githubRequest(
        'GET',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=20'
      );
      
      const matchingReleases = releases.filter(function(r) {
        return r.tag_name === TAG_NAME;
      });
      
      if (matchingReleases.length > 0) {
        matchingReleases.sort(function(a, b) {
          return b.assets.length - a.assets.length;
        });
        const release = matchingReleases[0];
        console.log('   Found draft release: ' + release.name + ' (' + release.assets.length + ' assets)');
        return release;
      }
    } catch (listError) {
      console.log('   Could not list releases: ' + listError.message);
    }

    console.log('   Creating draft release for ' + TAG_NAME + '...');
    try {
      const release = await githubRequest(
        'POST',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases',
        {
          tag_name: TAG_NAME,
          name: 'ROSI ' + VERSION,
          draft: true,
          prerelease: VERSION.includes('beta') || VERSION.includes('alpha')
        }
      );
      console.log('   ✓ Created draft release: ' + release.name);
      return release;
    } catch (createError) {
      console.error('   ✗ FAILED: Could not create release:', createError.message);
      return null;
    }
  }
}

async function uploadSignatures(release, filesToUpload) {
  if (!release || !release.upload_url) {
    console.log('\n⚠ No release found, skipping upload');
    return;
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
  const platform = getPlatformName();
  
  console.log('═'.repeat(60));
  console.log('GPG Sign & Upload - ROSI ' + VERSION);
  console.log('Platform: ' + platform);
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
  files.forEach(f => console.log('   • ' + f));

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

  if (GH_TOKEN) {
    try {
      const release = await getOrCreateRelease();
      await uploadSignatures(release, filesToUpload);
    } catch (error) {
      console.error('\n✗ ERROR: GitHub upload failed:', error.message);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✓ COMPLETE');
  console.log('═'.repeat(60));
  console.log('\nGenerated files in dist/:');
  
  const generatedFiles = fs.readdirSync(RELEASE_DIR)
    .filter(f => f.endsWith('.asc') || f.startsWith('SHA256SUMS'));
  generatedFiles.forEach(f => console.log('   • ' + f));
  
  if (!GH_TOKEN) {
    console.log('\n💡 TIP: To auto-upload, add GH_TOKEN to your .env file');
  }
}

main().catch(console.error);
