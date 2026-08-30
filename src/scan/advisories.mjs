// Known-bad versions, from a table in this file and no network.
//
// `scan` already says a package could be removed. This says why the removal is
// urgent: the version in your lockfile is one somebody has already been burned
// by. Every check is offline -- the table below is data in a source file, dated,
// with an identifier per row where one exists -- because a codemod that phones a
// registry mid-run is a supply chain of its own.
//
// This is not `npm audit` and must never be read as it. `npm audit` mirrors the
// whole GitHub Advisory Database over the network; this covers one neighbourhood
// on purpose: the packages nirdep offers to replace, plus the incidents that
// happened in the same street. That scope is the point. A tool that says "delete
// chalk" should be able to say what happened to the people who did not, and it
// should not pretend to know anything about the other four hundred entries in
// your tree. The report prints the table's review date next to every count.
//
// Two kinds of row, because they fail differently.
//
// A *flaw* is a bug with a version range: the code was always meant well and one
// input broke it. Ranges are matched with this project's own runtime/semver, so
// the module that replaces the package with the ReDoS is the module that decides
// whether you are still exposed to it.
//
// An *incident* is a version that was published to hurt you. There is no range,
// because there is no "fixed in": the malicious release sits between two innocent
// ones and only exact versions match. Where the hand was the maintainer's own --
// protestware, sabotage -- the row says so, because the lesson is different: no
// audit of the code as reviewed would have caught it, and the thing you trusted
// was a person.
//
// Where the affected versions are not written down here, the row says that too
// rather than guessing. An entry with no versions is reported as a name-level
// note: this package was in an incident, look it up. Inventing a version number
// would be worse than the gap.

import { gt, satisfies, valid } from '../runtime/semver.mjs';
import { ruleFor } from '../rules/registry.mjs';

/** The day somebody last read this table against the advisories it cites. */
export const REVIEWED = '2026-08-30';

export const KIND = Object.freeze({ FLAW: 'flaw', INCIDENT: 'incident' });

/** Who published the bad version. The maintainer's own hand is its own lesson. */
export const HAND = Object.freeze({ ATTACKER: 'attacker', AUTHOR: 'author' });

/** What a check concluded about one installed version. */
export const VERDICT = Object.freeze({
  HIT: 'hit',
  CLEAR: 'clear',
  UNVERSIONED: 'unversioned',
  UNKNOWN: 'unknown',
});

// -- the flaws ---------------------------------------------------------------
//
// Every row here is a package this project replaces, which is why the list is
// short and why each one has an answer beside it rather than only a warning.

