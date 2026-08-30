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
 * semver in the lockfile that nobody asked for. */
function plant(policy = null) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-guard-'));
  const files = { ...VECTOR.project };
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
  assert.match(stdout, /^FAIL: 3 of 8 watched packages present\.$/m);
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
  assert.match(after.stdout, /^PASS: 8 packages watched, 1 allowed by name, nothing to report\.$/m);
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

test('guard documents itself, and is no longer one of the pending commands', () => {
  const { stdout } = run(['guard', '--help']);
  assert.match(stdout, /--policy <string>/);
  assert.match(stdout, /--\[no-\]dev {11}count devDependencies as dependencies/);
  assert.match(stdout, /--max <number> {7}fail above this many direct dependencies/);
  assert.match(stdout, /--allow <string\.\.\.> {2}a package to permit this run, repeatable/);
  // The default is two file names and it folds, so it is read as a sentence.
  assert.match(flat(stdout), new RegExp(`default: ${POLICY_FILE.replace('.', '\\.')}, then package\\.json`));

  const help = run(['help']).stdout;
  assert.match(help, /\n {2}guard {2,}CI mode: fail if a replaceable dependency reappears/);
  assert.equal(/guard\s+\(pending\)/.test(help), false);
});
