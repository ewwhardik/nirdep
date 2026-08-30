// The findings engine, one finding at a time.
//
// Every case is built from a hand-made manifest and lockfile shape rather than from a real
// project, because the interesting question is not "does this fire on npm" but "does the
// sentence agree with its own number". Half of these assertions are grammar, which is not
// vanity: this command's whole claim is that it read the files carefully, and `1 package
// are imported` is a confession that nobody read the output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDING, SEVERITY, assess, floats, summarise } from '../../src/scan/risk.mjs';

/** A lockfile shaped the way readLock returns one, from a plain list of entries. */
function lockOf(entries, extra = {}) {
  // `integrity: null` is the whole point of one of the cases below, so a given null has to
  // beat the default rather than fall through it. `??` would have quietly hashed it.
  const given = (one, field, fallback) => (Object.prototype.hasOwnProperty.call(one, field) ? one[field] : fallback);
  const packages = entries.map((one) => ({
    name: one.name,
    version: one.version ?? '1.0.0',
    place: `node_modules/${one.name}`,
    depth: one.depth ?? 1,
    dev: one.dev === true,
    optional: false,
    peer: false,
    deprecated: one.deprecated ?? null,
    installScript: one.installScript === true,
    hasBin: one.hasBin === true,
    resolved: one.resolved ?? null,
    integrity: given(one, 'integrity', 'sha512-x'),
    source: one.source ?? 'registry',
    engines: null,
    requires: one.requires ?? [],
  }));
  const byName = new Map();
  for (const one of packages) {
    if (byName.has(one.name)) byName.get(one.name).push(one);
    else byName.set(one.name, [one]);
  }
  return {
    kind: 'npm',
    file: 'package-lock.json',
    version: 3,
    understood: packages.length > 0,
    note: 'read in full',
    packages,
    byName,
    roots: new Set(),
    count: packages.length,
    names: byName.size,
    ...extra,
  };
}

/** A manifest shaped the way readManifest returns one. */
function manifestOf(fields = {}) {
  const dependencies = fields.dependencies ?? {};
  const development = fields.devDependencies ?? {};
  return {
    found: true,
    type: 'module',
    name: fields.name ?? 'demo',
    dependencies: new Set([...Object.keys(dependencies), ...Object.keys(development)]),
    development: new Set(Object.keys(development)),
    ranges: new Map([...Object.entries(dependencies), ...Object.entries(development)]),
    scripts: new Map(Object.entries(fields.scripts ?? {})),
  };
}

const codes = (findings) => findings.map((one) => one.code);
const pick = (findings, code) => findings.find((one) => one.code === code);
const detailFor = (world, code) => {
  const found = pick(assess(world), code);
  assert.ok(found !== undefined, `expected a ${code} finding`);
  return found.detail;
};

test('a floating range is one that resolves on install day', () => {
  for (const range of ['*', 'x', '', '  ', 'latest', 'next', 'beta']) {
    assert.equal(floats(range), true, `${JSON.stringify(range)} floats`);
  }
  for (const range of ['^1.2.3', '~1.2.3', '1.2.3', '>=1.0.0 <2', '1.x', 'npm:chalk@^4', 'workspace:*']) {
    assert.equal(floats(range), false, `${JSON.stringify(range)} does not float`);
  }
  // A git URL pinned to a semver range is pinned; one pinned to a branch is not.
  assert.equal(floats('github:a/b#main'), true);
  assert.equal(floats('git+https://github.com/a/b.git#dev'), true);
  assert.equal(floats('github:a/b#semver:^1.0.0'), false);
});