const FLAWS = [
  {
    id: 'CVE-2022-25883', package: 'semver', when: '2023-06-21', severity: 'high',
    range: '<5.7.2 || >=6.0.0 <6.3.1 || >=7.0.0 <7.5.2', fixed: '7.5.2',
    what: 'the range parser backtracked, so any call site handed a user-supplied range could be hung '
      + 'by it. The fix shipped as a patch that plenty of lockfiles never took.',
  },
  {
    id: 'CVE-2022-3517', package: 'minimatch', when: '2022-10-17', severity: 'high',
    range: '<3.0.5', fixed: '3.0.5',
    what: 'brace expansion compiled to a pattern that backtracked on a crafted brace body. '
      + 'Almost nobody installs minimatch on purpose, which is what made it everywhere.',
  },
  {
    id: 'CVE-2020-28469', package: 'glob-parent', when: '2021-06-03', severity: 'high',
    range: '<5.1.2', fixed: '5.1.2',
    what: 'the same class again, one layer down: splitting a glob into its non-magic prefix '
      + 'backtracked on a path of repeated separators.',
  },
  {
    id: 'CVE-2024-4068', package: 'braces', when: '2024-05-13', severity: 'high',
    range: '<3.0.3', fixed: '3.0.3',
    what: 'brace expansion with no ceiling: enough nested braces and the process is gone before '
      + 'any pattern is matched.',
  },
  {
    id: 'CVE-2024-4067', package: 'micromatch', when: '2024-05-14', severity: 'medium',
    range: '<4.0.8', fixed: '4.0.8',
    what: 'the matcher above braces, backtracking on the same shape of input.',
  },
  {
    id: 'CVE-2021-3807', package: 'ansi-regex', when: '2021-09-17', severity: 'high',
    range: '>=3.0.0 <3.0.1 || >=4.0.0 <4.1.1 || >=5.0.0 <5.0.1 || >=6.0.0 <6.0.1', fixed: '5.0.1',
    what: 'the pattern that recognises an escape sequence could be hung by a string of them. '
      + 'node:util has stripVTControlCharacters and has had it since Node 16.',
  },
  {
    id: 'CVE-2020-7598', package: 'minimist', when: '2020-03-11', severity: 'medium',
    range: '<0.2.1 || >=1.0.0 <1.2.3', fixed: '1.2.3',
    what: 'dot notation assigned straight onto Object.prototype: --__proto__.polluted=yes '
      + 'reached every object in the process.',
  },
  {
    id: 'CVE-2021-44906', package: 'minimist', when: '2022-03-17', severity: 'high',
    range: '<0.2.4 || >=1.0.0 <1.2.6', fixed: '1.2.6',
    what: 'the same hole a second time, through the path the first fix did not cover. '
      + 'Nesting a command line is a config file job; runtime/args does not have the feature.',
  },
  {
    id: 'CVE-2018-3721', package: 'lodash', when: '2018-06-07', severity: 'medium',
    range: '<4.17.5', fixed: '4.17.5',
    what: 'merge, mergeWith and defaultsDeep would walk a __proto__ key in attacker JSON and '
      + 'write through it.',
  },
  {
    id: 'CVE-2019-10744', package: 'lodash', when: '2019-07-08', severity: 'high',
    range: '<4.17.12', fixed: '4.17.12',
    what: 'defaultsDeep, again, by a route the 2018 fix left open. A blocklist is the wrong shape for '
      + 'this bug: a merge that refuses __proto__, constructor and prototype structurally cannot have it.',
  },
  {
    id: 'CVE-2020-8203', package: 'lodash', when: '2020-07-15', severity: 'high',
    range: '<4.17.19', fixed: '4.17.19',
    what: 'zipObjectDeep, third time, same class. Three advisories in three years for one '
      + 'feature is a design telling you something.',
  },
  {
    id: 'CVE-2020-28500', package: 'lodash', when: '2021-02-15', severity: 'medium',
    range: '<4.17.21', fixed: '4.17.21',
    what: 'toNumber, trim and trimEnd backtracked on a long whitespace string. '
      + 'String.prototype.trim has done this correctly since ES5.',
  },
  {
    id: 'CVE-2021-23337', package: 'lodash', when: '2021-02-15', severity: 'high',
    range: '<4.17.21', fixed: '4.17.21',
    what: 'template compiled its input into a function, so a template from an untrusted source '
      + 'was code execution by design.',
  },
];

// -- the incidents -----------------------------------------------------------
//
// Published on purpose to do harm. `versions` is exact and short, because the
// malicious release sits between two innocent ones; `versions: null` means this
// table does not record which ones, and the report says so rather than guessing.

