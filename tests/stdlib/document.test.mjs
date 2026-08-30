// The generated document, from a stubbed scan.
//
// A real scan means a real directory, a real lockfile and a real npm tree, and none of those
// three make the interesting cases reachable: a project with twenty remaining dependencies,
// or one with no lockfile, or one that declares nothing at all. So the scan is a literal
// here and tests/cli/stdlibmd.test.mjs runs the whole command against a planted project.
//
// The assertions worth reading twice are the ones about sentences that would be false. A
// generator that says "every direct dependency here is one nirdep replaces" about a project
// with no dependencies has invented a claim, and a document that invents one claim is a
// document nobody should believe about the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stdlibDocument } from '../../src/stdlib/document.mjs';
import { ACTION, RULES } from '../../src/rules/registry.mjs';

/** Whitespace-collapsed, so a folded sentence can be asserted as a sentence. */
const flat = (text) => text.replace(/\s+/g, ' ');

const ruleFor = (name) => RULES.find((rule) => rule.package === name) ?? null;

/**
 * The parts of a scan this generator reads, and nothing else. One entry per direct
 * dependency: `{ chalk: { sites: 3, files: 1 }, express: { range: '^4.0.0', own: 12 } }`.
 */
function scanOf(packages, extra = {}) {
  const radius = Object.entries(packages).map(([name, one]) => {
    const rule = ruleFor(name);
    return {
      name,
      range: one.range ?? '^1.0.0',
      own: Array.from({ length: one.own ?? 0 }, (_, n) => `${name}-dep-${n}`),
      replaceable: rule !== null,
      action: rule?.action ?? null,
      target: rule?.target ?? null,
      files: one.files ?? (one.sites === undefined ? 0 : 1),
      sites: one.sites ?? 0,
    };
  }).sort((a, b) => Number(b.replaceable) - Number(a.replaceable) || a.name.localeCompare(b.name));
  const seeds = radius.filter((one) => one.replaceable).map((one) => one.name);
  return {
    manifest: { name: extra.name ?? 'demo' },
    graph: { names: extra.of ?? 12, understood: extra.understood !== false },
    radius,
    removable: {
      direct: seeds,
      count: extra.stranded ?? (extra.understood === false ? 0 : seeds.length),
      of: extra.of ?? 12,
    },
    counts: { direct: radius.length },
  };
}

/** An adoption map of the shape stdlibAdoption returns, keyed by module name. */
const adoptionOf = (entries) => new Map(Object.entries(entries).map(([name, one]) => [name, {
  sites: Array.from({ length: one.sites ?? 1 }, () => ({})),
  files: Array.from({ length: one.files ?? 1 }, (_, n) => `src/${name}-${n}.mjs`),
  vendored: one.vendored === true,
  home: one.home === true,
}]));

