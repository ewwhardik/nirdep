// Binding resolution's tests. Three kinds of check: the hand-written expectation table
// next door, properties that must hold over every file in this repository, and the
// helper functions a codemod actually calls.
//
// The table lives in tests/vectors/lex/bindings.json for the same reason the token
// table does: many of its cases are import statements, and tools/verify.mjs reads .mjs
// files looking for exactly that shape. A fixture that looked like a dependency would
// make the dependency proof lie about this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { lex } from '../../src/lex/lexer.mjs';
import {
  BINDING, FORM, analyse, lookup, referencesTo, renameSites, dependenciesOn, usesOf, freeName,
} from '../../src/lex/bindings.mjs';
import { findSpecifiers } from '../../src/audit/imports.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const table = JSON.parse(readFileSync(join(ROOT, 'tests/vectors/lex/bindings.json'), 'utf8'));

/** Every .mjs file in the repository, which is the corpus for the properties. */
function sources(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

const shapeBindings = (analysis) => analysis.bindings.map((one) => `${one.name}:${one.kind}`);

const shapeRefs = (analysis) => analysis.references
  .map((one) => `${one.name}->${one.binding === null ? 'free' : one.binding}`);

const shapeDeps = (analysis) => analysis.dependencies
  .map((one) => `${one.specifier}|${one.form}|${one.bindings.join(',')}`);

test('the expectation table, case by case', () => {
  assert.ok(table.cases.length >= 40, `${table.cases.length} cases`);
  for (const row of table.cases) {
    const analysis = analyse(row.in);
    const where = `${row.why}: ${JSON.stringify(row.in)}`;
    if (row.bindings) assert.deepEqual(shapeBindings(analysis), row.bindings, `bindings — ${where}`);
    if (row.refs) assert.deepEqual(shapeRefs(analysis), row.refs, `references — ${where}`);
    if (row.deps) assert.deepEqual(shapeDeps(analysis), row.deps, `dependencies — ${where}`);
    if (row.unresolved) assert.deepEqual([...analysis.unresolved], row.unresolved, `unresolved — ${where}`);
  }
});

test('a specifier that is not a literal string is reported, not rewritten', () => {
  // The honest failure. A codemod that guessed at a computed specifier would edit the
  // wrong module; one that ignored it silently would report a clean file that is not.
  for (const row of table.unanalysable) {
    const analysis = analyse(row.in);
    const where = `${row.why}: ${JSON.stringify(row.in)}`;
    assert.equal(analysis.dependencies.length, 0, `nothing to rewrite — ${where}`);
    assert.ok(analysis.unanalysable.length >= 1, `recorded — ${where}`);
    assert.equal(analysis.unanalysable[0].form, row.form, `form — ${where}`);
    assert.equal(typeof analysis.unanalysable[0].line, 'number', `line — ${where}`);
    assert.match(analysis.unanalysable[0].reason, /not a literal string/u, `reason — ${where}`);
  }
});

test('every .mjs file in this repository analyses, and its ranges hold the names they claim', () => {
  const files = sources();
  assert.ok(files.length >= 20, `${files.length} files in the corpus`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const where = relative(ROOT, file);
    const analysis = analyse(source);
    for (const record of analysis.bindings) {
      assert.equal(source.slice(record.start, record.end), record.name, `${where} binding ${record.name}`);
    }
    for (const reference of analysis.references) {
      assert.equal(source.slice(reference.start, reference.end), reference.name, `${where} reference ${reference.name}`);
      assert.ok(reference.binding === null || analysis.bindings[reference.binding] !== undefined, `${where} resolves into the binding list`);
      if (reference.binding !== null) {
        assert.equal(analysis.bindings[reference.binding].name, reference.name, `${where} resolved to its own name`);
      }
    }
    for (const dependency of analysis.dependencies) {
      const quoted = source.slice(dependency.specifierRange.start, dependency.specifierRange.end);
      assert.equal(quoted.slice(1, -1), dependency.specifier, `${where} specifier range`);
      assert.ok(dependency.statement.start <= dependency.specifierRange.start, `${where} statement encloses its specifier`);
      assert.ok(dependency.statement.end >= dependency.specifierRange.end, `${where} statement encloses its specifier`);
    }
  }
});

test('the analyser never claims a specifier the blunt scanner did not also see', () => {
  // The proof scanner in src/audit is deliberately over-eager: it reports import-shaped
  // text anywhere, comments included. This analyser understands the grammar and so must
  // find a subset. If it ever found something the scanner did not, the two disagree
  // about what a dependency is and the proof stops being a proof.
  for (const file of sources()) {
    const source = readFileSync(file, 'utf8');
    const blunt = new Set(findSpecifiers(source).map((one) => one.specifier));
    for (const dependency of analyse(source).dependencies) {
      assert.ok(blunt.has(dependency.specifier), `${relative(ROOT, file)}: ${dependency.specifier} seen by both`);
    }
  }
});

test('every unresolved name in this repository is a global, not a name we lost', () => {
  // The strongest single check on the scope tree. A local name that leaked into the
  // unresolved list would mean a reference resolved to nothing and a rename would miss
  // it, which is the failure that breaks someone's build.
  const globals = new Set(Object.getOwnPropertyNames(globalThis));
  for (const extra of ['process', 'Buffer', 'URL', 'JSON', 'Math', 'undefined', 'NaN', 'Infinity']) globals.add(extra);
  for (const file of sources()) {
    const analysis = analyse(readFileSync(file, 'utf8'));
    for (const name of analysis.unresolved) {
      assert.ok(globals.has(name), `${relative(ROOT, file)}: ${name} is a global`);
    }
  }
});

test('analyse takes a lex result as well as source, and returns the same answer', () => {
  const source = 'const a = 1;\na;\n';
  const fromText = analyse(source);
  const fromTokens = analyse(lex(source));
  assert.deepEqual(shapeBindings(fromTokens), shapeBindings(fromText));
  assert.deepEqual(shapeRefs(fromTokens), shapeRefs(fromText));
  assert.equal(fromTokens.result.source, source);
});

test('lookup answers what a name means from a given scope', () => {
  const analysis = analyse(table.fixtures.shadowedParameter);
  const inner = analysis.scopes.find((scope) => scope.kind === 'function');
  assert.equal(lookup(analysis, 'a'), 0, 'the module scope has the outer one');
  assert.equal(lookup(analysis, 'a', inner.id), 2, 'the function scope has its parameter');
  assert.equal(lookup(analysis, 'f'), 1);
  assert.equal(lookup(analysis, 'nothing'), -1, 'a name nobody declared');
  assert.equal(lookup(analysis, 'a', 999), -1, 'a scope that does not exist');
});

test('referencesTo and renameSites give the byte ranges a rename would overwrite', () => {
  const source = table.fixtures.rename;
  const analysis = analyse(source);
  assert.equal(analysis.bindings[0].name, 'r');
  assert.equal(analysis.bindings[0].imported, 'red', 'the exported name is remembered and not renamed');
  const mine = referencesTo(analysis, 0);
  assert.equal(mine.length, 1, 'the shadowed use in the block is not mine');
  const sites = renameSites(analysis, 0);
  assert.equal(sites.length, 2, 'the local name and its one use');
  assert.equal(sites[0].declaration, true);
  for (const site of sites) assert.equal(source.slice(site.start, site.end), 'r');
  assert.deepEqual(sites.map((one) => one.start).sort((a, b) => a - b), sites.map((one) => one.start));
  assert.deepEqual(renameSites(analysis, 99), [], 'a binding that does not exist has no sites');
  // The declaration site is the local name only. Widening it over `red as r` would
  // change which export the file asked for.
  assert.equal(source.slice(sites[0].start - 3, sites[0].start), 'as ');
});

test('dependenciesOn and usesOf gather a specifier and everything it introduced', () => {
  const analysis = analyse(table.fixtures.twoUses);
  const found = dependenciesOn(analysis, 'chalk');
  assert.equal(found.length, 1);
  assert.equal(found[0].form, FORM.STATIC);
  assert.equal(found[0].line, 1);
  assert.deepEqual(dependenciesOn(analysis, 'nothing'), []);
  const uses = usesOf(analysis, 'chalk');
  assert.equal(uses.length, 1, 'one binding');
  assert.equal(uses[0].record.kind, BINDING.IMPORT);
  assert.equal(uses[0].references.length, 2, 'both call sites');
});

test('freeName avoids every name the file uses, declared or free', () => {
  const analysis = analyse('const style = 1;\nlet style2 = 2;\nconsole.log(style, style2, mention);\n');
  assert.equal(freeName(analysis, 'style'), 'style3', 'the first two are taken');
  assert.equal(freeName(analysis, 'mention'), 'mention2', 'a name only mentioned counts as taken');
  assert.equal(freeName(analysis, 'colour'), 'colour', 'an unused name is returned as it is');
  assert.equal(freeName(analysis, 'console'), 'console2', 'a global the file relies on is not shadowed');
  assert.equal(freeName(analyse('const a = 1;'), 'const'), 'const2', 'and never a keyword');
});

test('`of` is a name where a name belongs and grammar where grammar belongs', () => {
  // The for-of clause word ends a pattern, so a declarator that opens with it once ended
  // before it began: no binding, and every later use of the variable filed as a global.
  const analysis = analyse('const of = (x) => x;\nfor (const item of [1]) of(item);\n');
  assert.deepEqual(shapeBindings(analysis), ['of:const', 'x:param', 'item:const']);
  assert.deepEqual([...analysis.unresolved], [], 'the call resolves to the arrow');
  assert.equal(analysis.references.filter((one) => one.name === 'of').length, 1,
    'the clause word reads nothing, so it is not one of them');

  // And the reverse, absurd but legal: the first `of` is the name, the second is the clause.
  const both = analyse('for (const of of [1]) count(of);\n');
  assert.deepEqual(shapeBindings(both), ['of:const']);
  assert.deepEqual(shapeRefs(both).filter((one) => one.startsWith('of')), ['of->0']);
});

test('a name declared in a scope nothing else can see does not block a rename elsewhere', () => {
  const analysis = analyse('function f() { const inner = 1; return inner; }\n');
  assert.equal(lookup(analysis, 'inner'), -1, 'not visible from the module scope');
  const scope = analysis.scopes.find((one) => one.kind === 'function');
  assert.equal(lookup(analysis, 'inner', scope.id), 1);
});

test('the analysis is frozen, so a caller cannot edit the answer it was given', () => {
  const analysis = analyse('const a = 1;\na;\n');
  assert.equal(Object.isFrozen(analysis), true);
  assert.equal(Object.isFrozen(analysis.bindings), true);
  assert.equal(Object.isFrozen(analysis.bindings[0]), true);
  assert.equal(Object.isFrozen(analysis.references[0]), true);
  assert.equal(Object.isFrozen(analysis.scopes), true);
  assert.equal(Object.isFrozen(analysis.dependencies), true);
  assert.equal(Object.isFrozen(BINDING), true);
  assert.equal(Object.isFrozen(FORM), true);
});

test('the scope tree is a tree: one root, every child pointing back at its parent', () => {
  const analysis = analyse(readFileSync(join(ROOT, 'src/lex/bindings.mjs'), 'utf8'));
  assert.equal(analysis.scopes[0].kind, 'module');
  assert.equal(analysis.scopes[0].parent, null);
  assert.ok(analysis.scopes.length > 20, `${analysis.scopes.length} scopes in this file`);
  for (const scope of analysis.scopes.slice(1)) {
    assert.equal(typeof scope.parent, 'number', `scope ${scope.id} has a parent`);
    assert.ok(scope.parent < scope.id, 'a parent is always opened first');
    assert.ok(analysis.scopes[scope.parent].children.includes(scope.id), `scope ${scope.id} is its parent's child`);
    assert.ok(scope.start <= scope.end, `scope ${scope.id} spans forwards`);
  }
  for (const [name, index] of analysis.scopes[0].declarations) {
    assert.equal(analysis.bindings[index].name, name, 'a declaration map entry points at its own binding');
  }
});

test('a file that does not lex is the lexer’s failure and is not swallowed here', () => {
  assert.throws(() => analyse('const a = \'unterminated'), { code: 'UNTERMINATED_STRING' });
  assert.throws(() => analyse(42), { code: 'NOT_A_STRING' });
});
