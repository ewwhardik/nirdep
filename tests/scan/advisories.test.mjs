// The advisory table, and the two things it must never do.
//
// It must never lie about a version, and it must never claim to be `npm audit`.
// The first is testable and most of this file is that test: every range is checked
// against its own `fixed`, because a range with a typo in it is a tool that tells
// somebody they are safe. The second is a property of the source rather than of a
// run, so the last test reads the module's own bytes and fails if anything in it
// could reach a network.
//
// The tree cases are planted from tests/vectors/scan/tree.json rather than written
// here: a fixture containing a real package name in a .mjs file is a dependency as
// far as tools/verify.mjs is concerned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADVISORIES, COVERAGE, HAND, KIND, REVIEWED, SOURCE, VERDICT,
  advisoriesFor, auditTree, checkVersion, highestFixed,
} from '../../src/scan/advisories.mjs';
import { readLock } from '../../src/scan/lockfile.mjs';
import { satisfies } from '../../src/runtime/semver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'scan', 'tree.json'), 'utf8'));
const SELF = readFileSync(join(HERE, '..', '..', 'src', 'scan', 'advisories.mjs'), 'utf8');

function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-adv-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const lockFor = (key) => readLock(plant(TREE[key]));
const flaws = ADVISORIES.filter((one) => one.kind === KIND.FLAW);
const incidents = ADVISORIES.filter((one) => one.kind === KIND.INCIDENT);
const named = (list, name) => list.filter((one) => one.package === name);

