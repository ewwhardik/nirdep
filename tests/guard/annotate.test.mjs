// The same findings, in the dialect GitHub reads.
//
// There is nothing to compute here, which is the point: every annotation is a field guard
// already filled in, so what these tests hold is the translation -- the escaping, the cap, and
// the refusal to point at a file that is not in the repository.
//
// The escaping is not cosmetic. A message with a newline in it ends the workflow command early
// and prints the rest of the sentence as build output, so a report of a wallet stealer becomes
// half a report and some noise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotate, annotations } from '../../src/guard/annotate.mjs';
import { guardProject } from '../../src/guard/project.mjs';
import { ADVISORY } from '../../src/guard/policy.mjs';
import { auditTree } from '../../src/scan/advisories.mjs';

function scanOf(versions, sites = {}) {
  const packages = Object.entries(versions).map(([name, version]) => ({
    name, version, place: `node_modules/${name}`, dev: false,
  }));
  const lock = { kind: 'npm', file: 'package-lock.json', understood: true, note: null, count: packages.length, packages };
  return {
    manifest: { name: 'demo', dependencies: new Set(), development: new Set(), ranges: new Map() },
    lock: { ...lock, byName: new Map(packages.map((one) => [one.name, [one]])) },
    source: {
      counts: { scanned: 1, opened: 1, lexed: 1 },
      unparsed: [],
      packages: Object.entries(sites).map(([name, all]) => ({
        name, files: [...new Set(all.map((one) => one.path))], sites: all,
      })),
    },
    counts: { direct: 0 },
    advisories: auditTree({ lock }),
  };
}

function guard(versions, sites = {}, policy = {}) {
  return guardProject('/demo', {
    scan: scanOf(versions, sites),
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    overrides: policy,
  });
}

const POISONED = { 'event-stream': '3.3.6', lodash: '4.17.11', minimist: '1.2.5' };
const at = (path, line) => ({ path, line, specifier: 'minimist', form: 'default' });
const lines = (result) => annotate(result).split('\n').filter(Boolean);

test('a version comes from the lockfile, so that is the file it is attached to', () => {
  // The path the scan recorded is inside node_modules, which is not a file in the repository:
  // an annotation pointing there puts the finding nowhere at all.
  for (const line of lines(guard(POISONED)).filter((one) => /CVE|event-stream@/.test(one))) {
    assert.match(line, /^::error file=package-lock\.json,title=/);
    assert.equal(/node_modules/.test(line), false);
  }
});

test('a breach is attached to the line that imports it', () => {
  const result = guard({ minimist: '1.2.8' }, { minimist: [at('src/args.mjs', 3)] });
  const [line] = lines(result).filter((one) => /minimist is denied/.test(one));
  assert.match(line, /^::error file=src\/args\.mjs,line=3,/);
  assert.match(line, /nirdep replaces it with nirdep\/runtime\/args -- run nirdep plan \. to see the change\./);
});

test('a finding with nowhere honest to point at carries no location', () => {
  // A wrong line number sends a reader to the wrong line, which is worse than no line at all.
  const result = guard({ minimist: '1.2.8' });
  const [line] = lines(result).filter((one) => /minimist is denied/.test(one));
  assert.match(line, /^::error title=/);
  assert.equal(/file=/.test(line), false);
});

test('the cap is about the project, so it has no file either', () => {
  const result = guardProject('/demo', {
    scan: { ...scanOf({}), counts: { direct: 9 } },
    read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    overrides: { max: 2 },
  });
  const [line] = lines(result).filter((one) => /dependency cap/.test(one));
  assert.match(line, /^::error title=nirdep%3A dependency cap::9 direct dependencies, and the policy allows 2\.$/);
});

test('a message is escaped so it cannot end its own command', () => {
  const result = guard(POISONED);
  for (const line of lines(result)) {
    // One command per line, and no percent left unencoded to be read as an escape.
    assert.equal(line.split('::').length >= 3, true);
    assert.equal(/[\r\n]/.test(line), false);
    assert.equal(/%(?!25|0D|0A|3A|2C)/.test(line), false, line);
  }
  // A colon in a property value ends the property list, so the title's own colon is encoded
  // while the message keeps its punctuation.
  assert.match(lines(result)[0], /title=nirdep%3A [^,:]+::/);
});

test('a policy that could not be read is annotated as a check that did not happen', () => {
  const result = guardProject('/demo', {
    read: () => JSON.stringify({ guard: { signal: ['imported'], max: -1 } }),
  });
  assert.equal(result.ran, false);
  const all = annotations(result);
  assert.equal(all.length, 2, 'two mistakes, two lines: a reader that stops at the first costs a run');
  for (const one of all) {
    assert.equal(one.level, 'error');
    assert.equal(one.place.path, '.nirdeprc.json');
    assert.equal(one.place.line, null, 'the file is known and the offending line is not');
  }
  assert.match(annotate(result), /unknown policy key "signal", did you mean "signals"\?/);
});

test('a green build still says what was not checked', () => {
  const off = annotations(guard({ lodash: '4.17.21' }, {}, { advisories: ADVISORY.OFF }));
  assert.deepEqual(off.map((one) => one.level), ['notice']);
  assert.match(off[0].text, /advisories: off/);

  // And a waiver is a notice rather than silence: somebody chose this, and the next person to
  // read a green build should be able to see that they did.
  const waived = annotations(guard({ lodash: '4.17.11' }, {}, { allow: ['lodash'] }));
  assert.match(waived.find((one) => one.level === 'notice').text, /allow list names/);
});

test('the cap on annotations is admitted rather than applied by GitHub in silence', () => {
  // GitHub shows ten per level and drops the rest without a word. Nine and a line saying how
  // many were left reads as what happened; ten and nothing reads as ten problems.
  // Three alarming versions and one of them denied by name as well: four errors, one file.
  const result = guard(POISONED);
  const capped = annotate(result, { limit: 2 }).split('\n').filter(Boolean);
  assert.equal(capped.length, 2);
  assert.match(capped[1], /^::error title=nirdep::3 more errors are in the run log/);

  // Under the limit, nothing is added and nothing is said.
  assert.equal(annotate(result, { limit: 50 }).split('\n').filter(Boolean).length, 4);
});

test('nothing to say is an empty string, not a blank line', () => {
  const result = guard({ typescript: '5.9.2' });
  assert.equal(result.counts.alarming, 0);
  assert.equal(annotate(result), '');
});
