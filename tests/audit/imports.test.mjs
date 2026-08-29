// The import scanner is the load-bearing part of the zero-dependency claim, so
// it gets tested against the cases that would quietly weaken it, not only the
// happy path.
//
// The fixture sources live in tests/vectors/imports/ as .txt rather than inline
// here, and that is not squeamishness. The scanner is deliberately blunt: it
// matches import syntax anywhere in a file, including inside comments and
// string literals, because for a proof of absence a false positive is cheap and
// a false negative is fatal. A test file full of inline import-shaped strings
// would therefore be flagged by the very tool it is testing. The alternative was
// to add an ignore pragma to the scanner, which is exactly the escape hatch a
// zero-dependency proof should not have. Keeping the fixtures as data costs one
// readFileSync and leaves the scanner with no way to be told to look away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify, findSpecifiers, auditSource, isBuiltinSpecifier } from '../../src/audit/imports.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const vector = (name) => readFileSync(new URL(`../vectors/imports/${name}.txt`, import.meta.url), 'utf8');

test('prefix-only builtins count as builtins', () => {
  // These three are absent from module.builtinModules. An earlier version of the
  // proof built its allow-list from that array and so failed on its own test
  // files. This is that regression, nailed down.
  for (const specifier of ['node:test', 'node:test/reporters', 'node:sqlite']) {
    assert.equal(isBuiltinSpecifier(specifier), true, specifier);
    assert.equal(classify(specifier), 'builtin', specifier);
  }
});

test('a bare name is not a builtin just because the prefixed form is', () => {
  // Without the node: prefix these resolve to packages on npm, so treating them
  // as builtins would let a real dependency through the proof.
  assert.equal(classify('test'), 'third-party');
  assert.equal(classify('sqlite'), 'third-party');
});

test('builtin subpaths are recognised', () => {
  for (const specifier of ['node:assert/strict', 'node:fs/promises', 'node:stream/web', 'fs/promises']) {
    assert.equal(classify(specifier), 'builtin', specifier);
  }
});

test('the categories a specifier can fall into', () => {
  assert.equal(classify('./walk.mjs'), 'relative');
  assert.equal(classify('../src/index.mjs'), 'relative');
  assert.equal(classify('/tmp/absolute.mjs'), 'absolute');
  assert.equal(classify('#internal/thing'), 'subpath');
  assert.equal(classify('node:fs'), 'builtin');
  assert.equal(classify('chalk'), 'third-party');
  assert.equal(classify('@scope/pkg'), 'third-party');
  assert.equal(classify('nirdep/runtime/colour', { selfNames: new Set(['nirdep/runtime/colour']) }), 'self');
});

test('a name that merely starts with a dot is not relative', () => {
  // A leading dot with no slash is a package name, not a path.
  assert.equal(classify('.hidden-package'), 'third-party');
  assert.equal(classify('.'), 'relative');
});

test('all six syntactic positions are found, with line numbers', () => {
  const found = findSpecifiers(vector('positions'));
  assert.deepEqual(found.map((entry) => entry.specifier), ['one', 'two', 'three', 'four', 'five', 'six']);
  assert.deepEqual(found.map((entry) => entry.line), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(found.map((entry) => entry.kind), ['import-from', 'import-bare', 'import-dynamic', 'export-from', 'require', 'create-require']);
});

test('overlapping patterns report each specifier once', () => {
  // Two of the six patterns can claim the same string literal; the scanner keys
  // matches by byte offset so the count is not doubled.
  const found = findSpecifiers(vector('overlap'));
  assert.equal(found.length, 1);
  assert.equal(found[0].specifier, 'node:fs');
});

test('a third-party import is reported with its position', () => {
  const { specifiers, thirdParty } = auditSource(vector('third-party'));
  assert.equal(specifiers.length, 2);
  assert.equal(thirdParty.length, 1);
  assert.equal(thirdParty[0].specifier, 'chalk');
  assert.equal(thirdParty[0].line, 2);
});

test('line numbers survive multi-byte characters and blank lines', () => {
  const found = findSpecifiers(vector('multibyte'));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 4);
});

test('the proof script passes on this repository and writes its receipt', () => {
  const stdout = execFileSync(process.execPath, ['tools/verify.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(stdout, /RESULT: zero third-party runtime dependencies\./);
  assert.match(stdout, /node:test/, 'the inventory names the test runner it is running under');
  const receipt = readFileSync(new URL('../../deps-proof.txt', import.meta.url), 'utf8');
  assert.equal(receipt, stdout);
});
