// The policy run over a project, as three signals that refuse to be one boolean.
//
// `scan` is stubbed here rather than planted on disk. That is not a shortcut: the point of
// these tests is the combinations, and a package that is installed but never declared, or
// declared but never installed, is two lines of a fixture and half an hour of a real npm
// tree. tests/cli/guard.test.mjs runs the whole thing against a planted project, which is
// where the readers themselves get exercised.
//
// The case worth reading twice is `dev: false`. A development dependency is still installed,
// so the flag has to silence the lockfile signal as well as the manifest one -- otherwise it
// looks like it works, and does nothing at all on a project that has run npm install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardExitCode, guardProject } from '../../src/guard/project.mjs';
import { SIGNAL } from '../../src/guard/policy.mjs';
import { ACTION } from '../../src/rules/registry.mjs';

/**
 * The parts of a scan that guard reads, and nothing else. Written as one call per package so
 * a case reads as the situation it is testing: `{ chalk: { declared: '^5.0.0', installed: ['5.3.0'] } }`.
 */
function scanOf(packages, extra = {}) {
  const dependencies = new Set();
  const development = new Set();
  const ranges = new Map();
  const byName = new Map();
  const source = [];
  for (const [name, state] of Object.entries(packages)) {
    if (state.declared !== undefined) {
      dependencies.add(name);
      ranges.set(name, state.declared);
      if (state.dev === true) development.add(name);
    }
    if (state.installed !== undefined) {
      byName.set(name, state.installed.map((version) => ({ name, version })));
    }
    if (state.sites !== undefined) {
      source.push({
        name,
        files: [...new Set(state.sites.map((one) => one.path))],
        sites: state.sites,
      });
    }
  }
  return {
    manifest: { name: 'demo', dependencies, development, ranges },
    lock: { kind: 'npm', understood: true, note: null, byName },
    source: { counts: { scanned: 3, opened: 1, lexed: 1 }, unparsed: [], packages: source },
    counts: { direct: extra.direct ?? dependencies.size },
  };
}

/** A guard run with the policy handed straight in, so no file is involved. */
function guard(packages, policy = {}, extra = {}) {
  return guardProject('/demo', {
    scan: scanOf(packages, extra),
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    overrides: policy,
  });
}

const rowFor = (result, name) => [...result.breaches, ...result.exempt, ...result.quiet]
  .find((one) => one.name === name);
const site = (path, line) => ({ path, line, specifier: 'chalk', form: 'default' });

test('the three ways a dependency comes back are three signals', () => {
  const result = guard({
    chalk: { declared: '^5.3.0', installed: ['5.3.0'], sites: [site('src/a.mjs', 1), site('src/b.mjs', 4)] },
    minimist: { declared: '^1.2.8' },
    semver: { installed: ['7.6.0'] },
    'strip-ansi': { sites: [site('src/c.mjs', 2)] },
  });
  assert.equal(result.ran, true);
  assert.deepEqual([...rowFor(result, 'chalk').signals],
    [SIGNAL.DECLARED, SIGNAL.INSTALLED, SIGNAL.IMPORTED]);
  assert.deepEqual([...rowFor(result, 'minimist').signals], [SIGNAL.DECLARED]);
  assert.deepEqual([...rowFor(result, 'semver').signals], [SIGNAL.INSTALLED]);
  assert.deepEqual([...rowFor(result, 'strip-ansi').signals], [SIGNAL.IMPORTED]);
  assert.equal(result.counts.breached, 4);
  assert.equal(guardExitCode(result), 1);
});

test('a package the policy does not watch is still seen, and said so', () => {
  const result = guard(
    { chalk: { declared: '^5.3.0', installed: ['5.3.0'], sites: [site('src/a.mjs', 1)] } },
    { signals: [SIGNAL.IMPORTED] },
  );
  const row = rowFor(result, 'chalk');
  assert.deepEqual([...row.signals], [SIGNAL.IMPORTED], 'only what the policy asked about');
  assert.deepEqual([...row.seen], [SIGNAL.DECLARED, SIGNAL.INSTALLED, SIGNAL.IMPORTED],
    'everything found, so the report can say what it is not minding');
});

test('a narrowed policy can pass on a package it can plainly see', () => {
  const result = guard({ minimist: { declared: '^1.2.8', installed: ['1.2.8'] } }, { signals: [SIGNAL.IMPORTED] });
  assert.equal(result.counts.breached, 0);
  assert.equal(guardExitCode(result), 0);
  // Not lost: it lands in `quiet` with its `seen` intact, which is what the report reads to
  // print "present but not watched here" under a green result.
  assert.deepEqual([...rowFor(result, 'minimist').seen], [SIGNAL.DECLARED, SIGNAL.INSTALLED]);
});

test('dev: false silences the manifest and the lockfile together', () => {
  const packages = { minimist: { declared: '^1.2.8', dev: true, installed: ['1.2.8'] } };
  assert.equal(guard(packages).counts.breached, 1, 'development counts by default');

  const result = guard(packages, { dev: false });
  assert.equal(result.counts.breached, 0, 'a dev-only package is installed, and still exempt');
  assert.deepEqual([...rowFor(result, 'minimist').signals], []);
  assert.equal(rowFor(result, 'minimist').dev, true, 'the row still knows what it is');
});

