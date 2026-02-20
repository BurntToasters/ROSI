const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const scriptVersion = '1.0.0';
const testVersion = require('../package.json').version;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const results = {
  unit: { status: 'pending', passed: 0, failed: 0 },
  lint: { status: 'pending' },
  format: { status: 'pending' },
  typecheck: { status: 'pending' },
  syntax: { status: 'pending', checked: 0, failed: 0, failures: [] },
  config: { status: 'pending', checks: 0, failed: 0, failures: [] },
};

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function printBanner(title) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║ ${title.padEnd(36, ' ')} ║
╚══════════════════════════════════════╝
ROSI Version: ${testVersion}
Script Version: ${scriptVersion}
${colors.reset}`);
}

function parseUnitTests(output) {
  const clean = stripAnsi(output);
  const testsLine = clean.split(/\r?\n/).find((line) => line.trim().startsWith('Tests'));
  if (!testsLine) return;
  const passedMatch = testsLine.match(/(\d+)\s+passed/);
  const failedMatch = testsLine.match(/(\d+)\s+failed/);
  results.unit.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  results.unit.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
}

function runCommand(name, command, parser) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    if (parser) parser(output);
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return { ok: true, output };
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    if (parser) parser(output);
    const details = stripAnsi(output).trim().split(/\r?\n/).slice(-12).join('\n');
    if (details) console.log(`${colors.yellow}${details}${colors.reset}`);
    console.log(`${colors.red}✗ ${name} failed${colors.reset}\n`);
    return { ok: false, output };
  }
}

function collectScriptFiles(rootDir) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist']);

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        if (entry.name !== '.github') continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && /\.(cjs|mjs|js|ts)$/.test(entry.name)) {
        out.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return out;
}

function runSyntaxChecks() {
  console.log(`${colors.blue}${colors.bold}Running syntax checks...${colors.reset}`);
  const files = [
    ...collectScriptFiles(path.join(process.cwd(), 'src')),
    ...collectScriptFiles(path.join(process.cwd(), 'build-scripts')),
  ];
  const uniqueFiles = Array.from(new Set(files)).sort();

  for (const filePath of uniqueFiles) {
    results.syntax.checked += 1;
    try {
      if (/\.ts$/.test(filePath)) {
        // TypeScript files are validated by the tsc compile step, skip node --check
        continue;
      }
      execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    } catch (error) {
      results.syntax.failed += 1;
      const relativePath = path.relative(process.cwd(), filePath);
      const output = stripAnsi(`${error.stdout || ''}${error.stderr || ''}`).trim();
      results.syntax.failures.push(`${relativePath}${output ? `\n${output}` : ''}`);
    }
  }

  results.syntax.status = results.syntax.failed === 0 ? 'passed' : 'failed';
  if (results.syntax.status === 'passed') {
    console.log(`${colors.green}✓ syntax passed${colors.reset}\n`);
  } else {
    console.log(`${colors.red}✗ syntax failed${colors.reset}\n`);
  }
}

function assertConfig(check, message) {
  results.config.checks += 1;
  if (!check) {
    results.config.failed += 1;
    results.config.failures.push(message);
  }
}

function loadYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

function runConfigChecks() {
  console.log(`${colors.blue}${colors.bold}Running config checks...${colors.reset}`);

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assertConfig(Boolean(pkg.scripts && pkg.scripts.test), 'package.json: missing scripts.test');
    assertConfig(
      Boolean(pkg.scripts && pkg.scripts['test:all']),
      'package.json: missing scripts.test:all'
    );
    assertConfig(
      pkg.scripts['test:all'] === 'node build-scripts/test-all.js',
      'package.json: scripts.test:all must run build-scripts/test-all.js'
    );
    assertConfig(pkg.main === 'dist/main/main.js', 'package.json: main must be dist/main/main.js');

    const baseConfigPath = path.join(process.cwd(), 'electron-builder.base.yml');
    const githubConfigPath = path.join(process.cwd(), 'electron-builder.github.yml');
    const msstoreConfigPath = path.join(process.cwd(), 'electron-builder.msstore.yml');

    const baseConfig = loadYaml(baseConfigPath);
    const githubConfig = loadYaml(githubConfigPath);
    const msstoreConfig = loadYaml(msstoreConfigPath);

    assertConfig(Boolean(baseConfig.appId), 'electron-builder.base.yml: missing appId');
    assertConfig(
      Boolean(baseConfig.win && baseConfig.mac && baseConfig.linux),
      'electron-builder.base.yml: missing win/mac/linux sections'
    );
    assertConfig(
      Array.isArray(baseConfig.win?.extraResources),
      'electron-builder.base.yml: win.extraResources missing for yt-dlp binaries'
    );
    assertConfig(
      Array.isArray(baseConfig.mac?.extraResources),
      'electron-builder.base.yml: mac.extraResources missing for yt-dlp_macos'
    );
    assertConfig(
      Array.isArray(baseConfig.linux?.extraResources),
      'electron-builder.base.yml: linux.extraResources missing for yt-dlp binaries'
    );
    assertConfig(
      Boolean(githubConfig.publish),
      'electron-builder.github.yml: missing publish config'
    );
    assertConfig(
      msstoreConfig.win?.target === 'appx',
      'electron-builder.msstore.yml: win.target must be appx'
    );

    const requiredFiles = [
      'src/main/main.ts',
      'src/main/preload.ts',
      'src/renderer/index.html',
      'assets/yt-dlp.exe',
      'assets/yt-dlp_arm64.exe',
      'assets/yt-dlp_macos',
      'assets/yt-dlp_linux',
      'assets/yt-dlp_linux_aarch64',
      'build/app-icon.ico',
      'build/app-icon.icns',
      'build/app-icon.png',
      'build/appx/appxmanifest.xml',
    ];
    for (const relativePath of requiredFiles) {
      assertConfig(
        fs.existsSync(path.join(process.cwd(), relativePath)),
        `missing required file: ${relativePath}`
      );
    }
  } catch (error) {
    assertConfig(false, `config parsing failed: ${error.message}`);
  }

  results.config.status = results.config.failed === 0 ? 'passed' : 'failed';
  if (results.config.status === 'passed') {
    console.log(`${colors.green}✓ config passed${colors.reset}\n`);
  } else {
    console.log(`${colors.red}✗ config failed${colors.reset}\n`);
  }
}

printBanner('ROSI Full Test Suite');

function run() {
  const unitResult = runCommand('unit', 'npm test', parseUnitTests);
  results.unit.status = unitResult.ok ? 'passed' : 'failed';

  const lintResult = runCommand('lint', 'npm run lint');
  results.lint.status = lintResult.ok ? 'passed' : 'failed';

  const formatResult = runCommand('format', 'npm run format:check');
  results.format.status = formatResult.ok ? 'passed' : 'failed';

  const typecheckResult = runCommand('typecheck', 'npm run typecheck');
  results.typecheck.status = typecheckResult.ok ? 'passed' : 'failed';

  runSyntaxChecks();
  runConfigChecks();

  printBanner('SUMMARY');

  const summaryLines = [
    `${colors.bold}Unit:${colors.reset}      ${results.unit.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset} (${results.unit.passed} passed${results.unit.failed > 0 ? `, ${results.unit.failed} failed` : ''})`,
    `${colors.bold}Lint:${colors.reset}      ${results.lint.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset}`,
    `${colors.bold}Format:${colors.reset}    ${results.format.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset}`,
    `${colors.bold}Typecheck:${colors.reset} ${results.typecheck.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset}`,
    `${colors.bold}Syntax:${colors.reset}    ${results.syntax.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset} (${results.syntax.checked} checked${results.syntax.failed > 0 ? `, ${results.syntax.failed} failed` : ''})`,
    `${colors.bold}Config:${colors.reset}    ${results.config.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'}${colors.reset} (${results.config.checks} checks${results.config.failed > 0 ? `, ${results.config.failed} failed` : ''})`,
  ];
  for (const line of summaryLines) {
    console.log(line);
  }

  if (results.syntax.failures.length > 0) {
    console.log(`\n${colors.yellow}Syntax failures:${colors.reset}`);
    for (const failure of results.syntax.failures) {
      console.log(`- ${failure}`);
    }
  }

  if (results.config.failures.length > 0) {
    console.log(`\n${colors.yellow}Config failures:${colors.reset}`);
    for (const failure of results.config.failures) {
      console.log(`- ${failure}`);
    }
  }

  const allPassed = Object.values(results).every((r) => r.status === 'passed');
  console.log('');
  if (allPassed) {
    console.log(`${colors.green}${colors.bold}✓ All checks passed!${colors.reset}`);
    process.exit(0);
  }

  console.log(`${colors.red}${colors.bold}✗ Some checks failed.${colors.reset}`);
  process.exit(1);
}

if (require.main === module) {
  run();
}

module.exports = { runCommand, runSyntaxChecks, runConfigChecks };
