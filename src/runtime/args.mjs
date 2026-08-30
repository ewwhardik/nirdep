// nirdep runtime: args -- the replacement for minimist, commander, yargs and
// yargs-parser. Roughly 190 million downloads a week between them.
//
// Published by Nastik AI. Developed by Hardik.
//
// What Node already gives you: util.parseArgs. It is deliberately small --
// strings and booleans, one flat result object, no subcommands, no counts, no
// arrays, no numbers, no choices, no environment fallback, no positional
// declarations, no generated help, no suggestion on a typo. Node core has
// declined all of that on purpose and says so in its own documentation. That
// declined surface is exactly the space the four packages above occupy.
//
// Two layers, because the packages split the same way:
//
//   parse(argv, spec)  the parser layer (minimist, yargs-parser): tokenising,
//                      clustering, negation, typing, defaults, validation.
//   createCli(spec)    the framework layer (commander, yargs): subcommands,
//                      positionals, generated help, did-you-mean, exit codes.
//
// Nothing here imports another nirdep module, including the colour one. Help
// rendering takes a plain `style` object of functions and defaults every one of
// them to the identity, so this file stays a single-file eject and the two
// runtime modules cannot rot against each other. bin/nirdep.mjs passes a colour
// instance in; the tests pass nothing and read plain text.
//
// Deliberate divergences from minimist, each argued in STDLIB.md:
//   * No automatic number coercion. minimist turns "--id 0123" into 123 and
//     "--v 1.10" into 1.1. A type must be declared.
//   * Keys that would reach Object.prototype are refused, not assigned.
//     That is CVE-2020-7598 and CVE-2021-44906, both in minimist, both from
//     accepting "--__proto__.x".
//   * A repeated option is last-wins unless it declares multiple: true.
//     minimist silently changes the value's type from string to array.

/** Thrown for every user-facing failure. `code` is stable; `message` is not. */
export class ArgsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArgsError';
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => {
  throw new ArgsError(code, message, details);
};

/** Thrown for a bad spec: our bug or the caller's, never the end user's. */
export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecError';
  }
}

// ---------------------------------------------------------------------------
// Key safety
//
// The whole class of prototype-pollution bugs in argument parsers comes from
// one line: result[key] = value, where key came from the command line. Refusing
// three names closes it. We refuse rather than silently drop, because a user who
// typed --__proto__.polluted deserves to be told the parser will not do that.

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function assertSafeKey(key, source) {
  if (!isSafeKey(key)) {
    fail('FORBIDDEN_KEY', `${source} would reach Object.prototype and was refused`, { key });
  }
  return key;
}

// ---------------------------------------------------------------------------
// Naming
//
// The spec key is the canonical name. The flag is derived from it, so a spec
// cannot declare `dryRun` and accidentally expose `--dryrun`. Both spellings are
// accepted on input; only the canonical key appears in the result, so consumers
// never have to check two properties for one flag.

/** dryRun -> dry-run, HTTPProxy -> http-proxy, level2 -> level2. */
export function toKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** dry-run -> dryRun, dry_run -> dryRun. Leading separators are kept as-is. */
export function toCamel(name) {
  return name.replace(/[-_]+([a-zA-Z0-9])/g, (whole, character) => character.toUpperCase());
}

const TYPES = new Set(['boolean', 'string', 'number', 'count']);

// ---------------------------------------------------------------------------
// Spec normalisation
//
// Done once, up front, and it throws SpecError rather than ArgsError: a bad spec
// is a programming mistake and must not be reported to the user as if they had
// mistyped something. The output is a frozen record with the three lookup maps
// the parser needs, so the hot loop does no searching.

function normaliseOption(key, declared) {
  if (!isSafeKey(key)) throw new SpecError(`option key ${JSON.stringify(key)} is not usable as a property`);
  const option = { key, ...declared };
  option.type ??= 'boolean';
  if (!TYPES.has(option.type)) {
    throw new SpecError(`option ${key}: unknown type ${JSON.stringify(option.type)}`);
  }
  option.flag = option.flag ?? toKebab(key);
  option.short = option.short ?? null;
  if (option.short !== null && !/^[A-Za-z0-9]$/.test(option.short)) {
    throw new SpecError(`option ${key}: short name must be one alphanumeric character`);
  }
  option.multiple = option.multiple === true;
  option.takesValue = option.type === 'string' || option.type === 'number';
  option.negatable = option.negatable ?? option.type === 'boolean';
  if (option.type === 'count') {
    if (option.multiple) throw new SpecError(`option ${key}: a count is already cumulative`);
    option.default ??= 0;
  }
  if (option.multiple && !option.takesValue) {
    throw new SpecError(`option ${key}: multiple needs a string or number type`);
  }
  if (option.choices !== undefined && !Array.isArray(option.choices)) {
    throw new SpecError(`option ${key}: choices must be an array`);
  }
  if (option.coerce !== undefined && typeof option.coerce !== 'function') {
    throw new SpecError(`option ${key}: coerce must be a function`);
  }
  option.conflicts = option.conflicts ?? [];
  option.implies = option.implies ?? [];
  option.describe = option.describe ?? '';
  option.hidden = option.hidden === true;
  return Object.freeze(option);
}

