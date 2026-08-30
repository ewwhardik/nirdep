// Pattern matching without a pattern engine.
//
// Replaces minimatch and the matching half of glob: together more than 100M
// downloads a week, and a transitive dependency of most of the ecosystem.
//
// Node 22 ships fs.globSync, which walks a tree. It exposes no reusable string
// matcher, and the matcher is what most of minimatch's traffic actually is:
// deciding whether a path you already have matches a pattern a user already
// typed. Node gives you the walk and not the matcher, so this file is the
// matcher, and globSync at the bottom is the walk written on top of it.
//
// It contains no regular expression. Not one, and a test asserts it -- in fact
// this file does not contain a forward slash outside its comments, which is a
// strange thing to say about a glob matcher and is the whole point. minimatch
// compiles a pattern to a RegExp; CVE-2022-3517 was that RegExp backtracking on
// crafted input, in a package almost nobody installs on purpose. So makeRe()
// cannot exist here. What replaces it is two state-set simulations, one over the
// segments of a path and one over the characters of a segment: every step is a
// set of reachable positions advanced once per token, so the work is bounded by
// positions times tokens and no input can drive it exponential. Backtracking is
// not patched out, it is absent.
//
// Where behaviour is observable, it matches minimatch 10.2.6 rather than my
// taste, because a rewritten call site is on the line. Divergences are named in
// STDLIB.md, and the limits below refuse rather than hang.

// Two imports, both builtin: the walk at the bottom needs a directory listing.
// The matcher above needs nothing at all.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SLASH = 47;
const STAR = 42;
const QMARK = 63;
const LBRACKET = 91;
const RBRACKET = 93;
const LBRACE = 123;
const RBRACE = 125;
const LPAREN = 40;
const RPAREN = 41;
const BACKSLASH = 92;
const BANG = 33;
const CARET = 94;
const DASH = 45;
const COMMA = 44;
const DOT = 46;
const AT = 64;
const PLUS = 43;
const PIPE = 124;
const COLON = 58;
const HASH = 35;
const ZERO = 48;
const NINE = 57;

// A pattern longer than this is refused rather than compiled. minimatch draws
// the same line at 64KiB; ours is a refusal with a code rather than a silent
// non-match, because a caller that hands us 200KiB of pattern has a bug.
const MAX_PATTERN_LENGTH = 65536;
// Brace expansion is the one part of a glob that can grow multiplicatively:
// {a,b}{a,b}{a,b}... doubles per group. CVE-2022-3517 lived in exactly this
// function. A ceiling turns a hang into an error somebody can read.
const MAX_EXPANSIONS = 8192;
// Extglobs nest, and the complement form !(...) costs a pass per start
// position, so depth is where the polynomial degree comes from. Sixteen is
// past anything a human writes and short of anything that hurts.
const MAX_EXTGLOB_DEPTH = 16;

/** The compiled marker for a `**` segment. A symbol, so no literal can be it. */
export const GLOBSTAR = Symbol('globstar **');

/** The separator this module speaks. Built from a code, because see above. */
export const sep = String.fromCharCode(SLASH);

/**
 * Extends TypeError on purpose: minimatch throws TypeError for a bad pattern,
 * so an existing catch still fires. The code is stable, the message is not.
 */
export class GlobError extends TypeError {
  constructor(message, code) {
    super(message);
    this.name = 'GlobError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new GlobError(message, code);
}

function requireString(value, what) {
  if (typeof value !== 'string') {
    fail(`${what} must be a string, got ${value === null ? 'null' : typeof value}`, 'NOT_A_STRING');
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    fail(`${what} is longer than ${MAX_PATTERN_LENGTH} characters`, 'TOO_LONG');
  }
  return value;
}

function codesOf(text) {
  const out = new Uint32Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index);
  return out;
}

// ---------------------------------------------------------------------------
// Brace expansion. `{a,b}` and `{1..9..2}`, by hand, with a ceiling.
// ---------------------------------------------------------------------------

/**
 * Expand a pattern into the list of patterns it stands for. One group at a
 * time, outermost first, so nesting falls out of the recursion instead of
 * needing its own case. A group with no top-level comma and no `..` range is
 * literal text, which is why `{a}` matches the four characters `{a}`.
 *
 * Two rules here are the reference package's rather than mine, and both are
 * observable. Expansion is skipped unless the pattern holds a brace pair with
 * no nested open brace, which is why `a\,b` keeps its backslash and
 * `{a,b}\,c` does not. And an expansion that comes out empty is dropped, which
 * is why `{,}` expands to nothing rather than to two empty strings.
 */
export function braceExpand(pattern, options) {
  requireString(pattern, 'pattern');
  if (settle(options).nobrace || !hasBraceGroup(pattern)) return [pattern];
  const guard = sentinels(pattern);
  const out = [];
  expandInto(protect(pattern, guard), out, 0);
  return out.filter((one) => one.length > 0).map((one) => restore(one, guard));
}

/**
 * Does the pattern hold a brace pair with nothing but plain characters between?
 * This is the reference package's own gate and it decides more than tidiness:
 * an escaped brace or comma only loses its backslash on a pattern that passes.
 */
