// The catalogue: which package this project can actually replace, and how.
//
// Two kinds of entry, and the difference is the whole honesty of the tool. A
// **rewrite** entry means the replacement takes the same calls in the same shape, so a
// machine can move the call sites and the build still passes. An **advise** entry means
// the replacement exists but the shape differs, so the change is a person's job and all
// a codemod should do is say where to look. Filing minimist as a rewrite because both
// things parse a command line would produce green output and a broken program.
//
// The member lists are read off the runtime modules rather than typed out here. A
// hand-typed list of "things we support" drifts the moment somebody adds a function,
// and the direction it drifts is the dangerous one: a name in the list that the module
// does not export is a rewrite that lands and then throws at run time.

import * as colour from '../runtime/colour.mjs';
import * as semver from '../runtime/semver.mjs';
import * as glob from '../runtime/glob.mjs';
import * as collect from '../runtime/collect.mjs';

/** What we are prepared to do about a package. */
export const ACTION = Object.freeze({ REWRITE: 'rewrite', ADVISE: 'advise' });

/** What a default binding turns into on the other side. */
export const AS = Object.freeze({
  DEFAULT: 'default', NAMED: 'named', NAMESPACE: 'namespace', DUAL: 'dual',
});

/**
 * The chained builder's surface: every style in the table, plus the members that take
 * arguments and the two properties chalk users read. Chained, so `bold.red.underline`
 * has to be checked link by link -- each one comes from this same table.
 */
const COLOUR_MEMBERS = Object.freeze(new Set([
  ...Object.keys(colour.styles),
  'rgb', 'bgRgb', 'hex', 'bgHex', 'ansi256', 'bgAnsi256', 'level', 'enabled',
]));

/** Everything the semver replacement exports, straight from the module. */
const SEMVER_MEMBERS = Object.freeze(new Set(Object.keys(semver.default)));

/**
 * The glob replacement's surface, minus `makeRe`. The module does export that
 * name -- it has to, or a moved call site would fail later with `undefined is
 * not a function` -- but it exports it as a throw, because there is no compiled
 * pattern to hand back. So it is kept out of this list on purpose: a file that
 * reaches for it is refused with DECLINE.MEMBER and the line is left alone,
 * which is the difference between "we cannot do this" and a green run that
 * breaks at midnight. `Minimatch` and `AST` are absent for the same reason from
 * the other direction: a class and a syntax tree are not part of this surface.
 */
const GLOB_MEMBERS = Object.freeze(new Set(
  Object.keys(glob.default).filter((name) => name !== 'makeRe'),
));

/**
 * The sixteen functions of lodash this project answers, read off the module. `CollectError` is
 * held out: it is on the default export so a caller can catch a refusal by class, but no lodash
 * call site has ever reached for `_.CollectError`, and a member list is a promise about calls.
 */
const COLLECT_MEMBERS = Object.freeze(new Set(
  Object.keys(collect.default).filter((name) => name !== 'CollectError'),
));

/**
 * The rules. `weekly` is the download figure that made the package worth writing a
 * replacement for; it is a fact about npm, quoted so the report can cite it.
 */
