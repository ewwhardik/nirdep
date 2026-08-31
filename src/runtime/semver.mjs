// nirdep/runtime/semver -- version arithmetic, with no regular expressions.
//
// Published by Nastik AI. Developed by Sai Ram Dash (Hardik).
//
// The package this replaces is installed roughly 250 million times a week, and
// unlike colour or argument parsing there is no partial answer in the standard
// library to build on. `process.versions` hands you strings; comparing them
// lexically is wrong at the first two-digit component, because "1.9.0" sorts
// above "1.10.0". Node ships no comparator, no range grammar, no precedence
// rule for prereleases, and no way to ask whether a version satisfies "^1.2.3".
// Every one of those had to be written.
//
// Two decisions shape the whole file.
//
// It contains no regular expression. Not one, and a test asserts it. The
// reference implementation is built out of them, and in 2023 that cost it
// CVE-2022-25883: the range grammar's backtracking could be driven quadratic by
// a long crafted range, which is a denial of service in every tool that reads a
// range out of a package manifest -- which is every tool. A hand-written scanner
// that reads each character once cannot have that bug at all, and the parser
// here is linear in the length of its input by construction.
//
// Where behaviour is observable, it matches the reference package rather than my
// taste, including the parts I would have designed differently: `inc` returns
// null instead of throwing, `satisfies` swallows an invalid range and answers
// false, and `compare` throws on input it cannot parse. The reason is the codemod
// this runtime exists for. A rewritten call site must mean exactly what it meant
// before, and a module that improved the error handling would quietly change the
// behaviour of the program it was rewritten into. The improvements go into the
// error objects instead: every throw is a SemverError carrying a stable `code`,
// and SemverError extends TypeError so existing catch blocks still fire.
//
// Deliberately absent, with reasons, rather than half-built: `subset` and
// `simplifyRange` are implemented over interval arithmetic and are prerelease
// blind, which is documented at each function; `re`, `src` and `tokens` -- the
// reference package's exported regular expressions -- cannot exist here, and
// their absence is the point of the file. STDLIB.md carries the full list.
//
// The version grammar is SemVer 2.0.0 (semver.org, items 9 to 11 for
// prereleases, build metadata and precedence). The range grammar is not part of
// that specification; it is the reference package's own, and it is pinned here
// by conformance vectors in tests/vectors/semver/.

/** Longest input we will look at, matching the reference package's limit. */
export const MAX_LENGTH = 256;

/** A component above this cannot be compared reliably, so it is refused. */
export const MAX_COMPONENT = Number.MAX_SAFE_INTEGER;

/** The specification this implements. */
export const SEMVER_SPEC_VERSION = '2.0.0';

/** Every release name `inc` accepts, in the order the reference package lists them. */
export const RELEASE_TYPES = Object.freeze([
  'major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease', 'release',
]);

/**
 * A version or range we could not read.
 *
 * It extends TypeError on purpose: the reference package throws a plain
 * TypeError, so a call site that was rewritten to this module keeps catching what
 * it caught before. The `code` is the part meant to be programmed against; the
 * message is for people and may change.
 */
export class SemverError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SemverError';
    this.code = code;
    for (const [key, value] of Object.entries(detail)) this[key] = value;
  }
}

const fail = (code, message, detail) => { throw new SemverError(code, message, detail); };

// -- character tests ---------------------------------------------------------
//
// Written against character codes rather than string comparisons because every
// one of these is called once per character of every version ever parsed, and
// because `charCodeAt` past the end returns NaN, which fails every test below
// without a length check at each call site.

const isDigit = (code) => code >= 48 && code <= 57;

/** The alphanumerics and the hyphen: the only characters an identifier may use. */
const isIdentifier = (code) => isDigit(code)
  || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;

const isSpace = (code) => code === 32 || code === 9;

/** x, X and * all mean "any" in a range, and only there. */
const isWildcard = (text) => text === 'x' || text === 'X' || text === '*';

/** True if every character is a digit and there is at least one. */
function isNumeric(text) {
  if (text.length === 0) return false;
  for (let at = 0; at < text.length; at += 1) if (!isDigit(text.charCodeAt(at))) return false;
  return true;
}

// -- reading a version -------------------------------------------------------

/**
 * One numeric component. SemVer forbids a leading zero, because it would give
 * two spellings of the same number and therefore two versions that compare equal
 * but are not the same string. Loose mode allows it and normalises it away.
 */
function readNumber(text, at, loose, what) {
  const start = at;
  while (at < text.length && isDigit(text.charCodeAt(at))) at += 1;
  if (at === start) fail('INVALID_VERSION', `expected ${what} at offset ${start}`, { offset: start });
  const digits = text.slice(start, at);
  if (!loose && digits.length > 1 && digits.charCodeAt(0) === 48) {
    fail('INVALID_VERSION', `${what} has a leading zero at offset ${start}`, { offset: start });
  }
  const value = Number(digits);
  if (value > MAX_COMPONENT) {
    fail('COMPONENT_TOO_BIG', `${what} is above ${MAX_COMPONENT} and cannot be compared`, { offset: start });
  }
  return { value, at };
}

/**
 * A dot-separated identifier list: a prerelease, or build metadata.
 *
 * The two differ in one way that matters. A numeric prerelease identifier
 * compares as a number, so it is converted to one here and the leading zero is
 * refused; build metadata never takes part in precedence, so it stays as text and
 * `+build.007` is perfectly legal.
 */
function readIdentifiers(text, at, { numeric, loose }) {
  const parts = [];
  for (;;) {
    const start = at;
    while (at < text.length && isIdentifier(text.charCodeAt(at))) at += 1;
    if (at === start) fail('INVALID_VERSION', `empty identifier at offset ${start}`, { offset: start });
    const part = text.slice(start, at);
    if (numeric && isNumeric(part)) {
      if (!loose && part.length > 1 && part.charCodeAt(0) === 48) {
        fail('INVALID_VERSION', `numeric identifier has a leading zero at offset ${start}`, { offset: start });
      }
      const value = Number(part);
      if (value > MAX_COMPONENT) {
        fail('COMPONENT_TOO_BIG', `identifier is above ${MAX_COMPONENT} and cannot be compared`, { offset: start });
      }
      parts.push(value);
    } else {
      parts.push(part);
    }
    if (at < text.length && text.charCodeAt(at) === 46) {
      at += 1;
      continue;
    }
    return { parts, at };
  }
}

/** True if the value is already one of our parsed versions. */
const isVersion = (value) => value !== null && typeof value === 'object'
  && typeof value.version === 'string' && typeof value.major === 'number';

/**
 * Freeze a record and give it a `toString` answering its canonical text. The
 * property is not enumerable, so the record stays plain data to `Object.keys`,
 * to spread and to `JSON.stringify`, while `${version}` and `String(range)` keep
 * answering what a call site written against the reference package expects.
 */
function sealed(record, text) {
  Object.defineProperty(record, 'toString', { value: () => text, enumerable: false });
  return Object.freeze(record);
}

/** Assemble the frozen record every other function in this file works on. */
function makeVersion(major, minor, patch, prerelease, build, raw) {
  const tail = prerelease.length > 0 ? `-${prerelease.join('.')}` : '';
  const version = `${major}.${minor}.${patch}${tail}`;
  return sealed({
    raw,
    version,
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(build),
  }, version);
}

/**
 * The strict grammar, plus the two liberties the reference package takes with it:
 * surrounding whitespace is trimmed even in strict mode, and a single leading `v`
 * is allowed. Loose mode additionally eats any run of `v`, `=` and whitespace at
 * the front, and forgives leading zeros throughout.
 */