function normalisePositional(declared, index, total) {
  if (typeof declared?.name !== 'string' || declared.name.length === 0) {
    throw new SpecError(`positional ${index}: a name is required`);
  }
  const positional = { ...declared };
  positional.key = toCamel(positional.name);
  if (!isSafeKey(positional.key)) throw new SpecError(`positional ${positional.name} is not usable as a property`);
  positional.type ??= 'string';
  if (positional.type === 'boolean' || positional.type === 'count') {
    throw new SpecError(`positional ${positional.name}: type must be string or number`);
  }
  positional.variadic = positional.variadic === true;
  positional.required = positional.required === true;
  positional.describe = positional.describe ?? '';
  if (positional.variadic && index !== total - 1) {
    throw new SpecError(`positional ${positional.name}: only the last one may be variadic`);
  }
  return Object.freeze(positional);
}

export function normaliseSpec(spec = {}) {
  const options = [];
  const byFlag = new Map();
  const byShort = new Map();
  const byNegation = new Map();

  for (const [key, declared] of Object.entries(spec.options ?? {})) {
    const option = normaliseOption(key, declared ?? {});
    options.push(option);
    // Both spellings resolve; the canonical key is what lands in the result.
    for (const name of new Set([option.flag, key, toCamel(option.flag)])) {
      if (byFlag.has(name)) throw new SpecError(`two options answer to --${name}`);
      byFlag.set(name, option);
    }
    if (option.short !== null) {
      if (byShort.has(option.short)) throw new SpecError(`two options answer to -${option.short}`);
      byShort.set(option.short, option);
    }
  }

  // Negations are registered after every real name, and only where the name is
  // free. An option genuinely called --no-cache must beat the negation of
  // --cache, because the author of the spec was more specific than we are.
  for (const option of options) {
    if (!option.negatable) continue;
    for (const base of new Set([option.flag, toKebab(option.key)])) {
      const negated = `no-${base}`;
      if (!byFlag.has(negated) && !byNegation.has(negated)) byNegation.set(negated, option);
    }
  }

  for (const option of options) {
    for (const name of [...option.conflicts, ...option.implies]) {
      if (!options.some((other) => other.key === name)) {
        throw new SpecError(`option ${option.key} refers to unknown option ${JSON.stringify(name)}`);
      }
    }
  }

  const declaredPositionals = spec.positionals ?? [];
  const positionals = declaredPositionals.map((entry, index) =>
    normalisePositional(entry, index, declaredPositionals.length));
  let sawOptional = false;
  for (const positional of positionals) {
    if (!positional.required) sawOptional = true;
    else if (sawOptional && !positional.variadic) {
      throw new SpecError(`positional ${positional.name}: a required one cannot follow an optional one`);
    }
  }

  return Object.freeze({
    options: Object.freeze(options),
    positionals: Object.freeze(positionals),
    byFlag,
    byShort,
    byNegation,
    strict: spec.strict !== false,
    describe: spec.describe ?? '',
    usage: spec.usage ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tokenising
//
// A separate, inspectable pass, the way util.parseArgs exposes `tokens: true`.
// The value of splitting it out is that every argument-parser argument on the
// internet is really an argument about tokenising, so the answers are visible
// here rather than buried in an accumulating result object.
//
// The rules, all of them:
//   --flag             a long option
//   --flag=value       an attached value; the split is at the FIRST equals sign,
//                      so --tag=a=b gives the value "a=b"
//   --no-flag          the negation of a boolean, when no option owns that name
//   -a                 a short option
//   -abc               a cluster: read left to right until one takes a value
//   -ovalue            the rest of a cluster is the value of the first taker
//   -o=value           the equals is dropped, the same way getopt does it
//   --                 the terminator: nothing after it is interpreted
//   -                  a positional, by convention standard input
//   -5, -.5            a positional, unless a short option is actually named 5
//
// A value-taking option with nothing attached consumes the next argument, and
// refuses to consume one that looks like another option. util.parseArgs and
// minimist both consume it regardless, so `--output --verbose` silently sets the
// output to the string "--verbose". That is never what was meant.

const LOOKS_LIKE_OPTION = /^-(?!\d|\.\d|$)/;

export function tokenise(argv, normalised) {
  const tokens = [];
  let terminated = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];

    if (terminated) {
      tokens.push({ kind: 'rest', value: raw, index });
      continue;
    }
    if (raw === '--') {
      tokens.push({ kind: 'terminator', index });
      terminated = true;
      continue;
    }
    if (!LOOKS_LIKE_OPTION.test(raw)) {
      tokens.push({ kind: 'positional', value: raw, index });
      continue;
    }

    if (raw.startsWith('--')) {
      const body = raw.slice(2);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      const attached = equals === -1 ? undefined : body.slice(equals + 1);
      const option = normalised.byFlag.get(name) ?? normalised.byFlag.get(toCamel(name));
      if (option !== undefined) {
        index = readLong(tokens, argv, index, raw, option, name, attached);
        continue;
      }
      const negated = normalised.byNegation.get(name) ?? normalised.byNegation.get(toCamel(name));
      if (negated !== undefined) {
        tokens.push({ kind: 'option', option: negated, flag: name, raw, value: attached, negated: true, index });
        continue;
      }
      tokens.push({ kind: 'unknown', flag: name, raw, value: attached, index });
      continue;
    }

    index = readCluster(tokens, argv, index, raw, normalised);
  }

  return tokens;
}

/** Push one long option, consuming the next argument if it needs a value. */
function readLong(tokens, argv, index, raw, option, flag, attached) {
  if (!option.takesValue) {
    if (attached !== undefined && option.type === 'count') {
      fail('UNEXPECTED_VALUE', `--${flag} is a counter and takes no value`, { flag });
    }
    // A boolean accepts --flag=false, because scripts build flags by string
    // concatenation and the alternative is a shell conditional.
    tokens.push({ kind: 'option', option, flag, raw, value: attached, negated: false, index });
    return index;
  }
  if (attached !== undefined) {
    tokens.push({ kind: 'option', option, flag, raw, value: attached, negated: false, index });
    return index;
  }
  const next = argv[index + 1];
  if (next === undefined || next === '--' || LOOKS_LIKE_OPTION.test(next)) {
    fail('MISSING_VALUE', `--${flag} needs a value`, { flag });
  }
  tokens.push({ kind: 'option', option, flag, raw, value: next, negated: false, index });
  return index + 1;
}

/** Push a short cluster; returns the index of the last argument consumed. */
function readCluster(tokens, argv, index, raw, normalised) {
  const body = raw.slice(1);
  for (let position = 0; position < body.length; position += 1) {
    const letter = body[position];
    const option = normalised.byShort.get(letter);
    if (option === undefined) {
      tokens.push({ kind: 'unknown', flag: letter, raw: `-${letter}`, short: true, index });
      continue;
    }
    if (!option.takesValue) {
      tokens.push({ kind: 'option', option, flag: letter, raw: `-${letter}`, short: true, negated: false, index });
      continue;
    }
    let remainder = body.slice(position + 1);
    if (remainder.startsWith('=')) remainder = remainder.slice(1);
    if (remainder.length > 0) {
      tokens.push({ kind: 'option', option, flag: letter, raw, short: true, value: remainder, negated: false, index });
      return index;
    }
    const next = argv[index + 1];
    if (next === undefined || next === '--' || LOOKS_LIKE_OPTION.test(next)) {
      fail('MISSING_VALUE', `-${letter} needs a value`, { flag: letter });
    }
    tokens.push({ kind: 'option', option, flag: letter, raw, short: true, value: next, negated: false, index });
    return index + 1;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Values
//
// The number grammar is strict on purpose. minimist uses a loose numeric test
// and then Number(), which turns the string "0123" into 123, "1.10" into 1.1 and
// "0x10" into 16. Version strings, zero-padded identifiers and hashes all go
// through argument parsers, so a parser that reinterprets them is a bug factory.
// Here a number must be a plain decimal literal, and must be finite.

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TRUTHY = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY = new Set(['false', '0', 'no', 'n', 'off', '']);

export function parseNumber(text, label) {
  if (!NUMBER.test(text)) {
    fail('INVALID_VALUE', `${label} expects a number, got ${JSON.stringify(text)}`, { value: text });
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    fail('INVALID_VALUE', `${label} expects a finite number, got ${JSON.stringify(text)}`, { value: text });
  }
  return value;
}

export function parseBoolean(text, label) {
  const lowered = text.toLowerCase();
  if (TRUTHY.has(lowered)) return true;
  if (FALSY.has(lowered)) return false;
  fail('INVALID_VALUE', `${label} expects true or false, got ${JSON.stringify(text)}`, { value: text });
  return false;
}

function convert(option, text, label) {
  if (option.type === 'number') return parseNumber(text, label);
  if (option.type === 'boolean') return parseBoolean(text, label);
  return text;
}

function checkChoices(declaration, value, label) {
  if (declaration.choices === undefined) return value;
  if (!declaration.choices.includes(value)) {
    fail('INVALID_CHOICE', `${label} must be one of ${declaration.choices.join(', ')}, got ${JSON.stringify(value)}`, {
      value,
      choices: declaration.choices,
    });
  }
  return value;
}

function applyCoerce(declaration, value, label) {
  if (declaration.coerce === undefined) return value;
  try {
    return declaration.coerce(value);
  } catch (error) {
    fail('INVALID_VALUE', `${label}: ${error.message}`, { value, cause: error });
    return value;
  }
}

// ---------------------------------------------------------------------------
// Environment fallback
//
// Applied only where the flag was absent from the command line, so an explicit
// --no-colour always beats FORCE_COLOUR in the environment. A boolean reads by
// the same truthy table as a value, except that an unrecognised string is taken
// as true rather than refused: an environment variable is often set to a word
// like "always", and failing a process over that would be rude.

function fromEnvironment(option, env) {
  if (option.env === undefined) return undefined;
  const names = Array.isArray(option.env) ? option.env : [option.env];
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined) continue;
    const label = `${name} (for --${option.flag})`;
    if (option.type === 'boolean') return !FALSY.has(raw.toLowerCase());
    if (option.type === 'count') return parseNumber(raw, label);
    if (option.multiple) return raw.split(',').map((part) => convert(option, part.trim(), label));
    return convert(option, raw, label);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The parser
//
// Note what is missing and is not coming back: dot notation. minimist turns
// --a.b=1 into { a: { b: 1 } }, and that single feature is both of its
// prototype-pollution advisories. Nesting a command line is a job for a config
// file, so the feature is absent rather than patched.

function assign(values, key, value) {
  assertSafeKey(key, `the option key ${JSON.stringify(key)}`);
  values[key] = value;
}

export function parse(argv, spec = {}, { env = {} } = {}) {
  const normalised = spec.byFlag instanceof Map ? spec : normaliseSpec(spec);
  const tokens = tokenise(argv, normalised);

  const values = {};
  const provided = new Set();
  const unknown = [];
  const words = [];
  const rest = [];

  for (const token of tokens) {
    if (token.kind === 'positional') { words.push(token.value); continue; }
    if (token.kind === 'rest') { rest.push(token.value); continue; }
    if (token.kind === 'terminator') continue;
    if (token.kind === 'unknown') {
      if (normalised.strict) {
        const flag = token.short === true ? `-${token.flag}` : `--${token.flag}`;
        fail('UNKNOWN_OPTION', unknownMessage(flag, token.flag, normalised), {
          flag: token.flag,
          suggestions: suggest(token.flag, [...normalised.byFlag.keys()]),
        });
      }
      unknown.push(token.raw);
      continue;
    }

    const { option } = token;
    const label = `--${token.flag}`;
    provided.add(option.key);

    if (option.type === 'count') {
      assign(values, option.key, (values[option.key] ?? 0) + 1);
      continue;
    }
    if (option.type === 'boolean') {
      const stated = token.value === undefined ? true : parseBoolean(token.value, label);
      assign(values, option.key, token.negated ? !stated : stated);
      continue;
    }
    const converted = convert(option, token.value, label);
    if (option.multiple) {
      const list = values[option.key] ?? [];
      list.push(converted);
      assign(values, option.key, list);
      continue;
    }
    // Last wins. minimist would turn the value into an array here, changing the
    // type of a field based on how many times a user pressed the up arrow.
    assign(values, option.key, converted);
  }

  finishOptions(values, provided, normalised, env);
  const positionals = takePositionals(words, normalised);

  return { values, positionals, rest, tokens, unknown, provided };
}

/** Environment, defaults, choices, coercion, required, conflicts, implies. */
function finishOptions(values, provided, normalised, env) {
  for (const option of normalised.options) {
    if (!provided.has(option.key)) {
      const inherited = fromEnvironment(option, env);
      if (inherited !== undefined) {
        assign(values, option.key, inherited);
        provided.add(option.key);
      } else if (option.default !== undefined) {
        // Cloned, or two parses of the same spec would share one array.
        assign(values, option.key, Array.isArray(option.default) ? [...option.default] : option.default);
      }
    }
    if (values[option.key] !== undefined) {
      const label = `--${option.flag}`;
      const held = values[option.key];
      if (Array.isArray(held) && option.multiple) {
        for (const item of held) checkChoices(option, item, label);
      } else {
        checkChoices(option, held, label);
      }
      assign(values, option.key, applyCoerce(option, held, label));
    }
  }

  for (const option of normalised.options) {
    if (option.required && values[option.key] === undefined) {
      fail('MISSING_REQUIRED', `--${option.flag} is required`, { flag: option.flag });
    }
    if (!provided.has(option.key)) continue;
    for (const name of option.conflicts) {
      if (provided.has(name)) {
        fail('CONFLICT', `--${option.flag} cannot be combined with --${toKebab(name)}`, { flag: option.flag, other: name });
      }
    }
    for (const name of option.implies) {
      if (values[name] === undefined) {
        fail('MISSING_REQUIRED', `--${option.flag} needs --${toKebab(name)} as well`, { flag: option.flag, other: name });
      }
    }
  }
}

/** Bind the positional words to their declarations, typing each one. */
function takePositionals(words, normalised) {
  const result = {};
  const declarations = normalised.positionals;
  if (declarations.length === 0) {
    if (normalised.strict && words.length > 0) {
      fail('UNEXPECTED_POSITIONAL', `unexpected argument ${JSON.stringify(words[0])}`, { value: words[0] });
    }
    result._ = words;
    return result;
  }

  let cursor = 0;
  for (const declaration of declarations) {
    const label = `<${declaration.name}>`;
    if (declaration.variadic) {
      const taken = words.slice(cursor).map((word) => applyCoerce(declaration,
        checkChoices(declaration, convert(declaration, word, label), label), label));
      cursor = words.length;
      if (declaration.required && taken.length === 0) {
        fail('MISSING_POSITIONAL', `${label} needs at least one value`, { name: declaration.name });
      }
      result[declaration.key] = taken;
      continue;
    }
    if (cursor >= words.length) {
      if (declaration.required) fail('MISSING_POSITIONAL', `${label} is required`, { name: declaration.name });
      if (declaration.default !== undefined) result[declaration.key] = declaration.default;
      continue;
    }
    const word = words[cursor];
    cursor += 1;
    result[declaration.key] = applyCoerce(declaration,
      checkChoices(declaration, convert(declaration, word, label), label), label);
  }

  const extra = words.slice(cursor);
  if (extra.length > 0 && normalised.strict) {
    fail('UNEXPECTED_POSITIONAL', `unexpected argument ${JSON.stringify(extra[0])}`, { value: extra[0] });
  }
  result._ = extra;
  return result;
}

// ---------------------------------------------------------------------------
// Did you mean
//
// Optimal string alignment rather than plain Levenshtein, because the commonest
// typo of all is a transposition: "sacn" for "scan" is one keystroke wrong and
// plain Levenshtein scores it two, the same as a word with two letters missing.
// Counting a swap as one edit is what makes the suggestion land.

export function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Three rows, not the full matrix: the transposition case needs the row before
  // the previous one, and nothing older than that.
  let older = null;
  let previous = Array.from({ length: b.length + 1 }, (unused, index) => index);
  let current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, older[j - 2] + 1);
      }
      current[j] = best;
    }
    older = previous;
    previous = current;
    current = new Array(b.length + 1);
  }
  return previous[b.length];
}

