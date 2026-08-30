// The page that appears only when the command was told to write.
//
// Piped, `stdlibmd` is the document and none of this is printed. So the only job here is the
// three facts somebody needs after a write: where the file went, what got logged in it, and
// that the document is not finished. The last one is why the page is not two lines: a
// generator that reported "done" about a write-up with five TODOs still in it would be the
// last thing anybody read before publishing five TODOs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT } from '../../src/stdlib/project.mjs';
import { stdlibExitCode, stdlibReport } from '../../src/stdlib/report.mjs';

const flat = (text) => text.replace(/\s+/g, ' ');

/** A finished run, without the plan or the disk that would normally produce one. */
const runOf = (result, extra = {}) => ({
  result,
  reason: extra.reason ?? null,
  display: extra.display ?? 'STDLIB.md',
  document: {
    empty: extra.empty === true,
    counts: {
      replaced: extra.replaced ?? 3, modules: extra.modules ?? 2, remaining: extra.remaining ?? 1,
      lines: 104, bytes: 4436,
    },
  },
});

test('a write says where, how big, and what is in it', () => {
  const text = stdlibReport(runOf(RESULT.WRITTEN));
  assert.match(text, /^ {2}written {6}STDLIB\.md {2}104 lines, 4436 bytes$/m);
  assert.match(flat(text), /3 packages logged as replaced across 2 runtime modules, and 1 dependency left in place with a table and no explanation\./);
  assert.match(flat(text), /The tables are derived and will be right\. The prose is not written: every heading that needs a sentence from you is marked TODO, and the last TODO is to delete the list\./);
  assert.equal(stdlibExitCode(runOf(RESULT.WRITTEN)), 0);
});

test('a document with nothing to log says so instead of printing three noughts', () => {
  const text = stdlibReport(runOf(RESULT.WRITTEN, { empty: true, replaced: 0, modules: 0, remaining: 4 }));
  assert.match(flat(text), /It logs no replacement, because this project depends on none of the packages nirdep replaces\. That is a result worth committing, and it is a short document\./);
  assert.equal(/0 packages logged/.test(text), false);
});

test('up to date is the one line with no byte count on it', () => {
  const text = stdlibReport(runOf(RESULT.SAME));
  assert.match(text, /^ {2}up to date {3}STDLIB\.md$/m);
  assert.equal(/104 lines/.test(text), false, 'nothing moved, so the size of it is not news');
  assert.equal(stdlibExitCode(runOf(RESULT.SAME)), 0);
});

test('a dry run says what it would have written and then says it did not', () => {
  const text = stdlibReport(runOf(RESULT.WOULD_WRITE));
  assert.match(text, /^ {2}would write {2}STDLIB\.md {2}104 lines, 4436 bytes$/m);
  assert.match(text, /^nothing was written: this was a dry run\.$/m);
  assert.equal(stdlibExitCode(runOf(RESULT.WOULD_WRITE)), 0);
});

test('a refusal is the user to resolve and a failure is ours, and the codes say which', () => {
  const refused = stdlibReport(runOf(RESULT.REFUSED, { reason: 'it is there and says something else; --force to replace it' }));
  assert.match(refused, /^ {2}refused {6}STDLIB\.md {2}104 lines, 4436 bytes$/m);
  assert.match(refused, /^ {15}it is there and says something else; --force to replace it$/m);
  // Nothing about what the document contains: it is not going anywhere, so that would be a
  // paragraph about a file that does not exist.
  assert.equal(/logged as replaced/.test(refused), false);
  assert.equal(stdlibExitCode(runOf(RESULT.REFUSED)), 2);

  const failed = stdlibReport(runOf(RESULT.FAILED, { reason: 'EROFS: read-only file system' }));
  assert.match(failed, /^ {2}failed {7}STDLIB\.md {2}104 lines, 4436 bytes$/m);
  assert.match(failed, /^ {15}EROFS: read-only file system$/m);
  assert.equal(stdlibExitCode(runOf(RESULT.FAILED)), 1);
});

test('styling adds bytes and no lines', () => {
  const style = { bold: (t) => `<b>${t}</b>`, dim: (t) => `<d>${t}</d>`, cyan: (t) => t, yellow: (t) => `<y>${t}</y>`, green: (t) => `<g>${t}</g>`, red: (t) => t };
  const plain = stdlibReport(runOf(RESULT.WRITTEN));
  const painted = stdlibReport(runOf(RESULT.WRITTEN), { style });
  assert.equal(painted.split('\n').length, plain.split('\n').length, 'the folding is measured before it is painted');
  assert.match(painted, /<b>STDLIB\.md<\/b>/);
});
