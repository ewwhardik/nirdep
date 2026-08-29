// A deliberately small TOML reader.
//
// Node ships no TOML parser -- see STDLIB.md. We need exactly enough of TOML
// 1.0 to read our own .zero-dep.toml, so this covers tables, arrays of tables,
// dotted keys, the four string forms, integers, floats, booleans, arrays and
// inline tables, and it refuses anything else with a line and column rather
// than guessing. It is not toml-test complete and does not pretend to be:
// offsets are tracked from the first character so the refusal is useful.

export class TomlError extends Error {
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'TomlError';
    this.line = line;
    this.column = column;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Reader {
  constructor(source) {
    this.s = source;
    this.i = 0;
    this.line = 1;
    this.col = 1;
  }

  get done() {
    return this.i >= this.s.length;
  }

  peek(offset = 0) {
    return this.s[this.i + offset];
  }

  next() {
    const ch = this.s[this.i++];
    if (ch === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return ch;
  }

  eat(literal) {
    if (this.s.startsWith(literal, this.i)) {
      for (let n = 0; n < literal.length; n += 1) this.next();
      return true;
    }
    return false;
  }

  fail(message) {
    throw new TomlError(message, this.line, this.col);
  }
}

function skipInlineSpace(r) {
  while (!r.done && (r.peek() === ' ' || r.peek() === '\t')) r.next();
}

function skipComment(r) {
  if (r.peek() !== '#') return;
  while (!r.done && r.peek() !== '\n') r.next();
}

// Blank lines and comments between statements.
function skipBlank(r) {
  for (;;) {
    skipInlineSpace(r);
    if (r.peek() === '#') {
      skipComment(r);
      continue;
    }
    if (r.peek() === '\r') {
      r.next();
      continue;
    }
    if (r.peek() === '\n') {
      r.next();
      continue;
    }
    return;
  }
}

function expectLineEnd(r) {
  skipInlineSpace(r);
  skipComment(r);
  if (r.done) return;
  if (r.peek() === '\r') r.next();
  if (r.done) return;
  if (r.peek() !== '\n') r.fail(`unexpected ${JSON.stringify(r.peek())} after value`);
  r.next();
}

const ESCAPES = {
  b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\',
};

function readEscape(r) {
  const ch = r.next();
  if (ch in ESCAPES) return ESCAPES[ch];
  if (ch === 'u' || ch === 'U') {
    const width = ch === 'u' ? 4 : 8;
    let hex = '';
    for (let n = 0; n < width; n += 1) hex += r.next();
    if (!/^[0-9a-fA-F]+$/.test(hex)) r.fail(`invalid \\${ch} escape ${JSON.stringify(hex)}`);
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff) r.fail(`escape \\${ch}${hex} is out of Unicode range`);
    return String.fromCodePoint(code);
  }
  return r.fail(`unknown escape \\${ch}`);
}

function readBasicString(r) {
  let out = '';
  for (;;) {
    if (r.done) r.fail('unterminated basic string');
    const ch = r.next();
    if (ch === '"') return out;
    if (ch === '\n') r.fail('newline in basic string; use """ for multi-line');
    out += ch === '\\' ? readEscape(r) : ch;
  }
}

function readMultilineBasicString(r) {
  if (r.peek() === '\n') r.next();
  else if (r.peek() === '\r' && r.peek(1) === '\n') { r.next(); r.next(); }
  let out = '';
  for (;;) {
    if (r.done) r.fail('unterminated multi-line basic string');
    if (r.s.startsWith('"""', r.i)) {
      // Three to five quotes may close the string; the surplus is content.
      let quotes = 0;
      while (r.peek(quotes) === '"') quotes += 1;
      if (quotes > 5) r.fail(`${quotes} consecutive quotes; at most five may close a string`);
      out += '"'.repeat(quotes - 3);
      for (let n = 0; n < quotes; n += 1) r.next();
      return out;
    }
    const ch = r.next();
    if (ch !== '\\') { out += ch; continue; }
    // A backslash at end of line trims the whitespace run that follows. Look
    // ahead without consuming, so line and column stay truthful either way.
    let k = r.i;
    while (r.s[k] === ' ' || r.s[k] === '\t') k += 1;
    if (r.s[k] === '\r') k += 1;
    if (r.s[k] === '\n') {
      while (r.i <= k) r.next();
      while (!r.done && ' \t\r\n'.includes(r.peek())) r.next();
      continue;
    }
    out += readEscape(r);
  }
}

function readLiteralString(r) {
  let out = '';
  for (;;) {
    if (r.done) r.fail('unterminated literal string');
    const ch = r.next();
    if (ch === "'") return out;
    if (ch === '\n') r.fail("newline in literal string; use ''' for multi-line");
    out += ch;
  }
}

function readMultilineLiteralString(r) {
  if (r.peek() === '\n') r.next();
  else if (r.peek() === '\r' && r.peek(1) === '\n') { r.next(); r.next(); }
  let out = '';
  for (;;) {
    if (r.done) r.fail('unterminated multi-line literal string');
    if (r.s.startsWith("'''", r.i)) {
      let quotes = 0;
      while (r.peek(quotes) === "'") quotes += 1;
      if (quotes > 5) r.fail(`${quotes} consecutive apostrophes; at most five may close a string`);
      out += "'".repeat(quotes - 3);
      for (let n = 0; n < quotes; n += 1) r.next();
      return out;
    }
    out += r.next();
  }
}

function readString(r) {
  if (r.s.startsWith('"""', r.i)) {
    for (let n = 0; n < 3; n += 1) r.next();
    return readMultilineBasicString(r);
  }
  if (r.s.startsWith("'''", r.i)) {
    for (let n = 0; n < 3; n += 1) r.next();
    return readMultilineLiteralString(r);
  }
  if (r.peek() === '"') { r.next(); return readBasicString(r); }
  r.next();
  return readLiteralString(r);
}

// A dotted key path: bare, quoted or a mixture, separated by dots.
function readKeyPath(r) {
  const path = [];
  for (;;) {
    skipInlineSpace(r);
    const ch = r.peek();
    if (ch === '"' || ch === "'") {
      path.push(readString(r));
    } else if (ch !== undefined && BARE_KEY.test(ch)) {
      let key = '';
      while (!r.done && BARE_KEY.test(r.peek())) key += r.next();
      path.push(key);
    } else {
      r.fail(ch === undefined ? 'expected a key, found end of input' : `expected a key, found ${JSON.stringify(ch)}`);
    }
    skipInlineSpace(r);
    if (r.peek() !== '.') return path;
    r.next();
  }
}

const INTEGER = /^[+-]?(0|[1-9](_?[0-9])*)$/;
const RADIX = /^0(x[0-9a-fA-F](_?[0-9a-fA-F])*|o[0-7](_?[0-7])*|b[01](_?[01])*)$/;
const FLOAT = /^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$/;
const DATELIKE = /^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/;

function classifyScalar(r, raw, line, column) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (DATELIKE.test(raw)) {
    throw new TomlError(`dates and times are not supported by this reader: ${raw}`, line, column);
  }
  if (raw === 'inf' || raw === '+inf') return Infinity;
  if (raw === '-inf') return -Infinity;
  if (raw === 'nan' || raw === '+nan' || raw === '-nan') return NaN;
  if (RADIX.test(raw)) {
    const digits = raw.slice(2).replaceAll('_', '');
    return Number.parseInt(digits, { x: 16, o: 8, b: 2 }[raw[1]]);
  }
  if (INTEGER.test(raw)) return Number.parseInt(raw.replaceAll('_', ''), 10);
  if (FLOAT.test(raw)) return Number.parseFloat(raw.replaceAll('_', ''));
  throw new TomlError(`not a valid TOML value: ${JSON.stringify(raw)}`, line, column);
}

