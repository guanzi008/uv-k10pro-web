// SPDX-License-Identifier: MIT
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', '.local'].includes(entry.name)) continue;
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item)); else files.push(item);
  }
  return files;
}
const files = await walk(root);
for (const file of files.filter(f => f.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    if (!files.includes(path.resolve(path.dirname(file), match[1]))) throw new Error(`Missing module ${match[1]} in ${file}`);
  }
}
const forbidden = files.filter(f => /\.(?:bin|apk|exe|dll|rar|k10)$/i.test(f));
if (forbidden.length) throw new Error(`Private/vendor binary in distributable: ${forbidden.join(', ')}`);
console.log(`Checked module syntax, local imports and distribution files (${files.length} files)`);
