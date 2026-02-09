const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const results = {
  test: { status: 'pending', passed: 0, failed: 0 },
};

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function runCommand(name, command, parser) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    results[name].status = 'passed';
    if (parser) parser(output);
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return true;
  } catch (error) {
    const output = error.stdout || error.stderr || '';
    if (parser) parser(output);
    results[name].status = 'failed';
    console.log(`${colors.red}✗ ${name} failed${colors.reset}\n`);
    return false;
  }
}

function parseTest(output) {
  const clean = stripAnsi(output);
  const testsLine = clean.split(/\r?\n/).find((line) => line.trim().startsWith('Tests'));
  if (!testsLine) return;
  const passedMatch = testsLine.match(/(\d+)\s+passed/);
  const failedMatch = testsLine.match(/(\d+)\s+failed/);
  results.test.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  results.test.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
}

console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║        ROSI Test Suite              ║
╚══════════════════════════════════════╝
${colors.reset}`);

runCommand('test', 'npm test', parseTest);

console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║             SUMMARY                 ║
╚══════════════════════════════════════╝
${colors.reset}`);

const allPassed = Object.values(results).every((r) => r.status === 'passed');

console.log(`${colors.bold}Tests:${colors.reset}      ${
  results.test.status === 'passed' ? colors.green + '✓ PASS' : colors.red + '✗ FAIL'
}${colors.reset} (${results.test.passed} passed${
  results.test.failed > 0 ? `, ${results.test.failed} failed` : ''
})`);

console.log('');

if (allPassed) {
  console.log(`${colors.green}${colors.bold}✓ All checks passed!${colors.reset}`);
  process.exit(0);
} else {
  console.log(`${colors.red}${colors.bold}✗ Some checks failed.${colors.reset}`);
  process.exit(1);
}
