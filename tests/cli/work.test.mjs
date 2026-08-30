// The two commands that touch a repository, run as a binary against a real directory.
//
// The unit tests already cover what the planner decides. What only a child process can
// show is the contract a user and a CI job depend on: `plan` prints and writes nothing,
// `apply` writes and says what it wrote, the diff goes to stdout so it can be piped into
// `git apply`, and the exit code means what the README says it means.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
const TREE = JSON.parse(readFileSync(new URL('../vectors/rules/tree.json', import.meta.url), 'utf8'));

function run(args = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const name of ['FORCE_COLOR', 'NO_COLOR']) if (!(name in env)) delete childEnv[name];
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function plant() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-cli-'));
  for (const [path, text] of Object.entries(TREE.project)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');

// The expected added lines are import statements, so they come from the vector table
// rather than from this file: tools/verify.mjs reads .mjs files looking for that exact
// shape and would count a test's assertion as a dependency of the project.
const ADDED = TREE.expect.added;
const lines = (text) => new Set(text.split('\n').map((line) => line.trimEnd()));

// Written as an escape, never as the byte: a raw control character in a source file is
// invisible in a diff and tests/repo/hygiene.test.mjs fails the repository for it.
const ESC = '\u001B';

test('plan prints a diff and a summary, and leaves the tree alone', () => {
  const root = plant();
  const before = read(root, 'src/report.mjs');
  const { code, stdout, stderr } = run(['plan', root]);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^--- a\/src\/report\.mjs$/m);
  assert.ok(lines(stdout).has(ADDED.package), 'the diff does not add the rewritten line');
  assert.match(stdout, /left alone/);
  assert.match(stdout, /rewrites in 2 files/);
  assert.equal(read(root, 'src/report.mjs'), before, 'plan wrote to the tree');
});

test('the diff plan prints is the diff git would produce', () => {
  // a/ and b/ prefixes and explicit ranges, so `nirdep plan | git apply` is a real
  // workflow rather than a claim in a README.
  const { stdout } = run(['plan', plant()]);
  const hunks = stdout.split('\n').filter((line) => line.startsWith('@@'));
  assert.ok(hunks.length > 0);
  for (const hunk of hunks) assert.match(hunk, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
});

test('--runtime rewrites to a path into the ejected directory, per file depth', () => {
  const printed = lines(run(['plan', plant(), '--runtime', 'nirdep/runtime']).stdout);
  assert.ok(printed.has(ADDED.ejected), 'a file one level down did not get one ../');
  assert.ok(printed.has(ADDED.ejectedDeeper), 'a file two levels down did not get two');
});

test('--no-diff keeps the reasons and drops the diff', () => {
  const { stdout } = run(['plan', plant(), '--no-diff']);
  assert.equal(stdout.includes('@@'), false);
  assert.match(stdout, /left alone/);
  assert.match(stdout, /not implemented yet|by hand/);
});

test('apply writes, says what it wrote, and finds nothing to do the second time', () => {
  const root = plant();
  const first = run(['apply', root, '--runtime', 'nirdep/runtime']);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /written/);
  for (const path of TREE.expect.written) {
    assert.match(read(root, path), /nirdep\/runtime\//, `${path} was not rewritten`);
  }
  assert.equal(read(root, 'src/cli.mjs'), TREE.project['src/cli.mjs'], 'an advise-only file was touched');
  const second = run(['apply', root, '--runtime', 'nirdep/runtime']);
  assert.match(second.stdout, /0 written/);
});

test('a project with nothing to replace is a success, not a usage error', () => {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-clean-'));
  writeFileSync(join(root, 'a.mjs'), 'export const a = 1;\n', 'utf8');
  const { code, stdout } = run(['plan', root]);
  assert.equal(code, 0);
  assert.match(stdout, /0 rewrites/);
});

test('a missing path is a refusal, not a report of a spotless project', () => {
  // walk() swallows ENOENT at every level, so before the root was checked a typo
  // printed "0 files seen ... 0 rewrites" and exited 0 -- the same output as a clean
  // repository. Exit 2 is the usage code, which is what a typo is.
  const missing = join(tmpdir(), 'nirdep-does-not-exist-9f2a');
  const { code, stdout, stderr } = run(['plan', missing]);
  assert.equal(code, 2);
  assert.equal(stdout, '', 'a path that cannot be read produced a report anyway');
  assert.match(stderr, /cannot read/);
  assert.ok(stderr.includes(missing), 'the message does not say which path');
  assert.equal(stderr.includes('at Object.'), false, 'a stack trace reached stderr');
});

test('a file where a directory belongs says so', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'nirdep-file-')), 'a.mjs');
  writeFileSync(file, 'export const a = 1;\n', 'utf8');
  const { code, stderr } = run(['apply', file]);
  assert.equal(code, 2);
  assert.match(stderr, /not a directory/);
});

test('piped output carries no escape sequences, and FORCE_COLOR paints the diff', () => {
  const root = plant();
  assert.equal(run(['plan', root]).stdout.includes(ESC), false);
  const styled = run(['plan', root], { FORCE_COLOR: '3' }).stdout;
  assert.ok(styled.includes(`${ESC}[32m+`), 'added lines are green');
  assert.ok(styled.includes(`${ESC}[31m-`), 'removed lines are red');
});

test('both commands document their own options', () => {
  for (const command of ['plan', 'apply']) {
    const { stdout } = run(['help', command]);
    assert.match(stdout, /--runtime/);
    assert.match(stdout, /--context/);
    assert.match(stdout, /\[path\]/);
  }
});
