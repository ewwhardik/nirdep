// The three presentation primitives, tested because both reports measure with them.
//
// `wrap` is the one that matters: it counts characters, so a caller that folds already
// styled text will fold it at the wrong column and blame the terminal. The test that pins
// that down is the one about escape sequences not being columns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN, WIDTH, pad, plural, styleOf, wrap } from '../../src/text/format.mjs';

test('the plain style set is the identity, and frozen', () => {
  assert.equal(Object.isFrozen(PLAIN), true);
  for (const [name, hook] of Object.entries(PLAIN)) {
    assert.equal(hook('text'), 'text', `${name} should change nothing`);
  }
  assert.deepEqual(Object.keys(PLAIN).sort(), ['bold', 'cyan', 'dim', 'green', 'red', 'yellow']);
});

test('a partial style set still has every hook', () => {
  const s = styleOf({ red: (text) => `<${text}>` });
  assert.equal(s.red('no'), '<no>');
  assert.equal(s.dim('quiet'), 'quiet');
  assert.equal(styleOf(null).bold('x'), 'x');
  assert.equal(styleOf(undefined).green('x'), 'x');
  // The caller's object is copied, not kept, so a report cannot mutate what it was given.
  const given = { bold: (text) => text.toUpperCase() };
  const made = styleOf(given);
  made.bold = (text) => text;
  assert.equal(given.bold('x'), 'X');
});

test('plural does not derive the plural, because English does not', () => {
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(2, 'file'), '2 files');
  assert.equal(plural(0, 'file'), '0 files');
  assert.equal(plural(1, 'dependency', 'dependencies'), '1 dependency');
  assert.equal(plural(3, 'dependency', 'dependencies'), '3 dependencies');
  assert.equal(plural(-1, 'file'), '-1 files');
});

test('wrap folds at the width and indents the continuations', () => {
  assert.equal(WIDTH, 76, 'an 80-column terminal with room for a four-space indent');
  const text = 'one two three four five six seven eight nine ten';
  assert.equal(wrap(text, 100), text, 'nothing to fold');
  // The width is measured against the line without its indent, so a continuation may be
  // the full width and then four spaces further right. That is the fold both reports use.
  assert.equal(wrap(text, 13), 'one two three\n    four five six\n    seven eight\n    nine ten');
  assert.equal(wrap(text, 13, '  '), 'one two three\n  four five six\n  seven eight\n  nine ten');
  for (const line of wrap('a '.repeat(200), WIDTH).split('\n')) {
    assert.ok(line.replace(/^ +/, '').length <= WIDTH, 'no line runs past the width');
  }
});

test('wrap normalises the whitespace it was given', () => {
  assert.equal(wrap('  spaced   out  \n  over lines ', 100), 'spaced out over lines');
  assert.equal(wrap('', 20), '');
  assert.equal(wrap('   ', 20), '');
  assert.equal(wrap(42, 20), '42', 'a number is text enough');
});

test('a word longer than the width is left alone rather than cut', () => {
  const long = 'x'.repeat(90);
  assert.equal(wrap(`short ${long} end`, 20), `short\n    ${long}\n    end`);
});

test('wrap measures characters, which is why styling happens after it', () => {
  // Written as escapes on purpose: a raw escape byte in a source file of this repository
  // is a test failure of its own, in tests/repo/hygiene.test.mjs.
  const red = '\u001B[31m';
  const off = '\u001B[39m';
  const folded = wrap(`${red}${'word '.repeat(20).trim()}${off}`, 20);
  // Five of the first line's characters occupy no columns at all, so it is asked for 20
  // and lands on 14. Nobody should fold styled text; this is the proof, not the feature.
  const [first] = folded.split('\n');
  assert.ok(first.startsWith(red));
  assert.equal(first.length, 19, 'measured as characters');
  assert.equal(first.length - red.length, 14, 'and 14 columns wide once a terminal has read it');
});

test('pad lines a column up and never truncates', () => {
  assert.equal(pad('a', 4), 'a   ');
  assert.equal(pad('abcd', 4), 'abcd');
  assert.equal(pad('abcdef', 4), 'abcdef', 'a long name breaks the column rather than losing letters');
  assert.equal(pad('', 3), '   ');
  assert.equal(pad('a', 0), 'a');
});
