// Conformance for runtime/glob. Five tables under tests/vectors/glob/ carry the
// contract. The pattern and path columns were chosen by hand -- one input per
// rule that has a wrong answer -- and the expectation columns were filled in by
// calling minimatch@10.2.6 as a black box, disclosed in STDLIB.md under Borrowed
// test data, because glob syntax has no specification and the only definition of
// correct is "what npm does".
//
// A table row that carries `except` is a row where this module answers
// differently on purpose. The cell is still asserted -- against `ours` -- and
// then has to survive a second test that gives every divergence a name and a
// count. Silent disagreement is the failure mode these tables exist to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as glob from '../../src/runtime/glob.mjs';

const {
  minimatch, matches, match, matcher, filter, hasMagic, parse, braceExpand,
  escape, unescape, defaults, makeRe, globSync, sep, GLOBSTAR, GlobError,
} = glob;

const table = (name) => JSON.parse(readFileSync(new URL(`../vectors/glob/${name}.json`, import.meta.url), 'utf8'));

/** assert.throws() does not hand the error back, and the code is the point. */
function caught(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/** A row's label: the pattern, then whichever options were switched on. */
const label = (pattern, options) => {
  const keys = Object.keys(options);
  return `${JSON.stringify(pattern)}${keys.length === 0 ? '' : ` +${keys.join('+')}`}`;
};

/** One character per path, so a whole row's disagreement reads as a diff. */
const bits = (paths, run) => paths.map((path) => (run(path) ? '1' : '0')).join('');

/** What the row expects of us: the reference's answer, except where named. */
const expected = (row) => {
  if (row.except === undefined) return row.bits;
  return [...row.bits].map((cell, index) => (row.except.includes(index) ? row.ours[index] : cell)).join('');
};

// -- the two matching tables -------------------------------------------------

test('the match table: 188,265 answers, one per pattern x option set x path', () => {
  const { paths, cases } = table('match');
  for (const row of cases) {
    for (const options of row.when) {
      assert.equal(bits(paths, (path) => minimatch(path, row.in, options)),
        expected(row), label(row.in, options));
    }
  }
});

test('the partial table: is this path a prefix of something that could match', () => {
  const { paths, cases } = table('partial');
  for (const row of cases) {
    for (const options of row.when) {
      assert.equal(bits(paths, (path) => minimatch(path, row.in, options)),
        expected(row), label(row.in, options));
    }
  }
});

test('every divergence in the tables has a name and a count', () => {
  // 697 cells out of 222,495 disagree with the reference package, and each one
  // falls into one of four causes. Naming them here means a new disagreement
  // cannot arrive quietly: it lands in UNKNOWN and the counts stop adding up.
  const braced = new Set(table('brace').cases.filter((row) => row.ours !== undefined).map((row) => row.in));
  const tally = { print: 0, nonascii: 0, partial: 0, brace: 0, unknown: [] };
  for (const name of ['match', 'partial']) {
    const { paths, cases } = table(name);
    for (const row of cases) {
      for (const options of row.when) {
        for (const index of row.except ?? []) {
          assert.notEqual(row.ours[index], row.bits[index], `${label(row.in, options)} lists a cell that agrees`);
          const ascii = [...paths[index]].every((one) => one.charCodeAt(0) < 128);
          if (row.in.includes('[[:print:]]')) tally.print += 1;
          else if (!ascii) tally.nonascii += 1;
          else if (braced.has(row.in)) tally.brace += 1;
          else if (options.partial === true) tally.partial += 1;
          else tally.unknown.push(`${label(row.in, options)} vs ${JSON.stringify(paths[index])}`);
        }
      }
    }
  }
  assert.deepEqual(tally.unknown, [], 'a disagreement with no recorded cause');
  assert.equal(tally.print, 576, 'their [[:print:]] compiles to the same thing as [[:cntrl:]]');
  assert.equal(tally.nonascii, 91, 'non-ASCII in a POSIX class: a stated limit, not a bug');
  assert.equal(tally.partial, 18, 'their partial walks into directories that cannot match');
  assert.equal(tally.brace, 12, 'their brace expansion loses a character to its own sentinel');
});

// -- the three surface tables ------------------------------------------------

test('the brace table: expansion happens before anything is matched', () => {
  for (const row of table('brace').cases) {
    const [options] = row.when;
    const at = label(row.in, options);
    assert.deepEqual(braceExpand(row.in, options), row.ours ?? row.out, at);
    // Expansion is the first thing parse() does, so the set count follows from it
    // -- with duplicates removed, which is why `x{,}` is one pattern and not two.
    if (row.in.charCodeAt(0) === 35) continue;
    const seen = new Set(row.ours ?? row.out);
    assert.equal(parse(row.in, options).sets.length, seen.size, `${at} sets`);
  }
});

test('the magic table: what can match more than itself', () => {
  for (const row of table('magic').cases) {
    const [options] = row.when;
    assert.equal(hasMagic(row.in, options), row.out, label(row.in, options));
  }
});

test('the escape table, and the round trip', () => {
  for (const row of table('escape').cases) {
    const [options] = row.when;
    const at = label(row.in, options);
    assert.equal(escape(row.in, options), row.escape, `escape ${at}`);
    assert.equal(unescape(row.in, options), row.unescape, `unescape ${at}`);
    assert.equal(unescape(escape(row.in, options), options), row.trip, `round trip ${at}`);
    // An escaped literal matches itself, which is the only reason escape()
    // exists. Three kinds of input are outside its remit and are skipped rather
    // than pretended about: a brace group or a leading `!` or `#`, none of which
    // escape() touches, because escaping them would break expansion, negation
    // and comments; a `.` or `..` segment, which the pattern rewriter cancels
    // before matching; and a backslash under windowsPathsNoEscape, which is a
    // separator by definition there -- the reference package agrees it stops
    // matching itself, so that is the flag working, not the escape failing.
    const literal = escape(row.in, options);
    const compiled = parse(literal, options);
    const leads = literal.charCodeAt(0) === 33 || literal.charCodeAt(0) === 35;
    const plain = !leads && compiled.sets.length === 1
      && braceExpand(literal, options).join('\n') === literal
      && !literal.split(sep).some((part) => part === '.' || part === '..');
    if (!plain) continue;
    if (options.windowsPathsNoEscape === true && row.in.includes('\\')) continue;
    assert.equal(minimatch(row.in, literal, options), true, `self ${at}`);
  }
});

// -- the promise in the header -----------------------------------------------

test('the module contains no regular expression', () => {
  // minimatch's ReDoS, CVE-2022-3517, was its own compiled pattern backtracking
  // on an adversarial brace body -- the same class of bug as node-semver's
  // CVE-2022-25883, in the module semver depends on. Both are answered the same
  // way here: two nested state-set simulations over character codes, where the
  // work is bounded by positions times tokens and there is nothing to backtrack.
  const source = readFileSync(new URL('../../src/runtime/glob.mjs', import.meta.url), 'utf8');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const banned of ['RegExp', '.match(', '.matchAll(', '.replace(/', '.split(/', '.search(']) {
    assert.equal(stripped.includes(banned), false, `${banned} appears in the module`);
  }
  // With the comments gone, a regular expression literal is the only thing left
  // that could put a `/` in this file -- the separator itself is a char code,
  // and nothing here divides. So counting is the whole test.
  const lines = stripped.split('\n').filter((line) => line.includes('/'));
  assert.deepEqual(lines.map((line) => line.trim()), [], 'a slash survives, so something is a pattern or a division');
});