const INCIDENTS = [
  {
    package: 'event-stream', when: '2018-11-26', hand: HAND.ATTACKER, versions: ['3.3.6'],
    what: 'a volunteer asked for publish rights, got them, and added a dependency that stole '
      + 'wallet keys from one specific application. The package had two million downloads a week '
      + 'and one unpaid maintainer.',
    also: 'flatmap-stream',
  },
  {
    package: 'flatmap-stream', when: '2018-11-26', hand: HAND.ATTACKER, versions: ['0.1.0', '0.1.1'],
    what: 'the payload itself: eleven lines of legitimate code and an encrypted blob keyed on '
      + "the victim application's own package description.",
  },
  {
    package: 'eslint-scope', when: '2018-07-12', hand: HAND.ATTACKER, versions: ['3.7.2'],
    what: 'a maintainer account with a reused password. The release read your .npmrc token and '
      + 'posted it away, which turns one compromise into the next one.',
  },
  {
    package: 'ua-parser-js', when: '2021-10-22', hand: HAND.ATTACKER, versions: ['0.7.29', '0.8.0', '1.0.0'],
    what: 'three releases in one afternoon carrying a password stealer and a crypto miner, from '
      + 'a hijacked account. Every version was pulled within hours and installed anyway.',
  },
  {
    package: 'coa', when: '2021-11-04', hand: HAND.ATTACKER, versions: null,
    what: 'an unmaintained argument parser, hijacked and republished with a credential stealer, '
      + 'breaking React builds worldwide because it was under react-scripts.',
  },
  {
    package: 'rc', when: '2021-11-04', hand: HAND.ATTACKER, versions: null,
    what: 'the same attacker, the same day, another package nobody chose: a config reader with '
      + 'no releases in years and tens of millions of weekly downloads.',
  },
  {
    package: 'colors', when: '2022-01-08', hand: HAND.AUTHOR, versions: ['1.4.44-liberty-2'],
    what: 'the maintainer added an infinite loop printing garbage, on purpose, to make a point '
      + 'about unpaid work. Two million weekly downloads, one person, no warning.',
  },
  {
    package: 'faker', when: '2022-01-08', hand: HAND.AUTHOR, versions: ['6.6.6'],
    what: 'the same maintainer, the same week: the library emptied to three lines. The fork '
      + 'people moved to is @faker-js/faker, which is a new trust decision, not the old one.',
  },
  {
    package: 'node-ipc', when: '2022-03-15', hand: HAND.AUTHOR, versions: ['10.1.1', '10.1.2'],
    what: 'protestware that overwrote files on disk with a heart emoji if it geolocated your IP '
      + 'to one of two countries. Neighbouring releases added a desktop message instead. Either '
      + 'way a transitive dependency read your network position and wrote to your filesystem.',
  },
];

// The September 2025 phishing wave, as one description across every package it
// reached. The names are recorded and the versions are not: this table was
// written after the fact from summaries, and a version number nobody here
// verified would be worse than the admission. So these rows match on name only
// and say what they cannot tell you.
const WAVE = {
  when: '2025-09-08', hand: HAND.ATTACKER, versions: null,
  what: 'a maintainer phished into handing over publish rights, and the releases that followed '
    + 'carried a wallet interceptor that rewrote crypto transactions in the browser. The packages '
    + 'hit were the smallest, dullest, most-installed leaves in the ecosystem, which is exactly '
    + 'why it worked: nobody chose them and nobody was watching them.',
  unrecorded: 'which versions carried it is not recorded here, so this is a name match and not a '
    + 'verdict on your tree',
  packages: [
    'chalk', 'debug', 'ansi-styles', 'strip-ansi', 'supports-color', 'color-convert', 'color-name',
    'wrap-ansi', 'slice-ansi', 'ansi-regex', 'is-arrayish', 'error-ex', 'simple-swizzle',
    'color-string', 'has-ansi', 'chalk-template', 'supports-hyperlinks', 'backslash',
  ],
};

/** One row, frozen, with every field present whether or not it was recorded. */
const row = (fields) => Object.freeze({
  id: fields.id ?? null,
  package: fields.package,
  kind: fields.kind,
  severity: fields.severity ?? (fields.kind === KIND.INCIDENT ? 'critical' : 'high'),
  when: fields.when,
  hand: fields.hand ?? null,
  range: fields.range ?? null,
  fixed: fields.fixed ?? null,
  versions: fields.versions === null || fields.versions === undefined
    ? null
    : Object.freeze([...fields.versions]),
  what: fields.what,
  also: fields.also ?? null,
  unrecorded: fields.unrecorded ?? null,
  group: fields.group ?? null,
});

/**
 * Every advisory this tool knows, flaws first, then incidents by date.
 *
 * An incident is `critical` by default and a flaw carries the rating its advisory
 * carries: a malicious release and a ReDoS are not the same news, and a table
 * that painted them the same colour would train people to skim both.
 */
