// `explain` as a binary: the exit codes, and the promise that the styled page and the plain
// one are the same page.
//
// The unit tests cover what it says. What only a child process shows is the part a CI
// script depends on -- 0 when the name means something here, 2 when it does not -- and that
// the command is documented in the same table as the finished ones rather than hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { REPLACEABLE } from '../../src/rules/registry.mjs';
import { childEnvironment } from './environment.mjs';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
// Built from its code point rather than typed: a raw escape byte in a source file is what
// tests/repo/hygiene.test.mjs exists to catch, and a test for this command is not the
// exception to it.
const ESC = String.fromCharCode(0x1B);

function run(args = [], env = {}) {
  const childEnv = childEnvironment({ NO_COLOR: '1', ...env });
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('a package we replace exits zero and shows its reasoning', () => {
  const { code, stdout, stderr } = run(['explain', 'chalk']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^chalk {2}319\.8M downloads a week$/m);
  assert.match(stdout, /nirdep rewrites this one\./);
  assert.match(stdout, /util\.styleText {17}Node 20\.12\.0/);
  assert.match(stdout, /^ {4}nirdep eject colour$/m);
});

test('a package we do not replace exits 2, which is a CI-visible answer', () => {
  const { code, stdout } = run(['explain', 'left-pad']);
  assert.equal(code, 2);
  assert.match(stdout, /nothing to explain: left-pad/);
});

test('a builtin exits zero: the dependency is already gone', () => {
  const { code, stdout } = run(['explain', 'node:fs']);
  assert.equal(code, 0);
  assert.match(stdout, /node:fs is part of Node/);
});

test('no argument is the whole table, and every package we claim is in it', () => {
  const { code, stdout } = run(['explain']);
  assert.equal(code, 0);
  assert.match(stdout, /^what nirdep replaces$/m);
  for (const name of REPLACEABLE) assert.match(stdout, new RegExp(`\\b${name}\\b`), `${name} is listed`);
  assert.match(stdout, /^ {2}rewrite {3}chalk/m);
  assert.match(stdout, /^ {2}by hand {3}minimist/m);
});

test('piped output is plain, and a forced terminal is the same text painted', () => {
  const plain = run(['explain', 'semver']).stdout;
  assert.equal(plain.includes(ESC), false, 'a pipe gets no escape sequences');
  const styled = run(['explain', 'semver'], { NO_COLOR: undefined, FORCE_COLOR: '3' }).stdout;
  assert.ok(styled.includes(ESC), 'FORCE_COLOR paints');
  // Stripped with node:util rather than with our own strip(), so this compares the
  // implementation against something that is not itself.
  assert.equal(stripVTControlCharacters(styled), plain);
});

test('explain documents itself as a finished command', () => {
  const { stdout } = run(['explain', '--help']);
  assert.match(stdout, /why a package can be replaced, and whether a machine may do it/);
  assert.match(stdout, /\[package\] {2}a package name \(default: list all of them\)/);
  const help = run(['help']).stdout;
  assert.match(help, /\n {2}explain {2,}why a package can be replaced/);
  assert.equal(/explain.*\(pending\)/.test(help), false, 'and is not marked pending any more');
});