test('makeRe is present, and refuses', () => {
  // A missing export would let a rewritten call site fail somewhere else, hours
  // later, with `undefined is not a function`. So the name exists and explains.
  const error = caught(() => makeRe('a*'));
  assert.ok(error instanceof GlobError);
  assert.equal(error.code, 'NO_REGEXP');
  assert.ok(error instanceof TypeError, 'so an existing catch still catches it');
  assert.match(error.message, /matcher\(pattern\)/, 'and it names the replacement');
});

test('every failure carries a code, and the codes are the documented set', () => {
  const code = (run) => {
    const error = caught(run);
    assert.ok(error instanceof GlobError, `${run} did not throw a GlobError`);
    assert.equal(error.name, 'GlobError');
    return error.code;
  };
  assert.equal(code(() => minimatch('a', null)), 'NOT_A_STRING');
  assert.equal(code(() => minimatch(null, 'a')), 'NOT_A_STRING');
  assert.equal(code(() => parse(42)), 'NOT_A_STRING');
  assert.equal(code(() => escape(undefined)), 'NOT_A_STRING');
  assert.equal(code(() => makeRe()), 'NO_REGEXP');
  assert.equal(code(() => parse('a'.repeat(70000))), 'TOO_LONG');
  // The two limits that stand in for the ReDoS this module cannot have: a brace
  // bomb is refused rather than expanded, and nesting stops at a stated depth.
  // Bounded work is only bounded if the bound is enforced somewhere.
  assert.equal(code(() => parse('{a,b}'.repeat(14))), 'TOO_MANY_EXPANSIONS');
  assert.equal(code(() => parse(`${'{a,'.repeat(17)}b${'}'.repeat(17)}`)), 'TOO_DEEP');
  assert.equal(code(() => parse(`${'@('.repeat(17)}a${')'.repeat(17)}`)), 'TOO_DEEP');
});

