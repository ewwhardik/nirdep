// A JavaScript tokeniser, written by hand, because the codemod half of nirdep has
// to read real source files and there is nothing in Node that will tokenise
// JavaScript for you. `node:vm` will tell you whether a string parses and refuse
// to say anything else about it; that is the syntax gate, not a reader.
//
// This is a lexer and deliberately not a parser. A rewrite of an import site needs
// three things: where every token starts and ends, which of them are identifiers in
// a position that could be a reference, and where the scope boundaries are. All
// three are token-level facts. A full AST would buy accuracy we can get more
// cheaply and would cost a tree walk over every file in someone's project.
//
// Two things in JavaScript cannot be tokenised without context, and both are
// handled here rather than papered over:
//
//   `/`   is division or the start of a regular expression depending on what came
//         before it. `a / b` and `if (a) /b/.test(c)` differ only in the token
//         preceding the slash, and for `)` and `}` that token is not enough: the
//         lexer has to remember whether the `(` belonged to `if`/`while`/`for` and
//         whether the `{` opened a block or an object literal. There is a stack.
//
//   `}`   closes a block, an object literal, or a template substitution, and in the
//         third case the characters after it are template text rather than code.
//         The same stack answers that.
//
// Every token carries its byte range, so `source.slice(token.start, token.end)` is
// the token's own text. `tests/lex/lexer.test.mjs` lexes every .mjs file in this
// repository and reassembles the source from the ranges: if the concatenation is
// not byte-identical to the input, the lexer is wrong somewhere and the test says
// where. That property is the reason the patcher downstream can work in byte
// ranges and never has to print code back out.

/** The token kinds. Strings rather than numbers, because they appear in failures. */
export const KIND = Object.freeze({
  NAME: 'name',
  PRIVATE: 'private',
  KEYWORD: 'keyword',
  PUNCT: 'punct',
  NUMBER: 'number',
  STRING: 'string',
  TEMPLATE: 'template',
  REGEXP: 'regexp',
  COMMENT: 'comment',
  SHEBANG: 'shebang',
  EOF: 'eof',
});

/** Raised for input that cannot be tokenised at all. Carries a position. */
export class LexError extends SyntaxError {
  constructor(code, message, position) {
    super(`${message} at line ${position.line}, column ${position.column}`);
    this.name = 'LexError';
    this.code = code;
    this.line = position.line;
    this.column = position.column;
    this.offset = position.offset;
  }
}

// -- the word lists ----------------------------------------------------------
//
// Reserved words as of ES2024. `let`, `static`, `yield` and `await` are reserved
// only in some contexts and are listed anyway: this lexer's callers use the
// distinction to decide whether an identifier could be a reference, and treating a
// contextual keyword as a keyword is the safe direction — it means the codemod
// declines to rename something rather than renaming the wrong thing.
//
// One space-separated string rather than a list of quoted words, because
// `tools/verify.mjs` scans this file for import-shaped text and a quoted word
// followed by a comma and another quoted word is exactly that shape. The proof
// script is deliberately blunt and the fix belongs on this side of it.

export const KEYWORDS = Object.freeze(new Set(`
  await break case catch class const continue debugger default delete do else
  enum export extends false finally for function if import in instanceof let new
  null return static super switch this throw true try typeof var void while with
  yield
`.split(/\s+/u).filter(Boolean)));


/**
 * Keywords after which a `/` begins a regular expression rather than a division.
 * `return /x/` is a regular expression; `a / x` is not. The list is every keyword
 * that can be followed by an expression, which is most of them — the interesting
 * members are the ones left out: `this`, `super`, `true`, `false` and `null` all
 * end an expression, so a slash after them divides.
 */
const KEYWORD_BEFORE_REGEXP = Object.freeze(new Set([
  'await', 'case', 'default', 'delete', 'do', 'else', 'extends', 'in',
  'instanceof', 'new', 'return', 'throw', 'typeof', 'void', 'yield',
]));

/**
 * Punctuators, longest first, so that `>>>=` is never read as `>>` followed by
 * `>=`. The order of this array is the matching order and is load-bearing.
 */
const PUNCTUATORS = Object.freeze([
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '#', '@',
]);

