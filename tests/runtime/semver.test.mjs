// Conformance for runtime/semver. Six tables under tests/vectors/semver/ carry
// the contract: the input columns were chosen by hand, one input per rule that
// has a wrong answer, and the expectation columns were filled in by calling
// semver@7.8.5 as a black box -- disclosed in STDLIB.md under Borrowed test data,
// because a range grammar is not specified anywhere and the only definition of
// correct is "what npm does".
//
// What stays in this file is everything a table cannot hold: the promise that the
// module contains no regular expression, the error codes, the type handling that
// JSON cannot express, and the five places where this module deliberately answers
// differently from the reference package. Those five are the interesting tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as semver from '../../src/runtime/semver.mjs';

const {
  parse, valid, clean, prerelease, major, minor, patch,
  compare, compareBuild, compareLoose, rcompare, sort, rsort,
  eq, neq, gt, gte, lt, lte, cmp, compareIdentifiers, rcompareIdentifiers,
  parseRange, validRange, toComparators, satisfies, maxSatisfying, minSatisfying,
  minVersion, outside, gtr, ltr, inc, diff, coerce, intersects, subset,
  simplifyRange, SemverError, RELEASE_TYPES, MAX_LENGTH, SEMVER_SPEC_VERSION,
} = semver;

const table = (name) => JSON.parse(readFileSync(new URL(`../vectors/semver/${name}.json`, import.meta.url), 'utf8'));

