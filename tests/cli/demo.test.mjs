// `demo` as a binary: the one command a judge with no project to hand can run.
//
// The unit tests already cover what each stage decides. What only a child process shows is
// that the whole thing exits 0 on a machine that has nothing installed, prints the seven
// stages in order, and leaves the tree exactly where it said it would. The environment is
// scrubbed for the same reason every other CLI test scrubs it: the output has to be a
// function of the arguments, not of whatever CI set FORCE_COLOR to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, DEMO_STAGES } from '../../src/demo/script.mjs';
import { GLOSSARY, NEXT_STEPS } from '../../src/demo/guide.mjs';
import { childEnvironment } from './environment.mjs';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));

function run(args = [], options = {}) {
  const childEnv = childEnvironment({ NO_COLOR: '1' });
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, cwd: options.cwd,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Somewhere to send --dir, which the demo creates and, being told where, keeps. */
const spot = () => join(mkdtempSync(join(tmpdir(), 'nirdep-cli-demo-')), 'run');

// One run, reused: planting a project, scanning it, rewriting it, ejecting four modules and
// importing the result is not expensive, but it is not free either, and every assertion below
// is about the same transcript.
const HOME = spot();
const RUN = run(['demo', '--dir', HOME, '--no-diff']);
const FOLDED = RUN.stdout.split(/\s+/).join(' ');

test('it exits 0, which means every stage passed, including the one that runs the code', () => {
  assert.equal(RUN.code, 0, RUN.stderr);
  assert.equal(RUN.stderr, '');
});

test('the seven stages print in order, numbered, each with the command it stands for', () => {
  const marks = [...RUN.stdout.matchAll(/-- (\d)\/7 /g)].map((one) => one[1]);
  assert.deepEqual(marks, ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(marks.length, DEMO_STAGES.length);
  assert.ok(RUN.stdout.includes(`$ cd ${DEMO.name}`), 'the first stage is a directory you enter');
  for (const command of ['$ nirdep scan', '$ nirdep plan', '$ nirdep eject', '$ nirdep apply']) {
    assert.ok(RUN.stdout.includes(command), `${command} is shown as something you typed`);
  }
});

test('the payoff is in there: the same file, refused at the top and answering at the bottom', () => {
  const refused = RUN.stdout.indexOf('ERR_MODULE_NOT_FOUND');
  assert.notEqual(refused, -1, 'nothing is installed, and Node says so');
  for (const check of DEMO.demonstrate) {
    const at = RUN.stdout.indexOf(`${check.export}(`);
    assert.notEqual(at, -1, `${check.export} was called`);
    assert.ok(at > refused, 'after the failure, not before it');
    assert.ok(FOLDED.includes(check.expect), `${check.export} answered ${check.expect}`);
  }
});

test('the closing count names the vendored modules and the packages it declined', () => {
  assert.match(FOLDED, /modules? vendored/);
  assert.match(FOLDED, /packages? declined/);
  assert.match(FOLDED, /by hand glob, minimist/);
  for (const one of NEXT_STEPS) assert.ok(RUN.stdout.includes(one.command), `${one.command} is printed`);
});

test('--dir keeps the tree, and it is a project: the vendored files are really there', () => {
  assert.ok(existsSync(join(HOME, 'project', 'package.json')));
  assert.ok(existsSync(join(HOME, 'project', DEMO.runtimeDir, 'colour.mjs')));
  assert.match(FOLDED, new RegExp(`the demo project is at ${HOME.split('\\').join('\\\\')}`));
});

test('without --dir the temporary tree is gone by the time the process is', () => {
  const done = run(['demo', '--no-diff']);
  assert.equal(done.code, 0, done.stderr);
  // Folded first: that sentence is wrapped to 76 columns, so the path can arrive with a
  // newline and six spaces in the middle of it.
  const folded = done.stdout.split(/\s+/).join(' ');
  const named = [...folded.matchAll(/project was at (\S+) and/g)].map((one) => one[1]);
  assert.equal(named.length, 1, 'and it says which directory that was');
  assert.equal(existsSync(named[0]), false, 'which no longer exists');
});

test('the terminal teaches nothing unless asked, and the page is where it says to look', () => {
  assert.equal(/What a codemod is/i.test(RUN.stdout), false);
  for (const term of Object.keys(GLOSSARY)) {
    const head = GLOSSARY[term].split(' ').slice(0, 5).join(' ');
    assert.equal(FOLDED.includes(head), false, `${term} is not defined in the plain run`);
  }
  const guided = run(['demo', '--guide', '--no-diff']);
  assert.equal(guided.code, 0, guided.stderr);
  const folded = guided.stdout.split(/\s+/).join(' ');
  assert.ok(folded.includes(GLOSSARY.codemod.split(' ').slice(0, 5).join(' ')), 'and --guide defines it');
  assert.ok(guided.stdout.length > RUN.stdout.length);
});

test('help lists demo with its flags, so the run above is discoverable', () => {
  const help = run(['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /demo\s+plant a broken project/);
});

// The kept tree is the last thing anything here reads.
test.after(() => rmSync(HOME, { recursive: true, force: true }));
