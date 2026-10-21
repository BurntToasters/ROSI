// Failure modes: src/tests/commands.contract.failure-modes.md
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(REPO, relativePath), 'utf8');

function rustCommands(listName: 'COMMANDS' | 'COMMANDS_WITH_E2E'): string[] {
  const match = read('src-tauri/build.rs').match(
    new RegExp(`const ${listName}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`)
  );
  if (!match?.[1]) throw new Error(`build.rs has no ${listName} list`);
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] as string);
}

function mapCommands(): string[] {
  const body = read('src/commands.ts').match(/export interface Commands \{([\s\S]*?)\n\}/)?.[1];
  if (!body) throw new Error('src/commands.ts has no Commands interface');
  return [...body.matchAll(/^ {2}([a-z0-9_]+): \{/gm)].map((m) => m[1] as string);
}

function rendererSources(): Array<[string, string]> {
  const srcDir = path.join(REPO, 'src');
  return fs
    .readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.startsWith('tests'))
    .map((name) => [name, fs.readFileSync(path.join(srcDir, name), 'utf8')]);
}

describe('typed command map', () => {
  const production = rustCommands('COMMANDS');
  const mapped = mapCommands();

  it('lists exactly the production commands Rust registers (modes 1, 2, 3)', () => {
    expect([...mapped].sort()).toEqual([...production].sort());
    const e2eOnly = rustCommands('COMMANDS_WITH_E2E').filter((name) => !production.includes(name));
    expect(e2eOnly.length).toBeGreaterThan(0);
    for (const name of e2eOnly) expect(mapped).not.toContain(name);
  });

  it('is the only place renderer code calls invoke() (mode 4)', () => {
    const direct = rendererSources()
      .filter(([name]) => name !== 'commands.ts')
      .filter(([, text]) => /\binvoke\s*[<(]/.test(text.replace(/\.invoke\b/g, '')))
      .map(([name]) => name);
    expect(direct).toEqual([]);
  });

  it('routes window.api through mapped command names (mode 5)', () => {
    const bridge = read('src/tauri-bridge.ts');
    const called = [...bridge.matchAll(/\b(?:call|fire)\('([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    for (const name of called) expect(mapped).toContain(name);
  });

  it('matches the main window capability grants (mode 6)', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/default.json')) as {
      permissions: string[];
    };
    const granted = capability.permissions
      .filter((permission) => permission.startsWith('allow-'))
      .map((permission) => permission.slice('allow-'.length).replace(/-/g, '_'));
    expect([...granted].sort()).toEqual([...mapped].sort());
  });
});