function hasBraceGroup(pattern) {
  const codes = codesOf(pattern);
  for (let open = 0; open < codes.length; open += 1) {
    if (codes[open] !== LBRACE) continue;
    for (let index = open + 1; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === RBRACE) return true;
      // A line break stops the group, because the gate over there is a `.` and
      // a `.` does not cross one.
      if (code === LBRACE || code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
    }
  }
  return false;
}

// The five sequences the expander must not read as syntax. Order matters: the
// escaped backslash goes first, so `\\{` is a real group opener.
const PROTECTED = Object.freeze([BACKSLASH, LBRACE, RBRACE, COMMA, DOT]);

/**
 * Five code points the pattern does not contain, to stand in for those five
 * sequences while the groups are found. brace-expansion reserves fixed markers
 * in the NUL block and hopes no input holds them -- which is how `{A..z}` there
 * yields an empty string where the backslash should be. Searching for unused
 * ones costs one pass and cannot be collided with.
 */
function sentinels(pattern) {
  const used = new Set();
  for (const character of pattern) used.add(character.codePointAt(0));
  const out = [];
  for (let code = 0xE000; out.length < PROTECTED.length; code += 1) {
    if (!used.has(code)) out.push(String.fromCodePoint(code));
  }
  return out;
}

function protect(pattern, guard) {
  let out = pattern;
  for (let which = 0; which < PROTECTED.length; which += 1) {
    out = out.split(String.fromCharCode(BACKSLASH, PROTECTED[which])).join(guard[which]);
  }
  return out;
}

/** The backslash does not come back: `{a,b\,c}` expands to `a` and `b,c`. */
function restore(text, guard) {
  let out = text;
  for (let which = 0; which < PROTECTED.length; which += 1) {
    out = out.split(guard[which]).join(String.fromCharCode(PROTECTED[which]));
  }
  return out;
}

function expandInto(pattern, out, depth) {
  if (out.length > MAX_EXPANSIONS) {
    fail(`brace expansion exceeded ${MAX_EXPANSIONS} results`, 'TOO_MANY_EXPANSIONS');
  }
  if (depth > MAX_EXTGLOB_DEPTH) fail('brace nesting is too deep', 'TOO_DEEP');
  const group = findGroup(pattern);
  if (group === null) {
    out.push(pattern);
    return;
  }
  const head = pattern.slice(0, group.start);
  const tail = pattern.slice(group.end + 1);
  for (const piece of group.pieces) expandInto(head + piece + tail, out, depth + 1);
}

/** The first brace group that actually stands for a choice, or null. */
function findGroup(pattern) {
  const codes = codesOf(pattern);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === BACKSLASH) { index += 1; continue; }
    if (code !== LBRACE) continue;
    const close = matchingBrace(codes, index);
    if (close === -1) continue;
    const body = pattern.slice(index + 1, close);
    const parts = splitTopLevel(body, COMMA);
    if (parts.length > 1) return { start: index, end: close, pieces: parts };
    const range = expandRange(body);
    if (range !== null) return { start: index, end: close, pieces: range };
  }
  return null;
}

