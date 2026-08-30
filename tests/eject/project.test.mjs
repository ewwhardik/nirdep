// The command that lets the tool leave.
//
// Two properties carry the weight here and both are about trust rather than about output.
// Eject must be deterministic -- the same module twice is the same bytes -- because that is
// the only thing that makes "this file differs from ours" a fact rather than a guess. And
// it must refuse to overwrite bytes it did not write, because the file it would clobber is
// somebody's edit and the whole pitch of the command is that editing is allowed.
//
// The catalogue is read off our own `exports` map, so a test that hard-codes three module
// names would pass while the map said something else. These assert the relationship
// instead: every module on offer resolves to a file that exists, and every rule in the
// registry points at one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { catalogue, ejectPlan, ejectApply, STATE, RESULT } from '../../src/eject/project.mjs';
import { ejectExitCode, ejectReport, ejectList } from '../../src/eject/report.mjs';
import { RULES } from '../../src/rules/registry.mjs';
import { DEFAULT_RUNTIME_DIR } from '../../src/apply/project.mjs';

/** A plan against a directory that is empty, without touching the disk to prove it. */
const missing = (file) => { const error = new Error(`ENOENT: ${file}`); error.code = 'ENOENT'; throw error; };

// The source files come off the real disk: this fakes the destination, not the runtime. A
// fixture copy of a 1700-line module would be the same file twice, and the copy would be
// the one that rots. Keyed by full path rather than by name, because `semver.mjs` is the
// name of both the module we read and the file we would write over it.
const SOURCES = new Set(catalogue().map((module) => module.source));

/** A read hook that answers for the destination from a table, and for anything else truthfully. */
function disk(files = {}) {
  return (file) => {
    if (SOURCES.has(file) || basename(file) === 'package.json') return readFileSync(file, 'utf8');
    return files[basename(file)] ?? missing(file);
  };
}

const planFor = (options = {}) => ejectPlan({ cwd: '/project', read: disk(options.files), ...options });
const entryFor = (plan, name) => plan.files.find((one) => one.module === name);

/** Apply against hooks instead of a filesystem, so what was written is a list to assert on. */
function ran(plan, options = {}) {
  const wrote = [];
  const made = [];
  const run = ejectApply(plan, {
    mkdir: (dir) => made.push(dir),
    writeFile: (file, text) => wrote.push([basename(file), text.length]),
    ...options,
  });
  return { run, wrote: wrote.map(([leaf]) => leaf), made };
}

test('the modules on offer are the ones package.json exports, not a list typed here', () => {
  const modules = catalogue();
  assert.deepEqual(modules.map((one) => one.name), ['args', 'colour', 'semver']);
  for (const module of modules) {
    assert.equal(existsSync(module.source), true, `${module.name} resolves to a file that is there`);
    assert.equal(module.leaf, `${module.name}.mjs`);
    assert.equal(module.target, `nirdep/runtime/${module.name}`);
    assert.equal(module.subpath, `runtime/${module.name}`);
  }
  // Every package we claim to replace has a module to replace it with. A rule pointing at
  // a subpath nobody can eject is advice with no way to take it.
  const offered = new Set(modules.map((one) => one.subpath));
  for (const rule of RULES) assert.equal(offered.has(rule.subpath), true, `${rule.package} has a module`);
  assert.deepEqual(
    catalogue().find((one) => one.name === 'semver').replaces,
    ['semver'],
  );
});

test('the banner names where the file came from and keeps the licence line', () => {
  const text = entryFor(planFor(), 'colour').text;
  const head = text.split('\n').slice(0, 8);
  assert.match(head[0], /^\/\/ colour\.mjs -- vendored from nirdep\/runtime\/colour, version \d/);
  assert.match(head[1], /^\/\/ Replaces chalk, strip-ansi, supports-color, ansi-styles\.$/);
  assert.match(text, /^\/\/ MIT\. Copyright \(c\) 2026 Hardik \(Nastik AI\)\.$/m);
  // The module's own header survives underneath it: the banner explains the file, the
  // header explains the code, and neither is a substitute for the other.
  assert.match(text, /\n\/\/ nirdep\/runtime\/colour -- terminal styling on the standard library\./);
  assert.equal(text.endsWith('\n'), true);
});