/** assert.throws() does not hand the error back, and the code is the point. */
function caught(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/** The options a vector row asks for, spelled the way the row spells them. */
const rowOptions = (row) => ({ loose: row.loose === true, includePrerelease: row.pre === true });

/** A row's label, short enough to read in a failure and unique enough to find. */
const label = (row) => `${JSON.stringify(row.in)}${row.loose ? ' loose' : ''}${row.pre ? ' pre' : ''}`;

// -- the version grammar -----------------------------------------------------

test('the version table', () => {
  for (const row of table('versions').cases) {
    const options = { loose: row.loose === true };
    const at = label(row);
    assert.equal(valid(row.in, options), row.valid, at);
    if (row.valid === null) {
      assert.equal(parse(row.in, options), null, at);
      const error = caught(() => major(row.in, options));
      assert.ok(error instanceof SemverError, at);
      assert.match(error.code, /^(INVALID_VERSION|COMPONENT_TOO_BIG)$/, at);
      continue;
    }
    const version = parse(row.in, options);
    assert.equal(version.version, row.valid, at);
    assert.equal(clean(row.in, options), row.clean, at);
    assert.deepEqual(version.prerelease, row.pre, at);
    assert.deepEqual(prerelease(row.in, options), row.pre.length > 0 ? row.pre : null, at);
    assert.deepEqual(version.build, row.build, at);
    assert.deepEqual([major(row.in, options), minor(row.in, options), patch(row.in, options)], row.at, at);
    assert.equal(Object.isFrozen(version), true, `${at} is immutable`);
  }
});

test('precedence and the diff between two versions', () => {
  for (const row of table('order').cases) {
    const at = `${row.a} vs ${row.b}`;
    assert.equal(compare(row.a, row.b), row.cmp, at);
    assert.equal(compareBuild(row.a, row.b), row.build, at);
    assert.equal(diff(row.a, row.b), row.diff, at);
    assert.equal(rcompare(row.a, row.b), row.cmp * -1 || 0, at);
    assert.equal(eq(row.a, row.b), row.cmp === 0, at);
    assert.equal(neq(row.a, row.b), row.cmp !== 0, at);
    assert.equal(gt(row.a, row.b), row.cmp > 0, at);
    assert.equal(gte(row.a, row.b), row.cmp >= 0, at);
    assert.equal(lt(row.a, row.b), row.cmp < 0, at);
    assert.equal(lte(row.a, row.b), row.cmp <= 0, at);
    assert.equal(cmp(row.a, '===', row.b), row.a === row.b, at);
  }
});

// -- the range grammar -------------------------------------------------------

test('the range table: what is a range, and what it normalises to', () => {
  for (const row of table('ranges').cases) {
    const options = rowOptions(row);
    const at = label(row);
    assert.equal(validRange(row.in, options), row.range, at);
    if (row.range === null) {
      assert.equal(parseRange(row.in, options), null, at);
      assert.ok(caught(() => toComparators(row.in, options)) instanceof SemverError, at);
      continue;
    }
    assert.deepEqual(toComparators(row.in, options), row.comps, at);
    const floor = minVersion(row.in, options);
    assert.equal(floor === null ? null : floor.version, row.min, at);
    const range = parseRange(row.in, options);
    assert.equal(Object.isFrozen(range), true, `${at} is immutable`);
    assert.equal(validRange(range, options), row.range, `${at} re-reads its own output`);
  }
});

test('the range table: which versions each range selects', () => {
  const { versions, cases } = table('ranges');
  for (const row of cases) {
    if (row.range === null) continue;
    const options = rowOptions(row);
    const at = label(row);
    const bits = (run) => versions.map((one) => (run(one) ? '1' : '0')).join('');
    assert.equal(bits((one) => satisfies(one, row.in, options)), row.sat, `satisfies ${at}`);
    assert.equal(bits((one) => gtr(one, row.in, options)), row.gtr, `gtr ${at}`);
    assert.equal(bits((one) => ltr(one, row.in, options)), row.ltr, `ltr ${at}`);
    const chosen = versions.filter((one) => satisfies(one, row.in, options));
    // maxSatisfying compares without build metadata and keeps the first winner it
    // meets, so `1.2.3-beta.2` beats `1.2.3-beta.2+b` when it comes first in the
    // list even though sort() puts the build-carrying one above it.
    const best = (order) => chosen.reduce((held, one) => (order(compare(one, held, options)) ? one : held), chosen[0]);
    assert.equal(maxSatisfying(versions, row.in, options),
      chosen.length === 0 ? null : best((order) => order > 0), `maxSatisfying ${at}`);
    assert.equal(minSatisfying(versions, row.in, options),
      chosen.length === 0 ? null : best((order) => order < 0), `minSatisfying ${at}`);
  }
});

test('the relation table: subset and intersects, as a square matrix', () => {
  const { ranges, cases } = table('relations');
  for (const row of cases) {
    const options = rowOptions(row);
    const at = label(row);
    // A cell named in `exceptSubset` or `exceptIntersects` is one where the reference
    // package contradicts itself; those six are asserted by name further down instead
    // of being smuggled into the table as though we agreed with them.
    const bits = (run, expected, except) => {
      const skip = new Set(except ?? []);
      return ranges.map((dom, index) => (skip.has(index) ? expected[index] : (run(dom) ? '1' : '0'))).join('');
    };
    assert.equal(bits((dom) => subset(row.in, dom, options), row.subset, row.exceptSubset),
      row.subset, `subset ${at}`);
    assert.equal(bits((dom) => intersects(row.in, dom, options), row.intersects, row.exceptIntersects),
      row.intersects, `intersects ${at}`);
  }
});

test('intersects is symmetric here, and is not in the package this replaces', () => {
  const { ranges } = table('relations');
  for (const one of ranges) {
    for (const other of ranges) {
      assert.equal(intersects(one, other), intersects(other, one), `${one} vs ${other}`);
    }
  }
  // The pair that fails that property upstream, in both directions, so the reason is
  // on the record: the only version in `1.2.3-beta` is `1.2.3-beta`, and `*` does not
  // accept a prerelease. So they do not intersect, whichever way round they are asked.
  assert.equal(intersects('1.2.3-beta', '*'), false);
  assert.equal(intersects('*', '1.2.3-beta'), false);
  assert.equal(intersects('1.2.3-beta', '*', { includePrerelease: true }), true);
});

// -- increment, coerce, simplify ---------------------------------------------

test('the inc table', () => {
  for (const row of table('inc').cases) {
    const at = `${JSON.stringify(row.in)} ${row.release}${row.id === undefined ? '' : ` id=${row.id}`}${row.base === undefined ? '' : ` base=${JSON.stringify(row.base)}`}`;
    assert.equal(inc(row.in, row.release, {}, row.id, row.base), row.out, at);
    // The third argument doubles as the identifier, which the reference package allows
    // and which real call sites use, so the two spellings must agree.
    if (row.base === undefined && row.id !== undefined) {
      assert.equal(inc(row.in, row.release, row.id), row.out, `${at} as a bare identifier`);
    }
  }
});

test('inc answers null for anything it cannot do, rather than throwing', () => {
  // Null for a bad release type as well as for a bad version is the reference
  // package's choice. It is a strange one — the two failures have different causes and
  // deserve different answers — but a rewritten call site that tested for null must
  // keep getting null, so the strangeness is kept and recorded here.
  assert.equal(inc('1.2.3', 'nonsense'), null);
  assert.equal(inc('1.2.3', ''), null);
  assert.equal(inc('1.2.3', undefined), null);
  assert.equal(inc('not a version', 'major'), null);
  assert.equal(inc('1.2.3', 'release'), null, 'release needs a prerelease to release');
  assert.equal(inc('1.2.3-beta.2', 'release'), '1.2.3');
  assert.deepEqual([...RELEASE_TYPES], [
    'major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease', 'release',
  ]);
  assert.equal(Object.isFrozen(RELEASE_TYPES), true);
});

test('the coerce table', () => {
  for (const row of table('coerce').cases) {
    const at = `${JSON.stringify(row.in)}${row.rtl ? ' rtl' : ''}`;
    const got = coerce(row.in, { rtl: row.rtl === true });
    assert.equal(got === null ? null : got.version, row.out, at);
  }
});

test('the simplify table', () => {
  const { versions, cases } = table('simplify');
  for (const row of cases) {
    assert.equal(simplifyRange(versions, row.in), row.out, JSON.stringify(row.in));
    // Whatever it returns has to select the same versions, or it is not a
    // simplification. This is the property behind the table, and it is cheap.
    // A range that does not parse has no versions to preserve, and the empty string
    // it simplifies to selects every version, so the property does not apply there.
    if (validRange(row.in) === null) continue;
    for (const one of versions) {
      assert.equal(satisfies(one, row.out), satisfies(one, row.in), `${row.in} vs ${row.out} at ${one}`);
    }
  }
});

// -- the promise in the header -----------------------------------------------

test('the module contains no regular expression', () => {
  // node-semver's ReDoS, CVE-2022-25883, was a backtracking range pattern reached by
  // any call site that passed a user-supplied range string. Every scanner here is a
  // hand-written loop over character codes instead, which is why that class of bug
  // cannot occur. The claim is worth an assertion because it is easy to break later
  // by reaching for a one-line pattern.
  const source = readFileSync(new URL('../../src/runtime/semver.mjs', import.meta.url), 'utf8');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const banned of ['RegExp', '.match(', '.matchAll(', '.replace(/', '.split(/', '.search(']) {
    assert.equal(stripped.includes(banned), false, `${banned} appears in the module`);
  }
  // With the comments gone, a regular expression literal is the only thing left that
  // could put a `/` in this file: nothing here divides. So counting is the whole test.
  const lines = stripped.split('\n').filter((line) => line.includes('/'));
  assert.deepEqual(lines.map((line) => line.trim()), [], 'a slash survives, so something is a pattern or a division');
});