function matchingBrace(codes, open) {
  let depth = 0;
  for (let index = open; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === BACKSLASH) { index += 1; continue; }
    if (code === LBRACE) depth += 1;
    else if (code === RBRACE) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split on a separator that is not inside braces, brackets or parentheses. */
function splitTopLevel(body, separator) {
  const codes = codesOf(body);
  const parts = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === BACKSLASH) { index += 1; continue; }
    if (code === LBRACE) braces += 1;
    else if (code === RBRACE) braces -= 1;
    else if (code === LBRACKET) brackets += 1;
    else if (code === RBRACKET) brackets -= 1;
    else if (code === LPAREN) parens += 1;
    else if (code === RPAREN) parens -= 1;
    else if (code === separator && braces === 0 && brackets <= 0 && parens === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** `{1..9}`, `{01..12}`, `{a..e..2}`, and descending forms of each. */
function expandRange(body) {
  const bounds = body.split('..');
  if (bounds.length < 2 || bounds.length > 3) return null;
  const [from, to] = bounds;
  const step = bounds.length === 3 ? readInteger(bounds[2]) : 1;
  if (step === null) return null;
  // A step of nothing would not terminate. bash reads `{1..3..0}` as a step of
  // one, and so does the reference package, so no loop here can fail to end.
  const size = Math.abs(step) || 1;
  const numeric = readInteger(from) !== null && readInteger(to) !== null;
  if (!numeric) return alphaRange(from, to, size);
  return numberRange(from, to, size);
}

/** A plain decimal integer, optionally signed. No hex, no underscores, no NaN. */
function readInteger(text) {
  if (text.length === 0) return null;
  const codes = codesOf(text);
  let index = 0;
  let sign = 1;
  if (codes[0] === DASH) { sign = -1; index = 1; }
  if (index >= codes.length) return null;
  let value = 0;
  for (; index < codes.length; index += 1) {
    const code = codes[index];
    if (code < ZERO || code > NINE) return null;
    value = value * 10 + (code - ZERO);
  }
  return sign * value;
}

function numberRange(from, to, step) {
  const low = readInteger(from);
  const high = readInteger(to);
  // Bash pads the whole sequence when either bound was written padded.
  const padded = (from.length > 1 && from.charCodeAt(0) === ZERO)
    || (to.length > 1 && to.charCodeAt(0) === ZERO);
  const width = Math.max(from.length, to.length);
  const out = [];
  const down = low > high;
  for (let value = low; down ? value >= high : value <= high; value += down ? -step : step) {
    const text = String(value);
    out.push(padded && text.length < width ? '0'.repeat(width - text.length) + text : text);
    if (out.length > MAX_EXPANSIONS) fail('brace range is too long', 'TOO_MANY_EXPANSIONS');
  }
  return out;
}

function alphaRange(from, to, step) {
  if (from.length !== 1 || to.length !== 1) return null;
  const low = from.charCodeAt(0);
  const high = to.charCodeAt(0);
  const out = [];
  const down = low > high;
  for (let code = low; down ? code >= high : code <= high; code += down ? -step : step) {
    out.push(String.fromCharCode(code));
    if (out.length > MAX_EXPANSIONS) fail('brace range is too long', 'TOO_MANY_EXPANSIONS');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens. One pass over the characters of one segment, no lookbehind.
// ---------------------------------------------------------------------------

const LITERAL = 'literal';
const ANY = 'star';
const ONE = 'qmark';
const CLASS = 'class';
const EXT = 'ext';

/**
 * Compile one path segment into a token list. `magic` says whether anything in
 * it can match more than itself, and `leadingDot` whether it opens with a
 * literal dot -- the two facts the dot rule needs, decided here so the matcher
 * never has to look at the pattern text again.
 */
function tokenize(input, options, depth) {
  if (depth > MAX_EXTGLOB_DEPTH) fail('extglob nesting is too deep', 'TOO_DEEP');
  // nocase is done by folding both sides once, here and in matchSegment, rather
  // than by a flag threaded through every comparison.
  const segment = options.nocase ? input.toLowerCase() : input;
  const codes = codesOf(segment);
  const tokens = [];
  let literal = [];
  const flush = () => {
    if (literal.length > 0) {
      tokens.push({ kind: LITERAL, codes: Uint32Array.from(literal) });
      literal = [];
    }
  };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === BACKSLASH && !options.windowsPathsNoEscape && index + 1 < codes.length) {
      literal.push(codes[index + 1]);
      index += 1;
      continue;
    }
    if (isExtglobHead(code) && codes[index + 1] === LPAREN && !options.noext) {
      const close = matchingParen(codes, index + 1);
      if (close !== -1) {
        flush();
        const body = segment.slice(index + 2, close);
        const alts = splitTopLevel(body, PIPE)
          .map((one) => tokenize(one, options, depth + 1).tokens)
          .filter((alt) => alt.length > 0);
        // An alternation with nothing left in it matches the empty string, not
        // nothing at all: `@()b` matches `b`, because over there it compiles to
        // `(?:)b`. An empty alternative beside a real one is simply dropped, so
        // `@(a|)` does not match the empty name even though a shell says it does.
        tokens.push({ kind: EXT, op: code, alts: alts.length > 0 ? alts : [[]] });
        index = close;
        continue;
      }
    }
    if (code === STAR) {
      flush();
      // A run of stars in one segment says nothing more than one star does.
      while (codes[index + 1] === STAR) index += 1;
      tokens.push({ kind: ANY });
      continue;
    }
    if (code === QMARK) { flush(); tokens.push({ kind: ONE }); continue; }
    if (code === LBRACKET) {
      const parsed = readClass(codes, index, options);
      if (parsed !== null) {
        const only = soleCharacter(parsed.token);
        // `[a]` and `[a-a]` say what `a` says. Folding them into the literal is
        // not only tidier: it is what makes `[.]x` an explicit leading dot, and
        // an explicit leading dot is allowed to match one without dot:true.
        if (only !== null) { literal.push(only); index = parsed.end; continue; }
        flush();
        tokens.push(parsed.token);
        index = parsed.end;
        continue;
      }
    }
    literal.push(code);
  }
  flush();
  // A segment where every token compiles to nothing has no pattern in it at
  // all, and the reference package falls back to the text: `@()` is four
  // characters to match, while `@()b` is an empty alternation and then `b`.
  if (tokens.length > 0 && tokens.every(isVacuous)) {
    tokens.length = 0;
    tokens.push({ kind: LITERAL, codes });
  }
  const magic = tokens.some((token) => token.kind !== LITERAL);
  // A star, a question mark or a bracket refuses `.` and `..` outright, and an
  // extglob group does not: `@(.)` and `!(a)` are allowed to name the two
  // entries every directory already has, because they name them on purpose.
  const sweeps = tokens.some((token) => token.kind === ANY
    || token.kind === ONE || token.kind === CLASS);
  const first = tokens[0];
  const leadingDot = first !== undefined && first.kind === LITERAL && first.codes[0] === DOT;
  return { tokens, magic, sweeps, leadingDot };
}

function isExtglobHead(code) {
  return code === AT || code === QMARK || code === STAR || code === PLUS || code === BANG;
}

/**
 * Does this token match the empty string and nothing else? Only an alternation
 * with no alternatives left. The complement form is excluded on purpose: the
 * complement of "nothing" is every non-empty name, which is a great deal.
 */
function isVacuous(token) {
  return token.kind === EXT && token.op !== BANG
    && token.alts.length === 1 && token.alts[0].length === 0;
}

/** The one character a bracket expression stands for, or null if it stands for more. */
function soleCharacter(token) {
  if (token.negate || token.classes.length > 0 || token.ranges.length !== 1) return null;
  const [low, high] = token.ranges[0];
  return low === high ? low : null;
}

function matchingParen(codes, open) {
  let depth = 0;
  for (let index = open; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === BACKSLASH) { index += 1; continue; }
    if (code === LPAREN) depth += 1;
    else if (code === RPAREN) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// The POSIX bracket classes. minimatch compiles each to a Unicode property
// escape, and without a RegExp there is no property table to borrow. Case is
// therefore decided by asking the character whether it changes when cased,
// which is right for every cased script rather than only for ASCII; separators
// and controls are small enough to list. What that still misses is stated in
// STDLIB.md by name -- a letter in a script with no case, and a digit outside
// ASCII, are not in a class here, because the table that would fix it is larger
// than this whole module.

/** Unicode Zs, plus Zl and Zp: every code point that is a space and not a control. */
const SPACES = Object.freeze(new Set([
  0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
]));

// Unicode P over ASCII, which is narrower than POSIX punct: `$ + < = > ^ ` | ~`
// are symbols rather than punctuation, and the reference package excludes them.
const PUNCT = Object.freeze(new Set([
  33, 34, 35, 37, 38, 39, 40, 41, 42, 44, 45, 46, 47, 58, 59, 63, 64, 91, 92, 93, 95, 123, 125,
]));

function cased(code, folded) {
  const character = String.fromCharCode(code);
  return folded === 'up' ? character.toLowerCase() !== character
    : character.toUpperCase() !== character;
}

function isControl(code) {
  return code < 32 || (code >= 127 && code <= 159);
}

const POSIX = Object.freeze({
  alpha: (code) => isUpper(code) || isLower(code),
  digit: (code) => code >= ZERO && code <= NINE,
  alnum: (code) => isUpper(code) || isLower(code) || (code >= ZERO && code <= NINE),
  upper: isUpper,
  lower: isLower,
  space: (code) => SPACES.has(code) || (code >= 9 && code <= 13),
  blank: (code) => code === 9 || (SPACES.has(code) && code !== 0x2028 && code !== 0x2029),
  cntrl: isControl,
  // POSIX print is graph plus the space, and this is the one class where the
  // reference package is not merely strange but wrong: it compiles [[:print:]]
  // to \p{C}, which is what it compiles [[:cntrl:]] to. Two class names cannot
  // mean the same thing when POSIX defines them as complements, so this one is
  // a deliberate divergence rather than parity, argued in STDLIB.md.
  print: (code) => POSIX.graph(code) || SPACES.has(code),
  graph: (code) => !isControl(code) && !SPACES.has(code)
    // Surrogate halves and the private-use blocks are Unicode C, so not graph.
    && !(code >= 0xD800 && code <= 0xF8FF),
  punct: (code) => PUNCT.has(code),
  xdigit: (code) => (code >= ZERO && code <= NINE)
    || (code >= 65 && code <= 70) || (code >= 97 && code <= 102),
  word: (code) => isUpper(code) || isLower(code) || (code >= ZERO && code <= NINE) || code === 95,
});

function isUpper(code) { return cased(code, 'up'); }
function isLower(code) { return cased(code, 'down'); }

/**
 * A bracket expression, or null when the bracket never closes -- in which case
 * the `[` was a literal all along, which is what a shell does too.
 */
function readClass(codes, open, options) {
  let index = open + 1;
  let negate = false;
  if (codes[index] === BANG || codes[index] === CARET) { negate = true; index += 1; }
  const ranges = [];
  const classes = [];
  let first = true;
  while (index < codes.length) {
    let code = codes[index];
    if (code === RBRACKET && !first) {
      return { token: { kind: CLASS, negate, ranges, classes }, end: index };
    }
    first = false;
    if (code === LBRACKET && codes[index + 1] === COLON) {
      const closed = findPosixEnd(codes, index + 2);
      if (closed !== -1) {
        const name = String.fromCharCode(...codes.slice(index + 2, closed));
        if (Object.hasOwn(POSIX, name)) {
          // Under nocase, `[[:upper:]]` cannot mean upper: minimatch compiles
          // the class with the `i` flag, where a case class stops discriminating.
          const folded = options.nocase && (name === 'upper' || name === 'lower')
            ? 'alpha' : name;
          classes.push(folded);
          index = closed + 2;
          continue;
        }
      }
    }
    if (code === BACKSLASH && !options.windowsPathsNoEscape && index + 1 < codes.length) {
      index += 1;
      code = codes[index];
    }
    if (codes[index + 1] === DASH && index + 2 < codes.length && codes[index + 2] !== RBRACKET) {
      let high = codes[index + 2];
      let step = 3;
      if (high === BACKSLASH && index + 3 < codes.length) { high = codes[index + 3]; step = 4; }
      ranges.push([code, high]);
      index += step;
      continue;
    }
    ranges.push([code, code]);
    index += 1;
  }
  return null;
}

function findPosixEnd(codes, from) {
  for (let index = from; index + 1 < codes.length; index += 1) {
    if (codes[index] === COLON && codes[index + 1] === RBRACKET) return index;
  }
  return -1;
}

function classMatches(token, code) {
  let hit = false;
  for (const [low, high] of token.ranges) {
    if (code >= low && code <= high) { hit = true; break; }
  }
  if (!hit) {
    for (const name of token.classes) {
      if (POSIX[name](code)) { hit = true; break; }
    }
  }
  return token.negate ? !hit : hit;
}

// ---------------------------------------------------------------------------
// The inner simulation: characters of one segment.
//
// `reach` is a set of positions in the name, held as one byte each. A token
// advances the whole set at once, so nothing is ever tried twice and nothing is
// ever undone. That is the property minimatch's RegExp did not have.
// ---------------------------------------------------------------------------

function empty(length) { return new Uint8Array(length + 1); }

/** A set holding exactly one position. */
function oneAt(position, length) {
  const set = empty(length);
  set[position] = 1;
  return set;
}

function anySet(set) {
  for (let index = 0; index < set.length; index += 1) if (set[index] === 1) return true;
  return false;
}

/** Add `from` into `into`, reporting whether anything was new. */
function union(into, from) {
  let grew = false;
  for (let index = 0; index < into.length; index += 1) {
    if (from[index] === 1 && into[index] === 0) { into[index] = 1; grew = true; }
  }
  return grew;
}

function advance(tokens, codes, start, options) {
  const length = codes.length;
  let reach = start;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const next = empty(length);
    if (token.kind === LITERAL) {
      const want = token.codes;
      for (let index = 0; index + want.length <= length; index += 1) {
        if (reach[index] === 0) continue;
        let same = true;
        for (let step = 0; step < want.length; step += 1) {
          if (codes[index + step] !== want[step]) { same = false; break; }
        }
        if (same) next[index + want.length] = 1;
      }
    } else if (token.kind === ONE) {
      for (let index = 0; index < length; index += 1) if (reach[index] === 1) next[index + 1] = 1;
    } else if (token.kind === CLASS) {
      for (let index = 0; index < length; index += 1) {
        if (reach[index] === 1 && classMatches(token, codes[index])) next[index + 1] = 1;
      }
    } else if (token.kind === ANY) {
      // A star is the one token that opens the set and never closes it: once a
      // position is reachable, so is every position after it.
      let open = false;
      for (let index = 0; index <= length; index += 1) {
        if (reach[index] === 1) open = true;
        if (open) next[index] = 1;
      }
    } else {
      union(next, advanceExt(token, codes, reach, options, tokens.slice(at + 1)));
    }
    reach = next;
    if (!anySet(reach)) return reach;
  }
  return reach;
}

/**
 * The five extglob forms. Four are closures over the alternatives and fall out
 * of the same fixed point; the fifth, `!(...)`, is a set complement and is the
 * only place this file pays for a second dimension: one pass per start
 * position. That is O(name^2) in the worst case and still cannot backtrack,
 * which is the trade being made on purpose.
 */
function advanceExt(token, codes, reach, options, rest) {
  const length = codes.length;
  const once = (from) => {
    const acc = empty(length);
    for (const alt of token.alts) union(acc, advance(alt, codes, from, options));
    return acc;
  };
  if (token.op === AT) return once(reach);
  if (token.op === QMARK) {
    const acc = Uint8Array.from(reach);
    union(acc, once(reach));
    return acc;
  }
  if (token.op === STAR || token.op === PLUS) {
    // Zero or more starts from where we are; one or more starts from one hop in.
    const acc = token.op === STAR ? Uint8Array.from(reach) : once(reach);
    while (union(acc, once(acc))) { /* until the set stops growing */ }
    return acc;
  }
  // The complement is a lookahead over the whole rest of the segment, not over
  // the run the group itself consumes: `!(a)*` refuses `ab`, because `a` and
  // then the trailing star reach the end of the name. So the refusal is decided
  // once per start position, and what the group consumes is then a plain star.
  const acc = empty(length);
  for (let start = 0; start <= length; start += 1) {
    if (reach[start] === 0 || acc[start] === 1) continue;
    let denied = false;
    for (const alt of token.alts) {
      const probe = [...bareStar(alt), ...bareStar(rest)];
      if (advance(probe, codes, oneAt(start, length), options)[length] === 1) {
        denied = true;
        break;
      }
    }
    if (denied) continue;
    for (let end = start; end <= length; end += 1) acc[end] = 1;
  }
  return acc;
}

/**
 * A star standing alone has to consume a character -- the same rule that makes
 * a segment of one star refuse an empty name. Inside the complement's lookahead
 * it applies to the alternative and to the remainder separately, which is why
 * `!(a)*` still matches `a` while `!(a)*b` does not match `ab`.
 */
function bareStar(tokens) {
  if (tokens.length !== 1 || tokens[0].kind !== ANY) return tokens;
  return [{ kind: ONE }, { kind: ANY }];
}

/** Does one name match one compiled segment? The dot rule lives here. */
function matchSegment(segment, name, options) {
  if (name === '') {
    // An empty name is not nothing. A bare `*` wants a character -- minimatch
    // compiles that one case as one-or-more and every other star as zero-or-
    // more -- while an extglob that may occur zero times is happy with none.
    // So the only special case is the segment that is nothing but a star.
    const [only] = segment.tokens;
    if (segment.tokens.length === 1 && only.kind === ANY) return false;
    return advance(segment.tokens, codesOf(''), oneAt(0, 0), options)[0] === 1;
  }
  if (!options.dot && !segment.leadingDot && name.charCodeAt(0) === DOT) return false;
  // `.*` matches `.git` and not `.` or `..`: a pattern that can match more than
  // itself must not sweep up the two entries every directory already has.
  if (segment.sweeps && (name === '.' || name === '..')) return false;
  const codes = codesOf(options.nocase ? name.toLowerCase() : name);
  const start = empty(codes.length);
  start[0] = 1;
  return advance(segment.tokens, codes, start, options)[codes.length] === 1;
}

// ---------------------------------------------------------------------------
// The outer simulation: segments of one path. Same trick, one level up.
// ---------------------------------------------------------------------------

function splitSegments(text) {
  const out = [];
  const codes = codesOf(text);
  let start = 0;
  for (let index = 0; index <= codes.length; index += 1) {
    if (index === codes.length || codes[index] === SLASH) {
      out.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return out;
}

/** Interior `//` says nothing; a leading one is the root and stays. */
function collapse(parts) {
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === '' && index > 0 && index < parts.length - 1) continue;
    out.push(parts[index]);
  }
  return out;
}

/**
 * `a/../b` is `b`, in the pattern rather than in the path: a segment that could
 * only be entered in order to leave again describes nothing. What cannot be
 * eaten is a `..` with nothing in front of it, or with `.`, `..` or `**` in
 * front of it -- a globstar spans any number of segments, so there is no single
 * one for the `..` to cancel. Only the pattern is rewritten this way; a path is
 * matched exactly as it is spelled.
 */
function resolveUp(parts, globstar) {
  const out = [];
  for (const part of parts) {
    const prior = out[out.length - 1];
    const blocked = prior === undefined || prior === '' || prior === '.'
      || prior === '..' || (globstar && prior === '**');
    if (part === '..' && !blocked) { out.pop(); continue; }
    out.push(part);
  }
  return out.length > 0 ? out : [''];
}

/**
 * `**` next to `**` says nothing twice. Collapsing them is not only tidier: it
 * is how minimatch decides whether a pattern counts as having a separator in
 * it, so `**` and `**\/**` answer matchBase the same way.
 */
function squash(segments) {
  return segments.filter((segment, index) => !(
    segment.kind === GLOBSTAR && index > 0 && segments[index - 1].kind === GLOBSTAR
  ));
}

function matchSet(segments, parts, options) {
  const depth = parts.length;
  let reach = empty(depth);
  reach[0] = 1;
  let ranOut = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = empty(depth);
    if (segment.kind === GLOBSTAR) {
      const last = index === segments.length - 1;
      for (let from = 0; from <= depth; from += 1) {
        if (reach[from] === 0) continue;
        // A trailing `**` wants at least one segment: `a/**` does not match `a`,
        // which is minimatch's answer and the one every tool has copied.
        if (!last) next[from] = 1;
        for (let over = from; over < depth; over += 1) {
          // `**` does not descend into a dot directory unless asked to, and it
          // never walks through `.` or `..` however you ask.
          const part = parts[over];
          if (part === '.' || part === '..') break;
          if (!options.dot && part.charCodeAt(0) === DOT) break;
          next[over + 1] = 1;
        }
      }
    } else {
      for (let from = 0; from < depth; from += 1) {
        if (reach[from] === 1 && matchSegment(segment, parts[from], options)) next[from + 1] = 1;
      }
    }
    reach = next;
    // The path is spent and the pattern is not: that is what `partial` means.
    if (options.partial && reach[depth] === 1) ranOut = true;
    if (!anySet(reach)) return options.partial === true && ranOut;
  }
  if (reach[depth] === 1) return true;
  // One trailing empty segment on the path side is noise: `a/b/` is `a/b`.
  if (depth > 0 && parts[depth - 1] === '' && reach[depth - 1] === 1) return true;
  return options.partial === true && ranOut;
}

// ---------------------------------------------------------------------------
// Compiling, and the surface minimatch is installed for.
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  dot: false,
  nocase: false,
  noext: false,
  nobrace: false,
  nocomment: false,
  noglobstar: false,
  matchBase: false,
  partial: false,
  nonegate: false,
  flipNegate: false,
  nonull: false,
  magicalBraces: false,
  windowsPathsNoEscape: false,
});

