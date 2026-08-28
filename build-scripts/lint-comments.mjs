#!/usr/bin/env node

import console from 'node:console';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import process from 'node:process';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.dart',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.rs',
  '.svelte',
  '.ts',
  '.tsx',
]);
const IGNORED_DIRECTORIES = new Set([
  '.dart_tool',
  '.git',
  '.next',
  '.svelte-kit',
  'build',
  'coverage',
  'coverage-headless',
  'dist',
  'node_modules',
  'out',
  'release',
  'target',
  'vendor',
]);
const EXEMPT_BLOCK_PATTERN =
  /(?:@license|copyright|eslint|prettier|@ts-|istanbul|\bc8\b|coverage|rustfmt|clippy|dart\s+format|SPDX|commentlint-disable)/i;
const GENERIC_LABEL_PATTERN =
  /^(?:imports?|exports?|constants?|variables?|types?|interfaces?|constructors?|getters?|setters?|methods?|helpers?|utilities?)\s*[:.]?$/i;
const GENERATED_FILE_PATTERN = /(?:generated (?:code|file)|do not edit|\/\/\s*node_modules\/)/i;
const URL_PATTERN = /\b(?:https?|file):\/\/\S+/gi;

function parseArguments(argv) {
  const options = {
    maxDocLines: 24,
    maxLength: 120,
    maxProseLines: 12,
    paths: [],
  };

  for (const argument of argv) {
    const match = argument.match(/^--(max-length|max-prose-lines|max-doc-lines)=(\d+)$/);
    if (!match) {
      options.paths.push(argument);
      continue;
    }

    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid value for ${match[1]}: ${match[2]}`);
    }

    if (match[1] === 'max-length') options.maxLength = value;
    if (match[1] === 'max-prose-lines') options.maxProseLines = value;
    if (match[1] === 'max-doc-lines') options.maxDocLines = value;
  }

  if (options.paths.length === 0) options.paths.push('src');
  return options;
}

async function collectFiles(inputPath, files) {
  const absolutePath = resolve(inputPath);
  let entryStats;
  try {
    entryStats = await stat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  if (entryStats.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(absolutePath))) files.add(absolutePath);
    return;
  }
  if (!entryStats.isDirectory()) return;

  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    await collectFiles(resolve(absolutePath, entry.name), files);
  }
}

function stripCommentMarker(line, state) {
  const trimmed = line.trim();

  if (state.kind === 'block') {
    const closes = trimmed.includes('*/');
    const text = trimmed.replace(/^\*?\s?/, '').replace(/\s*\*\/.*$/, '');
    if (closes) state.kind = null;
    return { isDoc: state.isDoc, text };
  }

  if (state.kind === 'html') {
    const closes = trimmed.includes('-->');
    const text = trimmed.replace(/\s*-->.*$/, '');
    if (closes) state.kind = null;
    return { isDoc: false, text };
  }

  if (trimmed.startsWith('//')) {
    const marker = trimmed.match(/^\/\/+!?/)?.[0] ?? '//';
    return {
      isDoc: marker.startsWith('///') || marker.startsWith('//!'),
      text: trimmed.slice(marker.length).trim(),
    };
  }

  if (trimmed.startsWith('/*')) {
    const isDoc = trimmed.startsWith('/**');
    const closes = trimmed.slice(2).includes('*/');
    const text = trimmed
      .replace(/^\/\*+!?\s?/, '')
      .replace(/\s*\*\/.*$/, '')
      .trim();
    if (!closes) {
      state.kind = 'block';
      state.isDoc = isDoc;
    }
    return { isDoc, text };
  }

  if (trimmed.startsWith('<!--')) {
    const closes = trimmed.includes('-->');
    const text = trimmed.replace(/^<!--\s?/, '').replace(/\s*-->.*$/, '').trim();
    if (!closes) state.kind = 'html';
    return { isDoc: false, text };
  }

  return null;
}

function lintSource(filePath, source, options) {
  const fileName = basename(filePath);
  if (
    /^(?:app_localizations(?:_[a-z]+)?|.+\.(?:freezed|g))\.dart$/i.test(fileName) ||
    GENERATED_FILE_PATTERN.test(source.split('\n').slice(0, 8).join('\n'))
  ) {
    return [];
  }

  const findings = [];
  const lines = source.split(/\r?\n/);
  const state = { isDoc: false, kind: null };
  let group = [];

  const flushGroup = () => {
    if (group.length === 0) return;

    const combinedText = group.map((entry) => entry.text).join(' ');
    if (!EXEMPT_BLOCK_PATTERN.test(combinedText)) {
      const isDoc = group.some((entry) => entry.isDoc);
      const maxLines = isDoc ? options.maxDocLines : options.maxProseLines;
      if (group.length > maxLines) {
        findings.push({
          line: group[0].line,
          message: `${isDoc ? 'Documentation' : 'Prose'} comment has ${group.length} lines (maximum ${maxLines}); keep it focused or move detail to documentation`,
        });
      }

      if (group.length === 1 && GENERIC_LABEL_PATTERN.test(group[0].text)) {
        findings.push({
          line: group[0].line,
          message: `Generic section comment "${group[0].text}" is usually redundant; prefer clear names and structure`,
        });
      }
    }

    group = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = stripCommentMarker(lines[index], state);
    if (!parsed) {
      flushGroup();
      continue;
    }

    const normalizedText = parsed.text.replace(URL_PATTERN, '<url>');
    if (
      normalizedText.length > options.maxLength &&
      !EXEMPT_BLOCK_PATTERN.test(parsed.text)
    ) {
      findings.push({
        line: index + 1,
        message: `Comment text is ${normalizedText.length} characters (maximum ${options.maxLength}); shorten or wrap it`,
      });
    }

    group.push({ ...parsed, line: index + 1 });
  }
  flushGroup();
  return findings;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = new Set();
  for (const inputPath of options.paths) await collectFiles(inputPath, files);

  let findingCount = 0;
  for (const filePath of [...files].sort()) {
    const source = await readFile(filePath, 'utf8');
    for (const finding of lintSource(filePath, source, options)) {
      findingCount += 1;
      console.error(`${relative(process.cwd(), filePath)}:${finding.line}: ${finding.message}`);
    }
  }

  if (findingCount > 0) {
    console.error(`\n${findingCount} concise-comment lint ${findingCount === 1 ? 'error' : 'errors'}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Concise-comment lint passed (${files.size} files checked).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
