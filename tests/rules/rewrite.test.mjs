// The codemod's expectations. The table lives next door in JSON; this runs it.
//
// Two kinds of assertion, and the second one is the point. The vector table checks that
// the right thing happens to each shape of import. The properties after it check things
// no table can: that every refusal carries a line and a sentence, that no rewrite is ever
// partial, and that the patched text of every rewrite still parses. A codemod that passes
// a table of thirty cases and produces unparseable output on the thirty-first is not
// nearly correct, it is broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DECLINE, planFile, rewriteSource } from '../../src/rules/rewrite.mjs';
import { RULES, ACTION } from '../../src/rules/registry.mjs';
import { checkSyntax } from '../../src/patch/gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'rules', 'rewrite.json'), 'utf8'));

const shape = (one) => `${one.code}|${one.specifier ?? 'null'}|${one.line}`;
const changed = (one) => `${one.specifier}|${one.target}`;

test('every case in the vector table', () => {
  for (const one of VECTORS.cases) {
    const plan = planFile(one.in, { file: 'case.mjs' });
    if (one.out !== undefined) {
      assert.equal(rewriteSource(one.in, { file: 'case.mjs' }), one.out, one.why);
    }
    if (one.changes !== undefined) {
      assert.deepEqual(plan.changes.map(changed), one.changes, one.why);
    }
    if (one.declined !== undefined) {
      assert.deepEqual(plan.declined.map(shape), one.declined, one.why);
      assert.equal(plan.changes.length, 0, `${one.why}: a refused file must not also report a change`);
    }
  }
});

test('the table covers every decline code the module defines', () => {
  const seen = new Set(VECTORS.cases.flatMap((one) => (one.declined ?? []).map((row) => row.split('|')[0])));
  // UNREADABLE is exercised below rather than in the table: the table's inputs are all
  // lexable by construction, which is what makes it a table of rewrites.
  for (const code of Object.values(DECLINE)) {
    if (code === DECLINE.UNREADABLE) continue;
    assert.ok(seen.has(code), `no vector produces a ${code} decline`);
  }
});

test('every refusal says where and why, in a sentence', () => {
  for (const one of VECTORS.cases) {
    for (const row of planFile(one.in, { file: 'case.mjs' }).declined) {
      assert.ok(Number.isInteger(row.line) && row.line >= 0, `${one.why}: a decline needs a line`);
      assert.equal(typeof row.detail, 'string');
      assert.ok(row.detail.length > 30, `${one.why}: "${row.detail}" is not an explanation`);
      assert.ok(Object.values(DECLINE).includes(row.code));
    }
  }
});

test('every rewrite this table produces still parses', () => {
  for (const one of VECTORS.cases) {
    const after = rewriteSource(one.in, { file: 'case.mjs' });
    if (after === one.in) continue;
    const verdict = checkSyntax(after, { kind: 'module', filename: 'case.mjs' });
    assert.ok(verdict.ok, `${one.why}: the rewrite does not parse (${verdict.error?.message})`);
  }
});

test('a rewrite is all of a statement or none of it', () => {
  // The declining half of a statement must take the specifier edit down with it, or the
  // file ends up pointing half its names at a module that does not have them.
  const cases = VECTORS.cases.filter((one) => one.declined !== undefined);
  assert.ok(cases.length > 0);
  for (const one of cases) {
    assert.equal(rewriteSource(one.in, { file: 'case.mjs' }), one.in, `${one.why}: text changed anyway`);
  }
});

test('unlexable input is declined, not thrown', () => {
  // An unterminated string is the cheapest way to make the lexer give up.
  const plan = planFile("const a = 'oh\n", { file: 'broken.mjs' });
  assert.equal(plan.patch, null);
  assert.equal(plan.readable, false);
  assert.equal(plan.declined[0].code, DECLINE.UNREADABLE);
  assert.equal(rewriteSource("const a = 'oh\n"), "const a = 'oh\n");
});

test('the resolve hook decides the target, and the report says what it decided', () => {
  const source = VECTORS.cases[0].in;
  const plan = planFile(source, { file: 'src/deep/a.mjs', resolve: () => '../../vendor/colour.mjs' });
  assert.equal(plan.changes[0].target, '../../vendor/colour.mjs');
  assert.ok(rewriteSource(source, { resolve: () => '../../vendor/colour.mjs' }).includes('../../vendor/colour.mjs'));
});

test('a plan is frozen, so a report cannot be edited into agreement with itself', () => {
  const plan = planFile(VECTORS.cases[0].in, { file: 'case.mjs' });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.changes));
  assert.ok(Object.isFrozen(plan.declined));
  assert.throws(() => { plan.changes.push({}); }, TypeError);
});

test('every advise rule declines with its own advice, and never rewrites', () => {
  for (const rule of RULES) {
    if (rule.action !== ACTION.ADVISE) continue;
    // The statement comes from the vector table with the package name substituted in, so
    // a new advise entry cannot be added without a test noticing, and so this file holds
    // no import-shaped text of its own for tools/verify.mjs to find.
    const source = VECTORS.adviceTemplate.replace('{package}', rule.package);
    const plan = planFile(source, { file: 'advice.mjs' });
    assert.equal(plan.changes.length, 0, `${rule.package} was rewritten`);
    assert.equal(plan.declined.length, 1, `${rule.package} said nothing`);
    assert.equal(plan.declined[0].code, DECLINE.ADVICE);
    assert.equal(plan.declined[0].detail, rule.advice);
  }
});

test('the empty file plans nothing and reports nothing', () => {
  const plan = planFile('', { file: 'empty.mjs' });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.declined.length, 0);
  assert.equal(plan.readable, true);
});