test('the same module twice is the same bytes, which is what makes a diff mean anything', () => {
  assert.equal(entryFor(planFor(), 'args').text, entryFor(planFor(), 'args').text);
  // No date, no path, no username. Every one of those has ended up in a generated header
  // somewhere and every one of them turns a re-run into a spurious change.
  assert.equal(/\b20\d\d-\d\d-\d\d\b/.test(entryFor(planFor(), 'args').text), false);
});

test('a file already there and already identical is not a conflict', () => {
  const planned = entryFor(planFor(), 'semver').text;
  const plan = planFor({ files: { 'semver.mjs': planned } });
  assert.equal(entryFor(plan, 'semver').state, STATE.SAME);
  const { run, wrote } = ran(plan, { write: true });
  assert.equal(run.counts.skipped, 1);
  assert.deepEqual(wrote, ['args.mjs', 'colour.mjs'], 'the other two are missing, so they are written');
  assert.equal(ejectExitCode(run), 0, 're-running eject is free, not an error');
});

test('a file that differs is refused until somebody says --force', () => {
  const plan = planFor({ modules: ['colour'], files: { 'colour.mjs': '// mine, thanks\n' } });
  assert.equal(entryFor(plan, 'colour').state, STATE.DIFFERS);
  const refused = ran(plan, { write: true });
  assert.equal(refused.run.counts.refused, 1);
  assert.deepEqual(refused.wrote, [], 'the refusal is a refusal, not a warning printed after the write');
  assert.equal(ejectExitCode(refused.run), 2, "the user's to resolve, so 2 rather than 1");
  const forced = ran(plan, { write: true, force: true });
  assert.equal(forced.run.counts.written, 1);
  assert.deepEqual(forced.wrote, ['colour.mjs']);
  assert.equal(ejectExitCode(forced.run), 0);
});

