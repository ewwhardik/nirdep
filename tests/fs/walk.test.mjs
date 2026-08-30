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

// The pattern half. A Set of names can only say "never anything called fixtures"; the whole
// reason src/runtime/glob.mjs exists inside this project rather than beside it is that our
// own walk needed to say "not the ones under tests".
function twins() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-walk-'));
  for (const dir of ['src/fixtures', 'tests/fixtures']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src', 'fixtures', 'x.mjs'), '');
  writeFileSync(join(root, 'tests', 'fixtures', 'x.mjs'), '');
  writeFileSync(join(root, 'root.mjs'), '');
  return root;
}

const seen = (root, options) => [...walk(root, options)].map((file) => displayPath(root, file)).toSorted();

test('exclude matches the path, which is the thing a name Set cannot do', () => {
  const root = twins();
  assert.deepEqual(seen(root, { exclude: 'tests/**' }), ['root.mjs', 'src/fixtures/x.mjs']);
  // The same word, and both copies go: this is the case the Set gets right too.
  assert.deepEqual(seen(root, { ignore: new Set(['fixtures']) }), ['root.mjs']);
});

test('an excluded directory is pruned rather than walked and filtered', () => {
  const root = fixture();
  // Naming the directory prunes it: `src/deep` matches the entry's own relative path, so
  // the subtree is never opened. globSync's ignore rule, and the same matcher behind it.
  assert.deepEqual(seen(root, { exclude: 'src/deep' }), ['a.mjs', 'b.mjs', 'notes.md', 'src/z.mjs']);
  assert.deepEqual(seen(root, { exclude: ['**/*.md', 'src'] }), ['a.mjs', 'b.mjs']);
});

test('include says what to keep, and only opens what could still match', () => {
  const root = fixture();
  assert.deepEqual(seen(root, { include: 'src/**' }), ['src/deep/y.mjs', 'src/z.mjs']);
  assert.deepEqual(seen(root, { include: '*.mjs' }), ['a.mjs', 'b.mjs']);
  // Brace expansion, which is the feature CVE-2022-3517 was found in and the reason ours
  // expands rather than compiles.
  assert.deepEqual(seen(root, { include: '{a,notes}.{mjs,md}' }), ['a.mjs', 'notes.md']);
});

test('the two filters and the extension set all apply, and the order still holds', () => {
  const root = fixture();
  const options = { include: '**/*', exclude: 'src/deep', extensions: new Set(['.mjs']) };
  const first = [...walk(root, options)];
  assert.deepEqual(first.map((file) => displayPath(root, file)), ['a.mjs', 'b.mjs', 'src/z.mjs']);
  assert.deepEqual([...walk(root, options)], first, 'patterns are compiled per walk, not per entry');
});

test('a pattern that would cost the walk everything is refused before the walk starts', () => {
  // 2^14 expansions of a fourteen-character pattern. The refusal is a limit rather than a
  // syntax error on purpose: an odd-looking pattern is treated as literal text, and only a
  // pattern whose cost is unbounded is turned down. It is turned down here, at the call
  // site, rather than at the first directory that happened to be big.
  const bomb = '{a,b}'.repeat(14);
  assert.throws(() => [...walk(fixture(), { exclude: bomb })], /brace expansion exceeded/);
});
