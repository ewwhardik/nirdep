// Finding the replacement in somebody's tree, and refusing to write over their words.
//
// Adoption is the half of this that can be wrong in a way nobody notices. The document is
// generated after the migration, when the packages are gone and there is nothing left to
// scan for, so the only evidence that anything was replaced is an import. Guessing from a
// file name would be cheap and would put a claim in the write-up that the code cannot
// support: half the JavaScript projects in the world have a `src/args.mjs` in them, and
// almost none of them got it from here. Every case below is about that distinction.
//
// The write half follows eject: identical is not a conflict, different is somebody's edit,
// and this file is one a person is meant to finish by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESULT, STDLIB_FILE, stdlibAdoption, stdlibApply, stdlibPlan,
} from '../../src/stdlib/project.mjs';
import { fixtureKey } from '../paths.mjs';

/** Our own runtime, as the exports map would report it, without reading package.json. */
const CATALOGUE = ['args', 'colour', 'semver'].map((name) => ({
  name, source: `/n/src/runtime/${name}.mjs`,
}));

/** The banner eject writes, which is the only provenance a vendored copy carries. */
const banner = (name) => `// ${name}.mjs -- vendored from nirdep/runtime/${name}, version 0.1.0.\n`
  + '// Replaces chalk.\n//\n// MIT. Copyright (c) 2026 Hardik (Nastik AI).\n\n';

/**
 * Adoption over a tree that only exists as an object. Keys are absolute paths; the ones that
 * are walked are the source files, and the rest are there to be resolved into.
 */