function settle(options) {
  if (options === undefined || options === null) return DEFAULTS;
  const settled = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(options, key)) settled[key] = options[key] === true || options[key] === 1;
  }
  return Object.freeze(settled);
}

/**
 * The compiled form, exported because a matcher you cannot inspect is a matcher
 * you have to trust. `sets` is one entry per brace expansion; each is a list of
 * segments, each segment a token list or the globstar marker.
 */
export function parse(pattern, options) {
  requireString(pattern, 'pattern');
  const settled = settle(options);
  let text = pattern;
  // `#` first, because a comment is not a pattern with a strange first letter.
  const comment = !settled.nocomment && text.charCodeAt(0) === HASH;
  let negate = false;
  let index = 0;
  // A leading run of `!` is negation, and it is eaten before the extglob parser
  // ever sees it -- which is why `!(a|b)` is "not the literal (a|b)" and matches
  // almost everything, rather than being the complement it looks like. Under
  // `nonegate` the run stays, and only then does `!(` become a complement.
  while (!comment && !settled.nonegate && text.charCodeAt(index) === BANG) {
    negate = !negate;
    index += 1;
  }
  text = text.slice(index);
  // On Windows a pattern arrives with backslashes and no intention of escaping
  // anything, so the flag turns them into separators rather than into escapes.
  if (settled.windowsPathsNoEscape) text = text.split(String.fromCharCode(BACKSLASH)).join(sep);
  // The same expansion twice is one pattern, and it has to be counted once:
  // `x{,}` expands to `x` and `x`, which is not two patterns and so is not the
  // brace magic that `magicalBraces` asks about.
  const expanded = comment ? [text] : [...new Set(braceExpand(text, settled))];
  const sets = expanded.map((one) => squash(
    resolveUp(collapse(splitSegments(one)), !settled.noglobstar).map((part) => (
      part === '**' && !settled.noglobstar ? { kind: GLOBSTAR } : tokenize(part, settled, 0)
    )),
  ));
  return Object.freeze({
    source: pattern, negate, comment, options: settled, sets: Object.freeze(sets),
  });
}

