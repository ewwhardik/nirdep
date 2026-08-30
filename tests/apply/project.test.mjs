// The driver's tests, which are mostly about what it refuses to write.
//
// The tree is built in a temporary directory from a JSON table, so no fixture file in this
// repository has to contain a real third-party import for tools/verify.mjs to trip over.
// The interesting assertions are the two nobody writes until it has bitten them: that a
// file which failed its syntax check stops the files that passed from being written, and
// that the plan is made against the bytes the writer writes back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME, SOURCE_EXTENSIONS, applyProject, mayMention, planProject, readManifest, targetResolver,
} from '../../src/apply/project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'rules', 'tree.json'), 'utf8'));

/** Lay a table of paths and contents down on disk and hand back the root. */
function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-tree-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const at = (run, path) => run.files.find((one) => one.path === path);

test('the prefilter opens what it must and skips what it can', () => {
  assert.equal(mayMention('const a = 1;\n'), false);
  assert.equal(mayMention('// one day we will drop chalk\n'), true, 'over-accepting is the safe direction');
  assert.equal(mayMention(`const x = ${JSON.stringify('semver')};\n`), true);
  assert.equal(mayMention(''), false);
});

test('a missing or unreadable manifest is not an error', () => {
  const root = plant({ 'a.mjs': 'const a = 1;\n' });
  const absent = readManifest(root);
  assert.equal(absent.found, false);
  assert.equal(absent.type, 'commonjs', 'the default type is Node\'s own default');
  for (const field of ['dependencies', 'development']) assert.equal(absent[field].size, 0);
  for (const field of ['ranges', 'scripts']) assert.equal(absent[field].size, 0, `${field} is a usable empty`);
  writeFileSync(join(root, 'package.json'), 'this is not json', 'utf8');
  assert.equal(readManifest(root).found, false);
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "name": "p", "dependencies": { "chalk": "^5" },'
    + ' "devDependencies": { "semver": "*" }, "scripts": { "build": "node tools/build.mjs" } }', 'utf8');
  const found = readManifest(root);
  assert.equal(found.type, 'module');
  assert.equal(found.name, 'p');
  assert.ok(found.dependencies.has('chalk') && found.dependencies.has('semver'));
  assert.ok(found.development.has('semver') && !found.development.has('chalk'), 'dev dependencies are told apart');
  assert.equal(found.ranges.get('chalk'), '^5');
  assert.equal(found.scripts.get('build'), 'node tools/build.mjs');
});

test('the target is the package subpath until a runtime directory is named', () => {
  const rule = { target: 'nirdep/runtime/colour', subpath: 'runtime/colour' };
  assert.equal(targetResolver({ root: '/p' })(rule, '/p/src/a.mjs'), 'nirdep/runtime/colour');
  const into = targetResolver({ root: '/p', runtimeDir: 'nirdep/runtime' });
  assert.equal(into(rule, '/p/src/a.mjs'), '../nirdep/runtime/colour.mjs');
  assert.equal(into(rule, '/p/src/deep/down/a.mjs'), '../../../nirdep/runtime/colour.mjs');
  // A file beside the runtime gets an explicit ./ rather than a bare name, which would
  // resolve as a package specifier and load something else entirely.
  assert.equal(into(rule, '/p/nirdep/runtime/a.mjs'), './colour.mjs');
});

test('a walk of the tree finds the rewrites and names what it left', () => {
  const root = plant(TREE.project);
  const plan = planProject(root, { runtimeDir: 'nirdep/runtime' });
  assert.equal(plan.manifest.type, 'module');
  assert.deepEqual(plan.changes.map((one) => `${one.path}:${one.line}`), TREE.expect.changes);
  assert.deepEqual(plan.declined.map((one) => `${one.path}:${one.code}`), TREE.expect.declined);
  assert.ok(plan.counts.opened < plan.counts.scanned, 'the prefilter opened every file it saw');
  assert.deepEqual(plan.files.map((one) => one.path), [...plan.files.map((one) => one.path)].sort());
});

test('node_modules is not our business', () => {
  const root = plant({ ...TREE.project, 'node_modules/chalk/index.js': TREE.vendored });
  const plan = planProject(root);
  assert.equal(plan.changes.some((one) => one.path.startsWith('node_modules')), false);
});

test('a dry run reports what it would do and touches nothing', () => {
  const root = plant(TREE.project);
  const before = readFileSync(join(root, 'src/report.mjs'), 'utf8');
  const run = applyProject(planProject(root, { runtimeDir: 'nirdep/runtime' }), { write: false });
  assert.equal(run.wrote, false);
  assert.equal(run.counts.written, 0);
  assert.ok(run.counts.wouldWrite > 0);
  assert.equal(readFileSync(join(root, 'src/report.mjs'), 'utf8'), before);
});

