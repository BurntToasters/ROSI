import { describe, expect, it } from 'vitest';

const { parseUnitTests, stripAnsi, results } = require('../../build-scripts/test-all.js');

describe('test-all helpers', () => {
  it('stripAnsi removes terminal color codes', () => {
    expect(stripAnsi('\u001b[32mPASS\u001b[0m')).toBe('PASS');
  });

  it('parseUnitTests extracts passed and failed counts', () => {
    parseUnitTests('Tests  12 passed | 2 failed (14)');
    expect(results.unit.passed).toBe(12);
    expect(results.unit.failed).toBe(2);
  });
});