test('a destination that is there and unreadable is not a destination to overwrite', () => {
  const read = (file) => {
    if (!SOURCES.has(file) && basename(file) === 'colour.mjs') {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return disk()(file);
  };
  const plan = ejectPlan({ cwd: '/project', modules: ['colour'], read });
  assert.equal(entryFor(plan, 'colour').state, STATE.UNREADABLE);
  const { run, wrote } = ran(plan, { write: true, force: true });
  assert.equal(run.counts.refused, 1);
  assert.deepEqual(wrote, [], 'not with --force either: a file we cannot read is a file we cannot diff');
  assert.match(run.files[0].reason, /cannot be read/);
});

test('a dry run writes nothing at all, including the directory', () => {
  const { run, wrote, made } = ran(planFor(), { write: false });
  assert.equal(run.counts.wouldWrite, 3);
  assert.deepEqual(wrote, []);
  assert.deepEqual(made, [], 'an empty directory left behind is still a change to the tree');
  assert.equal(run.wrote, false);
  assert.equal(ejectExitCode(run), 0);
});

test('the directory is made once, and only when there is something to put in it', () => {
  const all = ran(planFor(), { write: true });
  assert.equal(all.run.counts.written, 3);
  assert.equal(all.made.length, 1, 'once, not once per file');
  const planned = entryFor(planFor(), 'colour').text;
  const same = ran(planFor({ modules: ['colour'], files: { 'colour.mjs': planned } }), { write: true });
  assert.equal(same.run.counts.skipped, 1);
  assert.deepEqual(same.made, [], 'nothing to write, nothing to create');
});

test('a write that fails is our fault, and says which file', () => {
  const { run } = ran(planFor({ modules: ['semver'] }), {
    write: true,
    writeFile: () => { throw new Error('ENOSPC: no space left on device'); },
  });
  assert.equal(run.counts.failed, 1);
  assert.match(run.files[0].reason, /ENOSPC/);
  assert.equal(ejectExitCode(run), 1, 'a failed write is not something the user can rephrase');
});

test('an unknown module name is collected rather than guessed at', () => {
  const plan = planFor({ modules: ['colour', 'colur', 'chalk'] });
  assert.deepEqual(plan.unknown, ['colur', 'chalk']);
  assert.deepEqual(plan.files.map((one) => one.module), ['colour'], 'the ones that exist still get planned');
  const { run } = ran(plan, { write: true });
  assert.equal(ejectExitCode(run), 2);
  const text = ejectReport(run);
  assert.match(text, /no such runtime module: colur {2}did you mean colour\?/);
  assert.match(text, /no such runtime module: chalk\n/, 'and no suggestion where there is no near miss');
  assert.match(text, /there are 3: args, colour, semver/);
});

test('where the files go is where apply expects to find them', () => {
  assert.equal(planFor().into, DEFAULT_RUNTIME_DIR);
  assert.equal(entryFor(planFor(), 'args').path, `${DEFAULT_RUNTIME_DIR}/args.mjs`);
  const named = planFor({ into: 'vendor/runtime' });
  assert.equal(entryFor(named, 'args').path, 'vendor/runtime/args.mjs');
  const absolute = ejectPlan({ cwd: '/project', into: '/elsewhere/lib', modules: ['args'], read: disk() });
  assert.equal(absolute.dir, '/elsewhere/lib');
});

test('the report ends with the command that makes the copy reachable', () => {
  const text = ejectReport(ran(planFor({ into: 'vendor' }), { write: true }).run);
  assert.match(text, /^ {2}written {5}args {4}vendor\/args\.mjs {2}\d+ lines, \d+ bytes$/m);
  assert.match(text, /replaces minimist, commander, yargs\n/);
  assert.match(text, /next: nirdep apply --runtime vendor \.\n$/);
  // Printed on the boring path too: "nothing to do" is exactly the moment somebody has
  // forgotten that the imports still point at the package.
  const planned = entryFor(planFor(), 'colour').text;
  const same = ran(planFor({ modules: ['colour'], files: { 'colour.mjs': planned } }), { write: true });
  assert.match(ejectReport(same.run), /up to date {2}colour[\s\S]*next: nirdep apply --runtime/);
  const dry = ejectReport(ran(planFor(), { write: false }).run);
  assert.match(dry, /would add/);
  assert.match(dry, /nothing was written: this was a dry run\.\n$/);
  assert.equal(dry.includes('next:'), false, 'nothing to point at until something is written');
});

test('the refusal explains the way out, once, in a sentence', () => {
  const plan = planFor({ modules: ['colour', 'args'], files: { 'colour.mjs': '// mine\n' } });
  const text = ejectReport(ran(plan, { write: true }).run);
  assert.match(text, /refused {5}colour/);
  assert.match(text, /it differs from what eject would write/);
  assert.match(text, /1 file already there and not what this version of nirdep writes\./);
  assert.match(text, /pass --force to take ours\./);
  assert.equal(text.includes('next:'), false, 'a half-finished eject gets no next step');
});

test('--list is the catalogue, sizes and all, and folds inside 80 columns', () => {
  const text = ejectList(catalogue());
  assert.match(text, /^runtime modules\n/);
  assert.match(text, /\n {2}colour {2}nirdep\/runtime\/colour\n/);
  assert.match(text, /replaces chalk, strip-ansi, supports-color, ansi-styles\n/);
  for (const line of text.split('\n')) assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
});

test('every result the applier can produce has a verb to print for it', () => {
  const s = { bold: (text) => text, dim: (text) => text, cyan: (text) => text, yellow: (text) => text, green: (text) => text, red: (text) => text };
  for (const result of Object.values(RESULT)) {
    const run = {
      into: 'vendor', wrote: true, forced: false, unknown: [], available: ['colour'],
      files: [{ module: 'colour', path: 'vendor/colour.mjs', replaces: [], lines: 1, bytes: 1, result, reason: null }],
      counts: { written: 0, wouldWrite: 0, skipped: 0, refused: 0, failed: 0 },
    };
    assert.equal(ejectReport(run, { style: s }).includes('?'), false, `${result} has a verb`);
  }
});