test('a write run writes exactly the files it said it would, and is idempotent', () => {
  const root = plant(TREE.project);
  const first = applyProject(planProject(root, { runtimeDir: 'nirdep/runtime' }), { write: true });
  assert.equal(first.wrote, true);
  assert.equal(first.counts.written, TREE.expect.written.length);
  for (const path of TREE.expect.written) {
    assert.equal(at(first, path).outcome, OUTCOME.WRITTEN);
    assert.equal(readFileSync(join(root, path), 'utf8'), at(first, path).after);
  }
  const second = applyProject(planProject(root, { runtimeDir: 'nirdep/runtime' }), { write: true });
  assert.equal(second.counts.written, 0, 'a second run found something else to do');
});

test('a file that was broken before we read it is reported and skipped, not blamed on us', () => {
  const root = plant({ ...TREE.project, 'src/half.mjs': TREE.broken });
  const run = applyProject(planProject(root, { runtimeDir: 'nirdep/runtime' }), { write: true });
  const half = at(run, 'src/half.mjs');
  assert.equal(half.outcome, OUTCOME.WAS_BROKEN);
  assert.equal(half.gate.blame, 'source');
  assert.match(half.detail, /did not parse before/);
  assert.equal(run.halted, false, 'somebody else\'s broken file stopped the whole migration');
  assert.ok(run.counts.written > 0);
});

test('a rewrite that fails its own syntax check stops the whole run', () => {
  // Forced through a fake patch, because the real rules cannot produce this: the point is
  // that the writer does not trust them anyway.
  const source = "const chalk = 1;\n";
  const entry = (path, after) => ({
    file: join('/nowhere', path),
    path,
    source,
    kind: 'module',
    edits: 1,
    outcome: OUTCOME.WOULD_WRITE,
    detail: null,
    plan: { patch: { size: 1, apply: () => ({ after }) }, changes: [], declined: [] },
  });
  const saved = [];
  const run = applyProject({
    root: '/nowhere',
    files: [entry('bad.mjs', 'const chalk = ;\n'), entry('good.mjs', 'const chalk = 2;\n')],
  }, { write: true, save: (file) => saved.push(file) });
  assert.equal(run.halted, true);
  assert.equal(run.wrote, false);
  assert.deepEqual(saved, [], 'a file was written during a halted run');
  assert.equal(at(run, 'bad.mjs').outcome, OUTCOME.REJECTED);
  assert.equal(at(run, 'bad.mjs').gate.blame, 'patch');
  assert.equal(at(run, 'good.mjs').outcome, OUTCOME.WOULD_WRITE);
  assert.match(at(run, 'good.mjs').detail, /held back/);
});

test('a file that cannot be read is one line of the report, not an exception', () => {
  const root = plant(TREE.project);
  const plan = planProject(root, {
    files: [join(root, 'src/report.mjs'), join(root, 'src/gone.mjs')],
    read: (file) => {
      if (file.endsWith('gone.mjs')) throw new Error('ENOENT: it went away');
      return readFileSync(file, 'utf8');
    },
  });
  const run = applyProject(plan, { write: false });
  assert.equal(at(run, 'src/gone.mjs').outcome, OUTCOME.UNREADABLE);
  assert.match(at(run, 'src/gone.mjs').detail, /went away/);
  assert.equal(at(run, 'src/report.mjs').outcome, OUTCOME.WOULD_WRITE);
});

test('a save that fails is the file it failed on, not the run', () => {
  const root = plant(TREE.project);
  const plan = planProject(root, { runtimeDir: 'nirdep/runtime' });
  const run = applyProject(plan, {
    write: true,
    save: (file) => { if (file.endsWith('report.mjs')) throw new Error('EACCES: read-only'); },
  });
  assert.equal(at(run, 'src/report.mjs').outcome, OUTCOME.REJECTED);
  assert.match(at(run, 'src/report.mjs').detail, /read-only/);
  assert.equal(run.counts.written, TREE.expect.written.length - 1);
});

test('only source extensions are opened', () => {
  for (const extension of ['.mjs', '.cjs', '.js', '.jsx']) assert.ok(SOURCE_EXTENSIONS.has(extension));
  for (const extension of ['.json', '.ts', '.md']) assert.equal(SOURCE_EXTENSIONS.has(extension), false);
});
