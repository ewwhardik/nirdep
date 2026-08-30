// What the report prints, checked as text.
//
// Formatting tests earn their keep in exactly two places: when the numbers in the summary
// disagree with the body above it, and when a decline quietly stops being printed. Both
// have happened to every tool of this kind. The rest is padding, and the assertions here
// stay away from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { applyProject, planProject } from '../../src/apply/project.mjs';
import { applyReport, planReport, exitCodeFor } from '../../src/apply/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'rules', 'tree.json'), 'utf8'));

function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-report-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const fresh = () => planProject(plant(TREE.project), { runtimeDir: 'nirdep/runtime' });

test('the plan report holds a diff, the rewrites and every refusal', () => {
  const text = planReport(fresh());
  assert.match(text, /^--- a\/src\/deep\/plain\.mjs$/m);
  assert.match(text, /^\+\+\+ b\/src\/deep\/plain\.mjs$/m);
  assert.match(text, /^@@ -1,3 \+1,3 @@$/m);
  for (const change of TREE.expect.changes) {
    const [path, line] = change.split(':');
    assert.ok(text.includes(`${path}:${line}`), `${change} is missing from the report`);
  }
  assert.match(text, /left alone/);
  assert.match(text, /by hand/);
  assert.match(text, /wrong form/);
});

test('the summary line counts the same things the body listed', () => {
  const plan = fresh();
  const text = planReport(plan);
  const last = text.trimEnd().split('\n').at(-1);
  assert.match(last, new RegExp(`${plan.counts.scanned} files seen`));
  assert.match(last, new RegExp(`${plan.counts.changes} rewrites in ${plan.counts.touched} files`));
  assert.match(last, new RegExp(`${plan.counts.declined} dependencies left alone`));
  // The body prints one line per change and one heading per decline; if the counts and
  // the body ever part company, this is the assertion that says so.
  const rewrites = text.split('\n').filter((line) => line.startsWith('rewrite ')).length;
  assert.equal(rewrites, plan.counts.changes);
});

test('one of anything is singular', () => {
  const root = plant({ 'package.json': '{ "type": "module" }\n', 'a.mjs': TREE.project['src/report.mjs'] });
  const text = planReport(planProject(root));
  assert.match(text, /1 file seen/);
  assert.match(text, /0 dependencies left alone/);
  const one = plant({ 'package.json': '{ "type": "module" }\n', 'a.mjs': TREE.project['src/cli.mjs'] });
  assert.match(planReport(planProject(one)), /1 dependency left alone/);
});

test('the diff can be turned off without losing the reasons', () => {
  const plan = fresh();
  const text = planReport(plan, { diff: false });
  assert.equal(text.includes('@@'), false);
  assert.match(text, /rewrite /);
  assert.match(text, /left alone/);
});

test('the style hooks are used, and their absence is not a crash', () => {
  const plan = fresh();
  const marks = [];
  const style = Object.fromEntries(['bold', 'dim', 'cyan', 'yellow', 'green', 'red']
    .map((name) => [name, (text) => { marks.push(name); return `<${name}>${text}`; }]));
  const painted = planReport(plan, { style });
  assert.ok(marks.includes('green'), 'a rewrite line was not painted');
  assert.ok(marks.includes('red'), 'a removed diff line was not painted');
  assert.ok(marks.includes('cyan'), 'a hunk header was not painted');
  assert.ok(painted.length > planReport(plan).length);
  // A partial style object is filled in rather than throwing on the missing hooks.
  assert.doesNotThrow(() => planReport(plan, { style: { bold: (text) => text } }));
});

test('the apply report says written, and the dry run says would write', () => {
  const plan = fresh();
  const dry = applyReport(applyProject(plan, { write: false }));
  assert.match(dry, /would write {2}src\/report\.mjs/);
  assert.equal(dry.includes('written      src'), false);
  const wet = applyReport(applyProject(fresh(), { write: true }));
  assert.match(wet, /written {6}src\/report\.mjs/);
  assert.match(wet, new RegExp(`${TREE.expect.written.length} written`));
});

test('an unchanged file is not a line of output', () => {
  const text = applyReport(applyProject(fresh(), { write: false }));
  assert.equal(text.includes('src/quiet.mjs'), false);
  assert.equal(text.includes('src/cli.mjs'), false, 'a file with nothing to rewrite was listed');
  assert.match(text, /unchanged/, 'the count still has to be there');
});

test('a halted run says so, and says why nothing moved', () => {
  const entry = (path, after) => ({
    file: join('/nowhere', path),
    path,
    source: 'const chalk = 1;\n',
    kind: 'module',
    edits: 1,
    outcome: 'would-write',
    detail: null,
    plan: { patch: { size: 1, apply: () => ({ after }) }, changes: [], declined: [] },
  });
  const run = applyProject({
    root: '/nowhere',
    files: [entry('bad.mjs', 'const chalk = ;\n'), entry('good.mjs', 'const chalk = 2;\n')],
  }, { write: true, save: () => {} });
  const text = applyReport(run);
  assert.match(text, /rejected/);
  assert.match(text, /nothing was written/);
  assert.match(text, /held back/);
  assert.equal(exitCodeFor(run), 1);
});

test('a clean run and an empty run both exit zero', () => {
  assert.equal(exitCodeFor(applyProject(fresh(), { write: false })), 0);
  const empty = planProject(plant({ 'a.mjs': 'const a = 1;\n' }));
  assert.equal(exitCodeFor(applyProject(empty, { write: false })), 0);
  assert.match(applyReport(applyProject(empty, { write: false })), /0 written/);
});

test('a long reason is folded, not truncated', () => {
  const text = planReport(fresh());
  const body = text.split('\n');
  const start = body.findIndex((line) => line.includes('by hand'));
  const folded = body.slice(start + 1, start + 6).filter((line) => line.startsWith('    '));
  assert.ok(folded.length > 1, 'the advice was printed on one enormous line');
  for (const line of folded) assert.ok(line.length <= 84, `a folded line is ${line.length} wide`);
  assert.match(folded.join(' '), /advisories\.$/, 'the advice lost its tail');
});
