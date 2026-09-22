#!/usr/bin/env node
/**
 * Fail if production paths depend on Playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const errors = [];
if (pkg.dependencies?.playwright || pkg.dependencies?.['playwright-core']) {
  errors.push('package.json dependencies still include playwright');
}

const prodDirs = ['src/api', 'src/mcp', 'src/worker', 'src/memory', 'src/intelligence', 'src/telegram', 'src/security', 'src/observability'];
const prodFiles = ['src/index.js', 'src/config.js'];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs|cjs|ts)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

const files = [
  ...prodFiles.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
  ...prodDirs.flatMap((d) => walk(path.join(root, d))),
];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (/from\s+['"]playwright['"]|require\(['"]playwright['"]\)|playwright-core/.test(text)) {
    errors.push(`Playwright import in production file: ${path.relative(root, file)}`);
  }
  if (/src\/browser\//.test(text) && !file.includes('legacy')) {
    errors.push(`References src/browser in: ${path.relative(root, file)}`);
  }
}

if (errors.length) {
  console.error('guard-no-playwright FAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('guard-no-playwright OK (%d files scanned)', files.length);