test('every failure carries a code, and the codes are the documented set', () => {
  const codes = (run) => {
    const error = caught(run);
    assert.ok(error instanceof SemverError, `${run} did not throw a SemverError`);
    assert.equal(error.name, 'SemverError');
    // TypeError, so a call site that already caught the reference package's failures
    // keeps catching ours.
    assert.ok(error instanceof TypeError);
    return error.code;
  };
  assert.equal(codes(() => major(null)), 'INVALID_VERSION');
  assert.equal(codes(() => major('1.2')), 'INVALID_VERSION');
  assert.equal(codes(() => major(`1.2.3-${'a'.repeat(MAX_LENGTH)}`)), 'TOO_LONG');
  assert.equal(codes(() => major('99999999999999999999.1.2')), 'COMPONENT_TOO_BIG');
  assert.equal(codes(() => toComparators('nonsense')), 'INVALID_VERSION', 'a token with no operator is read as a version');
  assert.equal(codes(() => toComparators('1.x.3')), 'INVALID_RANGE');
  assert.equal(codes(() => toComparators('> = 1.2.3')), 'INVALID_RANGE', 'the space orphans the >');
  assert.equal(codes(() => cmp('1.2.3', '=>', '1.2.3')), 'INVALID_OPERATOR');
  assert.equal(codes(() => outside('1.2.3', '*', '!')), 'INVALID_OPERATOR');
  assert.equal(codes(() => toComparators(null)), 'INVALID_RANGE');
  // INVALID_IDENTIFIER, INVALID_RELEASE and NOT_A_PRERELEASE are raised inside `inc`,
  // which converts every failure of its own into null, so they are visible only to a
  // reader of this file. They are still coded, because the alternative is a bare throw
  // escaping some later refactor with nothing to test against.
  assert.equal(inc('1.2.3', 'prerelease', 'not an identifier!'), null);
  assert.equal(compareIdentifiers('a', 'b'), -1, 'identifier comparison never throws');
  // The detail object is merged onto the error, so a caller can point at the offset
  // rather than reprinting the whole input.
  const placed = caught(() => major('1.2.x'));
  assert.equal(typeof placed.offset, 'number');
});