function readValue(r) {
  skipInlineSpace(r);
  const ch = r.peek();
  if (ch === undefined) r.fail('expected a value, found end of input');
  if (ch === '"' || ch === "'") return readString(r);
  if (ch === '[') return readArray(r);
  if (ch === '{') return readInlineTable(r);
  const { line, col } = r;
  let raw = '';
  while (!r.done && !',]}#\r\n \t'.includes(r.peek())) raw += r.next();
  return classifyScalar(r, raw, line, col);
}

function readArray(r) {
  r.next();
  const out = [];
  for (;;) {
    skipBlank(r);
    if (r.done) r.fail('unterminated array');
    if (r.peek() === ']') { r.next(); return out; }
    out.push(readValue(r));
    skipBlank(r);
    if (r.peek() === ',') { r.next(); continue; }
    skipBlank(r);
    if (r.peek() === ']') { r.next(); return out; }
    r.fail(`expected "," or "]" in array, found ${JSON.stringify(r.peek() ?? '<end>')}`);
  }
}

function readInlineTable(r) {
  r.next();
  const out = Object.create(null);
  skipInlineSpace(r);
  if (r.peek() === '}') { r.next(); return out; }
  for (;;) {
    const path = readKeyPath(r);
    skipInlineSpace(r);
    if (r.peek() !== '=') r.fail(`expected "=" after key ${path.join('.')}`);
    r.next();
    assign(r, out, path, readValue(r));
    skipInlineSpace(r);
    if (r.peek() === ',') { r.next(); skipInlineSpace(r); continue; }
    if (r.peek() === '}') { r.next(); return out; }
    r.fail(`expected "," or "}" in inline table, found ${JSON.stringify(r.peek() ?? '<end>')}`);
  }
}

