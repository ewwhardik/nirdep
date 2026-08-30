// The conformance page, which is a table that has to survive being read out of context.
//
// The assertion that matters most is the one about the middle column. "colour: passed" is
// true of a module with one case in it, so every row carries the size of the corpus it
// passed, and the footer says where the expectations came from. A number without a
// denominator is the way a green conformance report comes to mean nothing.
//
// Runs are stubbed: what is under test here is the page, and a real suite per case would
// make this file slower than the command it describes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformancePlan, onlyModules } from '../../src/conformance/plan.mjs';
import { conformanceReport } from '../../src/conformance/report.mjs';
import { runConformance } from '../../src/conformance/run.mjs';

/** Whitespace-collapsed, so a folded sentence can be asserted as a sentence. */
const flat = (text) => text.replace(/\s+/g, ' ');

/** A TAP summary with the counts a case cares about. */
function tap({ pass = 0, fail = 0, skipped = 0, todo = 0, cancelled = 0, failures = [] } = {}) {
  return [
    ...failures.map((name, n) => `not ok ${n + 1} - ${name}`),
    `# tests ${pass + fail + skipped + todo}`, '# suites 0', `# pass ${pass}`, `# fail ${fail}`,
    `# cancelled ${cancelled}`, `# skipped ${skipped}`, `# todo ${todo}`, '# duration_ms 1',
  ].join('\n');
}

/** A page, from the real plan and a stubbed suite. `per` may answer differently per module. */
function page(per, options = {}) {
  const spawn = (root, files) => {
    const name = /runtime\/([a-z]+)\.test\.mjs$/.exec(files[0])?.[1] ?? files[0];
    const answer = typeof per === 'function' ? per(name, files) : per;
    return answer.stdout !== undefined ? answer : { stdout: tap(answer), status: answer.fail > 0 ? 1 : 0, error: null };
  };
  return conformanceReport(runConformance(options.plan ?? conformancePlan(), { spawn }), options);
}

test('every row carries the size of the corpus it passed', () => {
  const text = page({ pass: 12 });
  assert.match(text, /^5 runtime modules, \d{4} vector cases, 60 tests$/m);
  assert.match(text, /^ {2}colour {6}74 cases in 2 files {2}12 tests, all passed$/m);
  assert.match(text, /^ {11}4 packages: chalk, strip-ansi, supports-color, ansi-styles$/m);
  assert.match(text, /^ {2}semver {4}1243 cases in 7 files {2}12 tests, all passed$/m);
  assert.match(text, /^ {11}1 package: semver$/m);
  assert.match(text, /^ {2}glob {6}2035 cases in 5 files {2}12 tests, all passed$/m);
  assert.match(text, /^ {11}2 packages: minimatch, glob$/m);
  assert.match(text, /^ {2}collect {4}147 cases in 3 files {2}12 tests, all passed$/m);
  assert.match(text, /^ {11}1 package: lodash$/m);
  assert.match(text, /^PASS: 11 packages replaced, 3593 cases checked, nothing came back wrong\.$/m);
});

test('a failure is named where the row is, and the last line is the one CI quotes', () => {
  const text = page((name) => (name === 'semver'
    ? { pass: 14, fail: 2, failures: ['ranges: a comparator set that selects nothing', 'coerce, right to left'] }
    : { pass: 12 }));
  assert.match(text, /^ {2}semver {4}1243 cases in 7 files {2}16 tests, 14 passed, 2 failed$/m);
  assert.match(text, /^ {11}failed: ranges: a comparator set that selects nothing$/m);
  assert.match(text, /^ {11}failed: coerce, right to left$/m);
  assert.match(text, /^FAIL: 2 of 64 tests came back wrong across 5 modules\.$/m);
  assert.equal(/PASS/.test(text), false);
});