test('every row is frozen, dated, and says what happened', () => {
  assert.ok(ADVISORIES.length > 30, 'the table is smaller than it was');
  assert.equal(Object.isFrozen(ADVISORIES), true);
  for (const one of ADVISORIES) {
    assert.equal(Object.isFrozen(one), true, `${one.package} is mutable`);
    assert.ok(typeof one.package === 'string' && one.package.length > 0);
    assert.match(one.when, /^\d{4}-\d{2}-\d{2}$/, `${one.package} has no usable date`);
    assert.ok(one.what.length > 40, `${one.package} has no story`);
    assert.equal(one.what.endsWith(' '), false, `${one.package} joined two strings badly`);
    // Every story is written to follow a colon, and two places in risk.mjs join it to
    // one. A row that opened with a capital would read as a sentence starting twice.
    assert.equal(/^[A-Z]/.test(one.what), false, `${one.package} opens in upper case`);
    assert.match(one.what, /[.?"]$/, `${one.package} does not finish its sentence`);
    assert.ok(['critical', 'high', 'medium', 'low'].includes(one.severity), one.severity);
  }
  assert.match(REVIEWED, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(COVERAGE, { packages: new Set(ADVISORIES.map((one) => one.package)).size,
    rows: ADVISORIES.length,
    reviewed: REVIEWED });
});

test('a flaw carries a range and its advisory number; an incident carries neither', () => {
  for (const one of flaws) {
    assert.match(one.id, /^CVE-\d{4}-\d+$/, `${one.package} has no identifier`);
    assert.ok(one.range !== null, `${one.id} has no range`);
    assert.ok(one.fixed !== null, `${one.id} does not say what to upgrade to`);
    assert.equal(one.versions, null, `${one.id} is a range and a version list at once`);
    assert.equal(one.hand, null, 'a bug has no hand');
  }
  for (const one of incidents) {
    // No "fixed in": the malicious release sits between two innocent ones, so there
    // is no upper bound to be below, only an exact artefact to not have.
    assert.equal(one.range, null, `${one.package} treats an incident as a range`);
    assert.equal(one.fixed, null);
    assert.equal(one.severity, 'critical');
    assert.ok([HAND.ATTACKER, HAND.AUTHOR].includes(one.hand), `${one.package} does not say whose hand`);
  }
});

test('every fixed version is outside its own range, which is what a typo breaks', () => {
  // The one test that would catch the worst bug this table can have: a range that
  // reads plausibly and clears a version that is not actually safe, or damns one
  // that is. Both directions are asserted with our own semver, which is also the
  // one the report will use.
  for (const one of flaws) {
    assert.equal(satisfies(one.fixed, one.range, { includePrerelease: true }), false,
      `${one.id}: ${one.fixed} is inside its own affected range`);
    assert.equal(checkVersion(one, one.fixed), VERDICT.CLEAR, `${one.id} damns its own fix`);
  }
});

test('an exact version list matches exactly, because a malicious release is one artefact', () => {
  const [stream] = named(incidents, 'flatmap-stream');
  assert.deepEqual([...stream.versions], ['0.1.0', '0.1.1']);
  assert.equal(checkVersion(stream, '0.1.1'), VERDICT.HIT);
  assert.equal(checkVersion(stream, '0.1.2'), VERDICT.CLEAR, 'a later release is not the payload');
  assert.equal(checkVersion(stream, '0.1.0-0'), VERDICT.CLEAR);
  // Protestware published under a version nobody would type by hand still has to match.
  const [colours] = named(incidents, 'colors');
  assert.equal(colours.hand, HAND.AUTHOR);
  assert.equal(checkVersion(colours, '1.4.44-liberty-2'), VERDICT.HIT);
  assert.equal(checkVersion(colours, '1.4.0'), VERDICT.CLEAR);
});

test('a range is matched with our own semver, prereleases included', () => {
  const [flaw] = named(flaws, 'semver');
  assert.equal(checkVersion(flaw, '7.5.1'), VERDICT.HIT);
  assert.equal(checkVersion(flaw, '7.5.2'), VERDICT.CLEAR);
  assert.equal(checkVersion(flaw, '6.3.0'), VERDICT.HIT, 'the middle branch of the range was dropped');
  assert.equal(checkVersion(flaw, '6.3.1'), VERDICT.CLEAR);
  // A prerelease of an affected version is affected. The default `satisfies` would
  // say no, which is right for resolving an install and wrong for judging one.
  assert.equal(checkVersion(flaw, '7.5.1-rc.1'), VERDICT.HIT);
});

test('the table admits what it does not know instead of guessing a version', () => {
  const [wave] = named(incidents, 'chalk');
  assert.equal(wave.versions, null);
  assert.equal(wave.group, 'wave-2025-09');
  assert.ok(wave.unrecorded.includes('name match'), 'the row does not say it is only a name');
  // Any version at all, including one that does not exist: the answer is the same,
  // because the claim is about the name and the row says so.
  assert.equal(checkVersion(wave, '5.3.0'), VERDICT.UNVERSIONED);
  assert.equal(checkVersion(wave, '999.0.0'), VERDICT.UNVERSIONED);
});

test('a version string nobody can parse is unknown, not clear', () => {
  const [flaw] = named(flaws, 'minimatch');
  for (const odd of ['git+ssh://git@host/a.git#abc', 'file:../local', 'workspace:*', 'latest', '']) {
    assert.equal(checkVersion(flaw, odd), VERDICT.UNKNOWN, `${odd} was answered as though it were a version`);
  }
  assert.equal(checkVersion(flaw, null), VERDICT.UNKNOWN);
  assert.equal(checkVersion(flaw, 3), VERDICT.UNKNOWN, 'a number is not a version');
});

test('two rows for one package is the normal case, and the index finds both', () => {
  assert.equal(advisoriesFor('minimist').length, 2, 'the same hole twice is two rows');
  assert.equal(advisoriesFor('lodash').length, 5);
  assert.deepEqual(advisoriesFor('a-package-nobody-published'), []);
  assert.equal(Object.isFrozen(advisoriesFor('lodash')), true);
});

test('the highest fix is found by version order, not by string order', () => {
  // 4.17.9 sorts after 4.17.12 as text. Getting this wrong tells somebody to
  // upgrade to a release that is still inside three of the five advisories.
  assert.equal(highestFixed(advisoriesFor('lodash')), '4.17.21');
  assert.equal(highestFixed(advisoriesFor('event-stream')), null, 'an incident has nothing to upgrade to');
  assert.equal(highestFixed([]), null);
  assert.equal(highestFixed([{ advisory: { fixed: '2.0.0' } }, { advisory: { fixed: '10.0.0' } }]), '10.0.0');
});

test('a tree is crossed once and the answers land in three buckets', () => {
  const audit = auditTree({ lock: lockFor('unlucky') });
  assert.equal(audit.source, SOURCE.LOCK);
  assert.equal(audit.reviewed, REVIEWED);
  assert.equal(Object.isFrozen(audit.hits), true);
  const hits = audit.hits.map((one) => `${one.package}@${one.version}`);
  // Worst first: three malicious releases before two stale-but-honest packages.
  assert.deepEqual(hits.slice(0, 3), ['colors@1.4.44-liberty-2', 'event-stream@3.3.6', 'flatmap-stream@0.1.1']);
  assert.equal(audit.counts.incidents, 3);
  assert.equal(audit.counts.flaws, 6, 'five lodash advisories and one semver');
  assert.deepEqual(audit.unversioned.map((one) => one.package), ['rc']);
  assert.deepEqual(audit.unknown.map((one) => one.package), ['minimatch']);
  assert.equal(audit.hits.every((one) => one.verdict === VERDICT.HIT), true);
  assert.equal(audit.hits[0].places[0].includes('colors'), true, 'a hit does not say where it is installed');
});

test('a package the table clears is not mentioned at all', () => {
  // The demo tree has semver@7.5.4 and minimist@1.2.8, both of which the table
  // knows and both of which are past their fixes. A report that listed them as
  // "checked, fine" would be a report nobody finishes.
  const audit = auditTree({ lock: lockFor('tree') });
  assert.equal(audit.counts.hits, 0);
  assert.equal(audit.matched, 7, 'seven names in the tree are in the table');
  assert.deepEqual(audit.unversioned.map((one) => one.package).sort(),
    ['ansi-styles', 'chalk', 'color-convert', 'color-name', 'supports-color']);
  assert.equal(audit.unknown.length, 0);
});

test('a hoisted package installed at one version is reported once', () => {
  const twice = { count: 2, packages: [
    { name: 'lodash', version: '4.17.4', place: 'node_modules/lodash', dev: false },
    { name: 'lodash', version: '4.17.4', place: 'node_modules/a/node_modules/lodash', dev: true },
  ] };
  const audit = auditTree({ lock: twice });
  assert.equal(audit.checked, 1, 'the same name and version twice is one thing to judge');
  assert.equal(audit.counts.hits, 5);
  assert.deepEqual([...audit.hits[0].places], ['node_modules/lodash', 'node_modules/a/node_modules/lodash']);
  // One production copy makes the whole thing production, whatever the other says.
  assert.equal(audit.hits[0].dev, false);
});

test('with no lockfile the manifest is read and nothing is called clear', () => {
  const audit = auditTree({ lock: lockFor('bare'), manifest: { dependencies: { chalk: '^5', semver: '^7' } } });
  assert.equal(audit.source, SOURCE.MANIFEST);
  assert.equal(audit.counts.hits, 0, 'a range is not a version and must never produce a hit');
  assert.deepEqual(audit.unversioned.map((one) => one.package), ['chalk']);
  assert.deepEqual(audit.unknown.map((one) => one.package), ['semver']);
});

test('nothing to audit is a shape, not an exception', () => {
  for (const world of [undefined, {}, { lock: null }, { manifest: null }, { manifest: {} }]) {
    const audit = auditTree(world);
    assert.deepEqual(audit.counts, { hits: 0, unversioned: 0, unknown: 0, incidents: 0, flaws: 0 });
    assert.equal(audit.checked, 0);
    assert.equal(audit.matched, 0);
  }
});

test('the same tree twice is the same answer, in the same order', () => {
  const lock = lockFor('unlucky');
  assert.equal(JSON.stringify(auditTree({ lock })), JSON.stringify(auditTree({ lock })));
});

test('the module cannot reach a network, by inspection of its own source', () => {
  // The claim in the header is offline-by-construction, which is a property of the
  // file rather than of a run. So the file is the thing tested.
  for (const reach of ['fetch(', 'node:http', 'node:https', 'node:net', 'node:dgram', 'XMLHttpRequest']) {
    assert.equal(SELF.includes(reach), false, `advisories.mjs mentions ${reach}`);
  }
  // The quote is spelled by code point rather than typed. A pattern containing a
  // quoted specifier is an import declaration as far as tools/verify.mjs is
  // concerned, and a test that adds a fake dependency to prove there are none is
  // not the kind of joke this repository can afford.
  const q = String.fromCharCode(39);
  const shape = new RegExp(`^import .* from ${q}([^${q}]+)${q};$`, 'gm');
  const imports = [...SELF.matchAll(shape)].map((one) => one[1]);
  assert.deepEqual(imports, ['../runtime/semver.mjs', '../rules/registry.mjs'],
    'the table grew an import; every one of them has to be a relative path into this project');
  assert.equal(/https?:\/\//.test(SELF), false, 'a URL in the table is a registry lookup waiting to happen');
});
