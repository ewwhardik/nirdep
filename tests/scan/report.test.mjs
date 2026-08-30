// The page a person reads once and acts on.
//
// A report is not decoration here: the numbers in it are the argument, and the block that
// says what the scan could not see is the reason to believe the rest. So these tests check
// three things -- that every block is present, that the sentences agree with their own
// counts, and that no line runs past 80 columns once a terminal has read it.
//
// The last one is why styling is applied after folding, and the assertion that pins it down
// is the one that strips the markers back out: a styled report and a plain one must fold
// identically, because a fold that counts escape sequences as columns is a fold that lands
// in the wrong place and gets blamed on the terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from '../../src/scan/project.mjs';
import { scanReport, scanExitCode } from '../../src/scan/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'scan', 'tree.json'), 'utf8'));

function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-report-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const reportOf = (files, options) => scanReport(scanProject(plant(files)), options);

/** Style hooks that leave a trace a test can find and strip, instead of escape sequences. */
const MARKED = Object.freeze({
  bold: (text) => `<b>${text}</b>`,
  dim: (text) => `<d>${text}</d>`,
  cyan: (text) => `<c>${text}</c>`,
  yellow: (text) => `<y>${text}</y>`,
  green: (text) => `<g>${text}</g>`,
  red: (text) => `<r>${text}</r>`,
});

const strip = (text) => text.replace(/<\/?[bdcygr]>/g, '');
const lineWith = (text, needle) => text.split('\n').find((line) => line.includes(needle));
// For assertions about a sentence rather than about where it folds. Both are worth making,
// but a test that pins the fold of every paragraph fails on the next reworded adjective.
const flat = (text) => text.replace(/\s+/g, ' ');

test('the four blocks arrive in the order somebody decides things', () => {
  const text = reportOf(TREE.tree);
  const at = ['dependencies', 'what nirdep can replace', 'findings', 'what this scan did not check']
    .map((head) => text.indexOf(head));
  assert.ok(at.every((one) => one !== -1), 'every block is present');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'and none of them has moved');
  assert.match(text, /\n2 high \| 1 medium \| 1 low \| 1 note\n$/, 'the tally is the last line');
});

