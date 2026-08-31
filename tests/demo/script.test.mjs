// What `nirdep demo` decides, without the CLI around it.
//
// The demo's whole value is that it cannot lie: every stage calls the same function the
// matching command calls, so a green demo and a broken command is not a reachable state.
// These tests hold that line from both sides -- the happy path, and the one that matters
// more, where the "before" import unexpectedly succeeds and the walkthrough has to say so
// instead of narrating a failure that did not happen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO, DEMO_STAGES, modulesFor, plantDemo, runDemo } from '../../src/demo/script.mjs';
import { findSpecifiers } from '../../src/audit/imports.mjs';

/** A directory nobody else is using, cleaned up by the caller. */
const scratch = () => mkdtempSync(join(tmpdir(), 'nirdep-demo-'));

/** Run the whole thing once, and hand back everything it produced. */
async function once(options = {}) {
  const root = scratch();
  const seen = [];
  try {
    const result = await runDemo({ root, emit: (one) => seen.push(one), diff: false, ...options });
    return { root, result, seen, at: result.root };
  } finally {
    // The caller is done with the tree by the time it reads the result: every assertion
    // below is about what the run returned, except the two that read the rewritten files,
    // and those read them before this runs.
  }
}

test('the fixture is a project, not a toy: six declared dependencies, none installed', () => {
  const manifest = JSON.parse(DEMO.project['package.json']);
  assert.equal(Object.keys(manifest.dependencies).length, 6);
  assert.ok(DEMO.project['package-lock.json'], 'and a lockfile saying which versions were installed');
  assert.equal(DEMO.project['node_modules'], undefined, 'but nothing installed');
  const named = new Set();
  for (const [path, text] of Object.entries(DEMO.project)) {
    if (!path.endsWith('.mjs')) continue;
    for (const found of findSpecifiers(text)) named.add(found.specifier);
  }
  for (const name of Object.keys(manifest.dependencies)) {
    assert.ok(named.has(name), `${name} is declared and actually imported`);
  }
});

test('every export the payoff calls lives in a file the fixture plants', () => {
  for (const check of DEMO.demonstrate) {
    assert.ok(DEMO.project[check.module], `${check.module} is planted`);
    assert.ok(check.expect.length > 0, `${check.export} promises an answer`);
    assert.ok(check.why.length > 0, `${check.export} says why it is worth calling`);
  }
});

test('planting writes every fixture file through the save seam and touches no disk', () => {
  const written = new Map();
  const at = plantDemo('/nowhere', { save: (file, text) => written.set(file, text) });
  assert.equal(at, '/nowhere');
  assert.equal(written.size, Object.keys(DEMO.project).length);
  for (const path of Object.keys(DEMO.project)) {
    const key = [...written.keys()].find((one) => one.endsWith(path.split('/').join('/')));
    assert.ok(key, `${path} was written`);
    assert.equal(written.get(key), DEMO.project[path]);
  }
});

test('modulesFor names each runtime module once, sorted', () => {
  const plan = { changes: [
    { target: 'vendor/nirdep/semver.mjs' }, { target: 'vendor/nirdep/colour.mjs' },
    { target: 'vendor/nirdep/colour.mjs' },
  ] };
  assert.deepEqual(modulesFor(plan), ['colour', 'semver']);
});

test('the walkthrough runs seven stages in order and ends green', async () => {
  const { root, result, seen } = await once();
  try {
    assert.deepEqual(seen.map((one) => one.name), [...DEMO_STAGES]);
    assert.deepEqual(result.stages.map((one) => one.name), [...DEMO_STAGES]);
    assert.equal(result.ok, true, 'every stage passed');
    for (const one of result.stages) {
      assert.ok(one.title.length > 0, `${one.name} has a title`);
      assert.ok(one.command.length > 0, `${one.name} names a command`);
    }
    assert.deepEqual([...result.modules], ['collect', 'colour', 'glob', 'semver']);
    assert.ok(result.checks.length > 0, 'the payoff called something');
    for (const check of result.checks) assert.equal(check.ok, true, `${check.label} answered as promised`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('after the run the project imports files, not packages, and they exist', async () => {
  const { root, result, at } = await once();
  try {
    for (const name of result.modules) {
      assert.ok(existsSync(join(at, DEMO.runtimeDir, `${name}.mjs`)), `${name}.mjs was ejected`);
    }
    const entry = readFileSync(join(at, DEMO.demonstrate[0].module), 'utf8');
    for (const found of findSpecifiers(entry)) {
      assert.ok(found.specifier.startsWith('.'), `${found.specifier} is a file in the tree`);
    }
    // The two packages nirdep refuses are still declared, because it does not edit manifests.
    const manifest = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));
    assert.ok(manifest.dependencies.minimist, 'the declined package is still declared');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the scan the demo shows names the advisories in the lockfile it planted', async () => {
  const { root, result } = await once();
  try {
    const hit = result.scanned.advisories.hits;
    assert.ok(hit.length > 0, 'the planted lockfile is deliberately unhealthy');
    const gone = new Set(result.plan.changes.map((one) => one.specifier));
    assert.ok(hit.some((one) => !gone.has(one.package)),
      'and at least one advisory is against a package the rewrite will not touch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a "before" import that succeeds fails the demo instead of being narrated', async () => {
  // If something ever is installed, the honest answer is that the premise is gone. The
  // load seam is how that is provoked without installing anything.
  const root = scratch();
  try {
    const result = await runDemo({ root, diff: false, load: async () => ({}) });
    const before = result.stages.find((one) => one.name === 'before');
    assert.equal(before.ok, false);
    assert.match(before.text, /something is installed after all/);
    assert.equal(result.ok, false, 'and the whole run is not green');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a payoff whose answer changed is reported, not smoothed over', async () => {
  const root = scratch();
  try {
    // Everything imports; every export answers with the wrong thing.
    let first = true;
    const result = await runDemo({
      root,
      diff: false,
      load: async (url) => {
        if (first) { first = false; throw Object.assign(new Error('cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }); }
        // `then` is left undefined on purpose: a proxy that answers every property with a
        // function is a thenable, and awaiting one hangs the run rather than failing it.
        return new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : () => 'not what was promised') });
      },
    });
    assert.equal(result.stages.find((one) => one.name === 'before').ok, true);
    assert.equal(result.stages.find((one) => one.name === 'after').ok, false);
    for (const check of result.checks) assert.equal(check.ok, false);
    assert.equal(result.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
