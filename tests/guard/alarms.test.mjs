// The fourth reader: what the advisory table says about a lockfile, and what the policy does
// about it.
//
// The three signals are about a decision somebody made. This is about a decision nobody made,
// which is why the rules are different: an exemption written against a package name is consent
// to that package being installed, and it is not consent to a release published to steal
// wallet keys. The assertions worth reading twice are the waiver ones.
//
// The audit itself is not re-implemented here. `auditTree` is the one crossing of table against
// tree in this project, so these tests hand it a lockfile and then check what guard does with
// the record it produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardExitCode, guardProject } from '../../src/guard/project.mjs';
import { guardReport } from '../../src/guard/report.mjs';
import { ADVISORY } from '../../src/guard/policy.mjs';
import { auditTree } from '../../src/scan/advisories.mjs';

/** A lockfile as the audit wants it: one entry per installed copy. */
function lockOf(versions) {
  const packages = Object.entries(versions).map(([name, version]) => ({
    name, version, place: `node_modules/${name}`, dev: false,
  }));
  return { kind: 'npm', file: 'package-lock.json', understood: true, note: null, count: packages.length, packages };
}

/**
 * A scan with a real advisory pass in it. Only the fields guard reads are filled in, and the
 * lockfile is shared between the two readers so the versions in the alarm block are the same
 * versions the breach table saw.
 */
function scanOf(versions, extra = {}) {
  const lock = lockOf(versions);
  const byName = new Map(lock.packages.map((one) => [one.name, [one]]));
  return {
    manifest: { name: 'demo', dependencies: new Set(), development: new Set(), ranges: new Map() },
    lock: { ...lock, byName },
    source: { counts: { scanned: 1, opened: 1, lexed: 1 }, unparsed: [], packages: [] },
    counts: { direct: extra.direct ?? 0 },
    advisories: extra.audit === null ? undefined : auditTree({ lock }),
  };
}

function guard(versions, policy = {}, extra = {}) {
  return guardProject('/demo', {
    scan: scanOf(versions, extra),
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    // A deny list narrowed to one package nothing here installs. The default list is every
    // package nirdep replaces, and lodash joined it when runtime/collect landed -- which would
    // make the fixture below fail twice for two different reasons and prove neither.
    overrides: { deny: ['chalk'], ...policy },
  });
}

const named = (result, name) => result.advisories.alarms.find((one) => one.package === name);
const plain = (result) => guardReport(result);
/** The page with its folding undone, for asserting a sentence rather than a column. */
const flat = (result) => plain(result).replace(/\s+/g, ' ');

// The three versions used throughout: one release published to do harm, one flaw with a fix,
// and one package the table has never heard of.
const POISONED = { 'event-stream': '3.3.6', lodash: '4.17.11', typescript: '5.9.2' };

test('a version the table names fails the build nobody chose to fail', () => {
  const result = guard(POISONED);
  assert.equal(result.advisories.ran, true);
  assert.equal(result.advisories.level, ADVISORY.HITS);
  assert.equal(result.counts.alarming, 2, 'two packages, not two advisories');
  assert.equal(guardExitCode(result), 1);
  // Nothing was declared, installed-and-denied or imported, so this failure is entirely the
  // advisory pass: the exit code has to come from somewhere other than the deny list.
  assert.equal(result.counts.breached, 0);
});

test('one stale package answers several advisories and still costs one block', () => {
  const row = named(guard(POISONED), 'lodash');
  assert.equal(row.advisories > 1, true, 'four CVEs name lodash 4.17.11');
  assert.equal(row.fixed, '4.17.21', 'and the fix is the highest of them, not the first');
  assert.match(flat(guard(POISONED)), /3 further advisories name this version/);
});

test('a release published to do harm has no version to upgrade to', () => {
  const row = named(guard(POISONED), 'event-stream');
  assert.equal(row.fixed, null);
  assert.match(plain(guard(POISONED)), /No version fixes this one: the release itself was the payload/);
});

test('the ladder is a ladder: each level admits the one below it', () => {
  const counts = (level) => guard(POISONED, { advisories: level }).counts.alarming;
  assert.equal(counts(ADVISORY.OFF), 0);
  assert.equal(counts(ADVISORY.INCIDENTS), 1, 'the wallet stealer, and not the old lodash');
  assert.equal(counts(ADVISORY.HITS), 2);
  // `all` adds the rows that are a name and a date rather than a verdict about this tree, and
  // there are none of those here: every version in this lockfile parsed.
  assert.equal(counts(ADVISORY.ALL) >= 2, true);
});

test('off is a decision somebody committed, and the page says so out loud', () => {
  const result = guard(POISONED, { advisories: ADVISORY.OFF });
  assert.equal(result.advisories.ran, false);
  assert.equal(guardExitCode(result), 0, 'which is the whole risk of the setting');
  assert.match(plain(result), /^advisory {2}not checked: this policy says off/m);
});

test('a scan with no advisory pass in it is unchecked, never clean', () => {
  const result = guard(POISONED, {}, { audit: null });
  assert.equal(result.advisories.ran, false);
  assert.equal(result.advisories.coverage, null);
  assert.equal(result.counts.alarming, 0);
  assert.match(plain(result), /^advisory {2}not checked: this run was handed a scan with no advisory pass/m);
});

test('an allow list covers a package being installed, not a release published to do harm', () => {
  const result = guard(POISONED, { allow: ['event-stream', 'lodash'] });
  assert.deepEqual(result.advisories.waived.map((one) => one.package), ['lodash']);
  assert.deepEqual(result.advisories.alarms.map((one) => one.package), ['event-stream']);
  assert.equal(guardExitCode(result), 1, 'because the one that cannot be waived was not');

  const text = plain(result);
  assert.match(text, /Allowed by name, which does not cover a release published to do harm\./);
  assert.match(text, /1 advisory allowed by name/);
  assert.match(text, /passed on the command line/, 'and the reason travels with the waiver');
});

test('the coverage and the review date travel with the claim', () => {
  // A green page that does not say what was looked at is read as an audit, and this table is
  // one neighbourhood of npm on purpose.
  const text = plain(guard({ typescript: '5.9.2' }));
  assert.match(text, /^PASS:/m);
  assert.match(text, /^advisory {2}\d+ packages in the table, reviewed \d{4}-\d{2}-\d{2}, 0 matched here\./m);
  assert.match(text.replace(/\s+/g, ' '), /not an audit of your whole tree/);
});

test('the alarm block is above the breach table, and every line fits a terminal', () => {
  const result = guard(POISONED);
  const text = plain(result);
  const lines = text.split('\n');
  const alarms = lines.findIndex((line) => /versions the advisory table names/.test(line));
  const verdict = lines.findIndex((line) => /^FAIL:/.test(line));
  assert.equal(alarms, 0, 'a wallet stealer printed under a table of chalk imports is unread');
  assert.equal(verdict > alarms, true);
  for (const line of lines) assert.equal(line.length <= 80, true, line);
});

test('the verdict names every reason at once', () => {
  const result = guard(POISONED, { max: 1 }, { direct: 3 });
  // A log is read from the bottom, so a verdict that names the first of two problems buys a
  // second run to find the second one. Unfolded first, because the sentence wraps.
  assert.match(plain(result).replace(/\n {6}/g, ' '),
    /^FAIL: 3 direct dependencies, over the cap of 1; 2 versions the advisory table names\.$/m);
});