/** Punctuators after which a `/` begins a regular expression. */
const PUNCT_BEFORE_REGEXP = Object.freeze(new Set([
  '{', '(', '[', ';', ',', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '+',
  '-', '*', '/', '%', '**', '++', '--', '<<', '>>', '>>>', '&', '|', '^', '!',
  '~', '&&', '||', '??', '?', ':', '=', '+=', '-=', '*=', '/=', '%=', '**=',
  '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', '=>', '...',
]));

// -- characters --------------------------------------------------------------
//
// Character codes rather than string comparisons: these run once per character of
// every file the codemod reads, and a project of any size is megabytes of input.

const isDigit = (code) => code >= 48 && code <= 57;
const isHexDigit = (code) => isDigit(code)
  || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
const isOctalDigit = (code) => code >= 48 && code <= 55;

/**
 * The four line terminators the specification names. U+2028 and U+2029 are line
 * terminators in JavaScript and are not in anyone's idea of "\r\n", which is why
 * they are listed: a file containing one would otherwise have every subsequent line
 * number reported wrong, and a wrong line number in a codemod's diff is worse than
 * no line number.
 */
const isNewline = (code) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/** Every space the specification allows between tokens, including the exotic ones. */
const isSpace = (code) => code === 32 || code === 9 || code === 11 || code === 12
  || code === 0xa0 || code === 0xfeff
  || (code >= 0x1680 && (code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x202f || code === 0x205f || code === 0x3000));

const isAsciiIdStart = (code) => (code >= 97 && code <= 122)
  || (code >= 65 && code <= 90) || code === 36 || code === 95;

/**
 * Identifier characters beyond ASCII. The Unicode tables for ID_Start and
 * ID_Continue are tens of thousands of code points, and shipping a copy of them
 * would be both large and stale by the next Unicode release, so this asks the
 * engine's own tables through a property escape. It is a single-character test
 * against a compiled character class: there is no input to backtrack over, so this
 * is not the kind of pattern that CVE-2022-25883 was about. The ASCII path above
 * runs first and handles all but a fraction of a percent of real source.
 */
const ID_START_BEYOND_ASCII = /\p{ID_Start}/u;
const ID_CONTINUE_BEYOND_ASCII = /\p{ID_Continue}/u;

const isIdStart = (code) => isAsciiIdStart(code)
  || (code > 127 && ID_START_BEYOND_ASCII.test(String.fromCodePoint(code)));

const isIdPart = (code) => isAsciiIdStart(code) || isDigit(code)
  || code === 0x200c || code === 0x200d
  || (code > 127 && ID_CONTINUE_BEYOND_ASCII.test(String.fromCodePoint(code)));

/**
 * Punctuators after which a `{` opens an object literal rather than a block. This
 * is a whitelist on purpose. Guessing "block" when the truth is "object literal"
 * costs us at most a misread slash inside an expression nobody writes; guessing
 * "object literal" when the truth is a block would make `if (x) {} /re/.test(y)`
 * read as a division and take the rest of the file with it. So anything not listed
 * here is a block.
 */
const PUNCT_BEFORE_OBJECT = Object.freeze(new Set([
  '(', ',', '[', '=', ':', '?', '+', '-', '*', '/', '%', '**', '<', '>', '<=',
  '>=', '==', '!=', '===', '!==', '&&', '||', '??', '!', '~', '+=', '-=', '*=',
  '/=', '%=', '**=', '&&=', '||=', '??=', '=', '...', '&', '|', '^',
]));

/** Keywords after which a `{` opens an object literal. */
const KEYWORD_BEFORE_OBJECT = Object.freeze(new Set([
  'return', 'typeof', 'case', 'throw', 'yield', 'await', 'delete', 'void', 'in',
  'instanceof', 'of', 'default',
]));

/** Keywords whose parenthesis is a statement head, so a `/` after its `)` is a regexp. */
const STATEMENT_HEAD = Object.freeze(new Set(['if', 'while', 'for', 'with', 'switch', 'catch']));

// -- the scanner -------------------------------------------------------------

/**
 * Tokenise `source`. Returns a frozen result:
 *
 *   tokens    every token except comments, in order, each with `start`, `end`,
 *             `value` (its own text), `kind`, `line`, `column`, and `newlineBefore`
 *   comments  the comments, same shape, kept separately because a caller walking
 *             for references does not want them in the stream and a caller
 *             reassembling the file does
 *   lineStarts the offset of each line, so a byte offset can be turned into a
 *             position without rescanning
 *
 * Throws `LexError` for input that cannot be tokenised: an unterminated string,
 * template, comment or regular expression, or a character that starts nothing.
 */