test('a malicious release is one finding each, and quotes the day it was published', () => {
  const findings = assess({
    manifest: manifestOf({ dependencies: { 'event-stream': '3.3.6' } }),
    lock: lockOf([
      { name: 'event-stream', version: '3.3.6' },
      { name: 'flatmap-stream', version: '0.1.1', depth: 2 },
    ]),
    used: new Set(['event-stream']),
  });
  // Two rows, two findings: each malicious release is a separate story with a separate
  // date, and there are never so many of them that grouping would save a reader anything.
  const bad = findings.filter((one) => one.code === FINDING.COMPROMISED);
  assert.equal(bad.length, 2);
  assert.equal(bad[0].severity, SEVERITY.CRITICAL);
  assert.deepEqual(bad[0].subjects, ['event-stream@3.3.6']);
  assert.match(bad[0].detail, /^event-stream@3\.3\.6 is a release that was published to do harm, on 2018-11-26: /);
  assert.match(bad[0].detail, /It arrived alongside flatmap-stream, which is worth checking too\./);
  assert.match(bad[0].detail, /Installed at node_modules\/event-stream\.$/);
  // An incident has no "fixed in", so the finding must not invent one.
  assert.equal(bad[0].detail.includes('Fixed in'), false);
  assert.equal(bad[0].id, null, 'a supply-chain incident has no CVE to cite');
});