function testCompiled(compiled, path, options) {
  if (compiled.comment) return false;
  const parts = collapse(splitSegments(path));
  // matchBase is decided per brace expansion, not per pattern: `{a/b,c}` asks
  // about the whole path for `a/b` and about the basename for `c`. And the
  // basename is the last segment that is not empty, so a trailing slash does
  // not hand the matcher nothing to match.
  const based = options.matchBase ? [basename(parts)] : parts;
  let hit = false;
  for (const set of compiled.sets) {
    if (matchSet(set, options.matchBase && set.length === 1 ? based : parts, options)) {
      hit = true;
      break;
    }
  }
  if (compiled.negate && !options.flipNegate) return !hit;
  return hit;
}

function basename(parts) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== '') return parts[index];
  }
  return '';
}

/**
 * Does this path match this pattern? The name and the argument order are
 * minimatch's, so a rewritten call site needs no further editing.
 */
export function minimatch(path, pattern, options) {
  requireString(path, 'path');
  const settled = settle(options);
  return testCompiled(parse(pattern, settled), path, settled);
}

/** The same function under a name that is not a package's. */
export const matches = minimatch;

/**
 * Compile once, ask many times. minimatch exports a class for this; a closure
 * carries the same three facts without asking anyone to call `new`.
 */
export function matcher(pattern, options) {
  const settled = settle(options);
  const compiled = parse(pattern, settled);
  const test = (path) => {
    requireString(path, 'path');
    return testCompiled(compiled, path, settled);
  };
  test.pattern = pattern;
  test.options = settled;
  test.compiled = compiled;
  return test;
}

