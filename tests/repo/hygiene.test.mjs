// Repository hygiene. Small, mechanical, and load-bearing: several modules here
// carry comments that promise a property of the source itself, and a promise in a
// comment is worth nothing without a test underneath it.
//
// The one that keeps earning its place is the control-byte rule. runtime/colour
// is a file full of ANSI escape sequences, and an editor -- human or otherwise --
// that writes the byte U+001B instead of the six characters that spell it leaves
// a file that still passes every behavioural test, still renders correctly, and
// is unreadable in a diff, unsearchable, and silently mangled by anything that
// touches encodings. Test vectors carry the literal text <ESC> and expand it on
// load for the same reason. This suite is what makes that rule real.
//
// The Makefile is not checked: its recipe lines require tab indentation, so it is
// excluded by the extension filter rather than by an exception.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, join } from 'node:path';
import { walk } from '../../src/fs/walk.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSIONS = new Set(['.mjs', '.json', '.md', '.toml', '.txt', '.yml', '.yaml']);

/** Every text file in the repository, as [relative path, contents]. */
function files() {
  const found = [];
  for (const path of walk(ROOT, { extensions: EXTENSIONS })) {
    found.push([relative(ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8')]);
  }
  return found;
}

const ALL = files();

test('the repository is not empty and the walk found the real files', () => {
  const names = ALL.map(([path]) => path);
  assert.ok(ALL.length > 15, `found ${ALL.length} files`);
  for (const expected of ['src/runtime/args.mjs', 'src/runtime/colour.mjs', 'package.json', 'STDLIB.md']) {
    assert.ok(names.includes(expected), `${expected} was walked`);
  }
});

test('no source file contains a raw control byte', () => {
  // Everything below 0x20 except newline and tab, plus DEL. Newline is the line
  // separator; tab is permitted in data files even though nothing uses one.
  const control = /[\u0000-\u0008\u000B-\u001F\u007F]/;
  for (const [path, text] of ALL) {
    const at = text.search(control);
    if (at === -1) continue;
    const line = text.slice(0, at).split('\n').length;
    const code = text.codePointAt(at).toString(16).padStart(4, '0');
    assert.fail(`${path}:${line} contains U+${code.toUpperCase()}; write it as an escape instead`);
  }
});

test('the escape character is spelled out, never embedded', () => {
  // The positive half of the rule: the files that deal in escape sequences must
  // still say so, or a future refactor could satisfy the test above by deleting
  // the feature.
  const colour = readFileSync(join(ROOT, 'src/runtime/colour.mjs'), 'utf8');
  assert.ok(colour.includes('\\u001B'), 'runtime/colour writes escapes as \\u001B');
  const args = readFileSync(join(ROOT, 'src/runtime/args.mjs'), 'utf8');
  assert.ok(args.includes('\\u001B'), 'runtime/args writes escapes as \\u001B');
});

test('vector tables carry the ESC marker rather than the byte', () => {
  const vectors = ALL.filter(([path]) => path.startsWith('tests/vectors/colour/'));
  assert.ok(vectors.length > 0, 'the colour vectors were found');
  for (const [path, text] of vectors) {
    assert.ok(text.includes('<ESC>'), `${path} uses the <ESC> marker`);
  }
});

test('every file uses newline endings and ends with exactly one', () => {
  for (const [path, text] of ALL) {
    assert.ok(!text.includes('\r'), `${path} has a carriage return`);
    assert.ok(text.endsWith('\n'), `${path} does not end with a newline`);
    assert.ok(!text.endsWith('\n\n'), `${path} ends with a blank line`);
  }
});

test('no line carries trailing whitespace', () => {
  for (const [path, text] of ALL) {
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      assert.ok(!/[ \t]$/.test(line), `${path}:${index + 1} has trailing whitespace`);
    }
  }
});

test('no JavaScript file is indented with tabs', () => {
  for (const [path, text] of ALL) {
    if (!path.endsWith('.mjs')) continue;
    assert.ok(!text.includes('\t'), `${path} contains a tab`);
  }
});

test('every JSON file in the repository parses', () => {
  for (const [path, text] of ALL) {
    if (!path.endsWith('.json')) continue;
    try {
      JSON.parse(text);
    } catch (error) {
      assert.fail(`${path} is not valid JSON: ${error.message}`);
    }
  }
});

test('the attribution the hackathon requires is where it is claimed to be', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.author, 'Sai Ram Dash (Hardik)');
  assert.equal(manifest.publisher, 'Nastik AI');
  assert.match(manifest.description, /Published by Nastik AI\. Developed by Sai Ram Dash \(Hardik\)\./);
  for (const file of ['README.md', 'STDLIB.md', 'SECURITY.md', 'src/runtime/args.mjs', 'src/runtime/colour.mjs']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.match(text, /Nastik AI/, `${file} names the publisher`);
  }
});

test('no runtime module imports anything outside node:', () => {
  // tools/verify.mjs proves this across the whole tree and is the artifact the
  // judges will run. This is the fast version, so a stray import fails a normal
  // test run rather than waiting for the proof step.
  const pattern = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/g;
  for (const [path, text] of ALL) {
    if (!path.startsWith('src/') && !path.startsWith('bin/') && !path.startsWith('tools/')) continue;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      const local = specifier.startsWith('.') || specifier.startsWith('/');
      assert.ok(local || specifier.startsWith('node:'), `${path} imports ${specifier}`);
    }
  }
});

test('the runtime modules do not import each other', () => {
  // The eject story depends on this: a project that takes runtime/args must not
  // have to take runtime/colour with it. Help styling is injected instead.
  for (const [path, text] of ALL) {
    if (!path.startsWith('src/runtime/')) continue;
    for (const match of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      assert.fail(`${path} imports ${match[1]}; a runtime module must stand alone`);
    }
  }
});
