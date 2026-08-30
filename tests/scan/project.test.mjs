// The three readers in one room, and the arithmetic they produce.
//
// Two whole projects live in tests/vectors/scan/tree.json and are planted in a temporary
// directory: `tree` has a lockfile, a file that will not lex, a specifier that is not a
// literal, an undeclared import and a self-reference, and `bare` has none of it and no
// lockfile either. Keeping them as JSON is not tidiness -- a fixture with a real specifier
// in a .mjs file is a third-party dependency as far as tools/verify.mjs can tell.
//
// The assertions worth reading twice are the graph ones. Blast radius is a subtraction, and
// the case that proves it is two packages that share a child: neither owns it alone, both
// together strand it, and a tool that sums the rows reports the wrong number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READ, buildGraph, packageName, reachable, scanProject, strandedBy,
} from '../../src/scan/project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'scan', 'tree.json'), 'utf8'));

/** Lay a table of paths and contents down on disk and hand back the root. */
function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-scan-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

/** Just the two fields buildGraph reads, so a graph case is one line per node. */
const lockOf = (packages) => ({ packages });
const graphOf = (edges) => buildGraph(lockOf(Object.entries(edges).map(([name, requires]) => ({ name, requires }))));

const rowFor = (scan, name) => scan.radius.find((one) => one.name === name);
const codes = (scan) => scan.findings.map((one) => one.code);

test('the package a specifier belongs to is decided in one place', () => {
  assert.equal(packageName('chalk/index.js'), 'chalk');
  assert.equal(packageName('@scope/a/b'), '@scope/a');
  assert.deepEqual(READ, { LEXED: 'lexed', SCANNED: 'scanned' });
});

test('two copies of a package are one node whose edges are the union', () => {
  const graph = buildGraph(lockOf([
    { name: 'semver', requires: ['lru-cache'] },
    { name: 'semver', requires: ['yallist'] },
    { name: 'lru-cache', requires: [] },
  ]));
  assert.equal(graph.size, 2, 'two versions of semver, one node');
  assert.deepEqual([...graph.get('semver')].sort(), ['lru-cache', 'yallist']);
  // An edge to a name the lockfile never lists as a package of its own still exists; it
  // just leads nowhere. Dropping it would hide a dependency the manifest declared.
  assert.equal(graph.has('yallist'), false);
  assert.deepEqual([...reachable(graph, ['semver'])].sort(), ['lru-cache', 'semver', 'yallist']);
});

test('reachable includes its seeds and survives a cycle', () => {
  const graph = graphOf({ a: ['b'], b: ['c'], c: ['a'] });
  assert.deepEqual([...reachable(graph, ['a'])].sort(), ['a', 'b', 'c'], 'the walk does not recurse forever');
  assert.deepEqual([...reachable(graph, [])], [], 'no seeds, nothing reached');
  assert.deepEqual([...reachable(graph, ['ghost'])], ['ghost'], 'an unknown name is still itself');
});

test('what leaves is a subtraction, not the sum of the rows', () => {
  // a and b share c. Neither owns it alone, so a per-row count says nothing leaves with
  // either; removing both takes three packages out. This is the case that makes the
  // whole-set subtraction necessary rather than merely tidier.
  const graph = graphOf({ a: ['c'], b: ['c'], c: [] });
  const roots = new Set(['a', 'b']);
  assert.deepEqual(strandedBy(graph, roots, new Set(['a'])), ['a']);
  assert.deepEqual(strandedBy(graph, roots, new Set(['a', 'b'])), ['a', 'b', 'c']);
  assert.deepEqual(strandedBy(graph, roots, new Set()), [], 'removing nothing strands nothing');
  assert.deepEqual(strandedBy(graph, roots, new Set(['ghost'])), [], 'a name that is not a root changes nothing');
});