test('an import is an import whether or not it was ever declared', () => {
  // The phantom case: a line that has been broken since it was written, or a package
  // arriving through somebody else's tree. `dev` has nothing to say about either.
  const result = guard({ chalk: { sites: [site('src/a.mjs', 7)] } }, { dev: false });
  assert.deepEqual([...rowFor(result, 'chalk').signals], [SIGNAL.IMPORTED]);
  assert.equal(guardExitCode(result), 1);
});

test('an allowed package moves out of the failures and keeps its reason', () => {
  const result = guardProject('/demo', {
    scan: scanOf({ chalk: { declared: '^5.3.0', sites: [site('src/a.mjs', 1)] } }),
    read: () => JSON.stringify({ guard: { allow: { chalk: 'DEP-14, the logo needs 256 colours' } } }),
  });
  assert.equal(result.counts.breached, 0);
  assert.equal(result.counts.exempt, 1);
  assert.equal(result.exempt[0].reason, 'DEP-14, the logo needs 256 colours');
  assert.equal(guardExitCode(result), 0, 'allowed by name is not a failure');
});

test('the cap is a second, blunter question', () => {
  const under = guard({ 'left-pad': { declared: '^1.3.0' } }, { max: 1 });
  assert.deepEqual(under.max, { limit: 1, direct: 1, over: false });
  assert.equal(guardExitCode(under), 0);

  const over = guard({ 'left-pad': { declared: '^1.3.0' } }, { max: 1 }, { direct: 4 });
  assert.equal(over.max.over, true);
  assert.equal(over.counts.breached, 0, 'nothing denied came back');
  assert.equal(guardExitCode(over), 1, 'and it fails anyway, because four is more than one');
});

test('a policy we could not read stops the run rather than half-guarding', () => {
  const result = guardProject('/demo', {
    scan: scanOf({ chalk: { declared: '^5.3.0' } }),
    read: () => JSON.stringify({ guard: { signals: ['imports'] } }),
  });
  assert.equal(result.ran, false);
  assert.deepEqual([...result.breaches], []);
  assert.equal(result.counts.guarded, 0, 'nothing was watched, so nothing may be claimed');
  assert.equal(guardExitCode(result), 2);
});

test('every row carries the remedy the rule decides, not one this file typed', () => {
  const result = guard({
    chalk: { declared: '^5.3.0' },
    minimist: { declared: '^1.2.8' },
    'left-pad': { declared: '^1.3.0' },
  }, { deny: ['chalk', 'minimist', 'left-pad'] });
  const chalk = rowFor(result, 'chalk');
  assert.equal(chalk.replaceable, true);
  assert.equal(chalk.action, ACTION.REWRITE);
  assert.match(chalk.target, /^nirdep\/runtime\/colour/);
  assert.equal(chalk.module, 'colour', 'the module `nirdep eject` would be told to copy');
  // A name somebody added to their own deny list need not be one we replace, and the report
  // has to be able to say so instead of offering a rewrite that does not exist.
  const pad = rowFor(result, 'left-pad');
  assert.equal(pad.replaceable, false);
  assert.equal(pad.target, null);
  assert.equal(pad.module, null);
});

test('the first site is a file and a line, because that is what a build log is for', () => {
  const result = guard({ chalk: { sites: [site('src/b.mjs', 12), site('src/c.mjs', 3)] } });
  const row = rowFor(result, 'chalk');
  assert.deepEqual(row.first, { path: 'src/b.mjs', line: 12, specifier: 'chalk', form: 'default' });
  assert.equal(row.files, 2);
  assert.equal(row.sites, 2);
  assert.equal(rowFor(result, 'minimist').first, null);
});

test('two copies of one package are one row with both versions', () => {
  const result = guard({ semver: { installed: ['7.6.0', '6.3.1', '7.6.0'] } });
  assert.deepEqual([...rowFor(result, 'semver').versions], ['6.3.1', '7.6.0']);
});

test('nothing here requires the replacement to be used', () => {
  // A project can pass this guard with none of nirdep in it. "You must depend on us
  // instead" is not a guard, it is a lock-in, and it would be the one rule in this tool
  // that served the tool rather than the project.
  const result = guard({});
  assert.equal(guardExitCode(result), 0);
  assert.equal(result.counts.breached, 0);
  assert.equal(result.counts.guarded > 0, true, 'and it did watch for them');
});

test('the lockfile is quoted rather than restated, caveats and all', () => {
  const scan = scanOf({ chalk: { declared: '^5.3.0' } });
  const result = guardProject('/demo', {
    scan: { ...scan, lock: { ...scan.lock, understood: false, kind: 'none', note: 'no lockfile' } },
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  // `file` travels with the caveat because the annotations need somewhere to point: a version
  // comes from the lockfile, and with no lockfile there is no file to attach it to.
  assert.deepEqual(result.lock, { kind: 'none', file: null, understood: false, note: 'no lockfile' });
  assert.equal(result.source.counts.scanned, 3);
});