export function lex(source, options = {}) {
  if (typeof source !== 'string') {
    throw new LexError('NOT_A_STRING', `source must be a string, not ${typeof source}`, { line: 1, column: 1, offset: 0 });
  }
  const tokens = [];
  const comments = [];
  const lineStarts = [0];
  const stack = [];
  let at = 0;
  let line = 1;
  let lineStart = 0;
  let newlineBefore = false;
  let previous = null;

  const here = () => ({ line, column: at - lineStart + 1, offset: at });
  const fail = (code, message, position = here()) => { throw new LexError(code, message, position); };

  /** Record a line break at `at`, having already stepped over its characters. */
  const countLine = () => {
    line += 1;
    lineStart = at;
    lineStarts.push(at);
    newlineBefore = true;
  };

  const push = (kind, start, startLine, startColumn, extra) => {
    const token = {
      kind,
      value: source.slice(start, at),
      start,
      end: at,
      line: startLine,
      column: startColumn,
      newlineBefore,
      ...extra,
    };
    (kind === KIND.COMMENT ? comments : tokens).push(token);
    if (kind !== KIND.COMMENT) {
      previous = token;
      newlineBefore = false;
    }
    return token;
  };

  /**
   * Could a `/` here start a regular expression? Everything hangs off the previous
   * significant token, and for `)` and `}` off what that token closed — which the
   * token itself records, because the stack knew at the time and does not now.
   */
  const regexpAllowed = () => {
    if (previous === null) return true;
    if (previous.kind === KIND.KEYWORD) return KEYWORD_BEFORE_REGEXP.has(previous.value);
    if (previous.kind !== KIND.PUNCT) return false;
    if (previous.value === ')') return previous.statementHead === true;
    if (previous.value === '}') return previous.closesBlock === true;
    return PUNCT_BEFORE_REGEXP.has(previous.value);
  };

  /** Does a `{` here open an object literal? See PUNCT_BEFORE_OBJECT for the bias. */
  const objectAllowed = () => {
    if (previous === null) return false;
    if (previous.kind === KIND.KEYWORD) return KEYWORD_BEFORE_OBJECT.has(previous.value);
    if (previous.kind === KIND.NAME) return previous.value === 'of' || previous.value === 'from';
    if (previous.kind !== KIND.PUNCT) return false;
    if (previous.value === ')' || previous.value === '}') return false;
    return PUNCT_BEFORE_OBJECT.has(previous.value);
  };

  /** Whitespace and line terminators between tokens. Comments are read as tokens. */
  const skipSpace = () => {
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === 13) {
        at += 1;
        if (source.charCodeAt(at) === 10) at += 1;
        countLine();
        continue;
      }
      if (isNewline(code)) {
        at += 1;
        countLine();
        continue;
      }
      if (isSpace(code)) {
        at += 1;
        continue;
      }
      return;
    }
  };

  /** An identifier or keyword, including a `#private` name. */
  const readName = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    const isPrivate = source.charCodeAt(at) === 35;
    if (isPrivate) at += 1;
    if (at >= source.length || !isIdStart(source.codePointAt(at))) {
      if (isPrivate) fail('BAD_PRIVATE_NAME', 'a # must be followed by a name');
    }
    while (at < source.length) {
      const code = source.codePointAt(at);
      // `A` and `\u{41}` are legal inside an identifier, and minifiers emit them
      // to hide reserved words. Consumed as part of the name, not decoded: the codemod
      // compares names by text, and a name spelled with an escape is a name we decline
      // to rewrite rather than one we silently mis-match.
      if (code === 92 && source.charCodeAt(at + 1) === 117) {
        at += 2;
        if (source.charCodeAt(at) === 123) {
          while (at < source.length && source.charCodeAt(at) !== 125) at += 1;
          at += 1;
          continue;
        }
        at += 4;
        continue;
      }
      if (!isIdPart(code)) break;
      at += code > 0xffff ? 2 : 1;
    }
    const text = source.slice(start, at);
    const kind = isPrivate ? KIND.PRIVATE : (KEYWORDS.has(text) ? KIND.KEYWORD : KIND.NAME);
    return push(kind, start, startLine, startColumn);
  };

  /**
   * A quoted string. The escape handling exists to find the closing quote, not to
   * decode the value: `'\\'` ends at the third quote and `'a\<newline>b'` continues
   * across a line. A caller that wants the value calls `stringValue` below.
   */
  const readString = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    const quote = source.charCodeAt(at);
    at += 1;
    while (true) {
      if (at >= source.length) fail('UNTERMINATED_STRING', 'the string never closes', { line: startLine, column: startColumn, offset: start });
      const code = source.charCodeAt(at);
      if (code === 92) {
        at += 1;
        if (at < source.length) {
          const escaped = source.charCodeAt(at);
          at += 1;
          if (escaped === 13 && source.charCodeAt(at) === 10) at += 1;
          if (isNewline(escaped)) countLine();
        }
        continue;
      }
      if (code === quote) {
        at += 1;
        return push(KIND.STRING, start, startLine, startColumn, { quote: String.fromCharCode(quote) });
      }
      // A bare line terminator inside a quoted string is a syntax error, and saying so
      // is more useful than reading to the end of the file looking for a quote.
      if (isNewline(code)) fail('UNTERMINATED_STRING', 'a line break inside a string');
      at += 1;
    }
  };

  /**
   * A template literal, or the continuation of one after a `}`. Templates nest — a
   * substitution can contain another template — so the boundary is tracked on the
   * same stack that answers the brace question, and each piece is its own token:
   * `full`, `head` (ends in `${`), `middle` (`}` to `${`) or `tail` (`}` to a quote).
   */
  const readTemplate = (resuming) => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    at += 1;
    while (true) {
      if (at >= source.length) fail('UNTERMINATED_TEMPLATE', 'the template never closes', { line: startLine, column: startColumn, offset: start });
      const code = source.charCodeAt(at);
      if (code === 92) {
        at += 1;
        if (at < source.length) {
          if (isNewline(source.charCodeAt(at))) {
            at += 1;
            countLine();
          } else {
            at += 1;
          }
        }
        continue;
      }
      if (code === 13) {
        at += 1;
        if (source.charCodeAt(at) === 10) at += 1;
        countLine();
        continue;
      }
      if (isNewline(code)) {
        at += 1;
        countLine();
        continue;
      }
      if (code === 96) {
        at += 1;
        return push(KIND.TEMPLATE, start, startLine, startColumn, { part: resuming ? 'tail' : 'full' });
      }
      if (code === 36 && source.charCodeAt(at + 1) === 123) {
        at += 2;
        stack.push({ type: 'substitution' });
        return push(KIND.TEMPLATE, start, startLine, startColumn, { part: resuming ? 'middle' : 'head' });
      }
      at += 1;
    }
  };

  /**
   * A numeric literal: decimal, hex, octal, binary, legacy octal, exponent form,
   * `1_000` separators, and the BigInt `n` suffix. The value is not computed — the
   * codemod needs to know where the token ends, and computing `0.1 + 0.2` here would
   * only invite someone to trust it.
   */
  const readNumber = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    const digits = (test) => {
      while (at < source.length && (test(source.charCodeAt(at)) || source.charCodeAt(at) === 95)) at += 1;
    };
    if (source.charCodeAt(at) === 48 && at + 1 < source.length) {
      const marker = source.charCodeAt(at + 1) | 32;
      if (marker === 120) { at += 2; digits(isHexDigit); }
      else if (marker === 111) { at += 2; digits(isOctalDigit); }
      else if (marker === 98) { at += 2; digits((code) => code === 48 || code === 49); }
      else if (isDigit(source.charCodeAt(at + 1))) { at += 1; digits(isDigit); }
    }
    if (at === start) {
      digits(isDigit);
      if (source.charCodeAt(at) === 46) {
        at += 1;
        digits(isDigit);
      }
      const exponent = source.charCodeAt(at) | 32;
      if (exponent === 101) {
        const mark = at;
        at += 1;
        if (source.charCodeAt(at) === 43 || source.charCodeAt(at) === 45) at += 1;
        if (!isDigit(source.charCodeAt(at))) at = mark;
        else digits(isDigit);
      }
    }
    if (source.charCodeAt(at) === 110) at += 1;
    // `3in x` is not a thing, and neither is `1.2.3`: a name touching the end of a
    // number is a mistake somewhere, and stopping here beats handing the caller two
    // tokens that were one typo.
    if (at < source.length && isIdStart(source.codePointAt(at))) {
      fail('BAD_NUMBER', 'a name touches the end of a number');
    }
    return push(KIND.NUMBER, start, startLine, startColumn);
  };

  /**
   * A regular expression literal, reached only when `regexpAllowed()` said so. The
   * body scan has to know about character classes, because `/[/]/` is one regexp and
   * not a division of two: inside `[...]` a slash is an ordinary character.
   */
  const readRegexp = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    at += 1;
    let inClass = false;
    while (true) {
      if (at >= source.length) fail('UNTERMINATED_REGEXP', 'the regular expression never closes', { line: startLine, column: startColumn, offset: start });
      const code = source.charCodeAt(at);
      if (isNewline(code)) fail('UNTERMINATED_REGEXP', 'a line break inside a regular expression');
      if (code === 92) {
        at += 2;
        continue;
      }
      if (code === 91) inClass = true;
      else if (code === 93) inClass = false;
      else if (code === 47 && !inClass) {
        at += 1;
        break;
      }
      at += 1;
    }
    while (at < source.length && isIdPart(source.codePointAt(at))) at += 1;
    return push(KIND.REGEXP, start, startLine, startColumn);
  };

  /** A line or block comment. Both are tokens; the caller decides whether to care. */
  const readComment = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    if (source.charCodeAt(at + 1) === 47) {
      at += 2;
      while (at < source.length && !isNewline(source.charCodeAt(at))) at += 1;
      return push(KIND.COMMENT, start, startLine, startColumn, { block: false });
    }
    at += 2;
    while (true) {
      if (at >= source.length) fail('UNTERMINATED_COMMENT', 'the block comment never closes', { line: startLine, column: startColumn, offset: start });
      const code = source.charCodeAt(at);
      if (code === 42 && source.charCodeAt(at + 1) === 47) {
        at += 2;
        return push(KIND.COMMENT, start, startLine, startColumn, { block: true });
      }
      if (code === 13) {
        at += 1;
        if (source.charCodeAt(at) === 10) at += 1;
        countLine();
        continue;
      }
      if (isNewline(code)) {
        at += 1;
        countLine();
        continue;
      }
      at += 1;
    }
  };

  /** The punctuator at `at`, longest match, with the stack bookkeeping it implies. */
  const readPunct = () => {
    const start = at;
    const startLine = line;
    const startColumn = at - lineStart + 1;
    const found = PUNCTUATORS.find((one) => source.startsWith(one, at));
    if (found === undefined) {
      fail('UNKNOWN_CHARACTER', `nothing starts with ${JSON.stringify(source[at])}`);
    }
    // `?.3` is a ternary followed by a number, not optional chaining: the one place
    // where the longest match is the wrong answer.
    const punct = found === '?.' && isDigit(source.charCodeAt(at + 2)) ? '?' : found;
    at += punct.length;
    if (punct === '(') {
      stack.push({
        type: 'paren',
        statementHead: previous !== null && previous.kind === KIND.KEYWORD && STATEMENT_HEAD.has(previous.value),
      });
      return push(KIND.PUNCT, start, startLine, startColumn);
    }
    if (punct === '[') {
      stack.push({ type: 'bracket' });
      return push(KIND.PUNCT, start, startLine, startColumn);
    }
    if (punct === '{') {
      stack.push({ type: objectAllowed() ? 'object' : 'block' });
      return push(KIND.PUNCT, start, startLine, startColumn);
    }
    if (punct === ')' || punct === ']') {
      const open = stack.pop();
      return push(KIND.PUNCT, start, startLine, startColumn, { statementHead: open?.statementHead === true });
    }
    if (punct === '}') {
      const open = stack.pop();
      return push(KIND.PUNCT, start, startLine, startColumn, { closesBlock: open?.type === 'block' });
    }
    return push(KIND.PUNCT, start, startLine, startColumn);
  };

  // A shebang is not JavaScript, but it is the first line of every CLI entry point in
  // the ecosystem, and a codemod that refused to read `bin/tool.mjs` would be useless.
  if (source.startsWith('#!')) {
    while (at < source.length && !isNewline(source.charCodeAt(at))) at += 1;
    push(KIND.SHEBANG, 0, 1, 1);
    previous = null;
  }

  while (true) {
    skipSpace();
    if (at >= source.length) break;
    const code = source.charCodeAt(at);
    if (code === 47) {
      const next = source.charCodeAt(at + 1);
      if (next === 47 || next === 42) { readComment(); continue; }
      if (regexpAllowed()) { readRegexp(); continue; }
      readPunct();
      continue;
    }
    if (code === 34 || code === 39) { readString(); continue; }
    if (code === 96) { readTemplate(false); continue; }
    // A `}` that closes a substitution is the start of more template text, so the
    // template reader takes over rather than the punctuator reader.
    if (code === 125 && stack.length > 0 && stack[stack.length - 1].type === 'substitution') {
      stack.pop();
      readTemplate(true);
      continue;
    }
    if (isDigit(code) || (code === 46 && isDigit(source.charCodeAt(at + 1)))) { readNumber(); continue; }
    if (code === 35 && at + 1 < source.length && isIdStart(source.codePointAt(at + 1))) { readName(); continue; }
    if (isIdStart(source.codePointAt(at))) { readName(); continue; }
    readPunct();
  }

  const end = { kind: KIND.EOF, value: '', start: at, end: at, line, column: at - lineStart + 1, newlineBefore };
  tokens.push(end);

  return Object.freeze({
    source,
    tokens: Object.freeze(tokens),
    comments: Object.freeze(comments),
    lineStarts: Object.freeze(lineStarts),
    unclosed: Object.freeze(stack.map((one) => one.type)),
  });
}