test('the three readers agree about how much there is', () => {
  const scan = scanProject(plant(TREE.tree));
  assert.deepEqual(scan.counts, {
    direct: 4, declared: 4, dev: 1, installed: 15, names: 15, imported: 5, replaceable: 3,
  });
  // Three source files walked, two of them worth opening: src/self.mjs mentions only a
  // relative path and the project's own name, so the cheap prefilter stops there. Of the
  // two opened, one lexes and one does not.
  assert.deepEqual(scan.source.counts, { scanned: 3, opened: 2, lexed: 1 });
  assert.deepEqual(scan.graph, { names: 15, understood: true });
  assert.equal(scan.lock.kind, 'npm');
});

test('a file that will not lex is named, and its imports are kept anyway', () => {
  const scan = scanProject(plant(TREE.tree));
  assert.deepEqual(scan.source.unparsed.map((one) => one.path), ['src/broken.mjs']);
  assert.match(scan.source.unparsed[0].detail, /template never closes/);
  const lodash = scan.source.packages.find((one) => one.name === 'lodash');
  assert.equal(lodash.read, READ.SCANNED, 'the blunt answer is worse than nothing only if it is thrown away');
  assert.deepEqual(lodash.files, ['src/broken.mjs']);
  // A specifier that is a variable cannot be resolved by any tool that does not run the
  // program, so it is reported rather than guessed at.
  assert.deepEqual(scan.source.unanalysable, [
    { path: 'src/cli.mjs', line: 10, reason: 'the specifier is not a literal string' },
  ]);
  assert.deepEqual(scan.source.unreadable, []);
});

test('a package importing itself by name is not one of its own dependencies', () => {
  const scan = scanProject(plant(TREE.tree));
  const names = scan.source.packages.map((one) => one.name);
  // src/self.mjs loads `demo/helper`, which is this project reaching through its own
  // exports map. Counting it made the tool report `demo` as a dependency of demo.
  assert.equal(names.includes('demo'), false);
  assert.deepEqual(names, ['chalk', 'express', 'lodash', 'minimist', 'semver']);
  const express = scan.source.packages.find((one) => one.name === 'express');
  assert.equal(express.declared, false);
  assert.equal(express.rule, null, 'nirdep has nothing to say about express');
  const chalk = scan.source.packages.find((one) => one.name === 'chalk');
  assert.equal(chalk.range, '^4.1.2');
  assert.equal(chalk.rule.action, 'rewrite');
});

test('the radius table is ordered by what a person can act on', () => {
  const scan = scanProject(plant(TREE.tree));
  // Replaceable first, then by weight, then alphabetically. rimraf owns five packages and
  // still sorts last, because nirdep cannot replace it and a row nobody can act on is not
  // the row to put at the top.
  assert.deepEqual(scan.radius.map((one) => one.name), ['chalk', 'semver', 'minimist', 'rimraf']);
  const chalk = rowFor(scan, 'chalk');
  assert.deepEqual(chalk.own, ['ansi-styles', 'chalk', 'color-convert', 'color-name', 'has-flag', 'supports-color']);
  assert.equal(chalk.tree, 6);
  assert.equal(chalk.shared, 0);
  assert.deepEqual(chalk.versions, ['4.1.2']);
  assert.equal(chalk.target, 'nirdep/runtime/colour');
  assert.equal(chalk.sites, 1);
  assert.equal(chalk.files, 1);
  // The one caveat that travels with the number instead of sitting in a footnote: the graph
  // is keyed by name, so every "would leave with it" count is an upper bound.
  assert.equal(chalk.approximate, true);
  assert.deepEqual(rowFor(scan, 'semver').own, ['lru-cache', 'semver', 'yallist']);
  assert.deepEqual(rowFor(scan, 'minimist').own, ['minimist'], 'a leaf owns only itself');
  const rimraf = rowFor(scan, 'rimraf');
  assert.equal(rimraf.dev, true);
  assert.equal(rimraf.replaceable, false);
  assert.equal(rimraf.action, null);
  assert.equal(rimraf.sites, 0, 'named in a script, imported by nothing');
  assert.deepEqual(rimraf.own, ['glob', 'inflight', 'once', 'rimraf', 'wrappy']);
});