export const ADVISORIES = Object.freeze([
  ...FLAWS.map((one) => row({ ...one, kind: KIND.FLAW })),
  ...INCIDENTS.map((one) => row({ ...one, kind: KIND.INCIDENT })),
  ...WAVE.packages.map((name) => row({ ...WAVE, package: name, kind: KIND.INCIDENT, group: 'wave-2025-09' })),
]);

/** Name to rows, built once. Two rows for one package is the normal case. */
const BY_NAME = new Map();
for (const one of ADVISORIES) {
  const found = BY_NAME.get(one.package);
  if (found === undefined) BY_NAME.set(one.package, [one]);
  else found.push(one);
}

/** How many packages the table covers, which the report prints beside its counts. */
export const COVERAGE = Object.freeze({ packages: BY_NAME.size, rows: ADVISORIES.length, reviewed: REVIEWED });

/**
 * Every advisory recorded against a package name.
 *
 * @param {string} name
 * @returns {ReadonlyArray<object>}
 */
export function advisoriesFor(name) {
  return Object.freeze([...(BY_NAME.get(name) ?? [])]);
}

/**
 * Whether one installed version is the bad one, and how sure this is.
 *
 * Four answers rather than a boolean, because "no" and "the table does not say"
 * are different sentences and a report that printed them the same way would be
 * claiming knowledge it does not have. A version string a lockfile invented --
 * `file:../thing`, a git URL, a workspace protocol -- is `UNKNOWN`, not clear.
 *
 * @param {object} advisory a row from {@link ADVISORIES}
 * @param {string|null} version as the lockfile spells it
 * @returns {string} one of {@link VERDICT}
 */
export function checkVersion(advisory, version) {
  if (advisory.versions === null && advisory.range === null) return VERDICT.UNVERSIONED;
  if (typeof version !== 'string' || version === '') return VERDICT.UNKNOWN;
  if (advisory.versions !== null) {
    // An exact list, compared as written. A malicious release is one published
    // artefact, so `1.4.44-liberty-2` is either in your tree or it is not, and
    // semver precedence has no opinion worth having about it.
    return advisory.versions.includes(version) ? VERDICT.HIT : VERDICT.CLEAR;
  }
  try {
    if (valid(version) === null) return VERDICT.UNKNOWN;
    return satisfies(version, advisory.range, { includePrerelease: true })
      ? VERDICT.HIT
      : VERDICT.CLEAR;
  } catch {
    // Our own semver throws on input it will not guess at. A range this table
    // wrote and a version a lockfile wrote are different provenances, and the
    // one we did not write is the one allowed to be strange.
    return VERDICT.UNKNOWN;
  }
}

/** Where the version being judged came from, because it changes what silence means. */
export const SOURCE = Object.freeze({ LOCK: 'lock', MANIFEST: 'manifest' });

/**
 * The version a package has to reach to leave every row in a set behind.
 *
 * Compared with this project's own `gt` rather than as strings, because 4.17.9 is
 * not later than 4.17.12 in any ordering a computer reaches by accident. An
 * incident row has no `fixed` and contributes nothing.
 *
 * @param {ReadonlyArray<object>} rows advisories, or findings carrying one
 * @returns {string|null}
 */
export function highestFixed(rows) {
  let best = null;
  for (const one of rows) {
    const candidate = one.advisory?.fixed ?? one.fixed ?? null;
    if (candidate === null || candidate === undefined) continue;
    try {
      if (best === null || gt(candidate, best)) best = candidate;
    } catch {
      // A `fixed` this table cannot parse is this table's bug, not the tree's.
    }
  }
  return best;
}

/** Loudest first, so a wallet stealer is never printed under a whitespace ReDoS. */
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const rank = (one) => RANK[one.advisory.severity] ?? 4;

/** Severity, then package, then the older news first: the same order twice is stable. */
function order(a, b) {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  if (a.advisory.when !== b.advisory.when) return a.advisory.when < b.advisory.when ? -1 : 1;
  return (a.version ?? '') < (b.version ?? '') ? -1 : 1;
}

