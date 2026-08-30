// `guard` as the thing it is for: a process that exits non-zero in somebody's CI.
//
// The unit tests cover what the policy decides and how the page reads. What only a child
// process and a real directory can show is the sequence the command exists to enforce --
// guard fails, the codemod moves the call sites, guard passes -- and that the exit code is
// the part a build machine can act on.
//
// The fixture is JSON for the reason tests/vectors/guard/project.json gives: a real
// specifier in a .mjs file under tests/ is a third-party dependency as far as
// tools/verify.mjs can tell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { POLICY_FILE } from '../../src/guard/policy.mjs';
import { REPLACEABLE } from '../../src/rules/registry.mjs';

/** The default deny list is the catalogue, so the count on the page follows it. */
const WATCHED = REPLACEABLE.length;

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
const VECTOR = JSON.parse(readFileSync(new URL('../vectors/guard/project.json', import.meta.url), 'utf8'));

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

/** The fixture on disk: chalk declared, installed and imported, minimist dev-only, and a
 * semver in the lockfile that nobody asked for. `which` picks the other project, where every
 * problem arrived through somebody else's tree. */
function plant(policy = null, which = 'project') {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-guard-'));
  const files = { ...VECTOR[which] };
  if (policy !== null) files[POLICY_FILE] = VECTOR.policies[policy];
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

test('a project with the dependencies still in it fails, and says where', () => {
  const { code, stdout, stderr } = run(['guard', plant()]);
  assert.equal(code, 1, 'the only part of a report a build machine can act on');
  assert.equal(stderr, '');
  assert.match(stdout, /^3 packages came back$/m);
  assert.match(stdout, /^ {2}chalk {9}declared \^5\.3\.0 {2}installed 5\.3\.0 {2}imported 1 site in 1 file$/m);
  assert.match(stdout, /first at src\/paint\.mjs:1/);
  // The phantom: installed, never declared, arriving through somebody else's tree.
  assert.match(stdout, /^ {2}semver {8}installed 7\.6\.0$/m);
  assert.match(stdout, new RegExp(`^FAIL: 3 of ${WATCHED} watched packages present\\.$`, 'm'));
});

test('the sequence the command exists for: fail, rewrite, pass', () => {
  const root = plant('written');
  assert.equal(run(['guard', root]).code, 1);

  const rewrite = run(['apply', '--runtime', 'vendor/nirdep', '--no-diff', root]);
  assert.equal(rewrite.code, 0, rewrite.stderr);
  assert.match(rewrite.stdout, /^written {6}src\/paint\.mjs$/m);

  const after = run(['guard', root]);
  assert.equal(after.code, 0, after.stdout);
  assert.match(after.stdout, /^nothing came back$/m);
  // chalk is still in package.json and still in the lockfile. This policy watches imports
  // only, so it says so plainly instead of quietly passing on a package it can see.
  assert.match(after.stdout, /^ {2}2 others present but not watched here: chalk, semver$/m);
  assert.match(after.stdout, new RegExp(`^PASS: ${WATCHED} packages watched, 1 allowed by name, nothing to report\\.$`, 'm'));
});

test('an exemption somebody wrote down travels with its reason', () => {
  const { stdout } = run(['guard', plant('written')]);
  assert.match(stdout, /^allowed by policy$/m);
  assert.match(stdout, /DEP-14: the flag parser moves with the next release/);
  assert.match(stdout, new RegExp(`^policy {4}${POLICY_FILE.replace('.', '\\.')}: `, 'm'));
});

test('a policy we cannot read is its own exit code, and not a failure of the project', () => {
  const { code, stdout } = run(['guard', plant('broken')]);
  assert.equal(code, 2, 'two, because nothing was checked -- this is not a green build or a red one');
  assert.match(stdout, /^guard cannot run: 2 problems in the policy$/m);
  assert.match(stdout, /unknown policy key "signal", did you mean "signals"\?/);
  assert.equal(/FAIL|PASS/.test(stdout), false);
});

test('a policy file the user named and we cannot open is their mistake, not a silent default', () => {
  const { code, stdout } = run(['guard', plant(), '--policy', 'ci/nowhere.json']);
  assert.equal(code, 2);
  assert.match(stdout, /ci\/nowhere\.json cannot be read: ENOENT/);
});

test('flags overrule a policy only when they were typed, and the footer names them', () => {
  const root = plant('written');
  const capped = run(['guard', root, '--max', '1']);
  assert.equal(capped.code, 1);
  assert.match(capped.stdout, /^over the cap: 2 direct dependencies, and the policy allows 1$/m);
  // The footer folds, so the attribution is read as a sentence rather than as a line.
  assert.match(flat(capped.stdout), /at most 1 direct dependency, 1 allowed, max from the command line/);

  // The policy watches imports only. Passing --dev, which defaults to true, must not be
  // mistaken for the user having asked for anything.
  const untouched = run(['guard', root]);
  assert.equal(/from the command line/.test(flat(untouched.stdout)), false);
});

test('a directory that is not there is a usage error, not a spotless project', () => {
  const { code, stdout, stderr } = run(['guard', join(tmpdir(), 'nirdep-guard-nowhere')]);
  assert.equal(code, 2);
  assert.match(stderr, /^nirdep: guard: cannot read .*: there is nothing there\.$/m);
  assert.equal(stdout, '');
});

test('the page is plain down a pipe and painted when a terminal is claimed', () => {
  const root = plant();
  const plain = run(['guard', root]).stdout;
  const styled = run(['guard', root], { NO_COLOR: undefined, FORCE_COLOR: '3' }).stdout;
  assert.notEqual(styled, plain, 'FORCE_COLOR means paint it');
  assert.equal(stripVTControlCharacters(styled), plain, 'and painting changes nothing else');
});

test('a version nobody chose to install fails the build, and is printed first', () => {
  // The other project: nothing here was a decision. lodash is declared, and the release of it
  // that is installed and the two packages that came with somebody else's tree are not.
  const { code, stdout } = run(['guard', plant(null, 'poisoned')]);
  assert.equal(code, 1);
  assert.equal(stdout.split('\n')[0], '3 versions the advisory table names',
    'a wallet stealer under a table of imports is a wallet stealer nobody read');
  assert.match(stdout, /^ {2}event-stream@3\.3\.6 {2}published to do harm, 2018-11-26$/m);
  assert.match(flat(stdout), /No version fixes this one: the release itself was the payload/);
  assert.match(flat(stdout), /3 further advisories name this version/);
  assert.match(flat(stdout),
    new RegExp(`FAIL: 1 of ${WATCHED} watched packages present; 3 versions the advisory table names\\.`));
});

test('the ladder is a flag as well, and a rung nobody defined is a typo at the keyboard', () => {
  const root = plant(null, 'poisoned');
  const incidents = run(['guard', root, '--advisories', 'incidents']).stdout;
  assert.match(incidents, /^1 version the advisory table names$/m);
  assert.equal(/CVE-2019-10744/.test(incidents), false, 'an old lodash is not an incident');

  const off = run(['guard', root, '--advisories', 'off']).stdout;
  assert.match(off, /^advisory {2}not checked: this policy says off/m);

  // A bad flag earns a usage error and no run: a report of a project nobody checked reads as a
  // report of a project with nothing wrong with it.
  const typo = run(['guard', root, '--advisories', 'incident']);
  assert.equal(typo.code, 2);
  assert.equal(typo.stdout, '');
  assert.match(typo.stderr, /^nirdep: guard: no advisory level incident, did you mean incidents\?$/m);
});

test('an allow list is consent to a package, and not to a release published to do harm', () => {
  const { code, stdout } = run(['guard', plant('waived', 'poisoned')]);
  assert.equal(code, 1, 'because the one that cannot be waived was not');
  assert.match(stdout, /^2 versions the advisory table names$/m);
  assert.match(stdout, /^ {4}Allowed by name, which does not cover a release published to do harm\.$/m);
  assert.match(stdout, /^1 advisory allowed by name$/m);
  assert.match(stdout, /DEP-31: the last four call sites go with the reporting rewrite/);
});

test('--annotate says it again in the dialect GitHub reads, after the report and not instead', () => {
  const { stdout } = run(['guard', plant(null, 'poisoned'), '--annotate']);
  const lines = stdout.split('\n');
  const verdict = lines.findIndex((line) => /^FAIL:/.test(line));
  const first = lines.findIndex((line) => line.startsWith('::'));
  assert.equal(verdict < first, true, 'workflow commands are noise in a terminal, so they go last');
  // A version comes from the lockfile, so that is the file every advisory is attached to.
  const commands = lines.filter((line) => line.startsWith('::'));
  assert.equal(commands.length, 4);
  assert.equal(commands.filter((one) => one.includes('file=package-lock.json')).length, 3);
  assert.equal(/node_modules/.test(stdout), false);
});

test('guard documents itself, and is no longer one of the pending commands', () => {
  const { stdout } = run(['guard', '--help']);
  // Flattened, because the description column moves the day an option longer than the
  // previous longest one is added, and this test is about the text and not the arithmetic.
  const text = flat(stdout);
  assert.match(stdout, /--policy <string>/);
  assert.match(text, /--\[no-\]dev count devDependencies as dependencies/);
  assert.match(text, /--max <number> fail above this many direct dependencies/);
  assert.match(text, /--allow <string\.\.\.> a package to permit this run, repeatable/);
  assert.match(text, /--advisories <string> how much of the advisory table fails the build: off, incidents, hits, all/);
  assert.match(text, /--annotate also print GitHub workflow annotations/);
  // The default is two file names and it folds, so it is read as a sentence.
  assert.match(text, new RegExp(`default: ${POLICY_FILE.replace('.', '\\.')}, then package\\.json`));

  const help = run(['help']).stdout;
  assert.match(help, /\n {2}guard {2,}CI mode: fail if a replaceable dependency reappears/);
  assert.equal(/guard\s+\(pending\)/.test(help), false);
});
