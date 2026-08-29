import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walk, displayPath } from '../../src/fs/walk.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-walk-'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'chalk'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'b.mjs'), '');
  writeFileSync(join(root, 'a.mjs'), '');
  writeFileSync(join(root, 'notes.md'), '');
  writeFileSync(join(root, 'src', 'z.mjs'), '');
  writeFileSync(join(root, 'src', 'deep', 'y.mjs'), '');
  writeFileSync(join(root, 'node_modules', 'chalk', 'index.js'), '');
  writeFileSync(join(root, '.git', 'config'), '');
  return root;
}

test('walks every file and skips the usual noise', () => {
  const root = fixture();
  const found = [...walk(root)].map((file) => displayPath(root, file));
  assert.deepEqual(found.toSorted(), ['a.mjs', 'b.mjs', 'notes.md', 'src/deep/y.mjs', 'src/z.mjs']);
  assert.ok(!found.some((file) => file.includes('node_modules')), 'node_modules is skipped');
  assert.ok(!found.some((file) => file.includes('.git')), '.git is skipped');
});

test('extension filtering', () => {
  const root = fixture();
  const found = [...walk(root, { extensions: new Set(['.mjs']) })].map((file) => displayPath(root, file));
  assert.ok(!found.includes('notes.md'));
  assert.equal(found.length, 4);
});

test('traversal order is stable across runs, which the reproducible build relies on', () => {
  const root = fixture();
  const first = [...walk(root)];
  const second = [...walk(root)];
  assert.deepEqual(first, second);
  // Sorted at every level: siblings come out in name order.
  const names = first.map((file) => displayPath(root, file));
  assert.ok(names.indexOf('a.mjs') < names.indexOf('b.mjs'));
});

test('a missing directory yields nothing rather than throwing', () => {
  assert.deepEqual([...walk(join(tmpdir(), 'nirdep-does-not-exist-9e1f'))], []);
});

test('displayPath uses forward slashes on every platform', () => {
  const root = fixture();
  for (const file of walk(root)) assert.ok(!displayPath(root, file).includes('\\'));
});
