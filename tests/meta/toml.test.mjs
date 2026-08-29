import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, TomlError } from '../../src/meta/toml.mjs';

/** node:assert's throws() does not hand back the error, and we want to inspect it. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}


test('scalars', () => {
  assert.deepEqual({ ...parseToml('a = "x"') }, { a: 'x' });
  assert.deepEqual({ ...parseToml("a = 'x\\ny'") }, { a: 'x\\ny' });
  assert.deepEqual({ ...parseToml('a = true\nb = false') }, { a: true, b: false });
  assert.deepEqual({ ...parseToml('a = 0') }, { a: 0 });
  assert.deepEqual({ ...parseToml('a = -17') }, { a: -17 });
  assert.deepEqual({ ...parseToml('a = 1_000_000') }, { a: 1000000 });
  assert.deepEqual({ ...parseToml('a = 0xDEAD_beef') }, { a: 0xdeadbeef });
  assert.deepEqual({ ...parseToml('a = 0o755') }, { a: 0o755 });
  assert.deepEqual({ ...parseToml('a = 0b1011') }, { a: 0b1011 });
  assert.deepEqual({ ...parseToml('a = 3.1415') }, { a: 3.1415 });
  assert.deepEqual({ ...parseToml('a = 5e+22') }, { a: 5e22 });
  assert.equal(parseToml('a = inf').a, Infinity);
  assert.equal(parseToml('a = -inf').a, -Infinity);
  assert.ok(Number.isNaN(parseToml('a = nan').a));
});

test('escapes in basic strings', () => {
  assert.equal(parseToml('a = "tab\\there"').a, 'tab\there');
  assert.equal(parseToml('a = "quote\\"inside"').a, 'quote"inside');
  assert.equal(parseToml('a = "\\u00e9"').a, 'é');
  assert.equal(parseToml('a = "\\U0001F600"').a, '\u{1F600}');
  assert.throws(() => parseToml('a = "\\q"'), TomlError);
});

test('literal strings do not process escapes', () => {
  assert.equal(parseToml("path = 'C:\\Users\\zxark'").path, 'C:\\Users\\zxark');
});

test('multi-line strings', () => {
  assert.equal(parseToml('a = """\nfirst\nsecond"""').a, 'first\nsecond');
  // A trailing backslash swallows the newline and the indent that follows it.
  assert.equal(parseToml('a = """\none \\\n    two"""').a, 'one two');
  // Up to five quotes may close: the surplus is content.
  assert.equal(parseToml('a = """say ""hi"""').a, 'say ""hi');
  assert.equal(parseToml("a = '''raw\\nkept'''").a, 'raw\\nkept');
  assert.throws(() => parseToml('a = """unterminated'), TomlError);
});

test('the first newline after """ is stripped, later ones are not', () => {
  assert.equal(parseToml('a = """\n\nleading blank kept"""').a, '\nleading blank kept');
});

test('keys', () => {
  assert.deepEqual({ ...parseToml('bare-key_1 = 1') }, { 'bare-key_1': 1 });
  assert.deepEqual({ ...parseToml('"quoted key" = 1') }, { 'quoted key': 1 });
  assert.equal(parseToml('a.b.c = 1').a.b.c, 1);
  assert.equal(parseToml('a . b = 1').a.b, 1, 'whitespace around dots is allowed');
  assert.throws(() => parseToml('= 1'), TomlError);
  assert.throws(() => parseToml('a = 1\na = 2'), /duplicate key a/);
});

test('arrays', () => {
  assert.deepEqual(parseToml('a = []').a, []);
  assert.deepEqual(parseToml('a = [1, 2, 3]').a, [1, 2, 3]);
  assert.deepEqual(parseToml('a = [1, 2, 3,]').a, [1, 2, 3], 'trailing comma');
  assert.deepEqual(parseToml('a = [\n  1,\n  # a comment\n  2,\n]').a, [1, 2]);
  assert.deepEqual(parseToml('a = [[1], ["x"]]').a, [[1], ['x']]);
  assert.throws(() => parseToml('a = [1 2]'), TomlError);
  assert.throws(() => parseToml('a = [1,'), TomlError);
});

test('inline tables', () => {
  assert.deepEqual({ ...parseToml('a = {}').a }, {});
  assert.equal(parseToml('a = { b = 1, c = "x" }').a.c, 'x');
  assert.equal(parseToml('a = { b.c = 1 }').a.b.c, 1);
  assert.throws(() => parseToml('a = { b = 1'), TomlError);
});

test('tables and arrays of tables', () => {
  const doc = parseToml('[a]\nx = 1\n\n[a.b]\ny = 2\n');
  assert.equal(doc.a.x, 1);
  assert.equal(doc.a.b.y, 2);

  const many = parseToml('[[p]]\nn = 1\n[[p]]\nn = 2\n[p.q]\nr = 3\n');
  assert.equal(many.p.length, 2);
  assert.equal(many.p[1].n, 2);
  assert.equal(many.p[1].q.r, 3, 'a sub-table attaches to the most recent element');

  assert.throws(() => parseToml('[a]\n[[a]]\n'), /array of tables/);
  assert.throws(() => parseToml('[a\n'), /unterminated table header/);
});

test('comments and blank lines are ignored', () => {
  const doc = parseToml('# lead\n\n  # indented\na = 1 # trailing\n\n# tail\n');
  assert.deepEqual({ ...doc }, { a: 1 });
});

test('a byte-order mark is tolerated', () => {
  assert.deepEqual({ ...parseToml('﻿a = 1') }, { a: 1 });
});

test('unsupported constructs refuse with a position rather than guessing', () => {
  const error = caught(() => parseToml('\n\nwhen = 2026-08-29\n'));
  assert.ok(error instanceof TomlError);
  assert.equal(error.line, 3);
  assert.equal(error.column, 8);
  assert.match(error.message, /dates and times are not supported/);
  assert.throws(() => parseToml('a = 12:30:00'), /not supported/);
});

test('errors carry line and column from the first character', () => {
  const error = caught(() => parseToml('a = 1\nb = @'));
  assert.ok(error instanceof TomlError);
  assert.equal(error.line, 2);
  assert.match(error.message, /line 2, column 5/);
});

test('the shipped .zero-dep.toml parses', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../../.zero-dep.toml', import.meta.url));
  const doc = parseToml(readFileSync(path, 'utf8'));
  assert.equal(doc.track, 'A');
  assert.equal(doc.team.solo, true);
  assert.deepEqual(doc.team.members, ['Hardik']);
  assert.equal(doc.bonuses.single_file, false);
});