test('a long list of failures stops being a list and says how many there were', () => {
  const failures = Array.from({ length: 9 }, (_, n) => `case number ${n}`);
  const text = page((name) => (name === 'args' ? { pass: 1, fail: 9, failures } : { pass: 12 }));
  assert.match(text, /^ {11}failed: case number 4$/m);
  assert.equal(/case number 5/.test(text), false, 'five names, then a count');
  assert.match(text, /^ {11}and 4 more, in the suite's own output$/m);
});

test('a skip is on the page and not in the verdict', () => {
  const text = page((name) => (name === 'colour' ? { pass: 11, skipped: 1 } : { pass: 12 }));
  assert.match(text, /^ {2}colour {6}74 cases in 2 files {2}12 tests, 11 passed, 1 skipped$/m);
  // With a skip in it the verdict is 81 columns and folds, so it is read as a sentence.
  assert.match(flat(text), /PASS: 11 packages replaced, 3593 cases checked, 1 skipped, nothing came back wrong\./);
});

test('the verdict column does not move between a file and two files', () => {
  const text = page({ pass: 12 });
  const columns = [...text.matchAll(/^ {2}\S+ +\d+ cases in \d+ files?( +)/gm)]
    .map((match) => match[0].length);
  assert.equal(new Set(columns).size, 1, `the verdicts start at ${[...new Set(columns)].join(' and ')}`);
});

test('a module that could not be started says so instead of showing a nought', () => {
  const text = page((name) => (name === 'args'
    ? { stdout: 'Cannot find module\n', status: 1, error: null }
    : { pass: 12 }));
  assert.match(text, /^ {2}args {8}94 cases in 1 file {3}did not run$/m);
  assert.match(text, /^ {11}the suite exited 1 without a summary$/m);
  // The two modules that did run are still on the page, and the last line still refuses to
  // call the run a pass: 94 cases had nobody look at them.
  assert.match(text, /^ {2}colour {6}74 cases in 2 files {2}12 tests, all passed$/m);
  assert.match(text, /^NO VERDICT: 1 of 5 modules did not run; 94 cases went unchecked\.$/m);
  assert.equal(/PASS|FAIL/.test(text), false);
});

test('a module that did not run outranks the failures in the ones that did', () => {
  const text = page((name) => {
    if (name === 'args') return { stdout: 'boom\n', status: 1, error: null };
    if (name === 'semver') return { pass: 10, fail: 2, failures: ['coerce, right to left'] };
    return { pass: 12 };
  });
  assert.match(text, /^ {11}failed: coerce, right to left$/m);
  assert.match(flat(text), /NO VERDICT: 1 of 5 modules did not run; 94 cases went unchecked, and 2 of the rest came back wrong\./);
});

test('the footer says what was read and sends the reader to the provenance', () => {
  const text = page({ pass: 12 });
  assert.match(text, /^read {6}tests\/vectors and tests\/runtime, on node v\d+\./m);
  assert.match(flat(text), /source expectations are hand-written or taken from a published package's own test data; STDLIB\.md, under Borrowed test data, says which, per module\./);
});

test('a corpus that is not here is its own page, and not a table of noughts', () => {
  const absent = conformancePlan({ root: '/nowhere', list: () => [], read: () => { throw new Error('ENOENT'); } });
  const text = conformanceReport(runConformance(absent, { spawn: () => { throw new Error('nothing to spawn'); } }));
  assert.match(text, /^conformance cannot run: 1 problem$/m);
  assert.match(text, /^ {2}- no test files to run: the corpus ships with the repository, not with the$/m);
  assert.match(text, /^ {4}artifact$/m, 'a folded problem stays visibly one problem');
  assert.match(flat(text), /The vectors are data, not code: package\.json "files" ships bin, src and the documents/);
  assert.equal(/PASS|FAIL|NO VERDICT/.test(text), false, 'no verdict, because nothing was measured');
});

test('naming a module reports that module and totals only what it ran', () => {
  const { plan } = onlyModules(conformancePlan(), ['colour']);
  const text = page({ pass: 12 }, { plan });
  assert.match(text, /^1 runtime module, 74 vector cases, 12 tests$/m);
  assert.match(text, /^PASS: 4 packages replaced, 74 cases checked, nothing came back wrong\.$/m);
  assert.equal(/semver/.test(text), false);
});

test('verbose names the files, because a case count is a claim about files', () => {
  const text = page({ pass: 12 }, { verbose: true });
  assert.match(text, /^ {11}tests\/vectors\/colour\/named\.json 38$/m);
  assert.match(text, /^ {11}tests\/runtime\/level\.test\.mjs$/m);
});

test('a driver that reads no runtime module is called out under the table', () => {
  const plan = { ...conformancePlan(), strays: ['tests/runtime/helpers.test.mjs'] };
  const text = page({ pass: 12 }, { plan });
  assert.match(flat(text), /1 file under tests\/runtime reads no runtime module and was not run here: tests\/runtime\/helpers\.test\.mjs/);
});

test('nothing on the page is wider than a terminal', () => {
  // The verdict is the line most likely to overrun, so all three of them are measured, along
  // with the widest row the table can produce.
  const pages = [
    page((name) => (name === 'semver'
      ? { pass: 0, fail: 3, failures: ['a range with a prerelease on both sides of a hyphen and nowhere to put it'] }
      : { pass: 11, skipped: 1, todo: 1 }), { verbose: true }),
    page({ pass: 11, skipped: 1 }),
    page((name) => (name === 'colour' ? { pass: 12 } : { stdout: 'boom\n', status: 1, error: null })),
  ];
  for (const line of pages.join('\n').split('\n')) {
    assert.equal(line.length <= 80, true, `${line.length} columns: ${line}`);
  }
});

test('styling is a hook, and it changes no line count', () => {
  const plain = page({ pass: 12 });
  const loud = page({ pass: 12 }, {
    style: { red: (text) => `<<${text}>>`, green: (text) => `[[${text}]]`, dim: (text) => `((${text}))` },
  });
  assert.equal(loud.split('\n').length, plain.split('\n').length);
  assert.match(loud, /\[\[PASS\]\]/);
  assert.equal(plain.includes('[['), false);
});