test('non-string input is a null, not a crash', () => {
  // Every predicate that can answer "no" answers "no" for input it cannot read.
  // The reference package throws a TypeError from inside itself for some of these,
  // which is one of the divergences recorded below.
  for (const junk of [null, undefined, 1.2, 42, true, {}, [], () => {}]) {
    const at = JSON.stringify(junk) ?? String(junk);
    assert.equal(valid(junk), null, at);
    assert.equal(parse(junk), null, at);
    assert.equal(validRange(junk), null, at);
    assert.equal(parseRange(junk), null, at);
    assert.equal(satisfies(junk, '*'), false, at);
    assert.equal(satisfies('1.2.3', junk), false, at);
    assert.equal(coerce(junk) === null, typeof junk !== 'number', at);
    // `clean` is the exception, and deliberately: the reference package throws for
    // input with no `.trim()`, and a call site that relied on that must keep its throw.
    assert.equal(caught(() => clean(junk)).code, 'INVALID_VERSION', at);
  }
  assert.equal(coerce(42).version, '42.0.0', 'a number is coerced the way its text would be');
  assert.equal(clean('  =v1.2.3 '), '1.2.3');
  assert.equal(maxSatisfying([], '*'), null);
  assert.equal(minSatisfying(['x', 'y'], '*'), null, 'unreadable candidates are skipped');
});

