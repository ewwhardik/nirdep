// The no-regex claim, checked with our own lexer.
//
// Two runtime modules replace a pattern matcher, and both were written without a regular
// expression on purpose. CVE-2022-25883 in semver, CVE-2022-3517 in minimatch,
// CVE-2020-28469 in glob-parent, CVE-2024-4068 in braces and CVE-2021-3807 in ansi-regex are
// one bug five times: a pattern compiled to a backtracking engine, then handed input
// somebody else chose. A matcher that walks a segment at a time and never backtracks cannot
// have that bug, which is a better answer than a fixed version number -- and a claim worth
// making only if it is still true after the next refactor.
//
// So it is checked, and checked by lexing rather than by searching: `/` is division, a
// comment and a regexp, and only a tokeniser knows which. src/lex is this project's own
// lexer, so the proof runs on a file the project already had to be right about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KIND, lex } from '../../src/lex/lexer.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The modules that replace a pattern matcher, and so carry the claim. */
const MATCHERS = Object.freeze(['src/runtime/semver.mjs', 'src/runtime/glob.mjs']);

const tokensOf = (path) => lex(readFileSync(join(ROOT, path), 'utf8')).tokens;
const kind = (tokens, want) => tokens.filter((token) => token.kind === want);
const named = (tokens, want) => tokens.filter((token) => token.kind === KIND.NAME && token.value === want);

test('neither matcher contains a regular expression literal', () => {
  for (const path of MATCHERS) {
    const found = kind(tokensOf(path), KIND.REGEXP).map((token) => token.value);
    assert.deepEqual(found, [], `${path} has a regexp literal`);
  }
});

test('and neither reaches the constructor instead', () => {
  // The literal is the obvious way in. `new RegExp(...)` is the way around a test that only
  // looked for the literal, so it is closed here rather than left to good intentions.
  for (const path of MATCHERS) {
    assert.equal(named(tokensOf(path), 'RegExp').length, 0, `${path} names RegExp`);
  }
});

test('the claim is about the real files, not empty ones', () => {
  // A refactor that satisfied the two tests above by deleting the matcher would be a green
  // run with nothing left to match, so the floor is high enough that only the matcher clears it.
  for (const path of MATCHERS) {
    const count = tokensOf(path).length;
    assert.ok(count > 5000, `${path} lexed to ${count} tokens, which is too few to be the matcher`);
  }
});

test('collect copies a caller regexp and authors none of its own', () => {
  // runtime/collect is not a matcher and makes the narrower claim: cloneDeep has to reproduce
  // a RegExp somebody handed it, which is `new RegExp(value.source, value.flags)` and has
  // nothing to do with compiling a pattern of ours. What it must not do is write one --
  // lodash's own trim backtracked (CVE-2020-28500) and its template compiled its input
  // (CVE-2021-23337), and this module answers both by not having the machinery.
  const tokens = tokensOf('src/runtime/collect.mjs');
  assert.deepEqual(kind(tokens, KIND.REGEXP).map((token) => token.value), [], 'no regexp literal');
  assert.equal(named(tokens, 'RegExp').length, 1, 'one mention of RegExp, and it is the clone');
});
