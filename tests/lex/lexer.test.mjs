// The lexer's own tests. Two kinds of check: a hand-written token table for the cases
// where JavaScript cannot be tokenised without context, and a property that has to
// hold over every file in this repository — the token ranges must reassemble the file
// byte for byte, because the patcher downstream edits by byte range and never prints
// code back out.
//
// The token table lives in tests/vectors/lex/tokens.json rather than inline. Several
// of its cases are import statements, and tools/verify.mjs reads .mjs files looking
// for exactly that shape: a fixture that looked like a dependency would make the
// dependency proof lie about this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  KIND, KEYWORDS, LexError, lex, stringValue, positionAt, accountsForEverySource,
} from '../../src/lex/lexer.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const table = JSON.parse(readFileSync(join(ROOT, 'tests/vectors/lex/tokens.json'), 'utf8'));

/** Every .mjs file in the repository, which is the corpus for the round-trip. */
function sources(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

/** `kind:value` per token, comments and the end marker excluded: the table's shape. */
const shape = (result) => result.tokens
  .filter((one) => one.kind !== KIND.EOF)
  .map((one) => `${one.kind}:${one.value}`);

// `assert.throws` does not hand back the error, and every check here is about the
// error's own fields rather than its message.
const caught = (work) => {
  try {
    work();
    return null;
  } catch (error) {
    return error;
  }
};

test('every .mjs file in this repository lexes, and the tokens reassemble it exactly', () => {
  const files = sources();
  assert.ok(files.length >= 20, `${files.length} files in the corpus`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const where = relative(ROOT, file);
    const result = lex(source);
    assert.equal(accountsForEverySource(result), true, `${where} reassembles from its ranges`);
    assert.deepEqual([...result.unclosed], [], `${where} closes every context it opens`);
    const last = result.tokens.at(-1);
    assert.equal(last.kind, KIND.EOF, `${where} ends with an end marker`);
    assert.equal(last.start, source.length, `${where} marks the end at the end`);
  }
});

test('the token table, case by case', () => {
  assert.ok(table.cases.length >= 45, `${table.cases.length} cases`);
  for (const row of table.cases) {
    assert.deepEqual(shape(lex(row.in)), row.out, `${row.why}: ${JSON.stringify(row.in)}`);
  }
});

test('input that cannot be tokenised fails with a code and a position', () => {
  assert.ok(table.errors.length >= 9, `${table.errors.length} error cases`);
  for (const row of table.errors) {
    const error = caught(() => lex(row.in));
    assert.ok(error instanceof LexError, `${JSON.stringify(row.in)} throws a LexError`);
    assert.equal(error.code, row.code, JSON.stringify(row.in));
    assert.equal(error.name, 'LexError');
    assert.ok(error instanceof SyntaxError, 'a LexError is a SyntaxError, so existing catch blocks still catch it');
    assert.equal(typeof error.line, 'number');
    assert.equal(typeof error.column, 'number');
    assert.equal(typeof error.offset, 'number');
  }
});

test('an unterminated construct is reported where it opened, not at the end of the file', () => {
  // The offset of the failure is the offset a diff would point at. Reporting the end
  // of the file instead is technically true and useless: the quote that never closed is
  // the thing the reader has to find.
  const string = caught(() => lex('let a = 1;\nlet b = \'abc'));
  assert.equal(string.code, 'UNTERMINATED_STRING');
  assert.deepEqual([string.line, string.column], [2, 9]);
  const comment = caught(() => lex('a;\n/* b'));
  assert.equal(comment.code, 'UNTERMINATED_COMMENT');
  assert.deepEqual([comment.line, comment.column], [2, 1]);
  // A line break inside a string is the other kind of failure, and there the useful
  // position is the break itself rather than the opening quote.
  const broken = caught(() => lex('let a = \'abc\nlet b = 2;'));
  assert.equal(broken.code, 'UNTERMINATED_STRING');
  assert.deepEqual([broken.line, broken.column], [1, 13]);
});

test('a truncated file reports the contexts it left open rather than guessing', () => {
  // `nirdep apply` refuses to patch a file whose contexts do not close, because the
  // brace and paren stack is what makes the slash and brace answers trustworthy: if the
  // stack is wrong at the end it may have been wrong in the middle.
  assert.deepEqual([...lex('function f() {').unclosed], ['block']);
  assert.deepEqual([...lex('x = {a: (1').unclosed], ['object', 'paren']);
  assert.deepEqual([...lex('x = [1,').unclosed], ['bracket']);
  assert.deepEqual([...lex('if (a) { b(); }').unclosed], []);
});

test('comments stay out of the token stream and still account for their bytes', () => {
  const result = lex('a; // one\n/* two\nthree */ b;');
  assert.deepEqual(shape(result), ['name:a', 'punct:;', 'name:b', 'punct:;']);
  assert.deepEqual(result.comments.map((one) => one.block), [false, true]);
  assert.equal(result.comments[0].value, '// one');
  assert.equal(result.comments[1].value, '/* two\nthree */');
  assert.equal(accountsForEverySource(result), true, 'the comment bytes are accounted for');
  // The line count has to survive a multi-line comment, or every position after it lies.
  assert.equal(result.tokens.find((one) => one.value === 'b').line, 3);
});

test('a shebang is its own token and does not make the next slash a division', () => {
  const result = lex('#!/usr/bin/env node\n/a/.test(b)');
  assert.equal(result.tokens[0].kind, KIND.SHEBANG);
  assert.equal(result.tokens[0].value, '#!/usr/bin/env node');
  assert.equal(result.tokens[1].kind, KIND.REGEXP, 'the line after a shebang starts a statement');
  assert.equal(accountsForEverySource(result), true);
});

test('stringValue reads the specifier out of a quoted token', () => {
  // This is the function that turns a quoted token into the name of a package, so an
  // escape it decoded wrongly would be a dependency left behind under a success report.
  const value = (text) => stringValue(lex(`x = ${text}`).tokens[2]);
  assert.equal(value("'chalk'"), 'chalk');
  assert.equal(value('"./a.mjs"'), './a.mjs');
  assert.equal(value("'a\\nb'"), 'a\nb');
  assert.equal(value("'a\\'b'"), "a'b");
  assert.equal(value("'a\\\\b'"), 'a\\b');
  assert.equal(value("'\\u0061\\u{62}\\x63'"), 'abc');
  assert.equal(value("'a\\\nb'"), 'ab', 'a backslash before a line break is a continuation');
  assert.equal(value("'\\q'"), 'q', 'an escape with no meaning is the character itself');
  assert.equal(value('`plain`'), 'plain', 'a template with no substitution has one value');
  const parted = lex('`a${b}c`');
  assert.equal(stringValue(parted.tokens[0]), 'a', 'the head keeps only its literal text');
  assert.equal(stringValue(parted.tokens[2]), 'c', 'and the tail its own');
});

test('a template records which piece of itself each token is', () => {
  const parts = (text) => lex(text).tokens
    .filter((one) => one.kind === KIND.TEMPLATE)
    .map((one) => one.part);
  assert.deepEqual(parts('`a`'), ['full']);
  assert.deepEqual(parts('`a${b}`'), ['head', 'tail']);
  assert.deepEqual(parts('`a${b}c${d}e`'), ['head', 'middle', 'tail']);
  assert.deepEqual(parts('`a${`b`}c`'), ['head', 'full', 'tail'], 'the inner template is whole');
});

test('positionAt agrees with the position every token recorded for itself', () => {
  // Two paths to the same answer: the scanner counts lines as it goes, and positionAt
  // searches the line table afterwards. A codemod uses the second for offsets it
  // computed itself, so the two must not drift.
  const source = readFileSync(join(ROOT, 'src/lex/lexer.mjs'), 'utf8');
  const result = lex(source);
  for (const token of result.tokens) {
    const at = positionAt(result, token.start);
    assert.equal(at.line, token.line, `line at offset ${token.start}`);
    assert.equal(at.column, token.column, `column at offset ${token.start}`);
  }
  assert.equal(result.lineStarts.length, source.split('\n').length);
  assert.deepEqual(positionAt(result, 0), { line: 1, column: 1, offset: 0 });
});

test('newlineBefore marks the tokens a statement could begin at', () => {
  // Automatic semicolon insertion is a parser's problem, but the codemod needs to know
  // whether it may put a statement in front of a token, and that is this flag.
  assert.deepEqual(lex('a\nb;\nc').tokens.map((one) => one.newlineBefore), [
    false, true, false, true, false,
  ]);
  assert.deepEqual(lex('a b').tokens.map((one) => one.newlineBefore), [false, false, false]);
});

test('the keyword set answers what a keyword is, and the contextual words are not in it', () => {
  assert.equal(KEYWORDS.has('const'), true);
  assert.equal(KEYWORDS.has('await'), true, 'reserved inside a module, so treated as reserved');
  assert.equal(KEYWORDS.has('as'), false, 'a clause word in an import and a plain name elsewhere');
  assert.equal(KEYWORDS.has('from'), false);
  assert.equal(KEYWORDS.has('of'), false);
  assert.equal(KEYWORDS.has('undefined'), false, 'a global binding, not a keyword');
  assert.equal(Object.isFrozen(KEYWORDS), true);
  assert.equal(Object.isFrozen(KIND), true);
});

test('the result is frozen, and lex refuses anything that is not a string', () => {
  const result = lex('a;');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tokens), true);
  assert.equal(result.source, 'a;');
  for (const junk of [null, undefined, 42, {}, [], () => {}]) {
    const error = caught(() => lex(junk));
    assert.ok(error instanceof LexError, `${String(junk)} is refused`);
    assert.equal(error.code, 'NOT_A_STRING');
  }
  assert.deepEqual(shape(lex('')), [], 'an empty file has no tokens and is not an error');
  assert.equal(lex('').tokens.length, 1, 'only the end marker');
});

test('a character that starts nothing is a failure, and a lone # is a punctuator', () => {
  const error = caught(() => lex('a \\ b'));
  assert.equal(error.code, 'UNKNOWN_CHARACTER');
  assert.deepEqual([error.line, error.column], [1, 3]);
  // BAD_PRIVATE_NAME is defensive: the scanner only enters the name reader for a `#`
  // that is followed by a name, so a bare `#` arrives at the punctuator reader instead.
  // Recorded here rather than left as an unexplained unreachable branch.
  assert.deepEqual(shape(lex('a # b')), ['name:a', 'punct:#', 'name:b']);
});