function readVersion(input, options = {}) {
  if (isVersion(input)) return input;
  const loose = options.loose === true;
  if (typeof input !== 'string') {
    fail('INVALID_VERSION', `a version must be a string, not ${input === null ? 'null' : typeof input}`);
  }
  if (input.length > MAX_LENGTH) {
    fail('TOO_LONG', `a version may not be longer than ${MAX_LENGTH} characters`);
  }
  const text = input.trim();
  let at = 0;
  if (loose) {
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code === 118 || code === 61 || isSpace(code)) at += 1;
      else break;
    }
  } else if (text.charCodeAt(0) === 118) {
    at += 1;
  }
  const major = readNumber(text, at, loose, 'the major version');
  if (text.charCodeAt(major.at) !== 46) {
    fail('INVALID_VERSION', `expected "." after the major version at offset ${major.at}`, { offset: major.at });
  }
  const minor = readNumber(text, major.at + 1, loose, 'the minor version');
  if (text.charCodeAt(minor.at) !== 46) {
    fail('INVALID_VERSION', `expected "." after the minor version at offset ${minor.at}`, { offset: minor.at });
  }
  const patch = readNumber(text, minor.at + 1, loose, 'the patch version');
  at = patch.at;
  let prerelease = [];
  let build = [];
  if (text.charCodeAt(at) === 45) {
    // In loose mode the hyphen that introduces the prerelease is itself optional,
    // because a hyphen is a legal identifier character. So `1.2.3-` is a version
    // whose prerelease is the single identifier "-", and it prints as `1.2.3--`.
    // That is not a guess: it is what the reference package's loose grammar does,
    // and code in the wild relies on the trailing-hyphen case parsing at all.
    let read = null;
    try {
      read = readIdentifiers(text, at + 1, { numeric: true, loose });
    } catch (error) {
      if (!loose || !(error instanceof SemverError)) throw error;
      read = readIdentifiers(text, at, { numeric: true, loose });
    }
    prerelease = read.parts;
    at = read.at;
  }
  if (text.charCodeAt(at) === 43) {
    const read = readIdentifiers(text, at + 1, { numeric: false, loose });
    build = read.parts;
    at = read.at;
  }
  if (at !== text.length) {
    fail('INVALID_VERSION', `unexpected ${JSON.stringify(text.slice(at))} at offset ${at}`, { offset: at });
  }
  return makeVersion(major.value, minor.value, patch.value, prerelease, build, input);
}

// -- the public reading surface ----------------------------------------------

/**
 * `true` as the options argument means loose, which the reference package accepts
 * everywhere and which appears in a great deal of real code.
 */
const settle = (options) => (options === true ? { loose: true } : (options ?? {}));

/** The parsed version, or null. Never throws for a version it cannot read. */
export function parse(input, options) {
  try {
    return readVersion(input, settle(options));
  } catch (error) {
    if (error instanceof SemverError) return null;
    throw error;
  }
}

/** The version in its canonical spelling, or null. Build metadata is dropped. */
export function valid(input, options) {
  const version = parse(input, options);
  return version === null ? null : version.version;
}

/** Like `valid`, but forgiving of the `=v` prefixes people paste out of ranges. */
export function clean(input, options) {
  if (typeof input !== 'string') fail('INVALID_VERSION', `a version must be a string, not ${typeof input}`);
  let at = 0;
  const text = input.trim();
  while (at < text.length && (text.charCodeAt(at) === 61 || text.charCodeAt(at) === 118)) at += 1;
  return valid(text.slice(at), options);
}

/** The prerelease identifiers, or null when there are none. */
export function prerelease(input, options) {
  const version = parse(input, options);
  return version !== null && version.prerelease.length > 0 ? [...version.prerelease] : null;
}

export const major = (input, options) => readVersion(input, settle(options)).major;
export const minor = (input, options) => readVersion(input, settle(options)).minor;
export const patch = (input, options) => readVersion(input, settle(options)).patch;

// -- precedence --------------------------------------------------------------
//
// SemVer 2.0.0 item 11, in order: the three numeric components, then the presence
// of a prerelease (a version with one is *lower* than the same version without),
// then the prerelease identifiers pairwise, then -- if one list runs out -- the
// shorter list is lower. Build metadata is ignored throughout, which is item 10.

const sign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Two prerelease identifiers. Numbers rank below text, which is the rule that
 * makes `1.0.0-1` lower than `1.0.0-alpha`. Text compares by ASCII order.
 *
 * Takes strings as well as numbers, because the reference package exports this
 * and real code passes it raw identifiers.
 */
export function compareIdentifiers(a, b) {
  const left = typeof a === 'string' && isNumeric(a) ? Number(a) : a;
  const right = typeof b === 'string' && isNumeric(b) ? Number(b) : b;
  const leftNumeric = typeof left === 'number';
  const rightNumeric = typeof right === 'number';
  if (leftNumeric && !rightNumeric) return -1;
  if (rightNumeric && !leftNumeric) return 1;
  return sign(left, right);
}

export const rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);

/** The three numbers only. */
function compareMain(a, b) {
  return compareIdentifiers(a.major, b.major)
    || compareIdentifiers(a.minor, b.minor)
    || compareIdentifiers(a.patch, b.patch);
}

/** The prerelease tail only, assuming the main versions are equal. */
function comparePre(a, b) {
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  for (let at = 0; ; at += 1) {
    const left = a.prerelease[at];
    const right = b.prerelease[at];
    if (left === undefined && right === undefined) return 0;
    if (right === undefined) return 1;
    if (left === undefined) return -1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
}

/** -1, 0 or 1. Throws for input it cannot read, as the reference package does. */
export function compare(a, b, options) {
  const settled = settle(options);
  const left = readVersion(a, settled);
  const right = readVersion(b, settled);
  return compareMain(left, right) || comparePre(left, right);
}

export const rcompare = (a, b, options) => compare(b, a, options);

export const compareLoose = (a, b) => compare(a, b, { loose: true });

/**
 * Precedence, and then build metadata as a tiebreak.
 *
 * Build metadata is explicitly *not* part of precedence, so this is not a
 * comparison anyone should make decisions with. It exists so that sorting a list
 * is deterministic: two versions differing only in build metadata would otherwise
 * swap places depending on the sort implementation.
 */
export function compareBuild(a, b, options) {
  const settled = settle(options);
  const left = readVersion(a, settled);
  const right = readVersion(b, settled);
  const order = compare(left, right, settled);
  if (order !== 0) return order;
  if (left.build.length === 0 && right.build.length > 0) return -1;
  if (left.build.length > 0 && right.build.length === 0) return 1;
  for (let at = 0; ; at += 1) {
    const one = left.build[at];
    const two = right.build[at];
    if (one === undefined && two === undefined) return 0;
    if (two === undefined) return 1;
    if (one === undefined) return -1;
    const step = compareIdentifiers(one, two);
    if (step !== 0) return step;
  }
}

export const sort = (list, options) => [...list].sort((a, b) => compareBuild(a, b, options));
export const rsort = (list, options) => [...list].sort((a, b) => compareBuild(b, a, options));

export const eq = (a, b, options) => compare(a, b, options) === 0;
export const neq = (a, b, options) => compare(a, b, options) !== 0;
export const gt = (a, b, options) => compare(a, b, options) > 0;
export const gte = (a, b, options) => compare(a, b, options) >= 0;
export const lt = (a, b, options) => compare(a, b, options) < 0;
export const lte = (a, b, options) => compare(a, b, options) <= 0;

/** The comparison an operator names. An unknown operator is our caller's bug. */
export function cmp(a, operator, b, options) {
  switch (operator) {
    case '===': return (isVersion(a) ? a.version : a) === (isVersion(b) ? b.version : b);
    case '!==': return (isVersion(a) ? a.version : a) !== (isVersion(b) ? b.version : b);
    case '': case '=': case '==': return eq(a, b, options);
    case '!=': return neq(a, b, options);
    case '>': return gt(a, b, options);
    case '>=': return gte(a, b, options);
    case '<': return lt(a, b, options);
    case '<=': return lte(a, b, options);
    default: return fail('INVALID_OPERATOR', `unknown operator ${JSON.stringify(operator)}`, { operator });
  }
}

// -- reading a range ---------------------------------------------------------
//
// The range grammar is not part of SemVer 2.0.0. It belongs to the reference
// package, and it is bigger than the version grammar: comparator sets joined by
// `||`, hyphen ranges, carets, tildes, x-ranges, partial versions, and operators
// that may be separated from their version by a space. Everything below expands
// one of those forms into plain comparators, because a comparator is the only
// thing `satisfies` needs to test against.
//
// The `-0` that keeps appearing on upper bounds is not decoration. `<2.0.0` must
// exclude `2.0.0-beta`, since a prerelease of 2.0.0 is not what the author of
// `^1.2.3` asked for; `<2.0.0-0` says that, because `-0` is the lowest possible
// prerelease. Getting this wrong is how a caret range starts installing betas.

/** A comparator: an operator and a version, or the empty operator meaning "any". */
const comparator = (operator, version) => Object.freeze({ operator, version });

const ANY = comparator('', null);

/** A version assembled from numbers rather than parsed from text. */
function versionOf(major, minor, patch, prerelease = []) {
  return makeVersion(major, minor, patch, prerelease, [], '');
}

/** The comparator no version can satisfy, used for a range that cannot match. */
const NONE = comparator('<', versionOf(0, 0, 0, [0]));

const isAny = (item) => item.operator === '' && item.version === null;
const isNone = (item) => item.operator === '<' && item.version !== null
  && item.version.major === 0 && item.version.minor === 0 && item.version.patch === 0
  && item.version.prerelease.length === 1 && item.version.prerelease[0] === 0;

/**
 * A partial version: any component may be a wildcard or simply absent, and a
 * wildcard blanks everything to its right, so `1.x.7` is exactly `1.x`. The
 * prerelease and build tails are only legal after a patch, which is the reference
 * grammar's rule and not an accident.
 */
function readPartial(text, options) {
  const loose = options.loose === true;
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 118 || code === 61 || isSpace(code)) at += 1;
    else break;
  }
  const blank = { major: null, minor: null, patch: null, prerelease: [], build: [] };
  if (at >= text.length) {
    // Padding with nothing behind it is not the wildcard. `==`, `=v` and a lone
    // `v` are all invalid ranges, and they get here because the padding was
    // stripped and left an empty string; treating that as `x` would quietly turn
    // a typo into "any version at all", which is the most expensive way to be
    // wrong about a dependency range.
    fail('INVALID_RANGE', `${JSON.stringify(text)} has no version in it`);
  }
  const component = (what) => {
    const code = text.charCodeAt(at);
    if (code === 120 || code === 88 || code === 42) {
      at += 1;
      return null;
    }
    const read = readNumber(text, at, loose, what);
    at = read.at;
    return read.value;
  };
  const found = { ...blank };
  found.major = component('the major version');
  if (text.charCodeAt(at) === 46) {
    at += 1;
    found.minor = component('the minor version');
    if (text.charCodeAt(at) === 46) {
      at += 1;
      found.patch = component('the patch version');
      if (text.charCodeAt(at) === 45) {
        const read = readIdentifiers(text, at + 1, { numeric: true, loose });
        found.prerelease = read.parts;
        at = read.at;
      }
      if (text.charCodeAt(at) === 43) {
        const read = readIdentifiers(text, at + 1, { numeric: false, loose });
        found.build = read.parts;
        at = read.at;
      }
    }
  }
  if (at !== text.length) {
    fail('INVALID_RANGE', `unexpected ${JSON.stringify(text.slice(at))} at offset ${at}`, { offset: at });
  }
  // A wildcard blanks what follows it, but only a wildcard may follow it: `1.x.x` is
  // `1.x`, while `1.x.3` is not a range at all. The number after the wildcard cannot
  // be honoured and cannot be ignored either, because ignoring it would read
  // `1.x.3` as "any 1", which is not what whoever typed it meant.
  if (found.major === null && (found.minor !== null || found.patch !== null)) {
    fail('INVALID_RANGE', `${JSON.stringify(text)} has a version after a wildcard`);
  }
  if (found.minor === null && found.patch !== null) {
    fail('INVALID_RANGE', `${JSON.stringify(text)} has a version after a wildcard`);
  }
  if (found.major === null) return blank;
  if (found.minor === null) return { ...blank, major: found.major };
  if (found.patch === null) return { ...blank, major: found.major, minor: found.minor };
  return found;
}