function adoptionOf(files, options = {}) {
  const read = (given) => {
    const file = fixtureKey(given);
    if (!(file in files)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    // A null entry is a file that is there and will not open, which is a different failure
    // from one that is not there and has to be tolerated just as quietly.
    if (files[file] === null) throw Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
    return files[file];
  };
  return stdlibAdoption(options.root ?? '/n', {
    files: options.walk ?? Object.keys(files).filter((path) => /^\/n\/(bin|src)\//.test(path)),
    read,
    catalogue: options.catalogue ?? CATALOGUE,
  });
}

test('the package form is the easy case, and it is recorded as itself', () => {
  const found = adoptionOf({
    '/n/src/a.mjs': "import colour from 'nirdep/runtime/colour';\nimport args from 'nirdep/runtime/args.mjs';\n",
    '/n/src/b.mjs': "import { bold } from 'nirdep/runtime/colour';\n",
  });
  assert.deepEqual([...found.keys()].sort(), ['args', 'colour']);
  const colour = found.get('colour');
  assert.deepEqual(colour.files, ['src/a.mjs', 'src/b.mjs']);
  assert.equal(colour.sites.length, 2);
  assert.equal(colour.vendored, false);
  assert.equal(colour.home, false);
  assert.deepEqual(colour.sites.map((one) => one.line), [1, 1]);
  // The extension is optional in the subpath and either spelling is the same module.
  assert.equal(found.get('args').sites[0].specifier, 'nirdep/runtime/args.mjs');
});

test('a copy in the tree is identified by its banner, never by its name', () => {
  const found = adoptionOf({
    '/n/src/a.mjs': "import colour from '../vendor/colour.mjs';\nimport args from './args.mjs';\n",
    '/n/vendor/colour.mjs': `${banner('colour')}export const bold = (text) => text;\n`,
    // A project's own module, with the same file name and no claim of provenance in it. This
    // is the false positive the whole design is arranged around.
    '/n/src/args.mjs': "// our own flags, thanks\nexport const flags = () => ({});\n",
  });
  assert.deepEqual([...found.keys()], ['colour']);
  assert.equal(found.get('colour').vendored, true);
  assert.equal(found.get('colour').home, false);
  assert.equal(found.get('colour').sites[0].kind, 'copy');
});

test('an import that lands on our own source is the runtime, not a copy of it', () => {
  const found = adoptionOf({
    // What nirdep's own bin does. The file is never opened: the path is the evidence, so a
    // read of it here would throw and the case would fail.
    '/n/bin/nirdep.mjs': "import { createColour } from '../src/runtime/colour.mjs';\n",
    '/n/src/scan/one.mjs': "import { satisfies } from '../runtime/semver.mjs';\n",
  });
  assert.deepEqual([...found.keys()].sort(), ['colour', 'semver']);
  assert.equal(found.get('colour').home, true);
  assert.equal(found.get('colour').vendored, false);
  assert.equal(found.get('colour').sites[0].kind, 'source');
  assert.deepEqual(found.get('semver').files, ['src/scan/one.mjs']);
});

test('the things that look like adoption and are not', () => {
  const found = adoptionOf({
    '/n/src/a.mjs': [
      "import a from './colour.js';",          // not .mjs: not a file eject writes
      "import b from './helpers.mjs';",        // not a module name we know
      "import c from './gone.mjs';",           // the name is right, the file is not there
      "import d from './plain.mjs';",          // there, readable, and says nothing about us
      "import e from 'nirdep/runtime/paint';", // a subpath that does not exist
      "import f from 'node:util';",            // a builtin, which is the point of all this
      '',
    ].join('\n'),
    '/n/src/colour.js': 'module.exports = {};\n',
    '/n/src/helpers.mjs': 'export const help = 1;\n',
    '/n/src/plain.mjs': '// somebody else\nexport const plain = 1;\n',
  });
  assert.equal(found.size, 0);
});

test('an unreadable file is the scan report to make, not this one', () => {
  const found = adoptionOf({
    '/n/src/a.mjs': "import colour from 'nirdep/runtime/colour';\n",
    '/n/src/locked.mjs': null,
  }, { walk: ['/n/src/a.mjs', '/n/src/locked.mjs', '/n/src/vanished.mjs'] });
  assert.deepEqual([...found.keys()], ['colour'], 'one file it could not open, and no exception');
});

test('what is already at the path decides what apply is allowed to do', () => {
  const document = { markdown: '# STDLIB.md — demo\n', counts: { lines: 1, bytes: 20 } };
  const planned = (existing) => stdlibPlan(document, {
    root: '/p',
    read: () => {
      if (existing === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (existing instanceof Error) throw existing;
      return existing;
    },
  });

  const fresh = planned(null);
  assert.equal(fresh.display, STDLIB_FILE);
  assert.equal(fresh.existing, null);
  assert.equal(fresh.unreadable, null);
  assert.equal(fresh.same, false);

  assert.equal(planned(document.markdown).same, true);
  // A file that is there and cannot be compared is not a file to overwrite on a hunch.
  assert.match(planned(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })).unreadable, /EACCES/);
});

test('the five things that can happen to the file, and which of them is the user to resolve', () => {
  const document = { markdown: '# STDLIB.md — demo\n', counts: { lines: 1, bytes: 20 } };
  const written = [];
  const run = (existing, options = {}) => stdlibApply(stdlibPlan(document, {
    root: '/p',
    read: () => {
      if (existing === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (existing instanceof Error) throw existing;
      return existing;
    },
  }), {
    ...options,
    writeFile: options.writeFile ?? ((path, text) => { written.push([path, text]); }),
  });

  const first = run(null);
  assert.equal(first.result, RESULT.WRITTEN);
  assert.equal(first.reason, null);
  assert.equal(first.replaced, false);
  // The path is whatever `resolve` made of it, which is spelt differently on Windows; the
  // key is what a fixture would have written.
  assert.deepEqual([fixtureKey(written.at(-1)[0]), written.at(-1)[1]], ['/p/STDLIB.md', document.markdown]);

  // Re-running is free, which is what makes it safe to put in a script.
  assert.equal(run(document.markdown).result, RESULT.SAME);

  const edited = run('# STDLIB.md — demo\n\nand then a paragraph I wrote myself\n');
  assert.equal(edited.result, RESULT.REFUSED);
  assert.match(edited.reason, /it is there and says something else; --force to replace it/);

  const forced = run('mine', { force: true });
  assert.equal(forced.result, RESULT.WRITTEN);
  assert.equal(forced.replaced, true, 'which is the fact the report has to be able to say');

  const dry = run(null, { write: false });
  assert.equal(dry.result, RESULT.WOULD_WRITE);
  assert.equal(dry.wrote, false);

  const failed = run(null, { writeFile: () => { throw new Error('EROFS: read-only'); } });
  assert.equal(failed.result, RESULT.FAILED);
  assert.match(failed.reason, /EROFS/);

  const blind = run(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }), { force: true });
  assert.equal(blind.result, RESULT.REFUSED, 'even --force will not overwrite what it cannot read');
  assert.match(blind.reason, /it is there and cannot be read: EACCES/);
});

test('the file the command writes is where the flag defaults point', () => {
  const document = { markdown: 'x\n', counts: { lines: 1, bytes: 2 } };
  const plan = stdlibPlan(document, {
    root: '/p',
    file: 'docs/STDLIB.md',
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(fixtureKey(plan.path), '/p/docs/STDLIB.md');
  assert.equal(plan.display, 'docs/STDLIB.md');
  assert.equal(STDLIB_FILE, 'STDLIB.md');
});