// -- reading a token's value -------------------------------------------------

/** The single-character meanings, so the decoder below is a lookup and not a switch. */
const ESCAPES = Object.freeze(new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'],
  ['0', '\0'],
]));

/**
 * The value of a string token: quotes removed, escapes decoded. This is what turns
 * the quoted specifier of an import statement into the name of the package, and it
 * has to be exact — a specifier spelled with an escape is the same import, and a
 * codemod that missed it would leave a dependency behind while reporting success.
 *
 * Template tokens are accepted too, with their delimiters stripped. A template with
 * a substitution has no single value, so only the literal text between delimiters is
 * returned and the caller is expected to know that `part` was not `full`.
 */
export function stringValue(token) {
  const text = token.kind === KIND.TEMPLATE
    ? token.value.slice(
      token.part === 'full' || token.part === 'head' ? 1 : 1,
      token.part === 'full' || token.part === 'tail' ? -1 : -2,
    )
    : token.value.slice(1, -1);
  let out = '';
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (character !== '\\') {
      out += character;
      at += 1;
      continue;
    }
    const next = text[at + 1];
    at += 2;
    if (next === undefined) return out;
    if (next === 'u') {
      if (text[at] === '{') {
        const close = text.indexOf('}', at);
        out += String.fromCodePoint(Number.parseInt(text.slice(at + 1, close), 16));
        at = close + 1;
        continue;
      }
      out += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16));
      at += 4;
      continue;
    }
    if (next === 'x') {
      out += String.fromCharCode(Number.parseInt(text.slice(at, at + 2), 16));
      at += 2;
      continue;
    }
    // A backslash before a line break is a line continuation: the break disappears.
    if (next === '\n' || next === '\u2028' || next === '\u2029') continue;
    if (next === '\r') {
      if (text[at] === '\n') at += 1;
      continue;
    }
    out += ESCAPES.get(next) ?? next;
  }
  return out;
}