/** The lower-bound prerelease padding: `-0` only when prereleases are wanted. */
const pad = (options) => (options.includePrerelease === true ? [0] : []);

/**
 * `^1.2.3` — "compatible with", meaning: do not change the leftmost non-zero
 * component. The zero cases are the interesting ones, because before 1.0.0 the
 * meaning of each position shifts left: `^0.2.3` allows patches of 0.2 and not
 * 0.3, and `^0.0.3` allows nothing but 0.0.3.
 */
function expandCaret(partial, options) {
  const { major, minor, patch, prerelease } = partial;
  const z = pad(options);
  if (major === null) return [ANY];
  if (minor === null) {
    return [comparator('>=', versionOf(major, 0, 0, z)), comparator('<', versionOf(major + 1, 0, 0, [0]))];
  }
  if (patch === null) {
    const upper = major === 0
      ? versionOf(0, minor + 1, 0, [0])
      : versionOf(major + 1, 0, 0, [0]);
    return [comparator('>=', versionOf(major, minor, 0, z)), comparator('<', upper)];
  }
  let upper;
  if (major !== 0) upper = versionOf(major + 1, 0, 0, [0]);
  else if (minor !== 0) upper = versionOf(0, minor + 1, 0, [0]);
  else upper = versionOf(0, 0, patch + 1, [0]);
  return [comparator('>=', versionOf(major, minor, patch, [...prerelease])), comparator('<', upper)];
}

/**
 * `~1.2.3` — "approximately", meaning: patches only if a minor was given, minors
 * if it was not. Unlike the caret it does not care whether the major is zero,
 * which is the whole reason both operators exist.
 */
function expandTilde(partial, options) {
  const { major, minor, patch, prerelease } = partial;
  const z = pad(options);
  if (major === null) return [ANY];
  if (minor === null) {
    return [comparator('>=', versionOf(major, 0, 0, z)), comparator('<', versionOf(major + 1, 0, 0, [0]))];
  }
  const upper = comparator('<', versionOf(major, minor + 1, 0, [0]));
  if (patch === null) return [comparator('>=', versionOf(major, minor, 0, z)), upper];
  return [comparator('>=', versionOf(major, minor, patch, [...prerelease])), upper];
}

/**
 * A wildcard or a partial version, with or without an operator. This is the
 * fiddliest of the three because the operator changes what the missing components
 * mean: `<1.2` is `<1.2.0`, but `<=1.2` is `<1.3.0`, and `>1` is `>=2.0.0` — an
 * operator against a partial version has to be widened to the whole range of
 * versions the partial could have named.
 */
function expandPartial(operator, partial, options) {
  const { major, minor, patch, prerelease } = partial;
  const anyX = major === null || minor === null || patch === null;
  let op = operator === '=' && anyX ? '' : operator;
  let tail = pad(options);
  if (major === null) {
    // `>x` and `<x` ask for versions above or below every version there is.
    if (op === '>' || op === '<') return [NONE];
    return [ANY];
  }
  if (!anyX) return [comparator(op === '' ? '=' : op, versionOf(major, minor, patch, [...prerelease]))];
  if (op !== '') {
    let high = major;
    let mid = minor ?? 0;
    if (op === '>') {
      op = '>=';
      if (minor === null) high += 1;
      else mid += 1;
    } else if (op === '<=') {
      op = '<';
      if (minor === null) high += 1;
      else mid += 1;
    }
    if (op === '<') tail = [0];
    return [comparator(op, versionOf(high, mid, 0, tail))];
  }
  if (minor === null) {
    return [comparator('>=', versionOf(major, 0, 0, tail)), comparator('<', versionOf(major + 1, 0, 0, [0]))];
  }
  return [comparator('>=', versionOf(major, minor, 0, tail)), comparator('<', versionOf(major, minor + 1, 0, [0]))];
}

/**
 * `1.2.3 - 2.3.4` — an inclusive interval, except that inclusive of a partial
 * upper bound means "everything that partial covers": `1.2.3 - 2.3` ends below
 * 2.4.0, not at 2.3.0.
 */
function expandHyphen(from, to, options) {
  const z = pad(options);
  const list = [];
  if (from.major !== null) {
    if (from.minor === null) list.push(comparator('>=', versionOf(from.major, 0, 0, z)));
    else if (from.patch === null) list.push(comparator('>=', versionOf(from.major, from.minor, 0, z)));
    else if (from.prerelease.length > 0) {
      list.push(comparator('>=', versionOf(from.major, from.minor, from.patch, [...from.prerelease])));
    } else list.push(comparator('>=', versionOf(from.major, from.minor, from.patch, z)));
  }
  if (to.major !== null) {
    if (to.minor === null) list.push(comparator('<', versionOf(to.major + 1, 0, 0, [0])));
    else if (to.patch === null) list.push(comparator('<', versionOf(to.major, to.minor + 1, 0, [0])));
    else if (to.prerelease.length > 0) {
      list.push(comparator('<=', versionOf(to.major, to.minor, to.patch, [...to.prerelease])));
    } else if (options.includePrerelease === true) {
      list.push(comparator('<', versionOf(to.major, to.minor, to.patch + 1, [0])));
    } else list.push(comparator('<=', versionOf(to.major, to.minor, to.patch)));
  }
  return list.length === 0 ? [ANY] : list;
}

// -- assembling a range ------------------------------------------------------

/** Whitespace as the range grammar means it, which is more than a version allows. */
const isBlank = (code) => code === 32 || code === 9 || code === 10 || code === 13
  || code === 11 || code === 12;