test('the compiled form is data, and is frozen', () => {
  const compiled = parse('{a,b}/**/*.js');
  assert.deepEqual(Object.keys(compiled), ['source', 'negate', 'comment', 'options', 'sets']);
  assert.equal(Object.isFrozen(compiled) && Object.isFrozen(compiled.sets), true);
  assert.equal(compiled.sets.length, 2);
  assert.equal(compiled.sets[0][1].kind, GLOBSTAR, 'the globstar is a marker, not a token list');
  assert.equal(compiled.sets[0][0].tokens.length, 1);
  assert.equal(Object.isFrozen(glob.default), true, 'the default export is frozen');
  assert.equal(glob.default.minimatch, minimatch, 'and is the same functions as the named exports');
  assert.equal(matches, minimatch, 'the un-branded name is the same function');
  assert.equal(sep, '/', 'written as a char code inside the module, and still a slash');
});

test('the reusable forms agree with the one-shot one', () => {
  const list = ['a.js', 'b.js', 'c.ts', 'src/d.js', '.hidden.js'];
  const test = matcher('**/*.js');
  assert.deepEqual(list.filter(test), ['a.js', 'b.js', 'src/d.js']);
  assert.deepEqual(list.filter(filter('**/*.js')), list.filter(test));
  assert.deepEqual(match(list, '**/*.js'), list.filter(test));
  assert.deepEqual(match(list, '*.rs'), [], 'no match is no match');
  assert.deepEqual(match(list, '*.rs', { nonull: true }), ['*.rs'], 'unless you asked for the pattern back');
  assert.equal(test.pattern, '**/*.js');
  assert.equal(test.options.dot, false);
  // A preset module answers the same as passing those options every time.
  const dotted = defaults({ dot: true });
  assert.equal(dotted.minimatch('.hidden.js', '**/*.js'), true);
  assert.equal(dotted.minimatch('.hidden.js', '**/*.js', { dot: false }), false, 'and a later option wins');
  assert.deepEqual(dotted.match(list, '**/*.js'), ['a.js', 'b.js', 'src/d.js', '.hidden.js']);
  assert.equal(Object.isFrozen(dotted), true);
});

// -- the walk ----------------------------------------------------------------

/** A small tree on disk, because a walk needs somewhere to walk. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-glob-'));
  const write = (path, body) => {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split('/')), body);
  };
  write('index.js', 'x');
  write('src/one.js', 'x');
  write('src/two.ts', 'x');
  write('src/deep/three.js', 'x');
  write('src/.hidden.js', 'x');
  write('node_modules/pkg/four.js', 'x');
  write('build/five.js', 'x');
  return root;
}

test('globSync returns sorted relative paths, and prunes what cannot match', () => {
  const cwd = tree();
  assert.deepEqual(globSync('**/*.js', { cwd }), [
    'build/five.js', 'index.js', 'node_modules/pkg/four.js', 'src/deep/three.js', 'src/one.js',
  ]);
  // Sorted, not readdir order: `make repro` compares two runs of the whole tool
  // byte for byte, and a walk whose order depends on the filesystem breaks that.
  assert.deepEqual(globSync('**/*.js', { cwd }), globSync('**/*.js', { cwd }));
  assert.deepEqual(globSync('src/*.js', { cwd }), ['src/one.js']);
  assert.deepEqual(globSync('src/*.js', { cwd, dot: true }), ['src/.hidden.js', 'src/one.js']);
  // The ignore list is patterns, not names -- the reason this exists next to
  // node's own fs.globSync, which takes patterns but fixes neither order nor this.
  assert.deepEqual(globSync('**/*.js', { cwd, ignore: ['node_modules/**', 'build/**'] }),
    ['index.js', 'src/deep/three.js', 'src/one.js']);
  assert.deepEqual(globSync(['src/*.ts', 'index.js'], { cwd }), ['index.js', 'src/two.ts']);
  assert.deepEqual(globSync('*', { cwd, nodir: true }), ['index.js']);
  assert.deepEqual(globSync('src', { cwd, mark: true }), ['src/']);
  // maxDepth counts directories descended, not path segments, so 1 reaches the
  // files one level down and stops before `src/deep` and `node_modules/pkg`.
  assert.deepEqual(globSync('**/*.js', { cwd, maxDepth: 1 }), ['build/five.js', 'index.js', 'src/one.js']);
  assert.deepEqual(globSync('nothing/here/*', { cwd }), [], 'a missing directory is empty, not a throw');
  assert.deepEqual(globSync('index.js', { cwd, absolute: true }), [join(cwd, 'index.js')]);
});

