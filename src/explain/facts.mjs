// What the standard library already does, and when it started doing it.
//
// Every claim this project makes reduces to one of two sentences: "Node already does this,
// so the package is unnecessary", or "Node does not do this, so here are the 500 lines
// that do". `explain` is the command that has to say which, per package, without hedging.
//
// The versions are the ones Node's own documentation gives for the addition of each API,
// and they are here for a practical reason rather than for completeness: a reader on Node
// 18 needs to know that `util.styleText` is not going to be there, and a reader deciding
// whether to depend on this runtime needs to know how far back it could be backported.
// Our own floor is in package.json, `engines.node`, and it is higher than all of them.
//
// Nothing in this file is derived from the code, so it is the one place in src/ that can
// go quietly out of date. It is short on purpose, and tests/explain/facts.test.mjs checks
// every API named here against the running Node rather than against this table.

/**
 * Per runtime module: what Node hands you for free, and the part nobody hands you.
 *
 * `path` is the property to look up on the module named by `module`, so a test can ask the
 * running Node whether the API is really there instead of trusting the string.
 */
export const NODE_API = Object.freeze({
  'runtime/colour': Object.freeze({
    has: Object.freeze([
      Object.freeze({
        module: 'node:util',
        path: 'styleText',
        version: '20.12.0',
        gives: 'one styled string at sixteen colours, one call at a time',
      }),
      Object.freeze({
        module: 'node:util',
        path: 'stripVTControlCharacters',
        version: '16.11.0',
        gives: 'the whole of strip-ansi, and the one part of this Node got right',
      }),
    ]),
    lacks: Object.freeze([
      'a chainable builder: styleText takes a list and a string, and returns a string',
      '256-colour and truecolour, hex and rgb input, and downsampling when the terminal cannot',
      'capability detection: nothing reads NO_COLOR, FORCE_COLOR, TERM or the CI variables',
      'nesting that survives: styling text that already contains escape sequences',
    ]),
  }),
  'runtime/args': Object.freeze({
    has: Object.freeze([
      Object.freeze({
        module: 'node:util',
        path: 'parseArgs',
        version: '18.3.0',
        gives: 'strings, booleans and positionals, in one flat object',
      }),
    ]),
    lacks: Object.freeze([
      'subcommands, and a help screen generated from them',
      'numbers, counts, choices, conflicts, implications and required options',
      'environment fallback, and a did-you-mean on a mistyped flag',
      'refusing a value-taking option that swallowed the next flag',
    ]),
  }),
  'runtime/semver': Object.freeze({
    // The interesting row: an empty `has` is not an oversight, it is the argument for the
    // file existing at all.
    has: Object.freeze([]),
    lacks: Object.freeze([
      'any version comparison at all: process.versions hands you strings',
      'a range grammar, so nothing can answer whether 1.2.3 satisfies ^1.0.0',
      'prerelease precedence, which is where a lexical comparison goes wrong first',
    ]),
  }),
  'runtime/glob': Object.freeze({
    has: Object.freeze([
      Object.freeze({
        module: 'node:fs',
        path: 'globSync',
        version: '22.0.0',
        gives: 'a walk that matches, in whatever order the filesystem answered in',
      }),
      Object.freeze({
        module: 'node:path',
        path: 'matchesGlob',
        version: '22.5.0',
        gives: 'one path against one pattern, with no options and no reusable matcher',
      }),
    ]),
    lacks: Object.freeze([
      'a sorted result, without which two runs of a build cannot be compared',
      'brace expansion, extglobs, POSIX classes, and a case-insensitive mode',
      'a partial match, which is the answer a walk needs before it enters a directory',
      'options at all: dot, ignore, nocase, maxDepth, mark, nodir and absolute',
    ]),
  }),
});

/** The floor this project asks for, quoted from our own manifest by the caller. */
export const nodeApiFor = (subpath) => NODE_API[subpath] ?? Object.freeze({ has: [], lacks: [] });