/** Split on runs of whitespace. The tokens are what the reference package calls comparators. */
function words(text) {
  const list = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && isBlank(text.charCodeAt(at))) at += 1;
    const start = at;
    while (at < text.length && !isBlank(text.charCodeAt(at))) at += 1;
    if (at > start) list.push(text.slice(start, at));
  }
  return list;
}

/** The padding a version part tolerates in a range: `v`, `=`, and whitespace. */
const isPadding = (code) => code === 118 || code === 61 || isBlank(code);

/** `x`, `X` and `*`, the three spellings of "any component". */
const isXWildcard = (code) => code === 120 || code === 88 || code === 42;

/**
 * Where the version text beginning at `at` ends, or -1 if none begins there. This
 * is the shape the reference package's range grammar calls a *plain* version: a
 * partial version with wildcards allowed, padded by `v`, `=` and — this is the part
 * that surprises — whitespace, which is why `> = 1.2.3` behaves so strangely. The
 * scan stops at the last complete component, the way a backtracking matcher would,
 * so a trailing dot is not counted as part of the version.
 */
function scanVersionText(text, at) {
  let cursor = at;
  while (cursor < text.length && isPadding(text.charCodeAt(cursor))) cursor += 1;
  const component = () => {
    if (cursor < text.length && isXWildcard(text.charCodeAt(cursor))) { cursor += 1; return true; }
    const from = cursor;
    while (cursor < text.length && isDigit(text.charCodeAt(cursor))) cursor += 1;
    return cursor > from;
  };
  if (!component()) return -1;
  let end = cursor;
  let parts = 1;
  while (parts < 3 && text.charCodeAt(cursor) === 46) {
    cursor += 1;
    if (!component()) return end;
    end = cursor;
    parts += 1;
  }
  if (parts < 3) return end;
  for (const marker of [45, 43]) {
    if (text.charCodeAt(cursor) !== marker) continue;
    let run = cursor + 1;
    while (run < text.length && (isIdentifier(text.charCodeAt(run)) || text.charCodeAt(run) === 46)) run += 1;
    while (run > cursor + 1 && text.charCodeAt(run - 1) === 46) run -= 1;
    if (run > cursor + 1) { cursor = run; end = run; }
  }
  return end;
}

/**
 * The three whitespace passes the reference package makes over a comparator set,
 * in its order: comparators, then tildes, then carets. They look like tidying and
 * they are not — they decide what is a range at all, and they are not the same
 * pass twice.
 *
 * A comparator only loses the space after it when a version actually follows, and
 * that version may itself begin with padding — `v`, `=` *and whitespace* — which
 * is why `> = 1.2.3` ends up as the two tokens `>=` and `1.2.3`: the space after
 * the `=` was swallowed into the version text, leaving the operator stranded, to
 * be dropped in loose mode and to be fatal in strict.
 *
 * A tilde or caret loses the space unconditionally, with no version required. That
 * is the whole reason `^ ~1.2.3` is invalid rather than "an ignorable caret next to
 * a tilde range": the caret glues to whatever follows and takes it down with it. It
 * is also why `~ >=1.2.3` is a tilde range in both modes — `~>` is a spelling of
 * `~`, so the `>` is simply dropped — while `^ > 1.2.3` is invalid, because the
 * caret has no such spelling and `^>1.2.3` is nothing at all.
 *
 * None of that follows from any principle. Every row of it is pinned in
 * `tests/vectors/semver/ranges.json` against the package this replaces.
 */
function trimComparators(text) {
  const operators = ['<=', '>=', '<', '>', '='];
  let out = '';
  let at = 0;
  while (at < text.length) {
    const found = operators.find((operator) => text.startsWith(operator, at));
    if (found === undefined) { out += text[at]; at += 1; continue; }
    let cursor = at + found.length;
    while (cursor < text.length && isBlank(text.charCodeAt(cursor))) cursor += 1;
    const end = scanVersionText(text, cursor);
    if (end === -1) { out += text[at]; at += 1; continue; }
    out += found + text.slice(cursor, end);
    at = end;
  }
  return out;
}

/** `~ x` and `~> x` become `~x`; `^ x` becomes `^x`. Whatever x is. */
function trimLoneOperator(text, spellings, canonical) {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const found = spellings.find((spelling) => text.startsWith(spelling, at));
    let cursor = found === undefined ? -1 : at + found.length;
    if (found === undefined || cursor >= text.length || !isBlank(text.charCodeAt(cursor))) {
      out += text[at];
      at += 1;
      continue;
    }
    while (cursor < text.length && isBlank(text.charCodeAt(cursor))) cursor += 1;
    out += canonical;
    at = cursor;
  }
  return out;
}

const trimOperators = (text) => trimLoneOperator(
  trimLoneOperator(trimComparators(text), ['~>', '~'], '~'), ['^'], '^',
);

/** The operator at the front of a comparator, if any. `~>` is a spelling of `~`. */
function readOperator(token) {
  const first = token.charCodeAt(0);
  if (first === 94) return { operator: '^', rest: token.slice(1) };
  if (first === 126) {
    return token.charCodeAt(1) === 62
      ? { operator: '~', rest: token.slice(2) }
      : { operator: '~', rest: token.slice(1) };
  }
  if (first === 60 || first === 62) {
    return token.charCodeAt(1) === 61
      ? { operator: `${token[0]}=`, rest: token.slice(2) }
      : { operator: token[0], rest: token.slice(1) };
  }
  if (first === 61) return { operator: '=', rest: token.slice(1) };
  return { operator: '', rest: token };
}

/** True if the version part is prefixed by an `=`, which only partials may be. */
function hasEqualsPrefix(text) {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 61) return true;
    if (code !== 118 && !isSpace(code)) return false;
  }
  return false;
}

/** One comparator token, expanded into plain comparators. */
function expandToken(token, options) {
  const { operator, rest } = readOperator(token);
  if (operator !== '' && rest.length === 0) {
    fail('INVALID_RANGE', `${JSON.stringify(token)} is an operator with no version`);
  }
  const partial = readPartial(rest, options);
  const full = partial.major !== null && partial.minor !== null && partial.patch !== null;
  // `==1.2.3` is two operators and strict mode refuses it, but only here. A caret or
  // tilde reads its version through the x-range grammar, which tolerates `v`, `=`
  // and whitespace padding in *both* modes, so `^ =v1.2.3` is `>=1.2.3 <2.0.0-0`
  // strictly as well as loosely. Applying this check to all three operators is the
  // obvious mistake and it costs a handful of real ranges.
  const plain = operator !== '^' && operator !== '~';
  if (plain && full && options.loose !== true && hasEqualsPrefix(rest)) {
    fail('INVALID_RANGE', `${JSON.stringify(token)} has more than one operator`);
  }
  if (operator === '^') return expandCaret(partial, options);
  if (operator === '~') return expandTilde(partial, options);
  return expandPartial(operator, partial, options);
}

const formatComparator = (item) => {
  if (isAny(item)) return '';
  return item.operator === '=' ? item.version.version : `${item.operator}${item.version.version}`;
};

/** `>=0.0.0` allows everything, so the reference package erases it. Verbatim. */
const isEverything = (item, incPre) => item.operator === '>=' && item.version !== null
  && item.version.major === 0 && item.version.minor === 0 && item.version.patch === 0
  && (incPre
    ? item.version.prerelease.length === 1 && item.version.prerelease[0] === 0
    : item.version.prerelease.length === 0);

/**
 * Tidy one comparator set: a set containing the impossible comparator *is* the
 * impossible comparator, duplicates collapse, and "any" is dropped as soon as
 * anything narrower is present, since an unbounded comparator adds nothing to a
 * conjunction.
 */
