// The diff's tests. Three angles: golden hunks checked against what GNU diff prints for
// the same inputs, reconstruction (the ops have to add up to both files, byte for byte),
// and a differential check of minimality against an independent LCS written by dynamic
// programming -- if Myers ever finds a longer edit script than the DP, one of them is
// wrong, and the DP is the boring one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, splitLines, diffLines, unified, stat } from '../../src/patch/diff.mjs';

const lines = (...rows) => `${rows.join('\n')}\n`;
const TEN = lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten');
const numbered = (count, change = () => false) => lines(
  ...Array.from({ length: count }, (_, n) => (change(n) ? `L${n}` : `l${n}`)),
);

/** Put one side of the diff back together from the ops. */
const rebuild = (ops, skip) => ops
  .filter((one) => one.op !== skip)
  .map((one) => (one.noNewline ? one.text : `${one.text}\n`))
  .join('');

/** The shortest edit script length, by the textbook table. Slow, obvious, trustworthy. */
function distance(a, b) {
  const grid = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let n = 0; n <= a.length; n += 1) grid[n][0] = n;
  for (let m = 0; m <= b.length; m += 1) grid[0][m] = m;
  for (let n = 1; n <= a.length; n += 1) {
    for (let m = 1; m <= b.length; m += 1) {
      grid[n][m] = a[n - 1] === b[m - 1]
        ? grid[n - 1][m - 1]
        : Math.min(grid[n - 1][m], grid[n][m - 1]) + 1;
    }
  }
  return grid[a.length][b.length];
}

/** Deterministic noise. A random test that cannot be replayed is a rumour. */
function rolls(seed) {
  let state = seed >>> 0;
  return (bound) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % bound;
  };
}

test('splitLines keeps the fact a naive split throws away', () => {
  assert.deepEqual(splitLines(''), { lines: [], endsWithNewline: true });
  assert.deepEqual(splitLines('a'), { lines: ['a'], endsWithNewline: false });
  assert.deepEqual(splitLines('a\n'), { lines: ['a'], endsWithNewline: true });
  assert.deepEqual(splitLines('\n'), { lines: [''], endsWithNewline: true });
  assert.deepEqual(splitLines('a\nb'), { lines: ['a', 'b'], endsWithNewline: false });
});

test('one changed line in ten is one hunk with three lines of context', () => {
  const after = TEN.replace('three', 'THREE');
  assert.equal(unified(TEN, after, { fromFile: 'a/f.js', toFile: 'b/f.js' }), [
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1,6 +1,6 @@',
    ' one',
    ' two',
    '-three',
    '+THREE',
    ' four',
    ' five',
    ' six',
    '',
  ].join('\n'));
  assert.deepEqual(stat(diffLines(TEN, after).ops), { added: 1, removed: 1, kept: 9 });
});

test('identical texts produce no diff at all', () => {
  assert.equal(unified(TEN, TEN), '');
  assert.equal(unified('', ''), '');
  assert.deepEqual(stat(diffLines(TEN, TEN).ops), { added: 0, removed: 0, kept: 10 });
});

test('a new file and an emptied file get the zero range', () => {
  assert.equal(unified('', 'x\ny\n'), '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  assert.equal(unified('x\ny\n', ''), '--- a\n+++ b\n@@ -1,2 +0,0 @@\n-x\n-y\n');
});

test('a missing newline at the end of the file is reported, not silently fixed', () => {
  assert.equal(unified('a\nb', 'a\nc'), [
    '--- a', '+++ b', '@@ -1,2 +1,2 @@', ' a',
    '-b', '\\ No newline at end of file',
    '+c', '\\ No newline at end of file', '',
  ].join('\n'));
});

test('adding or removing the final newline is a change on its own', () => {
  assert.equal(unified('a', 'a\n'), '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n');
  assert.equal(unified('a\n', 'a'), '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n+a\n\\ No newline at end of file\n');
  assert.equal(diffLines('a', 'a\n').removed, 1);
});

test('changes far apart get their own hunks, changes close together share one', () => {
  const far = unified(numbered(20), numbered(20, (n) => n === 2 || n === 17));
  assert.deepEqual(far.split('\n').filter((one) => one.startsWith('@@')), [
    '@@ -1,6 +1,6 @@', '@@ -15,6 +15,6 @@',
  ]);
  const near = unified(numbered(12), numbered(12, (n) => n === 3 || n === 7));
  assert.deepEqual(near.split('\n').filter((one) => one.startsWith('@@')), ['@@ -1,11 +1,11 @@']);
});

test('context is a knob, and zero context is just the changed lines', () => {
  const after = TEN.replace('three', 'THREE');
  assert.equal(unified(TEN, after, { context: 0 }), '--- a\n+++ b\n@@ -3,1 +3,1 @@\n-three\n+THREE\n');
  assert.equal(unified(TEN, after, { context: 1 }), '--- a\n+++ b\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n');
});

test('an insertion is not reported as a rewrite of everything below it', () => {
  const diff = diffLines(lines('a', 'b', 'c'), lines('a', 'middle', 'b', 'c'));
  assert.deepEqual(stat(diff.ops), { added: 1, removed: 0, kept: 3 });
  assert.equal(unified(lines('a', 'b', 'c'), lines('a', 'middle', 'b', 'c')).includes('-b'), false);
});

test('the ops add up to both files, byte for byte', () => {
  const pairs = [
    ['', ''], ['', 'a\n'], ['a\n', ''], ['a', 'a'], ['a\nb\nc\n', 'c\nb\na\n'],
    [TEN, TEN.replace('three', 'THREE')], [numbered(30), numbered(30, (n) => n % 7 === 0)],
    ['a\nb', 'b\na\nc'], ['\n\n\n', '\n'], ['tabless\n', 'tabless\n'],
  ];
  for (const [before, after] of pairs) {
    const { ops } = diffLines(before, after);
    assert.equal(rebuild(ops, OP.ADD), before, `before, from ${JSON.stringify(before)}`);
    assert.equal(rebuild(ops, OP.REMOVE), after, `after, from ${JSON.stringify(after)}`);
  }
});

test('over three hundred random pairs it reconstructs both sides and finds the shortest script', () => {
  const next = rolls(20260829);
  const word = () => 'abcdefgh'[next(8)];
  for (let round = 0; round < 320; round += 1) {
    const a = Array.from({ length: next(14) }, word);
    const b = a.filter(() => next(3) > 0);
    for (let n = next(4); n > 0; n -= 1) b.splice(next(b.length + 1), 0, word());
    const before = a.length === 0 ? '' : `${a.join('\n')}\n`;
    const after = b.length === 0 ? '' : `${b.join('\n')}\n`;
    const { ops, truncated } = diffLines(before, after);
    const seen = `round ${round}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
    assert.equal(truncated, false, seen);
    assert.equal(rebuild(ops, OP.ADD), before, seen);
    assert.equal(rebuild(ops, OP.REMOVE), after, seen);
    const counted = stat(ops);
    assert.equal(counted.added + counted.removed, distance(a, b), `${seen} was not minimal`);
  }
});

test('a diff of two entirely different large files still reconstructs', () => {
  const before = numbered(400);
  const after = lines(...Array.from({ length: 400 }, (_, n) => `different ${n}`));
  const { ops } = diffLines(before, after);
  assert.equal(rebuild(ops, OP.ADD), before);
  assert.equal(rebuild(ops, OP.REMOVE), after);
  assert.deepEqual(stat(ops), { added: 400, removed: 400, kept: 0 });
});
