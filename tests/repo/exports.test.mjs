// The export map is a promise to a consumer, and an unresolvable subpath in it is
// the sort of defect that only shows up in someone else's project. This suite
// reads package.json and checks every promise it makes: each subpath exists, each
// one imports without side effects, and the entry point re-exports what it claims.
//
// It also pins the shape of the entry surface. `nirdep eject` rewrites a call site
// from `nirdep/runtime/semver` to a local copy, so the subpath spellings are part
// of the codemod's contract, not merely a convenience.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('every path the export map promises exists on disk', () => {
  const entries = Object.entries(manifest.exports);
  assert.ok(entries.length >= 4, `${entries.length} subpaths declared`);
  for (const [subpath, target] of entries) {
    assert.equal(typeof target, 'string', `${subpath} maps to a single file`);
    assert.ok(target.startsWith('./'), `${subpath} is relative`);
    assert.ok(existsSync(join(ROOT, target)), `${subpath} -> ${target} exists`);
  }
  assert.ok(existsSync(join(ROOT, manifest.bin.nirdep)), 'the bin exists');
  // `files` decides what a publish would contain, so a promised path must be inside it.
  for (const target of Object.values(manifest.exports)) {
    const top = target.slice(2).split('/')[0];
    assert.ok(manifest.files.includes(top), `${top} is in files[]`);
  }
});

test('the entry point re-exports the runtime, namespaced, with no work at import time', async () => {
  const entry = await import(new URL('../../src/index.mjs', import.meta.url));
  assert.deepEqual(Object.keys(entry).sort(), [
    'ABOUT', 'args', 'collect', 'collectDefault', 'colour', 'colourDefault', 'glob', 'globDefault',
    'semver', 'semverDefault',
  ]);
  assert.equal(entry.semver.valid('1.2.3'), '1.2.3');
  assert.equal(typeof entry.args.createCli, 'function');
  assert.equal(typeof entry.colour.createColour, 'function');
  assert.equal(typeof entry.collect.cloneDeep, 'function');
  assert.equal(entry.semverDefault, entry.semver.default);
  assert.equal(entry.colourDefault, entry.colour.default);
  assert.equal(entry.globDefault, entry.glob.default);
  assert.equal(entry.collectDefault, entry.collect.default);
  assert.equal(entry.ABOUT.publisher, 'Nastik AI');
  assert.equal(entry.ABOUT.developer, 'Sai Ram Dash (Hardik)');
  assert.equal(Object.isFrozen(entry.ABOUT), true);
  assert.deepEqual([...entry.ABOUT.runtime], Object.keys(manifest.exports).filter((one) => one !== '.')
    .map((one) => one.slice(2)));
});

test('each subpath imports on its own, so a consumer pays only for what it takes', async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const module = await import(new URL(`../../${target.slice(2)}`, import.meta.url));
    assert.ok(Object.keys(module).length > 0, `${subpath} exports something`);
  }
});