function finishSet(list, options) {
  const incPre = options.includePrerelease === true;
  const kept = [];
  const seen = new Set();
  for (const item of list) {
    if (isNone(item)) return [NONE];
    if (isEverything(item, incPre)) continue;
    const key = formatComparator(item);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  if (kept.length === 0) return [ANY];
  if (kept.length === 1) return kept;
  const narrowed = kept.filter((item) => !isAny(item));
  return narrowed.length === 0 ? [ANY] : narrowed;
}

/**
 * A hyphen range, or null if this is not one. The reference package recognises a
 * hyphen range with a single regular expression over the whole comparator set, so
 * `>1.2.3 - 2.0.0` is *not* a hyphen range — the left side is not a bare partial
 * version. When the shape does not fit, the tokens fall through to the ordinary
 * path, where the lone `-` is a comparator in its own right: an error in strict
 * mode, and discarded in loose mode.
 */
function readHyphenSet(tokens, options) {
  try {
    const from = readPartial(tokens[0], options);
    const to = readPartial(tokens[2], options);
    return expandHyphen(from, to, options);
  } catch (error) {
    if (error instanceof SemverError) return null;
    throw error;
  }
}

/**
 * One comparator set: the `&&` half of the grammar, whitespace-separated.
 *
 * Loose mode discards a comparator it cannot read instead of rejecting the whole
 * range, which is the one loose behaviour that is not merely a relaxed grammar:
 * `1.2.3 - garbage` is the range `1.2.3` and `> = 1.2.3` is the range `1.2.3`.
 * It reads like a bug and it is a bug, but real lockfiles and real registry
 * metadata are full of ranges that only resolve because of it, so a replacement
 * that refused them would break the projects it is meant to serve. Returns null
 * when every comparator was discarded, which is a set the range must forget.
 */
function readComparatorSet(text, options) {
  const loose = options.loose === true;
  const tokens = words(trimOperators(text));
  if (tokens.length === 0) return [ANY];
  if (tokens.length === 3 && tokens[1] === '-') {
    const hyphen = readHyphenSet(tokens, options);
    if (hyphen !== null) return finishSet(hyphen, options);
  }
  const list = [];
  let discarded = 0;
  for (const token of tokens) {
    try {
      list.push(...expandToken(token, options));
    } catch (error) {
      if (!loose || !(error instanceof SemverError)) throw error;
      discarded += 1;
    }
  }
  if (list.length === 0 && discarded > 0) return null;
  return finishSet(list, options);
}

/** True if the value is already one of our parsed ranges. */
const isRange = (value) => value !== null && typeof value === 'object'
  && Array.isArray(value.set) && typeof value.range === 'string';

function makeRange(raw, sets) {
  const set = Object.freeze(sets.map((one) => Object.freeze([...one])));
  const range = set.map((one) => one.map(formatComparator).join(' ').trim()).join('||').trim();
  return sealed({ raw, range, set }, range);
}

/**
 * A whole range: comparator sets joined by `||`, which is a union, so the tidying
 * runs the other way round from a set. A union with "everything" is everything,
 * and a union with the impossible set can forget the impossible set — unless every
 * set is impossible, in which case the range is honestly impossible and says so.
 */
function readRange(input, options = {}) {
  if (isRange(input)) return input;
  if (!isVersion(input) && typeof input !== 'string') {
    fail('INVALID_RANGE', `a range must be a string, not ${input === null ? 'null' : typeof input}`);
  }
  const raw = isVersion(input) ? input.version : input;
  const parts = raw.trim().split('||');
  const read = parts.map((part) => readComparatorSet(part.trim(), options));
  const sets = read.filter((one) => one !== null);
  if (sets.length === 0) {
    fail('INVALID_RANGE', `no readable comparator in ${JSON.stringify(raw)}`);
  }
  if (sets.length === 1) return makeRange(raw, sets);
  const possible = sets.filter((one) => !(one.length === 1 && isNone(one[0])));
  if (possible.length === 0) return makeRange(raw, [sets[0]]);
  if (possible.length > 1) {
    const everything = possible.find((one) => one.length === 1 && isAny(one[0]));
    if (everything !== undefined) return makeRange(raw, [everything]);
  }
  return makeRange(raw, possible);
}

/** The parsed range, or null if it cannot be read. Never throws. */
export function parseRange(input, options) {
  try {
    return readRange(input, settle(options));
  } catch (error) {
    if (error instanceof SemverError) return null;
    throw error;
  }
}

/** The range rewritten in normal form, or null. `*` for a range that allows anything. */
export function validRange(input, options) {
  const range = parseRange(input, options);
  if (range === null) return null;
  return range.range === '' ? '*' : range.range;
}

/**
 * The range as arrays of comparator strings, one array per set. The reference
 * package's `toComparators` shape, kept because tools consume it — including the
 * detail that an unbounded set arrives as a single empty string rather than as an
 * empty array.
 */
export function toComparators(input, options) {
  const range = readRange(input, settle(options));
  return range.set.map((one) => one.map(formatComparator).join(' ').trim().split(' '));
}

// -- testing a version against a range ---------------------------------------

function testComparator(version, item, options) {
  if (isAny(item)) return true;
  return cmp(version, item.operator, item.version, options);
}

/**
 * One comparator set, plus the rule that surprises everybody: a prerelease
 * satisfies a set only if some comparator in that set carries a prerelease on the
 * *same* major.minor.patch. It is why `1.2.3-beta` does not satisfy `*` or
 * `>=1.0.0`, and why it does satisfy `>=1.2.3-alpha`.
 *
 * The rule is not pedantry. A prerelease is an opt-in: whoever published
 * `2.0.0-rc.1` does not want it installed by everyone who wrote `>=1.0.0`, and
 * whoever wrote `>=1.2.3-alpha` has said out loud that they accept prereleases of
 * that one version. `includePrerelease` turns the rule off wholesale.
 */
function testSet(set, version, options) {
  for (const item of set) if (!testComparator(version, item, options)) return false;
  if (version.prerelease.length === 0 || options.includePrerelease === true) return true;
  for (const item of set) {
    if (isAny(item)) continue;
    const allowed = item.version;
    if (allowed.prerelease.length === 0) continue;
    if (allowed.major === version.major && allowed.minor === version.minor
      && allowed.patch === version.patch) return true;
  }
  return false;
}

/**
 * Does the version satisfy the range? Unreadable input answers false rather than
 * throwing, because that is what the reference package does and because this is
 * the function that appears inside `if`.
 */
export function satisfies(version, range, options) {
  const settled = settle(options);
  let parsed;
  let subject;
  try {
    parsed = readRange(range, settled);
    subject = readVersion(version, settled);
  } catch (error) {
    if (error instanceof SemverError) return false;
    throw error;
  }
  for (const set of parsed.set) if (testSet(set, subject, settled)) return true;
  return false;
}

/** The highest of the list that satisfies the range, as the caller wrote it. */
export function maxSatisfying(versions, range, options) {
  const settled = settle(options);
  let best = null;
  let bestParsed = null;
  const parsed = parseRange(range, settled);
  if (parsed === null) return null;
  for (const candidate of versions) {
    if (!satisfies(candidate, parsed, settled)) continue;
    if (best === null || compare(bestParsed, candidate, settled) === -1) {
      best = candidate;
      bestParsed = readVersion(candidate, settled);
    }
  }
  return best;
}

/** The lowest of the list that satisfies the range. */
export function minSatisfying(versions, range, options) {
  const settled = settle(options);
  let best = null;
  let bestParsed = null;
  const parsed = parseRange(range, settled);
  if (parsed === null) return null;
  for (const candidate of versions) {
    if (!satisfies(candidate, parsed, settled)) continue;
    if (best === null || compare(bestParsed, candidate, settled) === 1) {
      best = candidate;
      bestParsed = readVersion(candidate, settled);
    }
  }
  return best;
}

/**
 * The lowest version the range would accept, invented rather than chosen from a
 * list: the answer to "what will a fresh install resolve to at the floor". Null if
 * the range accepts nothing at all.
 */
export function minVersion(range, options) {
  const settled = settle(options);
  const parsed = readRange(range, settled);
  const zero = versionOf(0, 0, 0);
  if (parsed.set.some((set) => testSet(set, zero, settled))) return zero;
  const zeroPre = versionOf(0, 0, 0, [0]);
  if (parsed.set.some((set) => testSet(set, zeroPre, settled))) return zeroPre;
  let lowest = null;
  for (const set of parsed.set) {
    let floor = null;
    for (const item of set) {
      if (isAny(item)) continue;
      let bound = item.version;
      if (item.operator === '>') {
        // The lowest version above a bound is the next one up, and for a
        // prerelease that is a prerelease of itself: above `1.2.3-a` sits
        // `1.2.3-a.0`, not `1.2.4`.
        bound = bound.prerelease.length === 0
          ? versionOf(bound.major, bound.minor, bound.patch + 1)
          : versionOf(bound.major, bound.minor, bound.patch, [...bound.prerelease, 0]);
      } else if (item.operator === '<' || item.operator === '<=') {
        continue;
      }
      if (floor === null || compare(bound, floor, settled) === 1) floor = bound;
    }
    if (floor !== null && (lowest === null || compare(lowest, floor, settled) === 1)) lowest = floor;
  }
  if (lowest !== null && parsed.set.some((set) => testSet(set, lowest, settled))) return lowest;
  return null;
}

/**
 * Is the version wholly above (`'>'`) or wholly below (`'<'`) the range? Not the
 * same question as `!satisfies`: `1.5.0` fails `1.0.0 || 2.0.0` without being
 * outside it in either direction, which is exactly the case a caller asking "is my
 * version too old" needs to be told apart from "your version is unlisted".
 */
export function outside(version, range, hilo, options) {
  const settled = settle(options);
  const subject = readVersion(version, settled);
  const parsed = readRange(range, settled);
  let further;
  let atMostEdge;
  let beforeEdge;
  let mark;
  let markEqual;
  if (hilo === '>') {
    further = gt; atMostEdge = lte; beforeEdge = lt; mark = '>'; markEqual = '>=';
  } else if (hilo === '<') {
    further = lt; atMostEdge = gte; beforeEdge = gt; mark = '<'; markEqual = '<=';
  } else {
    return fail('INVALID_OPERATOR', 'the direction must be ">" or "<"', { hilo });
  }
  if (satisfies(subject, parsed, settled)) return false;
  for (const set of parsed.set) {
    let high = null;
    let low = null;
    for (const raw of set) {
      const item = isAny(raw) ? comparator('>=', versionOf(0, 0, 0)) : raw;
      if (high === null) high = item;
      if (low === null) low = item;
      if (further(item.version, high.version, settled)) high = item;
      else if (beforeEdge(item.version, low.version, settled)) low = item;
    }
    // The set is bounded in the direction we are asking about, so the version
    // cannot be beyond it.
    if (high.operator === mark || high.operator === markEqual) return false;
    const exact = low.operator === '' || low.operator === '=';
    if ((exact || low.operator === mark) && atMostEdge(subject, low.version, settled)) return false;
    if (low.operator === markEqual && beforeEdge(subject, low.version, settled)) return false;
  }
  return true;
}

/** Above every version the range allows. */
export const gtr = (version, range, options) => outside(version, range, '>', options);

/** Below every version the range allows. */
export const ltr = (version, range, options) => outside(version, range, '<', options);

// -- making a new version out of an old one -----------------------------------

/** A prerelease identifier, as `inc` accepts it. Throws if it is not one. */
function checkIdentifier(identifier, loose) {
  const text = String(identifier);
  const read = readIdentifiers(text, 0, { numeric: true, loose });
  if (read.at !== text.length) {
    fail('INVALID_IDENTIFIER', `${JSON.stringify(text)} is not a prerelease identifier`);
  }
}

/**
 * The release types, applied to an immutable version. The reference package
 * mutates a version in place and calls itself recursively; the sequence is
 * reproduced here move for move, because the order of those moves is observable.
 *
 * The rule worth knowing: a prerelease absorbs the bump it is already carrying.
 * `1.0.0-alpha` incremented by major is `1.0.0`, not `2.0.0`, because `1.0.0-alpha`
 * was already on its way to `1.0.0`. But `1.1.0-alpha` by major is `2.0.0`, since a
 * non-zero minor means it was never heading for a major release at all.
 */
function applyInc(start, release, identifier, identifierBase, options) {
  if (typeof release !== 'string') fail('INVALID_RELEASE', 'a release type must be a string');
  const state = {
    major: start.major,
    minor: start.minor,
    patch: start.patch,
    prerelease: [...start.prerelease],
    build: [...start.build],
  };
  if (release.startsWith('pre')) {
    if (!identifier && identifierBase === false) {
      fail('INVALID_IDENTIFIER', 'the identifier is empty and no numeric base was allowed');
    }
    if (identifier) checkIdentifier(identifier, options.loose === true);
  }
  const base = Number(identifierBase) ? 1 : 0;
  const bumpPrerelease = () => {
    if (state.prerelease.length === 0) {
      state.prerelease = [base];
    } else {
      let at = state.prerelease.length - 1;
      let bumped = false;
      while (at >= 0) {
        if (typeof state.prerelease[at] === 'number') {
          state.prerelease[at] += 1;
          bumped = true;
          break;
        }
        at -= 1;
      }
      if (!bumped) {
        if (identifier === state.prerelease.join('.') && identifierBase === false) {
          fail('INVALID_IDENTIFIER', `${JSON.stringify(identifier)} is already the whole prerelease`);
        }
        state.prerelease.push(base);
      }
    }
    if (identifier) {
      const next = identifierBase === false ? [identifier] : [identifier, base];
      if (compareIdentifiers(state.prerelease[0], identifier) === 0) {
        if (typeof state.prerelease[1] !== 'number') state.prerelease = next;
      } else {
        state.prerelease = next;
      }
    }
  };
  const bumpPatch = () => {
    if (state.prerelease.length === 0) state.patch += 1;
    state.prerelease = [];
  };
  switch (release) {
    case 'premajor':
      state.prerelease = [];
      state.patch = 0;
      state.minor = 0;
      state.major += 1;
      bumpPrerelease();
      break;
    case 'preminor':
      state.prerelease = [];
      state.patch = 0;
      state.minor += 1;
      bumpPrerelease();
      break;
    case 'prepatch':
      state.prerelease = [];
      bumpPatch();
      bumpPrerelease();
      break;
    case 'prerelease':
      if (state.prerelease.length === 0) bumpPatch();
      bumpPrerelease();
      break;
    case 'pre':
      bumpPrerelease();
      break;
    case 'release':
      if (state.prerelease.length === 0) {
        fail('NOT_A_PRERELEASE', `${start.version} is not a prerelease`);
      }
      state.prerelease = [];
      break;
    case 'major':
      if (state.minor !== 0 || state.patch !== 0 || state.prerelease.length === 0) state.major += 1;
      state.minor = 0;
      state.patch = 0;
      state.prerelease = [];
      break;
    case 'minor':
      if (state.patch !== 0 || state.prerelease.length === 0) state.minor += 1;
      state.patch = 0;
      state.prerelease = [];
      break;
    case 'patch':
      bumpPatch();
      break;
    default:
      fail('INVALID_RELEASE', `unknown release type ${JSON.stringify(release)}`, { release });
  }
  return makeVersion(state.major, state.minor, state.patch, state.prerelease, state.build, '');
}

/**
 * The incremented version as a string, or null if anything at all went wrong.
 * Null rather than a throw is the reference package's choice and a strange one,
 * but a rewritten call site that expected null must keep getting null.
 *
 * `options` may be the identifier instead, which is also the reference package's
 * doing: `inc('1.2.3', 'prerelease', 'beta')` has to keep working.
 */
export function inc(version, release, options, identifier, identifierBase) {
  let settled = options;
  let name = identifier;
  let numericBase = identifierBase;
  if (typeof options === 'string') {
    numericBase = identifier;
    name = options;
    settled = undefined;
  }
  const opts = settle(settled);
  try {
    const start = readVersion(isVersion(version) ? version.version : version, opts);
    return applyInc(start, release, name, numericBase, opts).version;
  } catch (error) {
    if (error instanceof SemverError) return null;
    throw error;
  }
}

/**
 * The release type that separates two versions: what you would have had to pass
 * to `inc` to get from the lower to the higher. Null if they are the same version.
 *
 * The awkward case is a prerelease on the low side and a release on the high side.
 * `1.0.0-1` to `1.0.0` is not a "prerelease" step and it is not a patch either —
 * it is whatever the release itself represents, which is read off the high
 * version's own components. Unlike most of this file it throws on bad input,
 * matching the reference package.
 */
export function diff(one, other) {
  const left = readVersion(one, {});
  const right = readVersion(other, {});
  const order = compare(left, right, {});
  if (order === 0) return null;
  const high = order > 0 ? left : right;
  const low = order > 0 ? right : left;
  if (low.prerelease.length > 0 && high.prerelease.length === 0) {
    // Leaving a prerelease behind is a major step unless the prerelease was for a
    // release that had somewhere smaller to go: `1.0.0-rc` to `1.0.0` is a major
    // change, because the prerelease was never 1.0.0. Where the two share their
    // main triple the answer comes from what the prerelease was *for* — a
    // prerelease of `1.2.0` is a minor, of `1.2.3` a patch. Where they do not
    // share it, the ordinary comparison below is already right, and the special
    // case must not pre-empt it: `0.0.1-0` to `1.2.3` is a major, not a patch.
    if (low.patch === 0 && low.minor === 0) return 'major';
    if (compareMain(low, high) === 0) {
      return low.minor !== 0 && low.patch === 0 ? 'minor' : 'patch';
    }
  }
  const prefix = high.prerelease.length > 0 ? 'pre' : '';
  if (left.major !== right.major) return `${prefix}major`;
  if (left.minor !== right.minor) return `${prefix}minor`;
  if (left.patch !== right.patch) return `${prefix}patch`;
  return 'prerelease';
}

// -- pulling a version out of arbitrary text ----------------------------------
//
// This is the one place a regular expression would have been genuinely
// convenient, and it is also the one place where the reference package's regular
// expression has to be read three times before it can be believed. What follows is
// a scanner that does the same job in the same order.

/** Digit runs longer than this cannot be compared, so they are not versions. */
const MAX_COERCE_LENGTH = 16;

/** The end of the maximal digit run at `at`, or null if there is not one. */
function digitRun(text, at) {
  let end = at;
  while (end < text.length && isDigit(text.charCodeAt(end))) end += 1;
  return end === at ? null : end;
}

/**
 * Dot-separated identifier parts, stopping at the first part the grammar refuses.
 * Stopping rather than failing is what the reference package's backtracking does:
 * `1.2.3-a.01` coerces with the prerelease `a`, because `01` is not an identifier
 * and the group simply ends before it.
 */
function coerceIdentifiers(text, from, strictNumeric) {
  const parts = [];
  let cursor = from;
  let end = from;
  for (;;) {
    let stop = cursor;
    while (stop < text.length && isIdentifier(text.charCodeAt(stop))) stop += 1;
    if (stop === cursor) break;
    const part = text.slice(cursor, stop);
    if (strictNumeric && isNumeric(part) && part.length > 1 && part.charCodeAt(0) === 48) break;
    parts.push(part);
    end = stop;
    if (stop < text.length && text.charCodeAt(stop) === 46) {
      cursor = stop + 1;
      continue;
    }
    break;
  }
  return parts.length === 0 ? null : { parts, at: end };
}

/**
 * The leftmost version-shaped run at or after `from`. A digit run only counts if
 * it starts at the beginning or after a non-digit, so `1.2.3.4` offers `1.2.3` and
 * not `2.3.4`; that is what makes right-to-left coercion a search rather than a
 * reversal.
 */
function findCoercible(text, from, incPre) {
  for (let at = from; at < text.length; at += 1) {
    let digits;
    if (at === 0 && isDigit(text.charCodeAt(0))) digits = 0;
    else if (!isDigit(text.charCodeAt(at))) digits = at + 1;
    else continue;
    const majorEnd = digitRun(text, digits);
    if (majorEnd === null || majorEnd - digits > MAX_COERCE_LENGTH) continue;
    const found = {
      start: at,
      majorEnd,
      major: text.slice(digits, majorEnd),
      minor: '0',
      patch: '0',
      prerelease: [],
      build: [],
      end: majorEnd,
    };
    let cursor = majorEnd;
    if (text.charCodeAt(cursor) === 46) {
      const minorEnd = digitRun(text, cursor + 1);
      if (minorEnd !== null && minorEnd - cursor - 1 <= MAX_COERCE_LENGTH) {
        found.minor = text.slice(cursor + 1, minorEnd);
        cursor = minorEnd;
        if (text.charCodeAt(cursor) === 46) {
          const patchEnd = digitRun(text, cursor + 1);
          if (patchEnd !== null && patchEnd - cursor - 1 <= MAX_COERCE_LENGTH) {
            found.patch = text.slice(cursor + 1, patchEnd);
            cursor = patchEnd;
          }
        }
      }
    }
    if (incPre) {
      if (text.charCodeAt(cursor) === 45) {
        const ids = coerceIdentifiers(text, cursor + 1, true);
        if (ids !== null) {
          found.prerelease = ids.parts;
          cursor = ids.at;
        }
      }
      if (text.charCodeAt(cursor) === 43) {
        const ids = coerceIdentifiers(text, cursor + 1, false);
        if (ids !== null) {
          found.build = ids.parts;
          cursor = ids.at;
        }
      }
    }
    if (cursor < text.length && isDigit(text.charCodeAt(cursor))) continue;
    // The grammar consumes the character that ends the run, so the match is one
    // longer than the version it found unless it ran to the end of the text.
    found.end = cursor < text.length ? cursor + 1 : cursor;
    return found;
  }
  return null;
}

/**
 * A version out of text that was never meant to be one: a tag name, a filename, a
 * line of output. Null if there is nothing version-shaped in it. With `rtl` the
 * search runs from the right, taking the last run that does not end where an
 * earlier one already ended.
 */
export function coerce(input, options) {
  const opts = settle(options);
  if (isVersion(input)) return input;
  const text = typeof input === 'number' ? String(input) : input;
  if (typeof text !== 'string') return null;
  const incPre = opts.includePrerelease === true;
  let found = null;
  if (opts.rtl !== true) {
    found = findCoercible(text, 0, incPre);
  } else {
    let at = 0;
    while (found === null || found.end !== text.length) {
      const next = findCoercible(text, at, incPre);
      if (next === null) break;
      if (found === null || next.end !== found.end) found = next;
      at = next.majorEnd;
    }
  }
  if (found === null) return null;
  const tail = (found.prerelease.length > 0 ? `-${found.prerelease.join('.')}` : '')
    + (found.build.length > 0 ? `+${found.build.join('.')}` : '');
  return parse(`${found.major}.${found.minor}.${found.patch}${tail}`, opts);
}

// -- comparing two ranges -----------------------------------------------------

/**
 * Could one comparator and one comparator both hold at once? This is the
 * reference package's algorithm, pair by pair, and it is worth saying out loud
 * that pairwise agreement is an approximation: it asks whether the comparators
 * contradict each other, not whether a version exists that satisfies both under
 * the prerelease rule. It is kept because `intersects` is used to decide whether
 * two dependency ranges can be deduplicated, and answering that differently from
 * npm would make nirdep's advice wrong rather than merely different.
 */
function comparatorIntersects(a, b, options) {
  if (isAny(a) || isAny(b)) return true;
  if (a.operator === '=') return testSet([b], a.version, options);
  if (b.operator === '=') return testSet([a], b.version, options);
  const incPre = options.includePrerelease === true;
  const impossible = (item) => (incPre
    ? isNone(item)
    : item.operator === '<' && item.version.major === 0 && item.version.minor === 0
      && item.version.patch === 0);
  if (impossible(a) || impossible(b)) return false;
  if (a.operator.startsWith('>') && b.operator.startsWith('>')) return true;
  if (a.operator.startsWith('<') && b.operator.startsWith('<')) return true;
  if (a.version.version === b.version.version
    && a.operator.includes('=') && b.operator.includes('=')) return true;
  const order = compare(a.version, b.version, options);
  if (order < 0 && a.operator.startsWith('>') && b.operator.startsWith('<')) return true;
  if (order > 0 && a.operator.startsWith('<') && b.operator.startsWith('>')) return true;
  return false;
}

/** Can any version satisfy every comparator in the set at once? */
function isSatisfiable(set, options) {
  for (let at = 0; at < set.length; at += 1) {
    for (let other = at + 1; other < set.length; other += 1) {
      if (!comparatorIntersects(set[at], set[other], options)) return false;
    }
  }
  return true;
}

/**
 * Is there a version both ranges accept? Numeric overlap is necessary and it is not
 * sufficient, because the prerelease rule is asked *of each range separately*: the
 * only version in `1.2.3-beta` is `1.2.3-beta`, and `*` does not accept it, so those
 * two ranges do not intersect even though the intervals plainly touch. The reference
 * package answers that pair correctly and gets there by comparing comparators one
 * pair at a time, which is also how it answers `>1.2.3-alpha <2.0.0-0` wrongly — see
 * the divergence tests, and `subset`, which has the same fault for the same reason.
 */
export function intersects(one, other, options) {
  const settled = settle(options);
  const left = readRange(one, settled);
  const right = readRange(other, settled);
  return left.set.some((setA) => right.set.some((setB) => setsOverlap(setA, setB, settled)));
}

/** Does the set name a prerelease on the same major.minor.patch as `want`? */
const mentionsPrerelease = (set, want) => set.some((item) => !isAny(item)
  && item.version.prerelease.length > 0
  && item.version.major === want.major
  && item.version.minor === want.minor
  && item.version.patch === want.patch);

/** Is there a version that satisfies both comparator sets at once? */
function setsOverlap(setA, setB, options) {
  const merged = [...setA, ...setB];
  if (!isSatisfiable(merged, options)) return false;
  if (options.includePrerelease === true) return true;
  // Where the overlap has narrowed to one exact prerelease version, that version is
  // the only candidate, and each side must admit it in its own right: the sole
  // member of `1.2.3-beta` is `1.2.3-beta`, and `*` does not accept it. Only this
  // shape is checked. Wider prerelease-only overlaps — `<1.2.3` against
  // `>=1.2.3-beta`, which no version can satisfy either — are left agreeing with the
  // reference package, because a range that behaves differently after a codemod is a
  // worse outcome than a range that is wrong in the same way it was before.
  const { low, high } = bounds(merged, options);
  const point = low !== null && high !== null && low.inclusive && high.inclusive
    && low.version.prerelease.length > 0 && compare(low.version, high.version, options) === 0;
  if (!point) return true;
  return mentionsPrerelease(setA, low.version) && mentionsPrerelease(setB, low.version);
}

/**
 * The interval a comparator set describes: a floor, a ceiling, and whether each
 * end is included. Nothing else survives, which is the deliberate limitation
 * `subset` is documented with — the prerelease rule is a hole in the interval, not
 * an end of it, and this reduction cannot see holes.
 */
function bounds(set, options) {
  let low = null;
  let high = null;
  const raise = (candidate) => {
    if (low === null) { low = candidate; return; }
    const order = compare(candidate.version, low.version, options);
    if (order > 0 || (order === 0 && low.inclusive && !candidate.inclusive)) low = candidate;
  };
  const lower = (candidate) => {
    if (high === null) { high = candidate; return; }
    const order = compare(candidate.version, high.version, options);
    if (order < 0 || (order === 0 && high.inclusive && !candidate.inclusive)) high = candidate;
  };
  for (const item of set) {
    if (isAny(item)) continue;
    if (item.operator === '=') {
      raise({ version: item.version, inclusive: true });
      lower({ version: item.version, inclusive: true });
    } else if (item.operator === '>' || item.operator === '>=') {
      raise({ version: item.version, inclusive: item.operator === '>=' });
    } else {
      lower({ version: item.version, inclusive: item.operator === '<=' });
    }
  }
  return { low, high };
}

/** Is the interval empty: a floor above its own ceiling? */
function isEmptyInterval({ low, high }, options) {
  if (low === null || high === null) return false;
  const order = compare(low.version, high.version, options);
  if (order > 0) return true;
  return order === 0 && !(low.inclusive && high.inclusive);
}

/** Is bound `a` at least as high as bound `b`, read as floors? */
const floorAtLeast = (a, b, options) => {
  if (b === null) return true;
  if (a === null) return false;
  const order = compare(a.version, b.version, options);
  if (order !== 0) return order > 0;
  return b.inclusive || !a.inclusive;
};

/** Is bound `a` no higher than bound `b`, read as ceilings? */
const ceilingAtMost = (a, b, options) => {
  if (b === null) return true;
  if (a === null) return false;
  const order = compare(a.version, b.version, options);
  if (order !== 0) return order < 0;
  return b.inclusive || !a.inclusive;
};

/**
 * The prerelease rule, asked of an interval rather than of a version: a set whose
 * floor or ceiling is a prerelease can only be contained by a set that mentions a
 * prerelease on the same major.minor.patch, because otherwise the containing set
 * admits none of the prereleases the contained one is made of. `^1.2.3-beta.2` is
 * therefore *not* a subset of `*`, which surprises everybody once.
 *
 * The one exemption is a `<X.Y.Z-0` ceiling. That is the upper bound `^` and `~`
 * generate for themselves, it exists to exclude prereleases rather than to admit
 * them, and requiring a partner for it would make every caret range a subset of
 * nothing.
 */
function prereleaseContained(span, set, options) {
  if (options.includePrerelease === true) return true;
  const needed = [];
  if (span.low !== null && span.low.version.prerelease.length > 0) needed.push(span.low.version);
  if (span.high !== null && span.high.version.prerelease.length > 0) {
    const isGeneratedBound = span.high.inclusive === false
      && span.high.version.prerelease.length === 1
      && span.high.version.prerelease[0] === 0;
    if (!isGeneratedBound) needed.push(span.high.version);
  }
  if (needed.length === 0) return true;
  return needed.every((want) => mentionsPrerelease(set, want));
}

/**
 * The floor an unbounded comparator set is treated as having. A bare `*` is not
 * "every string that parses": under the default options it excludes prereleases,
 * so as a *subset* question it means `>=0.0.0`, and under `includePrerelease` it
 * means `>=0.0.0-0`. The asymmetry is real and observable — `*` is a subset of
 * `>=0.0.0-0`, but `>=0.0.0-0` is not a subset of `*` — and reproducing it is the
 * difference between agreeing with the reference package and merely looking right.
 */
const floorOfEverything = (incPre) => ({ version: versionOf(0, 0, 0, incPre ? [0] : []), inclusive: true });

/**
 * Does every version the first range accepts also satisfy the second? Answered by
 * interval containment, set against set: each set of the subset must fit inside at
 * least one set of the superset, an impossible set fits inside anything, and the
 * prerelease rule is applied to the ends of the interval.
 *
 * This is a different algorithm from the reference package's, which walks the
 * comparators pairwise, and it is far shorter. The differential corpus in
 * `tests/vectors/semver/` is what says the two agree.
 */
export function subset(sub, dom, options) {
  // Identical arguments are answered before either side is parsed, which the
  // reference package also does and which is why `subset('==1.2.3', '==1.2.3')` is
  // true even though `validRange('==1.2.3')` is null. Every range contains itself,
  // including the ones nobody can read.
  if (sub === dom) return true;
  const settled = settle(options);
  const incPre = settled.includePrerelease === true;
  const unbounded = (set) => set.length === 1 && isAny(set[0]);
  const inner = readRange(sub, settled);
  const outer = readRange(dom, settled);
  return inner.set.every((setA) => {
    const spanA = unbounded(setA)
      ? { low: floorOfEverything(incPre), high: null }
      : bounds(setA, settled);
    if (isEmptyInterval(spanA, settled)) return true;
    return outer.set.some((setB) => {
      const wide = unbounded(setB);
      const spanB = wide
        ? { low: incPre ? null : floorOfEverything(false), high: null }
        : bounds(setB, settled);
      if (isEmptyInterval(spanB, settled)) return false;
      if (!prereleaseContained(spanA, wide ? [] : setB, settled)) return false;
      return floorAtLeast(spanA.low, spanB.low, settled)
        && ceilingAtMost(spanA.high, spanB.high, settled);
    });
  });
}

/**
 * The shortest range that accepts exactly the same members of a known version
 * list. Given every published version of a package and a sprawling range, this is
 * what turns it back into something a person can read.
 *
 * One deliberate difference: the caller's array is not sorted in place. The
 * reference package sorts the argument as a side effect, and a function that
 * reorders its input while answering a question about it is a trap.
 */
export function simplifyRange(versions, range, options) {
  const settled = settle(options);
  const sorted = [...versions].sort((a, b) => compare(a, b, settled));
  const spans = [];
  let first = null;
  let previous = null;
  for (const version of sorted) {
    if (satisfies(version, range, settled)) {
      previous = version;
      if (first === null) first = version;
    } else {
      if (previous !== null) spans.push([first, previous]);
      previous = null;
      first = null;
    }
  }
  if (first !== null) spans.push([first, null]);
  const pieces = [];
  for (const [min, max] of spans) {
    if (min === max) pieces.push(String(min));
    else if (max === null && min === sorted[0]) pieces.push('*');
    else if (max === null) pieces.push(`>=${min}`);
    else if (min === sorted[0]) pieces.push(`<=${max}`);
    else pieces.push(`${min} - ${max}`);
  }
  const simplified = pieces.join(' || ');
  const original = isRange(range) ? range.raw : String(range);
  return simplified.length < original.length ? simplified : range;
}

// -- the bundle ---------------------------------------------------------------
//
// A default export as well as named ones, because the code being rewritten was
// written against a package whose whole surface arrives as one object, and a
// codemod that only has to change the import specifier is a codemod that can be
// trusted. Frozen, so a caller cannot monkey-patch a comparison and quietly change
// what every other caller in the process resolves.

const semver = Object.freeze({
  MAX_LENGTH,
  MAX_COMPONENT,
  SEMVER_SPEC_VERSION,
  RELEASE_TYPES,
  SemverError,
  parse,
  valid,
  clean,
  prerelease,
  major,
  minor,
  patch,
  compare,
  rcompare,
  compareLoose,
  compareBuild,
  compareIdentifiers,
  rcompareIdentifiers,
  sort,
  rsort,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
  cmp,
  parseRange,
  validRange,
  toComparators,
  satisfies,
  maxSatisfying,
  minSatisfying,
  minVersion,
  outside,
  gtr,
  ltr,
  inc,
  diff,
  coerce,
  intersects,
  subset,
  simplifyRange,
});

export default semver;