const tolerance = (word) => (word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3);

/** Up to `limit` candidates worth offering, nearest first, then alphabetical. */
export function suggest(word, candidates, limit = 3) {
  const target = word.toLowerCase();
  const allowed = tolerance(target);
  const scored = [];
  for (const candidate of new Set(candidates)) {
    const lowered = candidate.toLowerCase();
    if (lowered === target) continue;
    const distance = editDistance(target, lowered);
    // A prefix is always worth offering: someone who typed "conf" wants
    // "conformance", and that is five edits away.
    const near = distance <= allowed || lowered.startsWith(target) || target.startsWith(lowered);
    if (near) scored.push({ candidate, distance: lowered.startsWith(target) ? Math.min(distance, allowed) : distance });
  }
  // Codepoints rather than localeCompare: two machines with different locales printing
  // "did you mean a or b" and "did you mean b or a" is a difference nobody can explain,
  // and this module is vendored into other people's trees where it cannot import ours.
  scored.sort((left, right) => left.distance - right.distance
    || (left.candidate < right.candidate ? -1 : left.candidate > right.candidate ? 1 : 0));
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

function unknownMessage(shown, bare, normalised) {
  const hints = suggest(bare, [...normalised.byFlag.keys()]);
  const tail = hints.length === 0 ? '' : `; did you mean ${hints.map((hint) => `--${hint}`).join(' or ')}?`;
  return `unknown option ${shown}${tail}`;
}

// ---------------------------------------------------------------------------
// Help
//
// Generated, never hand-maintained, because a hand-written usage string is wrong
// within two commits. The style hooks default to the identity function, so this
// file has no opinion about colour and no dependency on the module that does.

const PLAIN = Object.freeze({
  bold: (text) => text,
  dim: (text) => text,
  cyan: (text) => text,
  yellow: (text) => text,
  green: (text) => text,
  red: (text) => text,
});

const withStyle = (style) => ({ ...PLAIN, ...(style ?? {}) });

/**
 * Width as a terminal would count it. Help text arrives already styled -- the
 * describe column carries a dim note, a pending command carries a yellow marker
 * -- and measuring those bytes would wrap the table at the wrong place and pad
 * the label column by the length of an escape sequence. Written as an escape,
 * never as a literal control byte: a test in tests/repo/ enforces that.
 */
const SGR = /\u001B\[[0-9;]*m/g;
export const visibleWidth = (text) => text.replace(SGR, '').length;

/** Greedy wrap on spaces. Words longer than the width are left intact. */
export function wrap(text, width) {
  if (width <= 0 || visibleWidth(text) <= width) return [text];
  const lines = [];
  let line = '';
  let used = 0;
  for (const word of text.split(/\s+/)) {
    const size = visibleWidth(word);
    if (line.length === 0) { line = word; used = size; }
    else if (used + 1 + size <= width) { line += ` ${word}`; used += 1 + size; }
    else { lines.push(line); line = word; used = size; }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** A two-column block: labels left, wrapped prose right, aligned as one table. */
export function columns(rows, { width = 80, indent = 2, gap = 2, maximum = 30 } = {}) {
  const visible = rows.filter((row) => row !== null);
  if (visible.length === 0) return [];
  const longest = Math.max(...visible.map((row) => visibleWidth(row.label)));
  const labelWidth = Math.min(longest, maximum);
  const textWidth = Math.max(20, width - indent - labelWidth - gap);
  const lines = [];
  for (const row of visible) {
    const pad = ' '.repeat(indent);
    const wrapped = wrap(row.describe ?? '', textWidth);
    const size = visibleWidth(row.label);
    const render = row.render ?? ((text) => text);
    if (size > labelWidth) {
      // An over-long label gets its own line rather than pushing the whole table
      // out of shape for one entry.
      lines.push(pad + render(row.label));
      for (const piece of wrapped) lines.push(pad + ' '.repeat(labelWidth + gap) + piece);
      continue;
    }
    const label = render(row.label) + ' '.repeat(labelWidth - size);
    lines.push(`${pad}${label}${' '.repeat(gap)}${wrapped[0] ?? ''}`.trimEnd());
    for (const piece of wrapped.slice(1)) lines.push(pad + ' '.repeat(labelWidth + gap) + piece);
  }
  return lines;
}

/** `-o, --output <path>`, `--[no-]colour`, `--include <glob...>`. */
export function optionLabel(option) {
  // The `[no-]` form is shown only where negating is the useful direction: a
  // flag that defaults to true. Printing it for every boolean doubles the width
  // of the table to tell the reader something they will never type.
  const negatable = option.negatable && option.type === 'boolean' && option.default === true;
  const long = negatable ? `--[no-]${option.flag}` : `--${option.flag}`;
  const head = option.short === null ? `    ${long}` : `-${option.short}, ${long}`;
  if (!option.takesValue) return head;
  const placeholder = option.placeholder ?? option.type;
  return `${head} <${placeholder}${option.multiple ? '...' : ''}>`;
}

function positionalLabel(positional) {
  const inner = `${positional.name}${positional.variadic ? '...' : ''}`;
  return positional.required ? `<${inner}>` : `[${inner}]`;
}

/** The `Usage:` line, built from the spec so it cannot describe a stale shape. */
export function usageLine(name, normalised, { hasCommands = false } = {}) {
  const parts = [name];
  if (hasCommands) parts.push('<command>');
  if (normalised.options.some((option) => !option.hidden)) parts.push('[options]');
  for (const positional of normalised.positionals) parts.push(positionalLabel(positional));
  return parts.join(' ');
}

export function renderHelp(descriptor, { style, width = 80 } = {}) {
  const paint = withStyle(style);
  const spec = descriptor.spec.byFlag instanceof Map ? descriptor.spec : normaliseSpec(descriptor.spec);
  const commands = descriptor.commands ?? [];
  const lines = [];

  const heading = [paint.bold(descriptor.name)];
  if (descriptor.version !== undefined) heading.push(paint.cyan(descriptor.version));
  if (descriptor.tagline !== undefined) heading.push(`-- ${descriptor.tagline}`);
  lines.push(heading.join(' '), '');

  if (descriptor.describe) {
    lines.push(...wrap(descriptor.describe, width), '');
  }

  lines.push(`${paint.bold('Usage:')} ${descriptor.usage ?? usageLine(descriptor.name, spec, { hasCommands: commands.length > 0 })}`, '');

  if (spec.positionals.length > 0 && spec.positionals.some((entry) => entry.describe)) {
    lines.push(paint.bold('Arguments:'));
    lines.push(...columns(spec.positionals.map((positional) => ({
      label: positionalLabel(positional),
      describe: positional.describe,
      render: paint.cyan,
    })), { width }));
    lines.push('');
  }

  if (commands.length > 0) {
    lines.push(paint.bold('Commands:'));
    // The pending marker rides in the label column rather than the describe
    // column, so it can never be wrapped away from the name it belongs to. That
    // means the label arrives pre-styled and `render` has nothing left to do;
    // `columns` measures visible width, so the escape sequences cost no padding.
    lines.push(...columns(commands.filter((command) => command.hidden !== true).map((command) => ({
      label: command.ready === false
        ? `${paint.dim(command.name)} ${paint.yellow('(pending)')}`
        : paint.cyan(command.name),
      describe: command.describe,
      render: (text) => text,
    })), { width }));
    lines.push('');
  }

  const shown = spec.options.filter((option) => !option.hidden);
  if (shown.length > 0) {
    lines.push(paint.bold('Options:'));
    lines.push(...columns(shown.map((option) => ({
      label: optionLabel(option),
      describe: describeOption(option, paint),
      render: paint.cyan,
    })), { width }));
    lines.push('');
  }

  if (descriptor.footer) lines.push(paint.dim(descriptor.footer), '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** The describe column, plus the facts a reader needs: default, choices, env. */
function describeOption(option, paint) {
  const notes = [];
  if (option.choices !== undefined) notes.push(`one of ${option.choices.join(', ')}`);
  if (option.default !== undefined && option.type !== 'count') notes.push(`default ${JSON.stringify(option.default)}`);
  if (option.required) notes.push('required');
  if (option.env !== undefined) {
    notes.push(`or ${(Array.isArray(option.env) ? option.env : [option.env]).join(' / ')}`);
  }
  if (notes.length === 0) return option.describe;
  return `${option.describe} ${paint.dim(`[${notes.join('; ')}]`)}`.trim();
}

// ---------------------------------------------------------------------------
// The framework layer
//
// Subcommands, dispatch and exit codes: the part commander and yargs add on top
// of a parser. Streams and the environment are injected rather than reached for,
// so the tests drive the real dispatcher and read its real output instead of
// spawning a process for every case.
//
// Finding the command: argv is tokenised once against the global options, and
// the first bare word that names a known command wins. Matching against the
// command table rather than taking the first bare word is what lets
// `nirdep --colour scan` work as well as `nirdep scan --colour`.

const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2, UNIMPLEMENTED: 3 });

function unknownCommandMessage(asked, commands, style) {
  const hints = suggest(asked, [...commands.keys()]);
  const shown = style.bold(JSON.stringify(asked));
  if (hints.length === 0) return `unknown command ${shown}`;
  return `unknown command ${shown}; did you mean ${hints.map((hint) => style.cyan(hint)).join(' or ')}?`;
}

function mergeOptions(global, local) {
  const merged = { ...global };
  for (const [key, declared] of Object.entries(local ?? {})) merged[key] = declared;
  return merged;
}

export function createCli(descriptor) {
  const name = descriptor.name ?? 'cli';
  const style = withStyle(descriptor.style);
  // Errors get their own style object, because capability detection is per
  // stream: piping stdout to a file must not strip the colour from a message
  // still going to a terminal. bin/nirdep.mjs passes two colour instances in for
  // exactly that reason; a caller with one opinion passes `style` alone.
  const errStyle = withStyle(descriptor.errStyle ?? descriptor.style);
  const width = descriptor.width ?? 80;
  const env = descriptor.env ?? {};
  const out = descriptor.out ?? ((text) => process.stdout.write(text));
  const err = descriptor.err ?? ((text) => process.stderr.write(text));

  const globalOptions = descriptor.options ?? {};
  const commands = new Map();
  for (const [commandName, declared] of Object.entries(descriptor.commands ?? {})) {
    commands.set(commandName, Object.freeze({
      name: commandName,
      describe: declared.describe ?? '',
      ready: declared.ready !== false,
      hidden: declared.hidden === true,
      run: declared.run,
      spec: normaliseSpec({
        options: mergeOptions(globalOptions, declared.options),
        positionals: declared.positionals,
        strict: declared.strict,
        describe: declared.describe,
      }),
    }));
  }
  const rootSpec = normaliseSpec({ options: globalOptions, strict: false });

  const rootHelp = () => renderHelp({
    name,
    version: descriptor.version,
    tagline: descriptor.tagline,
    describe: descriptor.describe,
    footer: descriptor.footer,
    spec: rootSpec,
    commands: [...commands.values()],
  }, { style: descriptor.style, width });

  const commandHelp = (command) => renderHelp({
    name: `${name} ${command.name}`,
    describe: command.describe,
    footer: descriptor.footer,
    spec: command.spec,
  }, { style: descriptor.style, width });

  function locate(argv) {
    for (const token of tokenise(argv, rootSpec)) {
      if (token.kind !== 'positional') continue;
      if (commands.has(token.value)) return { name: token.value, index: token.index };
      return { name: token.value, index: token.index, unknown: true };
    }
    return null;
  }

  function reportUsage(message, { hint = true } = {}) {
    err(`${errStyle.red(`${name}:`)} ${message}\n`);
    if (hint) err(`${errStyle.dim(`Run "${name} help" for the command list.`)}\n`);
    return EXIT.USAGE;
  }

  function run(argv = process.argv.slice(2)) {
    // The three arguments that must work before anything else does, and must
    // work even when the rest of the command line is nonsense.
    if (argv.length === 0) { out(rootHelp()); return EXIT.OK; }
    const [first] = argv;
    if (first === '--help' || first === '-h') { out(rootHelp()); return EXIT.OK; }
    if (first === '--version' || first === '-V') { out(`${descriptor.version}\n`); return EXIT.OK; }
    if (first === 'help') {
      const asked = argv[1];
      if (asked === undefined) { out(rootHelp()); return EXIT.OK; }
      const command = commands.get(asked);
      if (command === undefined) return reportUsage(unknownCommandMessage(asked, commands, errStyle));
      out(commandHelp(command));
      return EXIT.OK;
    }

    const found = locate(argv);
    if (found === null) { out(rootHelp()); return EXIT.OK; }
    if (found.unknown === true) return reportUsage(unknownCommandMessage(found.name, commands, errStyle));

    const command = commands.get(found.name);
    const remainder = [...argv.slice(0, found.index), ...argv.slice(found.index + 1)];
    if (remainder.includes('--help') || remainder.includes('-h')) {
      out(commandHelp(command));
      return EXIT.OK;
    }
    if (!command.ready) {
      err(`${errStyle.red(`${name}:`)} ${errStyle.bold(JSON.stringify(command.name))} is not implemented yet.\n`);
      return EXIT.UNIMPLEMENTED;
    }

    let parsed;
    try {
      parsed = parse(remainder, command.spec, { env });
    } catch (error) {
      if (!(error instanceof ArgsError)) throw error;
      err(`${errStyle.red(`${name}:`)} ${errStyle.bold(command.name)}: ${error.message}\n`);
      err(`${errStyle.dim(`Run "${name} help ${command.name}" for the options.`)}\n`);
      return EXIT.USAGE;
    }

    if (typeof command.run !== 'function') {
      err(`${errStyle.red(`${name}:`)} ${command.name} has no implementation attached.\n`);
      return EXIT.RUNTIME;
    }
    const code = command.run({
      options: parsed.values,
      positionals: parsed.positionals,
      rest: parsed.rest,
      provided: parsed.provided,
      command: command.name,
      out,
      err,
      style,
      errStyle,
      help: () => commandHelp(command),
    });
    return typeof code === 'number' ? code : EXIT.OK;
  }

  return { run, help: rootHelp, commandHelp, commands, rootSpec, EXIT };
}

export { EXIT };
export default { parse, createCli, normaliseSpec, tokenise, suggest, renderHelp, ArgsError, SpecError };