test('the walk asks the matcher where not to look', () => {
  const cwd = tree();
  // `partial` is not a convenience: it is what makes the walk skip a subtree it
  // has no business entering. If it ever answered false for a viable prefix the
  // walk would silently lose files, which is why the tables above pin it too.
  const reach = matcher('src/deep/**', { partial: true });
  assert.equal(reach('src'), true);
  assert.equal(reach('src/deep'), true);
  assert.equal(reach('build'), false);
  assert.equal(reach('node_modules'), false);
  // A trailing `**` still has to consume a segment, so `src/deep` is a viable
  // prefix and not a match. The walk needs both answers about the same path: go
  // in, but do not report it.
  assert.equal(minimatch('src/deep', 'src/deep/**'), false);
  assert.deepEqual(globSync('src/deep/**', { cwd }), ['src/deep/three.js']);
});

// -- where this module deliberately answers differently ----------------------

test('the four deliberate divergences from the package this replaces', () => {
  // Recorded in STDLIB.md as well. A differential harness ran 222,495 matching
  // checks and 6,357 surface checks against minimatch@10.2.6 as a black box; 697
  // cells disagreed, in four groups, counted by name in the test above. Three of
  // the four are the reference package contradicting itself or POSIX; one is a
  // limit this module states rather than hides.

  // 1: `[[:print:]]` compiles to the same thing as `[[:cntrl:]]` upstream, so it
  // matches control characters and rejects printable ones -- the exact inverse of
  // what POSIX defines. 576 cells. Ours reads the class as POSIX writes it.
  assert.equal(minimatch('a', '[[:print:]]'), true);
  assert.equal(minimatch(String.fromCharCode(7), '[[:print:]]'), false);
  assert.equal(minimatch(String.fromCharCode(7), '[[:cntrl:]]'), true, 'and cntrl is still cntrl');

  // 2: partial match. Ours refuses a path that cannot be a prefix of any match;
  // theirs walks in anyway. Five of those cells are provable without leaving the
  // reference package: its own full matcher says `**/.*` matches `.git`, and its
  // own partial matcher says `.git` is not a prefix of anything it matches, which
  // no correct partial matcher can say about a path that already matches.
  for (const path of ['.git', '.a', '.b', 'a/.b', 'a/b/.c']) {
    assert.equal(minimatch(path, '**/.*'), true, path);
    assert.equal(minimatch(path, '**/.*', { partial: true }), true, `${path} is a prefix of itself`);
  }
  assert.equal(minimatch('b', 'a/**/*/b', { partial: true }), false, 'nothing under `b` can be `a/...`');

  // 3: brace ranges. `{A..z}` spans ASCII 65 to 122, and the backslash sits at
  // 92. Their expander reserves that character as an internal marker, so it comes
  // back as an empty string and the pattern matches the empty path. 12 cells.
  const spanned = braceExpand('{A..z}');
  assert.equal(spanned.length, 58);
  assert.equal(spanned[27], '\\', 'the 28th character in that span is a backslash');
  assert.equal(minimatch('', '{A..z}'), false, 'and an empty alternative is not one of them');
  assert.equal(minimatch('\\', '{A..z}'), true);

  // 4: the limit, stated. A POSIX class here is decided by tables of ASCII ranges
  // plus toLowerCase/toUpperCase, so `[[:alpha:]]` does not know that a Han
  // character is a letter. The property tables that would fix it are larger than
  // this module, and a wrong answer on 91 cells is a fairer trade than shipping
  // them. Every ASCII cell agrees.
  assert.equal(minimatch('a', '[[:alpha:]]'), true);
  assert.equal(minimatch('1', '[[:digit:]]'), true);
  assert.equal(minimatch('中', '[[:alpha:]]'), false, 'a Han character is a letter, and we say no');
  assert.equal(minimatch('٣', '[[:digit:]]'), false, 'so is an Arabic-Indic digit a digit');
});
