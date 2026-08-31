// The syntax gate's tests. The one that matters most is the last: every file in this
// repository goes through the gate, so the check that guards other people's code is
// held to the same standard by our own.
//
// Sources here are written in module grammar wherever possible. A script-grammar sample
// wants a loader call, and a loader call spelled out in a .mjs file is exactly the shape
// tools/verify.mjs reads as a dependency -- so the script cases use plain `var` and a
// function instead, which is script grammar without the trap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { KIND, METHOD, checkByLexer, checkSyntax, gate, kindFor } from '../../src/patch/gate.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PARSERS = new Set([METHOD.VM_MODULE, METHOD.NODE_CHECK]);

function sources(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

test('valid module source passes, whichever door was open', () => {
  const verdict = checkSyntax('export const a = 1;\nexport default a;\n');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.error, null);
  assert.ok(PARSERS.has(verdict.method), `${verdict.method} is a real parser`);
});

test('broken module source fails with a message and a position', () => {
  const verdict = checkSyntax('export const = 1;\n');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error.message, "Unexpected token '='");
  assert.equal(verdict.error.line, 1);
  assert.ok(verdict.error.column > 0, 'a column was found');
});

test('the position is the line that is wrong, not the line the file starts on', () => {
  const { error } = checkSyntax('const a = 1;\nconst b = 2;\nconst = 3;\n');
  assert.equal(error.line, 3);
});

test('the lexer catches unclosed brackets on its own, without spawning anything', () => {
  const verdict = checkSyntax('export function f() {\n  return 1;\n');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.method, METHOD.LEX);
  assert.match(verdict.error.message, /unclosed/);
});

test('source the lexer cannot tokenise is broken and needs no second opinion', () => {
  const verdict = checkSyntax('export const s = "never closed;\n');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.method, METHOD.LEX);
  assert.equal(verdict.error.line, 1);
});

test('script grammar is checked as script grammar', () => {
  const ok = checkSyntax('var a = 1;\nfunction f() { return a; }\n', { kind: KIND.SCRIPT });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, METHOD.VM_SCRIPT);
  const bad = checkSyntax('export const a = 1;\n', { kind: KIND.SCRIPT });
  assert.equal(bad.ok, false);
  assert.equal(bad.method, METHOD.VM_SCRIPT);
  assert.match(bad.error.message, /export/);
});

test('a caller that passes something other than a string gets a verdict, not a throw', () => {
  const verdict = checkSyntax(42);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error.message, /source text/);
});

test('the extension decides the grammar when it can, and defers when it cannot', () => {
  assert.equal(kindFor('a/b.mjs'), KIND.MODULE);
  assert.equal(kindFor('a/b.cjs'), KIND.SCRIPT);
  assert.equal(kindFor('a/b.mjs', 'commonjs'), KIND.MODULE);
  assert.equal(kindFor('a/b.js'), KIND.SCRIPT);
  assert.equal(kindFor('a/b.js', 'module'), KIND.MODULE);
});

test('a patch that keeps the file parsing is waved through', () => {
  const result = gate('export const a = 1;\n', 'export const alpha = 1;\n');
  assert.equal(result.ok, true);
  assert.equal(result.parsed, true);
  assert.equal(result.wasBroken, false);
  assert.equal(result.blame, null);
});

test('a patch that breaks the file is blamed on the patch', () => {
  const result = gate('export const a = 1;\n', 'export const = 1;\n');
  assert.equal(result.ok, false);
  assert.equal(result.blame, 'patch');
  assert.equal(result.wasBroken, false);
  assert.equal(result.after.error.line, 1);
});

test('a file that was already broken is not blamed on the patch', () => {
  const result = gate('export const = 1;\n', 'export const = 2;\n');
  assert.equal(result.ok, false);
  assert.equal(result.blame, 'source');
  assert.equal(result.wasBroken, true);
});

test('a verdict cannot be edited after the fact', () => {
  const verdict = checkSyntax('export const a = 1;\n');
  assert.equal(Object.isFrozen(verdict), true);
  assert.throws(() => { verdict.ok = false; }, TypeError);
});

test('every module in this repository passes its own gate', () => {
  for (const file of sources()) {
    const verdict = checkSyntax(readFileSync(file, 'utf8'), { filename: file });
    assert.equal(verdict.ok, true, `${relative(ROOT, file)}: ${verdict.error?.message ?? 'ok'}`);
  }
});

// The lexer-only check exists for one host: a browser, where compiling without running is
// not on offer. These tests pin what it can and cannot promise, because a check that
// over-claims is worse than no check at all.

test('the lexer-only check passes real source and says who checked it', () => {
  const verdict = checkByLexer('export const a = `${1}`;\n');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.method, METHOD.LEX);
});

test('the lexer-only check still catches what a lexer can see', () => {
  const verdict = checkByLexer('export const a = "unterminated\n');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.method, METHOD.LEX);
  assert.equal(verdict.error.line, 1);
  assert.equal(checkByLexer('function a() {\n').ok, false, 'an unclosed brace is a run it can count');
});

test('the lexer-only check admits what it cannot see, rather than pretending', () => {
  // Grammar, not tokens: this is a SyntaxError to Node and four fine tokens to a lexer.
  assert.equal(checkByLexer('let let = 1;\n').ok, true);
  assert.equal(checkSyntax('let let = 1;\n').ok, false, 'and the real gate does catch it');
});

test('an injected check is the one that runs, and the verdict names it', () => {
  const result = gate('export const = 1;\n', 'export const = 2;\n', { check: checkByLexer });
  assert.equal(result.ok, true, 'the lexer has no complaint about either side');
  assert.equal(result.before.method, METHOD.LEX);
  assert.equal(gate('a\n', 'a\n').before.method !== METHOD.LEX, true, 'and the default is still a parser');
});