/** One installed thing judged against one row, frozen for the report to read. */
const finding = (fields) => Object.freeze({
  package: fields.package,
  version: fields.version ?? null,
  places: Object.freeze([...(fields.places ?? [])]),
  dev: fields.dev === true,
  source: fields.source,
  verdict: fields.verdict,
  replaceable: ruleFor(fields.package) !== null,
  advisory: fields.advisory,
});

/**
 * Every distinct name-and-version in a tree, with where each copy sits.
 *
 * A hoisted package appears at several paths with one version, and reporting the
 * same advisory four times because npm wrote four entries would be padding.
 */
function installed(lock) {
  const seen = new Map();
  for (const one of lock.packages) {
    const key = `${one.name}${one.version ?? ''}`;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, { name: one.name, version: one.version ?? null, places: [one.place], dev: one.dev === true });
    } else {
      found.places.push(one.place);
      // dev only if every copy is: one production path is a production dependency.
      found.dev = found.dev && one.dev === true;
    }
  }
  return [...seen.values()];
}

/** The declared names, used only when there is no lockfile to be more precise with. */
function declared(manifest) {
  if (manifest === null || typeof manifest !== 'object') return [];
  // Two shapes arrive here: this project's own manifest record, where the ranges
  // are a Map and the dev names are a Set, and a package.json parsed straight from
  // disk. Reading both is three lines; making a caller convert is a bug waiting.
  if (manifest.ranges instanceof Map) {
    const dev = manifest.development instanceof Set ? manifest.development : new Set();
    return [...manifest.ranges.keys()].map((name) => ({
      name, version: null, places: [], dev: dev.has(name),
    }));
  }
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = manifest[field];
    if (block === null || typeof block !== 'object') continue;
    for (const name of Object.keys(block)) {
      out.push({ name, version: null, places: [], dev: field === 'devDependencies' });
    }
  }
  return out;
}

/**
 * Cross the table against a tree.
 *
 * Three buckets, because there are three honest answers and a single list would
 * blur them: `hits` is a version this table says is bad, `unversioned` is a
 * package that was in an incident whose affected releases are not recorded here,
 * and `unknown` is a version nobody could parse -- a git URL, a `file:` path, or
 * a lockfile that was never read at all. A package the table clears is not
 * mentioned, which is what keeps the report short enough to read.
 *
 * @param {{ lock?: object, manifest?: object }} world
 * @returns {Readonly<object>}
 */
export function auditTree(world = {}) {
  const lock = world.lock ?? null;
  const usable = lock !== null && lock.count > 0;
  const source = usable ? SOURCE.LOCK : SOURCE.MANIFEST;
  const tree = usable ? installed(lock) : declared(world.manifest ?? null);
  const hits = [];
  const unversioned = [];
  const unknown = [];
  let matched = 0;
  for (const one of tree) {
    const rows = BY_NAME.get(one.name);
    if (rows === undefined) continue;
    matched += 1;
    for (const advisory of rows) {
      const verdict = checkVersion(advisory, one.version);
      if (verdict === VERDICT.CLEAR) continue;
      const row = finding({ ...one, package: one.name, source, verdict, advisory });
      if (verdict === VERDICT.HIT) hits.push(row);
      else if (verdict === VERDICT.UNVERSIONED) unversioned.push(row);
      else unknown.push(row);
    }
  }
  hits.sort(order);
  unversioned.sort(order);
  unknown.sort(order);
  return Object.freeze({
    source,
    reviewed: REVIEWED,
    coverage: COVERAGE,
    checked: tree.length,
    matched,
    hits: Object.freeze(hits),
    unversioned: Object.freeze(unversioned),
    unknown: Object.freeze(unknown),
    counts: Object.freeze({
      hits: hits.length,
      unversioned: unversioned.length,
      unknown: unknown.length,
      incidents: hits.filter((one) => one.advisory.kind === KIND.INCIDENT).length,
      flaws: hits.filter((one) => one.advisory.kind === KIND.FLAW).length,
    }),
  });
}
