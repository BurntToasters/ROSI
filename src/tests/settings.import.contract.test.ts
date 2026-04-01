import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('settings import persistence contract', () => {
  it('uses tmp file + rename for atomic import writes', () => {
    const settingsSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'main', 'settings.ts'),
      'utf8'
    );

    expect(settingsSource).toMatch(/const tmpPath = `\$\{settingsPath\}\.tmp`;/);
    expect(settingsSource).toMatch(
      /fs\.writeFileSync\(tmpPath, JSON\.stringify\(migrated, null, 2\).*\);/
    );
    expect(settingsSource).toMatch(/fs\.renameSync\(tmpPath, settingsPath\);/);
  });
});