export const RULES = Object.freeze([
  Object.freeze({
    package: 'chalk',
    weekly: '319.8M',
    action: ACTION.REWRITE,
    target: 'nirdep/runtime/colour',
    subpath: 'runtime/colour',
    fromDefault: Object.freeze({ as: AS.DEFAULT }),
    fromNamespace: null,
    fromNamed: null,
    chained: true,
    members: COLOUR_MEMBERS,
    note: 'the default export is a chained builder with the same surface and the same close codes',
    declines: Object.freeze({
      namespace: 'a namespace object is not a chained builder; the default export is the one to take',
      named: "chalk's named exports are its class and its per-stream instances, neither of which this runtime has",
    }),
  }),
  Object.freeze({
    package: 'strip-ansi',
    weekly: '294.1M',
    action: ACTION.REWRITE,
    target: 'nirdep/runtime/colour',
    subpath: 'runtime/colour',
    // The whole package is one function, and here it is one named export, so a default
    // binding becomes a named one under the same local name.
    fromDefault: Object.freeze({ as: AS.NAMED, name: 'strip' }),
    fromNamespace: null,
    fromNamed: null,
    chained: false,
    members: Object.freeze(new Set()),
    note: 'one function in, one function out: node:util strips the sequences',
    declines: Object.freeze({
      namespace: 'the package has one default export, so a namespace object has nothing useful on it',
      named: 'the package exports no names at all, so a named import of it never resolved; '
        + 'whatever this line is doing, it is not what it looks like',
    }),
  }),
  Object.freeze({
    package: 'semver',
    weekly: '188.4M',
    action: ACTION.REWRITE,
    target: 'nirdep/runtime/semver',
    subpath: 'runtime/semver',
    fromDefault: Object.freeze({ as: AS.DEFAULT }),
    fromNamespace: Object.freeze({ as: AS.NAMESPACE }),
    fromNamed: Object.freeze({ as: AS.NAMED }),
    chained: false,
    members: SEMVER_MEMBERS,
    note: 'the function names match, so only the member each call site reaches for has to be checked',
    declines: Object.freeze({}),
  }),
  Object.freeze({
    package: 'minimatch',
    weekly: '348.9M',
    action: ACTION.REWRITE,
    target: 'nirdep/runtime/glob',
    subpath: 'runtime/glob',
    // A default import of this package means two different things depending on which
    // major the file was written against, so the shape is read off the file rather than
    // assumed: see AS.DUAL.
    fromDefault: Object.freeze({ as: AS.DUAL, name: 'minimatch' }),
    fromNamespace: Object.freeze({ as: AS.NAMESPACE }),
    fromNamed: Object.freeze({ as: AS.NAMED }),
    chained: false,
    members: GLOB_MEMBERS,
    note: 'the matcher takes the same arguments in the same order and answers the same, '
      + 'with makeRe held out of the member list on purpose',
    declines: Object.freeze({}),
  }),
  Object.freeze({
    package: 'lodash',
    // Blank rather than guessed: no download figure could be checked from this machine. What could
    // be measured is the copy on disk -- 1051 files and 2.1MB of it, carried to reach two names.
    weekly: '—',
    action: ACTION.REWRITE,
    target: 'nirdep/runtime/collect',
    subpath: 'runtime/collect',
    fromDefault: Object.freeze({ as: AS.DEFAULT }),
    fromNamespace: Object.freeze({ as: AS.NAMESPACE }),
    fromNamed: Object.freeze({ as: AS.NAMED }),
    chained: false,
    members: COLLECT_MEMBERS,
    // `_(list).map(...)` needs no entry here: a default binding that is called is a value use, and
    // a value use is already refused with DECLINE.SHAPE. The wrapper is not part of this surface.
    note: 'the names take the same arguments and answer the same, with two refusals on purpose: a '
      + 'deep write stops at a key the object does not own, and __proto__ throws ERR_UNSAFE_KEY '
      + 'rather than returning quietly. Both are named in STDLIB.md',
    declines: Object.freeze({}),
  }),
  Object.freeze({
    package: 'supports-color',
    weekly: '317.5M',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/colour',
    subpath: 'runtime/colour',
    advice: 'detectLevel(stream, env) answers the same question and returns the same 0-3 level. '
      + 'The package hands back an object per stream with hasBasic and has256 on it, so the '
      + 'call sites read differently and a machine should not guess at them.',
  }),
  Object.freeze({
    package: 'ansi-styles',
    weekly: '318.9M',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/colour',
    subpath: 'runtime/colour',
    advice: 'the styles table is exported under the same name, but as a pair of numbers per '
      + 'style rather than open and close strings on a nested object. One line each at the '
      + 'call site, and not a line a codemod can write for you.',
  }),
  Object.freeze({
    package: 'minimist',
    weekly: '110.8M',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/args',
    subpath: 'runtime/args',
    advice: 'parse(argv, spec) covers it, but the shapes differ on purpose: it returns '
      + '{ values, positionals, rest } instead of one flat object with an underscore key, '
      + 'unknown flags are an error unless you ask otherwise, and dot notation is gone '
      + "rather than patched -- that feature was both of minimist's advisories.",
  }),
  Object.freeze({
    package: 'commander',
    weekly: '138.5M',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/args',
    subpath: 'runtime/args',
    advice: 'createCli(descriptor) takes the whole command table as data and generates the '
      + 'help, the did-you-mean and the exit codes. It is a different way round from a '
      + 'builder chain, so the migration is a rewrite of one file by hand.',
  }),
  Object.freeze({
    package: 'yargs',
    weekly: '89.6M',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/args',
    subpath: 'runtime/args',
    advice: 'as with commander: createCli(descriptor) is declarative where yargs is fluent. '
      + 'The features that survive are the ones worth having; middleware and command '
      + 'modules are not implemented and are not planned.',
  }),
  Object.freeze({
    package: 'glob',
    weekly: '—',
    action: ACTION.ADVISE,
    target: 'nirdep/runtime/glob',
    subpath: 'runtime/glob',
    advice: 'globSync(patterns, options) walks and matches, and the pattern half is at '
      + 'conformance with the matcher this package installs. What differs is everything '
      + 'around it: there is no Glob class, no stream, no async iterator and no cache, the '
      + 'result is always sorted so a build can compare two runs, and ignore takes patterns '
      + 'rather than names. The weekly figure is left blank rather than guessed -- the one '
      + 'quoted for minimatch is the one that could be checked.',
  }),
]);

const BY_PACKAGE = new Map(RULES.map((rule) => [rule.package, rule]));

/** The rule for a specifier, or null. Only the package root matches: a deep path into a
 * package is a different entry point with a different surface, and guessing is how a
 * codemod rewrites something it has never seen. */
export function ruleFor(specifier) {
  return BY_PACKAGE.get(specifier) ?? null;
}

/** Every package this project claims to replace, for `scan` and for the README. */
export const REPLACEABLE = Object.freeze(RULES.map((rule) => rule.package));

/** The rewritable subset, which is the honest answer to "what can the codemod do". */
export const REWRITABLE = Object.freeze(
  RULES.filter((rule) => rule.action === ACTION.REWRITE).map((rule) => rule.package),
);

/**
 * The last segment of a subpath, which is what `eject`, `conformance` and `stdlibmd` all
 * call a module. Five commands were each keeping their own copy of this line, and five
 * copies of a naming rule is five chances to disagree about what to call `runtime/colour`.
 *
 * @param {string} subpath a rule's subpath, or any specifier ending in one
 * @returns {string}
 */
export const moduleOf = (subpath) => subpath.slice(subpath.lastIndexOf('/') + 1);