test('what a whole migration is worth is one subtraction over the whole set', () => {
  const scan = scanProject(plant(TREE.tree));
  const { removable } = scan;
  assert.deepEqual(removable.direct, ['chalk', 'semver', 'minimist']);
  assert.deepEqual(removable.rewritable, ['chalk', 'semver'], 'minimist needs a hand, so it is not counted as rewritable');
  assert.equal(removable.count, 10);
  assert.equal(removable.of, 15);
  // 6 + 3 + 1 = 10 here, because these three share nothing. The sum agreeing with the
  // subtraction is worth pinning: when it stops agreeing, the subtraction is the right one.
  const sum = removable.direct.reduce((total, name) => total + rowFor(scan, name).own.length, 0);
  assert.equal(sum, removable.count);
  assert.equal(removable.stranded.includes('glob'), false, 'rimraf stays, so its tree stays');
});

test('the findings are the disagreements between the three readers', () => {
  const scan = scanProject(plant(TREE.tree));
  assert.deepEqual(codes(scan), ['no-integrity', 'undeclared', 'deprecated', 'floating', 'depth']);
  assert.deepEqual(scan.summary, { high: 2, medium: 1, low: 1, note: 1, total: 5 });
  const undeclared = scan.findings.find((one) => one.code === 'undeclared');
  assert.deepEqual(undeclared.subjects, ['express', 'lodash'], 'both readers contribute, and neither invents demo');
  // rimraf is declared, imported nowhere and named in `scripts.clean`, so it is not unused.
  assert.equal(codes(scan).includes('unused'), false);
});

test('a project with no lockfile gets numbers that stop where the evidence does', () => {
  const scan = scanProject(plant(TREE.bare));
  assert.equal(scan.lock.kind, 'none');
  assert.deepEqual(scan.graph, { names: 0, understood: false });
  assert.deepEqual(scan.counts, {
    direct: 2, declared: 2, dev: 0, installed: 0, names: 0, imported: 1, replaceable: 1,
  });
  // With no tree there is nothing to strand. Running the subtraction over an empty graph
  // hands back the seeds, which would have printed "1 of 0 installed names".
  assert.equal(scan.removable.count, 0);
  assert.deepEqual(scan.removable.stranded, []);
  assert.deepEqual(scan.removable.direct, ['chalk']);
  assert.equal(rowFor(scan, 'chalk').installed, false);
  assert.deepEqual(rowFor(scan, 'chalk').versions, []);
  assert.deepEqual(codes(scan), ['no-lockfile', 'unused']);
});

test('a file that cannot be read is reported rather than counted as clean', () => {
  const scan = scanProject(plant(TREE.tree), {
    read: (file) => {
      if (file.endsWith('cli.mjs')) throw new Error('EACCES: permission denied');
      return readFileSync(file, 'utf8');
    },
  });
  assert.deepEqual(scan.source.unreadable, [{ path: 'src/cli.mjs', detail: 'EACCES: permission denied' }]);
  assert.equal(scan.source.counts.scanned, 3, 'it was still walked');
  assert.equal(scan.counts.imported, 1, 'and its packages are missing from the count, which is the point');
});

test('the result is frozen all the way down, because two commands read it', () => {
  const scan = scanProject(plant(TREE.tree));
  for (const one of [scan, scan.graph, scan.source, scan.radius, scan.removable, scan.counts, scan.findings]) {
    assert.equal(Object.isFrozen(one), true);
  }
  for (const one of scan.radius) {
    assert.equal(Object.isFrozen(one), true);
    assert.equal(Object.isFrozen(one.own), true);
  }
  assert.deepEqual(Object.keys(scan.source).sort(), ['counts', 'packages', 'unanalysable', 'unparsed', 'unreadable']);
});