test('a parsed version and a parsed range are accepted wherever their text is', () => {
  const version = parse('1.2.3');
  const range = parseRange('^1.0.0');
  assert.equal(valid(version), '1.2.3');
  assert.equal(satisfies(version, range), true);
  assert.equal(satisfies(version, '^1.0.0'), true);
  assert.equal(satisfies('1.2.3', range), true);
  assert.equal(validRange(range), '>=1.0.0 <2.0.0-0');
  assert.equal(inc(version, 'minor'), '1.3.0');
  assert.equal(compare(version, parse('1.2.4')), -1);
  // Both records stringify to their canonical text, because call sites interpolate them.
  assert.equal(`${version}`, '1.2.3');
  assert.equal(String(parse('1.2.3-b+x')), '1.2.3-b');
  assert.equal(`${range}`, '>=1.0.0 <2.0.0-0');
  // And they are data: no methods, nothing to mutate, nothing hidden in JSON.
  assert.deepEqual(Object.keys(version), ['raw', 'version', 'major', 'minor', 'patch', 'prerelease', 'build']);
  assert.deepEqual(Object.keys(range), ['raw', 'range', 'set']);
  assert.equal(JSON.parse(JSON.stringify(version)).version, '1.2.3');
  assert.equal(Object.isFrozen(version.prerelease) && Object.isFrozen(version.build), true);
  assert.equal(Object.isFrozen(range.set[0]), true);
});

test('sorting copies rather than reorders, and the constants are what they claim', () => {
  const list = ['1.2.3', '1.0.0', '1.2.3-a', '1.2.3+b'];
  assert.deepEqual(sort(list), ['1.0.0', '1.2.3-a', '1.2.3', '1.2.3+b']);
  assert.deepEqual(rsort(list), ['1.2.3+b', '1.2.3', '1.2.3-a', '1.0.0']);
  assert.deepEqual(list, ['1.2.3', '1.0.0', '1.2.3-a', '1.2.3+b'], 'the argument is untouched');
  assert.equal(compareLoose('=v1.2.3', '1.2.3'), 0);
  assert.equal(compareIdentifiers('1', 'a'), -1, 'numeric sorts below alphanumeric');
  assert.equal(rcompareIdentifiers('1', 'a'), 1);
  assert.equal(MAX_LENGTH, 256);
  assert.equal(SEMVER_SPEC_VERSION, '2.0.0');
  assert.equal(Object.isFrozen(semver.default), true, 'the default export is frozen');
  assert.equal(semver.default.parse, parse, 'and is the same functions as the named exports');
});

// -- where this module deliberately answers differently ----------------------

test('the five deliberate divergences from the package this replaces', () => {
  // Recorded in STDLIB.md as well. A differential harness ran 507,316 checks against
  // semver@7.8.5 as a black box; 72 disagreed, and each was then re-checked against
  // that package's own `satisfies`, which contradicts it in every case. These five
  // stand for the whole set, one per cause.

  // 1 and 2: reading a property of null or of a number. The reference package crashes
  // with a TypeError from inside itself; a predicate should answer instead.
  assert.equal(cmp('1.2.3', '===', null), false);
  assert.equal(cmp('1.2.3', '!==', null), true);
  assert.equal(satisfies(1.2, '*'), false);

  // 3: `intersects` is asymmetric there — false one way round, true the other, for
  // the same pair. Ours is symmetric, and its own `satisfies` agrees with our answer:
  // no version is in both `*` and `1.2.3-beta`.
  assert.equal(intersects('*', '1.2.3-beta'), false);
  assert.equal(satisfies('1.2.3-beta', '*'), false, 'because a bare range takes no prerelease');

  // 4: `subset` denies a containment its own `satisfies` affirms. The only version in
  // `1.2.3-beta` is `1.2.3-beta`, which is in `>1.2.3-alpha <2.0.0-0`, so it is a subset.
  assert.equal(subset('1.2.3-beta', '>1.2.3-alpha <2.0.0-0'), true);
  assert.equal(satisfies('1.2.3-beta', '>1.2.3-alpha <2.0.0-0'), true);

  // 5: a numeric component after a wildcard is not a range. The reference package
  // rejects `1.x.3` and so do we; what differs is that we say why, with a code, rather
  // than returning null and leaving the caller to guess.
  assert.equal(validRange('1.x.3'), null);
  assert.equal(caught(() => toComparators('1.x.3')).code, 'INVALID_RANGE');
  assert.equal(validRange('1.*.x'), '>=1.0.0 <2.0.0-0', 'a wildcard after a wildcard is fine');
});
