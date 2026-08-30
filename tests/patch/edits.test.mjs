// The patcher's tests. The interesting ones are not "does it splice bytes" but the
// refusals: an edit with no reason, two edits fighting over the same range, an offset
// past the end of the file. Those are the checks that stop a half-applied rewrite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PatchError, applyEdits, createPatch } from '../../src/patch/edits.mjs';

const SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

/** Run `body` and hand back the PatchError it threw, or fail loudly if it did not. */
function refusal(body) {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof PatchError, `expected a PatchError, got ${error.name}`);
    return error;
  }
  return assert.fail('expected a refusal, got a patch');
}

test('applyEdits splices right to left so offsets stay valid', () => {
  const out = applyEdits('abcdef', [
    { start: 0, end: 1, text: 'A' },
    { start: 4, end: 6, text: 'EF!' },
    { start: 2, end: 3, text: '' },
  ]);
  assert.equal(out, 'AbdEF!');
});

test('a replacement lands where the offsets say and nothing else moves', () => {
  const patch = createPatch(SOURCE, { file: 'x.mjs' });
  patch.replace(6, 7, 'alpha', 'rename a');
  const result = patch.apply();
  assert.equal(result.after, 'const alpha = 1;\nconst b = 2;\nconst c = 3;\n');
  assert.equal(result.changed, true);
  assert.equal(result.bytes.before, SOURCE.length);
  assert.equal(result.bytes.after, result.after.length);
  assert.equal(result.file, 'x.mjs');
  assert.equal(result.before, SOURCE);
});

test('insert and remove are replace with one side empty', () => {
  const patch = createPatch(SOURCE);
  patch.insert(0, '// top\n', 'add a header');
  patch.remove(13, 26, 'drop the second line');
  assert.equal(patch.apply().after, '// top\nconst a = 1;\nconst c = 3;\n');
});

test('two inserts at the same offset keep the order they were added', () => {
  const patch = createPatch('x');
  patch.insert(0, 'one ', 'first');
  patch.insert(0, 'two ', 'second');
  assert.equal(patch.apply().after, 'one two x');
});

test('an edit that puts back what was there is not a change', () => {
  const patch = createPatch(SOURCE);
  patch.replace(6, 7, 'a', 'a rule that matched and had nothing to do');
  const result = patch.apply();
  assert.equal(result.changed, false);
  assert.equal(result.after, SOURCE);
  assert.equal(result.edits.length, 1);
});

test('every edit remembers the bytes it displaced', () => {
  const patch = createPatch(SOURCE);
  patch.replace(0, 5, 'let', 'const to let');
  assert.equal(patch.apply().edits[0].was, 'const');
});

test('edits come out in apply order however they went in', () => {
  const patch = createPatch(SOURCE);
  patch.replace(19, 20, 'B', 'third');
  patch.replace(6, 7, 'A', 'first');
  patch.insert(13, '  ', 'second');
  const starts = patch.list().map((one) => one.start);
  assert.deepEqual(starts, [6, 13, 19]);
  assert.equal(patch.size, 3);
});

test('an edit with no reason is refused, because plan has to print something', () => {
  assert.equal(refusal(() => createPatch(SOURCE).replace(0, 1, 'x', '   ')).code, 'NO_REASON');
  assert.equal(refusal(() => createPatch(SOURCE).insert(0, 'x')).code, 'NO_REASON');
});

test('overlapping edits are a caller bug, not a merge to attempt', () => {
  const patch = createPatch(SOURCE);
  patch.replace(0, 12, 'const a = 2;', 'rule one');
  const error = refusal(() => patch.replace(6, 7, 'z', 'rule two'));
  assert.equal(error.code, 'OVERLAPPING_EDITS');
  assert.equal(error.first, 'rule one');
  assert.equal(error.second, 'rule two');
  // The loser was not quietly dropped: the patch is untouched.
  assert.equal(patch.size, 1);
});

test('edits that touch end to start do not overlap', () => {
  const patch = createPatch(SOURCE);
  patch.replace(0, 5, 'let', 'one');
  patch.replace(5, 6, '', 'two');
  assert.equal(patch.apply().after, 'leta = 1;\nconst b = 2;\nconst c = 3;\n');
});

test('a range has to be two real offsets inside the file', () => {
  assert.equal(refusal(() => createPatch(SOURCE).replace(-1, 2, 'x', 'why')).code, 'BAD_RANGE');
  assert.equal(refusal(() => createPatch(SOURCE).replace(1.5, 2, 'x', 'why')).code, 'BAD_RANGE');
  assert.equal(refusal(() => createPatch(SOURCE).replace(5, 2, 'x', 'why')).code, 'BAD_RANGE');
  const past = refusal(() => createPatch(SOURCE).replace(0, SOURCE.length + 1, 'x', 'why'));
  assert.equal(past.code, 'BAD_RANGE');
  assert.equal(past.length, SOURCE.length);
});

test('the source and the replacement both have to be strings', () => {
  assert.equal(refusal(() => createPatch(null)).code, 'NOT_A_STRING');
  assert.equal(refusal(() => createPatch(SOURCE).replace(0, 1, 42, 'why')).code, 'BAD_TEXT');
});

test('what a patch hands back cannot be edited behind its back', () => {
  const patch = createPatch(SOURCE);
  patch.replace(6, 7, 'q', 'rename');
  const result = patch.apply();
  assert.throws(() => { result.edits[0].start = 99; }, TypeError);
  assert.throws(() => { result.after = 'nonsense'; }, TypeError);
  assert.equal(Object.isFrozen(result.edits), true);
});