/**
 * The line and column of a byte offset, from the line table the lexer already built.
 * Binary search, because a codemod reporting fifty rewrites in a large file would
 * otherwise rescan it fifty times.
 */
export function positionAt(result, offset) {
  const starts = result.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1, offset };
}

/**
 * True if the token stream reassembles into the source byte for byte, meaning the
 * lexer accounted for every character. The gaps between tokens must be whitespace
 * and nothing else. Exported rather than kept in the test because `nirdep apply`
 * runs it as a precondition: a file the lexer cannot fully account for is a file we
 * refuse to patch.
 */
export function accountsForEverySource(result) {
  const pieces = [...result.tokens, ...result.comments]
    .filter((one) => one.kind !== KIND.EOF)
    .sort((one, other) => one.start - other.start);
  let at = 0;
  for (const piece of pieces) {
    const gap = result.source.slice(at, piece.start);
    for (const character of gap) {
      const code = character.codePointAt(0);
      if (!isSpace(code) && !isNewline(code)) return false;
    }
    if (result.source.slice(piece.start, piece.end) !== piece.value) return false;
    at = piece.end;
  }
  for (const character of result.source.slice(at)) {
    const code = character.codePointAt(0);
    if (!isSpace(code) && !isNewline(code)) return false;
  }
  return true;
}