/** For Array#filter, argument order and all. */
export function filter(pattern, options) {
  const test = matcher(pattern, options);
  return (path) => test(path);
}

/**
 * Filter a list. Kept because minimatch exports it under this name; note that
 * it takes the list first, while `minimatch` above takes one path -- their
 * disagreement, preserved so a rewrite cannot change what a line means.
 */
export function match(list, pattern, options) {
  const settled = settle(options);
  const test = matcher(pattern, settled);
  const hits = list.filter((one) => test(one));
  return hits.length === 0 && settled.nonull ? [pattern] : hits;
}

/**
 * Is there anything in here that can match more than itself? Braces are not
 * magic by that definition: they are expanded away first, so `{a,b}` is two
 * plain names and `hasMagic` says no. `magicalBraces: true` asks the other
 * question, and only then does a group that produced more than one pattern
 * count. This is minimatch's rule, where it is a method on a compiled pattern
 * rather than a function -- and glob's, where it is a function like this one.
 */
export function hasMagic(pattern, options) {
  const compiled = parse(pattern, options);
  if (compiled.options.magicalBraces && compiled.sets.length > 1) return true;
  for (const set of compiled.sets) {
    for (const segment of set) {
      if (segment.kind === GLOBSTAR || segment.magic) return true;
    }
  }
  return false;
}