test('a maintainer who did it themselves gets the sentence a review cannot answer', () => {
  const detail = detailFor({
    manifest: manifestOf({ dependencies: { colors: '^1.4.0' } }),
    lock: lockOf([{ name: 'colors', version: '1.4.44-liberty-2' }]),
    used: new Set(['colors']),
  }, FINDING.COMPROMISED);
  assert.match(detail, /The hand was the maintainer's own, so no review of the version you approved/);
});

test('five advisories against one package are one finding at the worst of them', () => {
  const findings = assess({
    manifest: manifestOf({ dependencies: { lodash: '4.17.4' } }),
    lock: lockOf([{ name: 'lodash', version: '4.17.4' }]),
    used: new Set(['lodash']),
  });
  const flaw = pick(findings, FINDING.VULNERABLE);
  assert.equal(flaw.severity, SEVERITY.HIGH);
  assert.deepEqual(flaw.subjects, ['lodash@4.17.4']);
  // One stale lodash answers five advisories. Printing it five times would bury the rest
  // of the report under a single dependency.
  assert.equal(findings.filter((one) => one.code === FINDING.VULNERABLE).length, 1);
  assert.match(flaw.detail, /^lodash@4\.17\.4 is inside 5 published advisories \(CVE-/);
  assert.match(flaw.detail, /The worst of them, CVE-2021-23337: /, 'the newest of the worst, not the oldest');
  // The highest fix across all five, by version order: 4.17.9 sorts after 4.17.12 as text.
  // The upgrade is not the last word any more: lodash joined the catalogue with
  // runtime/collect, so the sentence goes on to say the dependency itself is optional.
  assert.match(flaw.detail, /Fixed in 4\.17\.21\. This is a package nirdep replaces outright\.$/);
  assert.equal(flaw.id, 'CVE-2021-23337', 'the margin cites what the sentence quotes');
});

test('a name match says it is a name match, in its own sentence', () => {
  const findings = assess({
    manifest: manifestOf(),
    lock: lockOf([
      { name: 'chalk', version: '5.6.0' },
      { name: 'ansi-styles', version: '6.2.1', depth: 2 },
      { name: 'minimatch', version: 'git+ssh://git@host/a.git#4f2a1f4', source: 'git' },
    ]),
  });
  const named = pick(findings, FINDING.IN_INCIDENT);
  assert.equal(named.severity, SEVERITY.LOW);
  assert.match(named.detail, /^2 packages in this tree are named in a supply-chain incident whose affected/);
  assert.match(named.detail, /record: ansi-styles, chalk\. 2025-09-08: a maintainer phished/);
  assert.match(named.detail, /a match on names and not a verdict on your versions; go and look them up\.$/);
  // And a version nothing can parse is unchecked rather than clear, at note severity,
  // because it is a question about this tool's reach and not about the project.
  const gap = pick(findings, FINDING.UNCHECKED);
  assert.equal(gap.severity, SEVERITY.NOTE);
  assert.match(gap.detail, /^1 package in the advisory table could not be checked against a version here: /);
  assert.match(gap.detail, /The lockfile records something other than a version for it -- a path, a URL, a tag/);
});

test('a package the table clears produces no sentence at all', () => {
  // Both of these are in the table and both are past their fixes. "Checked, fine" rows
  // are how a report gets long enough that nobody reaches the line that mattered.
  const findings = assess({
    manifest: manifestOf({ dependencies: { semver: '^7.5.2', minimist: '^1.2.8' } }),
    lock: lockOf([{ name: 'semver', version: '7.5.2' }, { name: 'minimist', version: '1.2.8' }]),
    used: new Set(['semver', 'minimist']),
  });
  assert.deepEqual(codes(findings).filter((one) => one === FINDING.VULNERABLE), []);
  assert.equal(summarise(findings).critical, 0);
});

test('install scripts and deprecations agree with their own counts', () => {
  const one = assess({
    manifest: manifestOf({ dependencies: { 'node-sass': '^4.14.1' } }),
    lock: lockOf([{ name: 'node-sass', version: '4.14.1', installScript: true, deprecated: 'no longer  supported' }]),
    used: new Set(['node-sass']),
  });
  const script = pick(one, FINDING.INSTALL_SCRIPT);
  assert.equal(script.severity, SEVERITY.HIGH);
  assert.match(script.detail, /^1 package runs its own code during install/);
  assert.deepEqual(script.subjects, ['node-sass@4.14.1']);
  // The deprecation message is quoted with its whitespace collapsed, because lockfiles
  // wrap it and a report that keeps the newlines loses its own indentation.
  const old = pick(one, FINDING.DEPRECATED);
  assert.match(old.detail, /^1 package in this tree is deprecated by its own author/);
  assert.match(old.detail, /"no longer supported"$/);

  const many = assess({
    manifest: manifestOf(),
    lock: lockOf([
      { name: 'a', installScript: true, deprecated: 'gone' },
      { name: 'b', installScript: true, deprecated: 'also gone' },
    ]),
  });
  assert.match(pick(many, FINDING.INSTALL_SCRIPT).detail, /^2 packages run their own code/);
  assert.match(pick(many, FINDING.DEPRECATED).detail, /^2 packages in this tree are deprecated by their own authors/);
});

test('a missing hash is only a finding for a package a registry served', () => {
  const findings = assess({
    manifest: manifestOf(),
    lock: lockOf([
      { name: 'unhashed', integrity: null, source: 'registry' },
      { name: 'local', integrity: null, source: 'file' },
      { name: 'linked', integrity: null, source: 'link' },
    ]),
  });
  const gap = pick(findings, FINDING.NO_INTEGRITY);
  assert.equal(gap.severity, SEVERITY.HIGH);
  assert.match(gap.detail, /^1 registry package is recorded without an integrity hash/);
  assert.deepEqual(gap.subjects, ['unhashed@1.0.0']);
  // A file: or link: entry has no tarball to hash, so demanding one would be noise.
  assert.equal(gap.subjects.includes('local@1.0.0'), false);
});

test('git and plain http installs are named as off-registry', () => {
  const findings = assess({
    manifest: manifestOf(),
    lock: lockOf([
      { name: 'left-pad', source: 'git' },
      { name: 'tarball', source: 'http' },
      { name: 'normal', source: 'registry' },
    ]),
  });
  const off = pick(findings, FINDING.OFF_REGISTRY);
  assert.equal(off.severity, SEVERITY.MEDIUM);
  assert.match(off.detail, /^2 packages come from somewhere other than a registry/);
  assert.deepEqual(off.subjects, ['left-pad (git)', 'tarball (http)']);
  assert.match(detailFor({ manifest: manifestOf(), lock: lockOf([{ name: 'x', source: 'git' }]) },
    FINDING.OFF_REGISTRY), /^1 package comes from somewhere other than a registry/);
});

test('duplicates are counted by name, and the same version twice is not one', () => {
  const twice = assess({
    manifest: manifestOf(),
    lock: lockOf([
      { name: 'semver', version: '6.3.1' },
      { name: 'semver', version: '7.5.4' },
      { name: 'ms', version: '2.1.2' },
      { name: 'ms', version: '2.1.2', depth: 2 },
    ]),
  });
  const duplicate = pick(twice, FINDING.DUPLICATE);
  assert.equal(duplicate.severity, SEVERITY.LOW);
  assert.match(duplicate.detail, /^1 package is installed at more than one version \(semver ×2\)/);
  assert.deepEqual(duplicate.subjects, ['semver'], 'ms is hoisted twice at one version, which costs nothing');
});

test('the depth note carries the lockfile note with it', () => {
  const findings = assess({
    manifest: manifestOf({ dependencies: { a: '^1.0.0', b: '^1.0.0' } }),
    lock: lockOf([{ name: 'a' }, { name: 'b' }, { name: 'c', depth: 3 }]),
    direct: 2,
  });
  const note = pick(findings, FINDING.DEPTH);
  assert.equal(note.severity, SEVERITY.NOTE);
  assert.equal(note.detail, '3 installed packages under 2 direct dependencies, nested 3 deep. read in full.');
  // The plural nobody notices until it is wrong: "1 direct dependencys".
  const alone = detailFor({
    manifest: manifestOf({ dependencies: { a: '^1.0.0' } }),
    lock: lockOf([{ name: 'a' }]),
    direct: 1,
  }, FINDING.DEPTH);
  assert.equal(alone, '1 installed package under 1 direct dependency, nested 1 deep. read in full.');
});

test('an undeclared import reads differently depending on whether the lock covers it', () => {
  const hoisted = detailFor({
    manifest: manifestOf({ dependencies: { chalk: '^4.1.2' } }),
    lock: lockOf([{ name: 'chalk' }, { name: 'express' }]),
    used: new Set(['chalk', 'express']),
  }, FINDING.UNDECLARED);
  assert.match(hoisted, /^1 package is imported by this project's source and declared in no dependency field/);
  assert.match(hoisted, /It is in the lockfile anyway/);

  const absent = detailFor({
    manifest: manifestOf({ dependencies: { chalk: '^4.1.2' } }),
    lock: lockOf([{ name: 'chalk' }]),
    used: new Set(['chalk', 'express']),
  }, FINDING.UNDECLARED);
  assert.match(absent, /Nothing installs it, so this only runs where it already happens to be\./);

  const two = detailFor({
    manifest: manifestOf(),
    lock: lockOf([{ name: 'express' }]),
    used: new Set(['express', 'cors']),
  }, FINDING.UNDECLARED);
  assert.match(two, /^2 packages are imported/);
  assert.match(two, /One of them is in the lockfile anyway/);

  const both = detailFor({
    manifest: manifestOf(),
    lock: lockOf([{ name: 'express' }, { name: 'cors' }]),
    used: new Set(['express', 'cors']),
  }, FINDING.UNDECLARED);
  assert.match(both, /2 of them are in the lockfile anyway/);

  const none = detailFor({
    manifest: manifestOf(),
    lock: lockOf([]),
    used: new Set(['express', 'cors']),
  }, FINDING.UNDECLARED);
  assert.match(none, /Nothing installs them, so this only runs where they already happen to be\./);
});

test('a dependency with a bin, or named in a script, is not unused', () => {
  const world = {
    manifest: manifestOf({
      dependencies: { chalk: '^4.1.2' },
      devDependencies: { eslint: '^8.0.0', rimraf: '^5.0.0', 'dead-weight': '^1.0.0' },
      scripts: { clean: 'rimraf dist' },
    }),
    lock: lockOf([
      { name: 'chalk' }, { name: 'eslint', hasBin: true }, { name: 'rimraf', hasBin: true },
      { name: 'dead-weight' },
    ]),
    used: new Set(['chalk']),
  };
  const unused = pick(assess(world), FINDING.UNUSED);
  assert.equal(unused.severity, SEVERITY.LOW);
  assert.deepEqual(unused.subjects, ['dead-weight'], 'eslint has a bin, rimraf is in a script');
  assert.match(unused.detail, /^1 declared dependency is imported by no file here and named in no script/);
  assert.match(unused.detail, /needs it at run time or it is install weight/);

  // Nothing imported anywhere is a project this tool could not read, not a project with
  // no dependencies in use, so the finding is withheld rather than fired at everything.
  assert.equal(codes(assess({ ...world, used: new Set() })).includes(FINDING.UNUSED), false);
});

test('a floating range is worse when no lockfile is holding it still', () => {
  const held = pick(assess({
    manifest: manifestOf({ dependencies: { minimist: '*' } }),
    lock: lockOf([{ name: 'minimist' }]),
    used: new Set(['minimist']),
  }), FINDING.FLOATING);
  assert.equal(held.severity, SEVERITY.LOW);
  assert.match(held.detail, /^1 dependency is declared with a range that resolves to whatever exists/);
  assert.match(held.detail, /The lockfile is holding it still for now\./);

  const loose = assess({
    manifest: manifestOf({ dependencies: { minimist: '*', glob: 'latest' } }),
    lock: lockOf([], { kind: 'none', file: null, understood: false, note: 'no lockfile' }),
    used: new Set(['minimist']),
  });
  const floating = pick(loose, FINDING.FLOATING);
  assert.equal(floating.severity, SEVERITY.MEDIUM);
  assert.match(floating.detail, /^2 dependencies are declared/);
  assert.match(floating.detail, /Nothing is holding them still\./);
  // And the absent lockfile is its own finding, because it explains every other number.
  assert.match(pick(loose, FINDING.NO_LOCKFILE).detail,
    /^2 dependencies are declared and no lockfile is committed/);
});

test('no lockfile with no dependencies is not a finding', () => {
  const findings = assess({
    manifest: manifestOf(),
    lock: lockOf([], { kind: 'none', file: null, understood: false, note: 'no lockfile' }),
    used: new Set(),
  });
  assert.deepEqual(codes(findings), []);
  assert.deepEqual(summarise(findings), { critical: 0, high: 0, medium: 0, low: 0, note: 0, total: 0 });
});

test('findings come back worst first, then by code, and frozen', () => {
  // This world is hand-built, and the advisory table is crossed against it anyway: the
  // default version here is 1.0.0, which is inside minimist's prototype-pollution range
  // and is the name of a package the 2025 phishing wave touched. Both are reported, which
  // is the point -- `assess` audits whatever tree it is handed, not only real ones.
  const findings = assess({
    manifest: manifestOf({ dependencies: { minimist: '*', chalk: '^4.1.2' } }),
    lock: lockOf([
      { name: 'chalk', requires: ['ansi-styles'] },
      { name: 'ansi-styles', depth: 2 },
      { name: 'minimist', integrity: null },
      { name: 'sass', installScript: true },
      { name: 'glob', version: '7.2.3', deprecated: 'old' },
      { name: 'glob', version: '9.0.0' },
    ]),
    used: new Set(['chalk', 'express']),
    direct: 2,
  });
  assert.deepEqual(codes(findings), [
    FINDING.INSTALL_SCRIPT, FINDING.NO_INTEGRITY, FINDING.UNDECLARED, FINDING.VULNERABLE,
    FINDING.DEPRECATED, FINDING.DUPLICATE, FINDING.FLOATING, FINDING.IN_INCIDENT,
    FINDING.UNUSED, FINDING.DEPTH,
  ]);
  assert.deepEqual(summarise(findings), { critical: 0, high: 4, medium: 1, low: 4, note: 1, total: 10 });
  assert.equal(Object.isFrozen(findings), true);
  for (const one of findings) {
    assert.equal(Object.isFrozen(one), true);
    assert.equal(Object.isFrozen(one.subjects), true);
    // A severity with no sentence is a colour, and a colour is not an argument.
    assert.ok(one.detail.length > 20, `${one.code} needs a sentence`);
    assert.match(one.detail, /[.")]$/, `${one.code} should end its sentence`);
  }
});

test('assess fills in what the caller left out', () => {
  const findings = assess({
    manifest: manifestOf({ dependencies: { a: '^1.0.0', b: '^1.0.0' } }),
    lock: lockOf([{ name: 'a' }, { name: 'b' }]),
  });
  // No `used`, so nothing is undeclared and the unused finding is withheld; no `direct`,
  // so the manifest's count stands in.
  assert.deepEqual(codes(findings), [FINDING.DEPTH]);
  assert.match(pick(findings, FINDING.DEPTH).detail, /under 2 direct dependencies/);
});
