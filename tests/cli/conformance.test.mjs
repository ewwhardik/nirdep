// `conformance` as a process, which is the only way to see the thing it claims.
//
// The unit tests stub the suite, so what is left to check here is that the real corpus and
// the real drivers agree: run the actual command against the actual tree and the numbers on
// the page have to be the numbers on disk. This is also the one test in the repository that
// runs the runtime suites twice -- once inside `make test` and once through the command that
// reports on them -- which is the price of the command not having its own executor.
//
// Most cases name a single module. The whole corpus is a second of child processes and one
// case is enough to prove the total.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { conformancePlan } from '../../src/conformance/plan.mjs';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));

function run(args = [], env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...env };
  for (const name of ['FORCE_COLOR', 'NO_COLOR']) {
    if (name in env && env[name] === undefined) delete childEnv[name];
  }
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Whitespace-collapsed, so a folded sentence can be asserted as a sentence. */
const flat = (text) => text.replace(/\s+/g, ' ');

/** Written as an escape, because tests/repo/hygiene.test.mjs will not have the byte itself
 * in a source file, and it is right about that. */
const ESC = String.fromCharCode(0x1B);

test('the whole corpus runs green, and the page counts what is on disk', () => {
  const plan = conformancePlan();
  const { code, stdout } = run(['conformance']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, new RegExp(`^3 runtime modules, ${plan.totals.cases} vector cases, \\d+ tests$`, 'm'));
  assert.match(flat(stdout), new RegExp(`PASS: ${plan.totals.packages} packages replaced, `
    + `${plan.totals.cases} cases checked, nothing came back wrong\\.`));
  // The provenance, which is the reason a case count is worth printing at all.
  assert.match(flat(stdout), /source expectations are hand-written or taken from a published package's own test data; STDLIB\.md/);
  assert.match(stdout, new RegExp(`^read {6}tests/vectors and tests/runtime, on node ${process.version.replace(/\./g, '\\.')}$`, 'm'));
});

test('naming a module runs that module and nothing else', () => {
  const { code, stdout } = run(['conformance', 'colour']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^1 runtime module, 74 vector cases, \d+ tests$/m);
  assert.match(stdout, /^ {2}colour {5}74 cases in 2 files {2}\d+ tests, all passed$/m);
  assert.match(flat(stdout), /PASS: 4 packages replaced, 74 cases checked, nothing came back wrong\./);
  assert.equal(/semver|minimist/.test(stdout), false, 'the other modules are not on the page');
});

test('verbose names the files the case count came out of', () => {
  const { code, stdout } = run(['conformance', 'colour', '-v']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^ {10}tests\/vectors\/colour\/named\.json 38$/m);
  assert.match(stdout, /^ {10}tests\/vectors\/colour\/dynamic\.json 36$/m);
  assert.match(stdout, /^ {10}tests\/runtime\/colour\.test\.mjs$/m);
  assert.match(stdout, /^ {10}tests\/runtime\/level\.test\.mjs$/m);
});

test('a module name we do not have is a usage error with a suggestion', () => {
  const { code, stdout, stderr } = run(['conformance', 'color']);
  assert.equal(code, 2);
  assert.match(stderr, /^nirdep: conformance: no runtime module color, did you mean colour\?$/m);
  assert.equal(stdout, '', 'nothing was measured, so nothing is reported');
});

test('a name with nothing near it is told what there is', () => {
  const { code, stderr } = run(['conformance', 'lodash']);
  assert.equal(code, 2);
  assert.match(stderr, /no runtime module lodash\. There are colour, semver, args\./);
});

test('conformance documents itself, and is no longer one of the pending commands', () => {
  const { stdout } = run(['conformance', '--help']);
  assert.match(stdout, /^ {2}\[module\.\.\.\] {2}which modules to check \(default: all of them\)$/m);

  const help = run(['help']).stdout;
  // The describe line folds inside the table, so the summary is read as a sentence.
  assert.match(flat(help), /conformance run the vector corpus: pass, fail and skip counts per runtime module/);
  assert.equal(/conformance\s+\(pending\)/.test(help), false);
});

test('the page is styled for a terminal and plain for a pipe', () => {
  const piped = run(['conformance', 'colour'], { NO_COLOR: undefined });
  const painted = run(['conformance', 'colour'], { NO_COLOR: undefined, FORCE_COLOR: '3' });
  assert.equal(piped.code, 0);
  assert.equal(painted.code, 0);
  assert.equal(piped.stdout.includes(ESC), false, 'a pipe detects level 0');
  assert.equal(painted.stdout.includes(ESC), true, 'FORCE_COLOR is honoured');
  // The same page either way: styling is a hook over text that was already measured.
  assert.equal(stripVTControlCharacters(painted.stdout), piped.stdout);
});
