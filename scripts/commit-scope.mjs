#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const msgFile = process.argv[2];
if (!msgFile) process.exit(1);

let lines;
try {
  lines = readFileSync(msgFile, 'utf8').split('\n');
} catch {
  process.exit(1);
}
const first = lines[0] ?? '';

if (/^[a-z]+\([^)]*\):/.test(first)) process.exit(0);

if (!/^(feat|fix|perf|refactor|docs|ci|chore|style|test|build|revert):/.test(first)) {
  process.exit(0);
}

const AREAS = new Map([
  ['addon/_locales/', 'l10n'],
  ['addon/', 'addon'],
  ['crates/webhid-daemon/', 'daemon'],
  ['crates/webhid/', 'webhid'],
  ['crates/webhid-native-messaging/', 'nm'],
  ['crates/webhid-mock/', 'mock'],
  ['scripts/', 'build'],
  ['Makefile', 'build'],
  ['crowdin.yml', 'l10n'],
  ['.husky/', 'build'],
  ['commitlint.config.js', 'build'],
  ['package.json', 'build'],
  ['package-lock.json', 'build'],
]);

const prefixes = [...AREAS.keys()].sort((a, b) => b.length - a.length);

let files;
try {
  files = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  process.exit(1);
}

const counts = new Map();
let unmatched = 0;
for (const path of files) {
  const prefix = prefixes.find((p) => path.startsWith(p));
  if (prefix) {
    const area = AREAS.get(prefix);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  } else {
    unmatched += 1;
  }
}

if (unmatched > 0 || counts.size !== 1) process.exit(0);
const [area] = counts.keys();

const type = first.split(':')[0];
if (area === type) process.exit(0);

lines[0] = lines[0].replace(/^[a-z]*:/, `${type}(${area}):`);
writeFileSync(msgFile, lines.join('\n'));