test('what went is a table of facts, and how names the rewrite rather than the replacement', () => {
  const { markdown, counts, replaced, modules } = stdlibDocument(scanOf({
    chalk: { sites: 3, files: 2 },
    minimist: { sites: 1 },
    express: { range: '^4.19.2', own: 12 },
  }, { stranded: 5, of: 20 }));

  assert.match(markdown, /^# STDLIB\.md — demo$/m);
  // The weekly figure is the registry's, not a number typed into this document.
  assert.match(markdown, /^\| `chalk` \| 319\.8M \| `nirdep\/runtime\/colour` \| codemod \| 3 in 2 files \|$/m);
  assert.match(markdown, /^\| `minimist` \| 110\.8M \| `nirdep\/runtime\/args` \| by hand \| 1 in 1 file \|$/m);
  assert.equal(ruleFor('minimist').action, ACTION.ADVISE, 'which is where "by hand" comes from');
  // A dependency that is declared and never imported is not a dependency with no call sites
  // to move; it is one nobody has looked at, and the cell says which.
  const quiet = stdlibDocument(scanOf({ chalk: {} })).markdown;
  assert.match(quiet, /^\| `chalk` \| 319\.8M \| `nirdep\/runtime\/colour` \| codemod \| declared, not imported \|$/m);

  assert.deepEqual(replaced, ['chalk', 'minimist']);
  assert.deepEqual(modules, ['colour', 'args']);
  assert.equal(counts.replaced, 2);
  assert.equal(counts.remaining, 1);
  assert.equal(counts.stranded, 5);
  assert.equal(counts.empty, undefined, 'empty is a flag on the document, not a count');
});

test('the claim is a subtraction, with the caveat the subtraction needs', () => {
  const text = stdlibDocument(scanOf({
    chalk: { sites: 2 }, semver: { sites: 1 }, express: { own: 9 },
  }, { name: 'painted', stranded: 7, of: 31 })).markdown;
  assert.match(flat(text), /painted declares 3 direct dependencies\. 2 of them are packages nirdep replaces with a standard-library module, and removing them takes 7 of the 31 installed packages out of the tree: the 2 packages themselves, plus 5 packages nothing else needs\./);
  // The number is an over-count and the document says so where the number is, not in a
  // footnote nobody scrolls to.
  assert.match(flat(text), /That count is an upper bound\./);
});

test('nothing else leaves with them is a shorter sentence, not a nought', () => {
  const text = stdlibDocument(scanOf({ chalk: { sites: 1 }, express: {} }, { stranded: 1 })).markdown;
  assert.match(flat(text), /takes 1 of the 12 installed packages out of the tree: itself, and nothing that was there only for it\./);
  assert.equal(/plus 0/.test(text), false, 'a subtraction that subtracts nothing is padding');
});

test('a project with nothing to replace gets a short document and correct grammar', () => {
  const one = stdlibDocument(scanOf({ express: { own: 3 } }, { name: 'clean' }));
  assert.equal(one.empty, true);
  assert.equal(one.counts.replaced, 0);
  assert.match(flat(one.markdown), /clean declares 1 direct dependency, and it is not a package nirdep replaces\./);
  assert.match(flat(one.markdown), new RegExp(`The ${RULES.length} packages it does replace are listed by \`nirdep explain\``));
  assert.equal(/## What went/.test(one.markdown), false, 'nothing went, so there is no table of it');
  assert.equal(/### runtime\//.test(one.markdown), false);

  // Two is where the singular would have read wrong, which is the only reason it is branched.
  const two = stdlibDocument(scanOf({ express: {}, fastify: {} }, { name: 'clean' })).markdown;
  assert.match(flat(two), /clean declares 2 direct dependencies, and none of them is a package nirdep replaces\./);
});

test('a project with no dependencies at all is not a project that replaced them all', () => {
  const bare = stdlibDocument(scanOf({}, { name: 'plain', of: 0 })).markdown;
  assert.match(flat(bare), /plain declares no dependencies, so there is nothing here for this document to log: nothing was replaced, because nothing was there\./);
  // The sentence this branch exists to prevent. `rest.length === 0` is true for a project
  // that replaced everything and for one that never had anything, and only one of those two
  // is allowed to claim the credit.
  assert.equal(/Every direct dependency this project has is one nirdep replaces/.test(bare), false);
  assert.match(flat(bare), /Nothing, and not because the table was filtered: this project declares no dependencies/);
  assert.equal(/0 of them are packages/.test(bare), false);
});

test('the tool describes itself: no dependencies, and the replacements in the tree', () => {
  // nirdep's own document. The packages are not in its manifest and never were, so the only
  // evidence of the trade is that its own code imports the runtime out of its own src.
  const text = stdlibDocument(scanOf({}, { name: 'nirdep', of: 0 }), {
    adoption: adoptionOf({
      colour: { home: true, files: 6, sites: 7 },
      args: { home: true, files: 7, sites: 7 },
    }),
  }).markdown;
  assert.match(flat(text), /nirdep declares no dependencies\. The replacements are not a package it installs, they are files in this tree: 2 runtime modules standing in for 7 packages, imported at 14 sites across 13 files\./);
  assert.match(text, /^### runtime\/colour — chalk, strip-ansi, supports-color, ansi-styles$/m);
  assert.match(flat(text), /In this project the replacement is a file in this tree rather than a package, imported from 6 files, 7 sites\./);
  assert.equal(/## What went/.test(text), false, 'nothing left this manifest, because nothing was in it');
});

test('no lockfile means no transitive count, said once and shown in the column', () => {
  const text = stdlibDocument(scanOf({
    chalk: { sites: 1 }, express: { own: 40 },
  }, { understood: false, of: 0 })).markdown;
  assert.match(flat(text), /No lockfile was read, so there is no tree to subtract from and no transitive count in this document\. Commit a lockfile and run it again\./);
  assert.equal(/upper bound/.test(text), false, 'there is no count to bound');
  assert.equal(/installed packages out of the tree/.test(text), false);
  // The row's own cell has to agree with the paragraph. `own` was 40 and the honest answer
  // is that nobody knows, because the number came from a file that is not there.
  assert.match(text, /^\| `express` \| `\^1\.0\.0` \| no lockfile \| no \|$/m);
});

test('what is left stops being a table at fifteen rows and says how many it dropped', () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`pkg-${String(n).padStart(2, '0')}`, { own: n }]));
  const text = stdlibDocument(scanOf({ chalk: { sites: 1 }, ...many })).markdown;
  const rows = text.split('\n').filter((line) => /^\| `pkg-/.test(line));
  assert.equal(rows.length, 15);
  assert.match(flat(text), /And 5 more, which `nirdep scan` lists in full\./);
  assert.match(flat(text), /TODO: for each of these, one sentence on why it stays\./);
});

test('the prose it will not write is left as prompts, and the last one deletes the list', () => {
  const text = stdlibDocument(scanOf({ chalk: { sites: 1 } })).markdown;
  const prompts = text.slice(text.indexOf('## TODO before you publish this')).split('\n')
    .filter((line) => line.startsWith('- '));
  assert.equal(prompts.length, 5);
  assert.equal(prompts.at(-1), '- Delete this section.');
  // The whole argument for the command: the numbers are generated, the judgement is not.
  assert.match(flat(text), /The tables below are derived and will be right\. The prose between them is yours to write, and every place that needs it is marked TODO\./);
});

test('the same project twice is the same bytes, with nothing dated in them', () => {
  const scan = scanOf({ chalk: { sites: 2 }, semver: { sites: 1 }, express: { own: 4 } });
  const once = stdlibDocument(scan, { version: '0.1.0' });
  const twice = stdlibDocument(scanOf({ chalk: { sites: 2 }, semver: { sites: 1 }, express: { own: 4 } }), { version: '0.1.0' });
  assert.equal(once.markdown, twice.markdown, 'a document that changes when nothing changed is a diff nobody reads');
  assert.match(once.markdown, /^Generated by `nirdep stdlibmd` 0\.1\.0 from three things/m);
  // Nothing in here can date the file: it is meant to be committed and reviewed as a diff.
  assert.equal(/\d{4}-\d{2}-\d{2}|GMT|node v\d/.test(once.markdown), false);
  assert.equal(once.counts.lines, once.markdown.split('\n').length - 1);
  assert.equal(once.counts.bytes, Buffer.byteLength(once.markdown, 'utf8'));
  assert.equal(once.markdown.endsWith('\n'), true);
  assert.equal(/\n\n\n/.test(once.markdown), false, 'one blank line is a paragraph break; two is a mistake');
});

test('semver is the module with no partial answer, and the document does not pretend otherwise', () => {
  const text = stdlibDocument(scanOf({ semver: { sites: 4 } })).markdown;
  const section = text.slice(text.indexOf('### runtime/semver'));
  assert.match(flat(section), /Nothing\. This is the row with no partial answer in it: Node ships no comparator, no range grammar and no precedence rule/);
  assert.equal(/\| Node API \| Since \|/.test(section), false, 'an empty table would read as a table with nothing in it');
  assert.match(section, /^- any version comparison at all: process\.versions hands you strings$/m);
});

test('a copy in the tree and a package subpath are two different sentences', () => {
  const copy = stdlibDocument(scanOf({ chalk: { sites: 1 } }), {
    adoption: adoptionOf({ colour: { vendored: true, files: 3, sites: 4 } }),
  }).markdown;
  assert.match(flat(copy), /In this project the replacement is a copy in the tree rather than a package, imported from 3 files, 4 sites\./);

  const installed = stdlibDocument(scanOf({ chalk: { sites: 1 } }), {
    adoption: adoptionOf({ colour: { files: 1, sites: 2 } }),
  }).markdown;
  assert.match(flat(installed), /In this project the replacement is imported from 1 file, 2 sites\./);

  // A module nobody imports gets its section -- the package is still in the manifest -- and
  // no adoption sentence, because there is nothing to report about a migration not made.
  const none = stdlibDocument(scanOf({ chalk: { sites: 1 } })).markdown;
  assert.match(none, /^### runtime\/colour/m);
  assert.equal(/In this project the replacement/.test(none), false);
});

test('a section appears for a module that is only visible in the imports', () => {
  // After `apply` and a manifest edit there is no chalk left to scan for, and the document
  // still owes a section for the module that took its place.
  const text = stdlibDocument(scanOf({ express: { own: 2 } }), {
    adoption: adoptionOf({ args: { vendored: true } }),
  });
  assert.equal(text.empty, false);
  assert.deepEqual(text.modules, ['args']);
  assert.deepEqual(text.replaced, []);
  assert.match(text.markdown, /^### runtime\/args — minimist, commander, yargs$/m);
  assert.equal(/## What went/.test(text.markdown), false, 'nothing in this manifest is going anywhere');
});

test('a pipe in a package name does not end the cell it is in', () => {
  const text = stdlibDocument(scanOf({ 'odd|name': { own: 1 } })).markdown;
  assert.match(text, /^\| `odd\\\|name` \|/m);
});