test('the overview says what was read and where it came from', () => {
  const text = reportOf(TREE.tree);
  assert.match(text, /4 packages declared, 1 of them for development/);
  assert.match(text, /15 packages installed, 15 distinct names, from package-lock\.json \(v3\)/);
  assert.match(text, /5 packages imported by this project's own source, out of 3 files read/);
  // No dev dependencies means no clause about them, rather than "0 of them".
  const bare = reportOf(TREE.bare);
  assert.match(bare, /\n {2}2 packages declared\n/);
  assert.match(bare, /the transitive tree is not visible: no lockfile/);
  assert.match(bare, /1 package imported by this project's own source, out of 1 file read/);
});

test('a replaceable row carries its verb, its weight and the names behind it', () => {
  const text = reportOf(TREE.tree);
  // Column-aligned names, the rewritable ones first, and the list of what leaves on its
  // own line: a row that runs to 130 columns is a row nobody reads to the end of.
  assert.match(text, /\n {2}rewrite {2}chalk {5}\^4\.1\.2\n/);
  assert.match(text, /\n {2}by hand {2}minimist {2}\*\n/);
  assert.match(text, /1 import in 1 file, removing it takes 6 packages out of the tree\n/);
  assert.match(text, /\n {6}ansi-styles, chalk, color-convert, color-name, has-flag, supports-color\n/);
  assert.match(text, /removing it takes 1 package out of the tree\n {6}minimist\n/, 'the singular, and a list of one');
  assert.ok(text.indexOf('chalk  ') < text.indexOf('minimist  '), 'rewritable before by-hand');
});

test('the migration line spells its own arithmetic out', () => {
  const text = reportOf(TREE.tree);
  // 10 = 3 + 7, and each of the three is checkable against a row printed above it. A
  // reader who can verify one number believes the next one for free.
  assert.match(text, /10 of 15 installed names are reachable only through 3 packages this tool\n {2}replaces: /);
  assert.match(text, /remove those 3 and 7 packages go with them\./);
});

test('a package that is declared but not installed says so instead of claiming a saving', () => {
  const text = reportOf(TREE.bare);
  assert.match(text, /1 import in 1 file, not installed here, so nothing would leave with it/);
  assert.equal(text.includes('installed names are reachable'), false, 'no tree, no subtraction to report');
});

test('a project with nothing to replace gets a sentence, not an empty heading', () => {
  const files = { ...TREE.bare };
  files['package.json'] = JSON.stringify({ name: 'bare', dependencies: { 'left-pad': '^1.3.0' } }, null, 2);
  const text = reportOf(files);
  assert.match(text, /what nirdep can replace\n {2}nothing here: no direct dependency is one of the packages/);
});

test('findings are printed worst first, each with its severity in the margin', () => {
  const text = reportOf(TREE.tree);
  const marks = text.split('\n')
    .map((line) => line.match(/^ {2}(high|medium|low|note) {2,}([a-z-]+)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(marks, [
    ['high', 'no-integrity'], ['high', 'undeclared'], ['medium', 'deprecated'],
    ['low', 'floating'], ['note', 'depth'],
  ]);
  assert.match(text, /findings\n {2}high {4}no-integrity\n {4}1 registry package is recorded/);
});

test('a clean project still gets told what was not looked at', () => {
  const text = reportOf({
    'package.json': JSON.stringify({ name: 'clean', type: 'module' }, null, 2),
    'index.mjs': 'export const answer = 42;\n',
  });
  assert.match(text, /findings\n {2}nothing to report\n/);
  // "Nothing found" means very little without "and here is what I could not have found".
  assert.match(text, /what this scan did not check\n {4}Known vulnerabilities\./);
  assert.match(flat(text), /not a clean report from npm audit\./);
  assert.match(text, /\n0 high \| 0 medium \| 0 low \| 0 note\n$/);
  for (const line of text.split('\n')) assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
});

test('the limits block names the source of every number above it', () => {
  const text = reportOf(TREE.tree);
  assert.match(text, /Everything above comes from package-lock\.json \(v3\) and package\.json as\n {4}committed/);
  assert.match(text, /not from node_modules as installed/);
  // The name-level graph is the one caveat that changes what a number means, so it is
  // stated as such: every "would leave with it" count is an upper bound.
  assert.match(text, /follows the lockfile's edges by package name rather than by\n {4}name and version/);
  assert.match(text, /count an upper bound\./);
  const bare = reportOf(TREE.bare);
  assert.match(bare, /Everything above comes from package\.json alone: no lockfile is committed/);
  assert.equal(bare.includes('upper bound'), false, 'no graph, no approximation to admit');
});

test('the limits block agrees with itself about how many files it could not read', () => {
  const text = reportOf(TREE.tree);
  // Singular throughout: "1 file ... its imports", "1 import names ... what it loads".
  assert.match(text, /1 file would not parse, so its imports were read with a blunt text scan\n {4}instead: src\/broken\.mjs\./);
  assert.match(text, /1 import names a specifier that is not a literal string, so no tool can say\n {4}what it loads/);
});

test('a file that could not be read is a question about the report, so it exits 1', () => {
  const root = plant(TREE.tree);
  const scan = scanProject(root, {
    read: (file) => {
      if (file.endsWith('cli.mjs')) throw new Error('EACCES: permission denied');
      return readFileSync(file, 'utf8');
    },
  });
  assert.equal(scanExitCode(scan), 1);
  assert.match(scanReport(scan), /could not read src\/cli\.mjs: EACCES: permission denied/);
  // Findings do not fail: a command that exits 1 on a deprecation notice gets wrapped in
  // `|| true` within a week, and then it never fails again.
  assert.equal(scanExitCode(scanProject(root)), 0);
  assert.ok(scanProject(root).findings.length > 0, 'and that project has findings to ignore');
});

test('no line runs past 80 columns, styled or not', () => {
  for (const files of [TREE.tree, TREE.bare]) {
    for (const line of reportOf(files).split('\n')) {
      assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
    }
  }
});

test('styling happens after folding, so it cannot move a fold', () => {
  for (const files of [TREE.tree, TREE.bare]) {
    const plain = reportOf(files);
    const marked = reportOf(files, { style: MARKED });
    assert.notEqual(marked, plain, 'the hooks were used');
    assert.equal(strip(marked), plain, 'and folding did not notice');
    for (const line of marked.split('\n')) {
      // A style that opens on one line and closes on another paints the indent of every
      // line between them. Each line is styled whole, so every marker is balanced.
      const opens = (line.match(/<[bdcygr]>/g) ?? []).length;
      assert.equal(opens, (line.match(/<\/[bdcygr]>/g) ?? []).length, `unbalanced: ${line}`);
    }
  }
  // The severity margin is painted per level, and the tally's separators are dimmed.
  const marked = reportOf(TREE.tree, { style: MARKED });
  assert.match(lineWith(marked, 'no-integrity'), /^ {2}<r>high {2}<\/r>/);
  assert.match(lineWith(marked, 'depth'), /^ {2}<d>note {2}<\/d>/);
  assert.match(marked, /2 high<d> \| <\/d>1 medium/);
});