// What escape() escapes, and nothing else. A brace is left alone because
// escaping it would defeat brace expansion, and `!` because negation belongs to
// the pattern rather than to a position in it. The list is the reference
// package's; a wider one would be safer and would also stop being a round trip.
const MAGIC = Object.freeze(new Set(['?', '*', '(', ')', '[', ']']));

/** Make a literal string safe to use as a pattern. */
export function escape(literal, options) {
  requireString(literal, 'literal');
  const windows = settle(options).windowsPathsNoEscape;
  let out = '';
  for (const character of literal) {
    if (MAGIC.has(character)) {
      out += windows ? `[${character}]` : `\\${character}`;
      continue;
    }
    // A bracket cannot protect a backslash, so under that flag it travels as
    // itself and the round trip holds only for the six above.
    out += !windows && character === '\\' ? '\\\\' : character;
  }
  return out;
}

/** Undo either escaping form, so a round trip is a round trip. */
export function unescape(pattern, options) {
  requireString(pattern, 'pattern');
  const windows = settle(options).windowsPathsNoEscape;
  const codes = codesOf(pattern);
  let out = '';
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === LBRACKET && index + 2 < codes.length && codes[index + 2] === RBRACKET) {
      const inner = codes[index + 1];
      // A separator or a backslash in a one-character class is left alone: it
      // was never an escape, and unescaping it would change the path described.
      // A bracket that is itself escaped is left to the next branch.
      const escaped = !windows && index > 0 && codes[index - 1] === BACKSLASH;
      if (inner !== SLASH && inner !== BACKSLASH && !escaped) {
        out += String.fromCharCode(inner);
        index += 2;
        continue;
      }
    }
    if (!windows && code === BACKSLASH && index + 1 < codes.length && codes[index + 1] !== SLASH) {
      index += 1;
      out += String.fromCharCode(codes[index]);
      continue;
    }
    out += String.fromCharCode(code);
  }
  return out;
}