// Walk down a key path, creating tables as needed. When a segment is an array
// of tables the path continues into its most recent element -- and note that we
// must not write that element back over the array, which is the kind of mistake
// that silently turns [[p]] into a single table.
function descend(r, root, path, upto) {
  let node = root;
  for (let n = 0; n < upto; n += 1) {
    const key = path[n];
    if (node[key] === undefined) node[key] = Object.create(null);
    const child = Array.isArray(node[key]) ? node[key].at(-1) : node[key];
    if (child === null || typeof child !== 'object') {
      r.fail(`cannot extend ${path.slice(0, n + 1).join('.')}, it is not a table`);
    }
    node = child;
  }
  return node;
}

function assign(r, root, path, value) {
  const node = descend(r, root, path, path.length - 1);
  const last = path.at(-1);
  if (last in node) r.fail(`duplicate key ${path.join('.')}`);
  node[last] = value;
}

function tableAt(r, root, path, arrayOfTables) {
  const node = descend(r, root, path, path.length - 1);
  const last = path.at(-1);
  if (arrayOfTables) {
    if (node[last] === undefined) node[last] = [];
    if (!Array.isArray(node[last])) r.fail(`${path.join('.')} is already a table, not an array of tables`);
    const fresh = Object.create(null);
    node[last].push(fresh);
    return fresh;
  }
  if (node[last] === undefined) node[last] = Object.create(null);
  if (Array.isArray(node[last])) r.fail(`${path.join('.')} is an array of tables; use [[${path.join('.')}]]`);
  return node[last];
}

/**
 * Parse a TOML document into a plain object.
 * Throws TomlError with a line and column for anything it will not accept.
 */
export function parseToml(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const r = new Reader(text);
  const root = Object.create(null);
  let current = root;
  for (;;) {
    skipBlank(r);
    if (r.done) return root;
    if (r.peek() === '[') {
      r.next();
      const arrayOfTables = r.peek() === '[';
      if (arrayOfTables) r.next();
      const path = readKeyPath(r);
      skipInlineSpace(r);
      if (!r.eat(arrayOfTables ? ']]' : ']')) r.fail('unterminated table header');
      current = tableAt(r, root, path, arrayOfTables);
      expectLineEnd(r);
      continue;
    }
    const path = readKeyPath(r);
    skipInlineSpace(r);
    if (r.peek() !== '=') r.fail(`expected "=" after key ${path.join('.')}`);
    r.next();
    assign(r, current, path, readValue(r));
    expectLineEnd(r);
  }
}