/** A module with your options already applied, as minimatch offers. */
export function defaults(options) {
  const preset = settle(options);
  const merge = (extra) => (extra === undefined ? preset : { ...preset, ...settle(extra) });
  return Object.freeze({
    minimatch: (path, pattern, extra) => minimatch(path, pattern, merge(extra)),
    matches: (path, pattern, extra) => minimatch(path, pattern, merge(extra)),
    match: (list, pattern, extra) => match(list, pattern, merge(extra)),
    matcher: (pattern, extra) => matcher(pattern, merge(extra)),
    filter: (pattern, extra) => filter(pattern, merge(extra)),
    hasMagic: (pattern, extra) => hasMagic(pattern, merge(extra)),
    parse: (pattern, extra) => parse(pattern, merge(extra)),
    globSync: (pattern, extra) => globSync(pattern, merge(extra)),
    escape, unescape, braceExpand, sep, GLOBSTAR, GlobError, defaults,
  });
}

/**
 * Present, and it throws. minimatch's makeRe hands back the compiled RegExp,
 * and the whole argument of this module is that it compiles none: CVE-2022-3517
 * was that object backtracking. Returning undefined would let a rewritten call
 * site fail somewhere else, hours later, so it fails here with a reason. The
 * codemod refuses to move a file that reaches for this name at all.
 */
export function makeRe() {
  fail('this module compiles no regular expression, so there is none to hand back; '
    + 'use matcher(pattern) for a reusable test', 'NO_REGEXP');
}

// ---------------------------------------------------------------------------
// The walk. Node's fs.globSync covers this; ours exists so the order is fixed,
// the ignore list is patterns rather than names, and one matcher decides both.
// ---------------------------------------------------------------------------

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Walk `cwd` and return every path matching any pattern, sorted, relative and
 * separated by `/` on every platform. Directories are pruned when no pattern
 * could still match inside them, which is the `partial` option earning its
 * keep: the same simulation that answers the question also decides where not
 * to look.
 */
export function globSync(patterns, options = {}) {
  const list = asList(patterns).map((one) => requireString(one, 'pattern'));
  const root = options.cwd ?? process.cwd();
  const depthLimit = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const tests = list.map((one) => matcher(one, options));
  const reaches = list.map((one) => matcher(one, { ...options, partial: true }));
  const skips = asList(options.ignore).map((one) => matcher(one, options));
  const found = [];
  const stack = [{ dir: root, prefix: '', depth: 0 }];
  while (stack.length > 0) {
    const here = stack.pop();
    let entries;
    try {
      entries = readdirSync(here.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = here.prefix === '' ? entry.name : here.prefix + sep + entry.name;
      if (skips.some((test) => test(path))) continue;
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink() && options.follow === true) {
        try { directory = statSync(join(here.dir, entry.name)).isDirectory(); } catch { directory = false; }
      }
      if (tests.some((test) => test(path)) && !(directory && options.nodir === true)) {
        found.push(directory && options.mark === true ? path + sep : path);
      }
      if (directory && here.depth + 1 <= depthLimit && reaches.some((test) => test(path))) {
        stack.push({ dir: join(here.dir, entry.name), prefix: path, depth: here.depth + 1 });
      }
    }
  }
  found.sort();
  return options.absolute === true ? found.map((one) => join(root, one)) : found;
}

// One object with everything on it, for the call sites that took the whole
// package as a default import. Frozen, so nobody monkey-patches the matcher.
const glob = Object.freeze({
  minimatch,
  matches,
  match,
  matcher,
  filter,
  hasMagic,
  parse,
  braceExpand,
  escape,
  unescape,
  defaults,
  makeRe,
  globSync,
  sep,
  GLOBSTAR,
  GlobError,
});

export default glob;
