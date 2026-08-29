// nirdep/runtime/colour -- terminal styling on the standard library.
//
// Replaces: chalk, ansi-styles, supports-color, color-convert, picocolors,
// kleur, colorette, strip-ansi. Combined, a little over 320 million downloads a
// week for something the terminal has done since 1979.
//
// Node already gives us two of the four pieces. `util.styleText(['red'], s)`
// writes one styled string at 16 colours, and `util.stripVTControlCharacters`
// is, on its own, the entire `strip-ansi` package. What Node does not give us is
// what people actually install chalk for:
//
//   1. A chainable builder. `colour.red.bold.underline('x')` -- one object that
//      accumulates styles and is still callable at every step.
//   2. More than sixteen colours. No 256-colour palette, no 24-bit truecolour,
//      no hex or RGB input, and no downsampling when the terminal cannot do it.
//   3. Capability detection. Nothing in Node reads NO_COLOR, FORCE_COLOR, TERM,
//      COLORTERM or the CI variables to decide whether to emit escapes at all.
//   4. Nesting that survives. Styling a string that already contains escape
//      sequences is where naive implementations produce visible corruption.
//
// One file on purpose: `nirdep eject colour` copies it in and you are done. Its
// only import is `node:util`, for the one part of this Node already got right.
//
// Published by Nastik AI. Developed by Hardik. MIT.

import { stripVTControlCharacters } from 'node:util';

// Written as a \u escape rather than a literal control byte: a raw ESC in source
// survives copy-paste badly, vanishes in code review, and makes the file
// unreadable in half the tools that will open it.
const ESC = '\u001B';
const CSI = `${ESC}[`;

/** Wrap a Select Graphic Rendition parameter list, e.g. sgr('1') -> ESC [ 1 m. */
const sgr = (parameters) => `${CSI}${parameters}m`;

/**
 * The colour depth of a stream, as an ordered scale. Higher levels are strict
 * supersets: anything expressible at level 1 is expressible at level 3.
 *
 * The numbering matches the convention chalk established, because code being
 * migrated off chalk compares against these numbers and a different scale would
 * turn a silent behaviour change into the migration's problem.
 */
export const Level = Object.freeze({
  /** No escape sequences at all. Every style is the identity function. */
  NONE: 0,
  /** The original sixteen: eight colours and their bright variants. */
  BASIC: 1,
  /** The xterm 256-colour palette: 16 system, a 6x6x6 cube, 24 greys. */
  ANSI256: 2,
  /** 24-bit truecolour. */
  TRUECOLOUR: 3,
});

// ---------------------------------------------------------------------------
// The code tables
// ---------------------------------------------------------------------------
//
// Each entry is [open, close]. The close codes are the interesting part and the
// place naive implementations go wrong: there is no "close bold" code. SGR 22
// turns off *both* bold and dim, 23 closes italic, 24 underline, and a single
// 39 resets the foreground regardless of which of the sixteen colours set it.
// Anything that closes every style with SGR 0 will work in a demo and destroy
// the surrounding styling of anyone who nests it.

/** @type {Record<string, [number, number]>} */
const MODIFIERS = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  overline: [53, 55],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
};

const FOREGROUND_CLOSE = 39;
const BACKGROUND_CLOSE = 49;

const BASE_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** @type {Record<string, [number, number]>} */
const COLOURS = {};
/** @type {Record<string, [number, number]>} */
const BACKGROUNDS = {};

for (const [index, name] of BASE_COLOURS.entries()) {
  COLOURS[name] = [30 + index, FOREGROUND_CLOSE];
  COLOURS[`${name}Bright`] = [90 + index, FOREGROUND_CLOSE];
  const capitalised = name[0].toUpperCase() + name.slice(1);
  BACKGROUNDS[`bg${capitalised}`] = [40 + index, BACKGROUND_CLOSE];
  BACKGROUNDS[`bg${capitalised}Bright`] = [100 + index, BACKGROUND_CLOSE];
}

// Aliases people actually type. `gray` and `grey` are both blackBright, which is
// a lie the terminal tells: SGR 90 is "bright black", and every terminal renders
// it as grey. Keeping both spellings is not indulgence, it is the difference
// between a migration compiling and not.
COLOURS.gray = COLOURS.blackBright;
COLOURS.grey = COLOURS.blackBright;
BACKGROUNDS.bgGray = BACKGROUNDS.bgBlackBright;
BACKGROUNDS.bgGrey = BACKGROUNDS.bgBlackBright;

/** Every style name, in one flat table, with the group it belongs to. */
export const styles = Object.freeze(
  Object.fromEntries(
    [
      ...Object.entries(MODIFIERS).map(([name, codes]) => [name, { group: 'modifier', codes }]),
      ...Object.entries(COLOURS).map(([name, codes]) => [name, { group: 'colour', codes }]),
      ...Object.entries(BACKGROUNDS).map(([name, codes]) => [name, { group: 'background', codes }]),
    ].map(([name, entry]) => [name, Object.freeze({ ...entry, open: sgr(entry.codes[0]), close: sgr(entry.codes[1]) })]),
  ),
);

// ---------------------------------------------------------------------------
// Colour space conversion
// ---------------------------------------------------------------------------
//
// This is the whole of `color-convert` that a terminal needs, which turns out to
// be four functions. The point of them is downsampling: a caller asks for
// #ff8800 and the terminal on the other end may only have sixteen colours, so
// the request has to be answered approximately rather than dropped.

/**
 * Parse a CSS-style hex colour into 8-bit components.
 *
 * Accepts `#rgb`, `#rrggbb`, and either form without the hash, because half the
 * codebases being migrated store colours without it. The three-digit form
 * expands by digit duplication (`#f80` is `#ff8800`) rather than by multiplying
 * by 17 in the abstract, which is the same arithmetic but the wrong mental model
 * when you are reading the output.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const digits = String(hex).replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(digits)) {
    throw new TypeError(`not a hex colour: ${JSON.stringify(hex)} (expected #rgb or #rrggbb)`);
  }
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * 24-bit colour to the xterm 256-colour palette.
 *
 * The palette is three regions: 0-15 are the system colours, 16-231 are a 6x6x6
 * RGB cube, and 232-255 are 24 shades of grey. A grey input must go to the grey
 * ramp rather than the cube, because the cube's diagonal has only six steps and
 * would quantise a subtle grey gradient into visible bands.
 *
 * @param {number} red @param {number} green @param {number} blue
 * @returns {number} 0-255
 */
export function rgbToAnsi256(red, green, blue) {
  if (red === green && green === blue) {
    if (red < 8) return 16;
    if (red > 248) return 231;
    return Math.round(((red - 8) / 247) * 24) + 232;
  }
  const channel = (value) => Math.round((value / 255) * 5);
  return 16 + 36 * channel(red) + 6 * channel(green) + channel(blue);
}

/**
 * A 256-palette index down to one of the sixteen basic foreground codes.
 *
 * Indices below 16 are already basic and map straight across. Above that we
 * reverse the palette arithmetic to recover approximate components, then decide
 * two things separately: *which* of the eight hues is closest, by rounding each
 * component to 0 or 1 and reading the result as a three-bit number in blue,
 * green, red order -- which is the order the ANSI codes themselves use -- and
 * whether the colour is bright enough to deserve the 90-97 range instead of
 * 30-37. Doing brightness separately is what stops dark red becoming bright red.
 *
 * @param {number} code 0-255
 * @returns {number} an SGR foreground code, 30-37 or 90-97
 */
export function ansi256ToAnsi16(code) {
  if (code < 8) return 30 + code;
  if (code < 16) return 90 + (code - 8);

  let red;
  let green;
  let blue;
  if (code >= 232) {
    // The grey ramp, normalised to 0..1.
    red = green = blue = ((code - 232) * 10 + 8) / 255;
  } else {
    const offset = code - 16;
    red = Math.floor(offset / 36) / 5;
    green = Math.floor((offset % 36) / 6) / 5;
    blue = (offset % 6) / 5;
  }

  const brightness = Math.max(red, green, blue) * 2;
  if (brightness === 0) return 30;
  const hue = (Math.round(blue) << 2) | (Math.round(green) << 1) | Math.round(red);
  return 30 + hue + (brightness === 2 ? 60 : 0);
}

/**
 * 24-bit colour straight down to the sixteen. Routed through the 256 palette
 * rather than reimplemented, so the two downsample paths cannot disagree: a
 * colour rendered at level 2 and the same colour rendered at level 1 always pick
 * the same hue.
 *
 * @param {number} red @param {number} green @param {number} blue
 * @returns {number} an SGR foreground code
 */
export function rgbToAnsi16(red, green, blue) {
  return ansi256ToAnsi16(rgbToAnsi256(red, green, blue));
}

// ---------------------------------------------------------------------------
// Opening sequences for the dynamic colours, per level
// ---------------------------------------------------------------------------
//
// The named styles above are fixed strings. These are not: the same call has to
// produce a different sequence depending on what the terminal can do, and the
// downsample happens here rather than at the call site so that user code never
// has to ask what level it is running at.
//
// Background codes are foreground codes plus ten. That is not a coincidence to be
// hidden behind a second table -- it is how ECMA-48 lays out the parameters, and
// deriving it keeps the two ranges from drifting apart when someone edits one.

const BACKGROUND_OFFSET = 10;

function assertByte(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError(`${what} must be an integer from 0 to 255, received ${JSON.stringify(value)}`);
  }
}

/**
 * @param {number} level
 * @param {[number, number, number]} rgb
 * @param {boolean} background
 * @returns {string}
 */
function rgbSequence(level, [red, green, blue], background) {
  assertByte(red, 'red');
  assertByte(green, 'green');
  assertByte(blue, 'blue');
  const layer = background ? 48 : 38;
  if (level >= Level.TRUECOLOUR) return sgr(`${layer};2;${red};${green};${blue}`);
  if (level === Level.ANSI256) return sgr(`${layer};5;${rgbToAnsi256(red, green, blue)}`);
  return sgr(rgbToAnsi16(red, green, blue) + (background ? BACKGROUND_OFFSET : 0));
}

/**
 * @param {number} level
 * @param {number} code 0-255
 * @param {boolean} background
 * @returns {string}
 */
function ansi256Sequence(level, code, background) {
  assertByte(code, 'palette index');
  const layer = background ? 48 : 38;
  if (level >= Level.ANSI256) return sgr(`${layer};5;${code}`);
  return sgr(ansi256ToAnsi16(code) + (background ? BACKGROUND_OFFSET : 0));
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/** CI providers that advertise truecolour. */
const TRUECOLOUR_CI = ['GITHUB_ACTIONS', 'GITEA_ACTIONS', 'CIRCLECI'];
/** CI providers that render 16 colours but set no TERM worth reading. */
const BASIC_CI = ['TRAVIS', 'APPVEYOR', 'GITLAB_CI', 'BUILDKITE', 'DRONE', 'TEAMCITY_VERSION'];

/**
 * Parse FORCE_COLOR. Empty or "true" means "yes, whatever you can do"; a number
 * pins the level; "false" or 0 means off.
 * @returns {number | undefined} undefined when the variable is absent
 */
function forcedLevel(env) {
  if (!('FORCE_COLOR' in env)) return undefined;
  const value = env.FORCE_COLOR;
  if (value === 'false') return Level.NONE;
  if (value === 'true' || value === '') return Level.BASIC;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return Level.BASIC;
  return Math.max(Level.NONE, Math.min(Level.TRUECOLOUR, parsed));
}

/**
 * Work out what a stream can render.
 *
 * Precedence, and the reasoning for it: FORCE_COLOR is checked before NO_COLOR
 * because it is the more specific instruction -- NO_COLOR is a standing
 * preference, FORCE_COLOR is a decision about this run, usually made by someone
 * piping output into a tool that understands escapes. Everything after those two
 * is inference and can be wrong; those two cannot.
 *
 * @param {{ isTTY?: boolean } | undefined} stream
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} a Level
 */
export function detectLevel(stream, env = process.env) {
  const forced = forcedLevel(env);
  if (forced !== undefined) return forced;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return Level.NONE;
  if (env.TERM === 'dumb') return Level.NONE;

  const tty = stream?.isTTY === true;
  const inCI = 'CI' in env;
  if (!tty && !inCI) return Level.NONE;

  if (inCI) {
    if (TRUECOLOUR_CI.some((name) => name in env)) return Level.TRUECOLOUR;
    if (BASIC_CI.some((name) => name in env) || env.CI_NAME === 'codeship') return Level.BASIC;
    if (!tty) return Level.NONE;
  }

  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return Level.TRUECOLOUR;
  if (env.TERM === 'xterm-kitty' || env.TERM === 'wezterm') return Level.TRUECOLOUR;
  if (env.TERM_PROGRAM === 'iTerm.app') {
    return Number.parseInt(env.TERM_PROGRAM_VERSION ?? '0', 10) >= 3 ? Level.TRUECOLOUR : Level.ANSI256;
  }
  if (env.TERM_PROGRAM === 'vscode') return Level.TRUECOLOUR;
  if (env.TERM_PROGRAM === 'Apple_Terminal') return Level.ANSI256;
  if (/-256(colou?r)?$/i.test(env.TERM ?? '')) return Level.ANSI256;
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|colou?r|ansi|cygwin|linux/i.test(env.TERM ?? '')) return Level.BASIC;
  if ('COLORTERM' in env) return Level.BASIC;
  return Level.NONE;
}

// ---------------------------------------------------------------------------
// Style chains
// ---------------------------------------------------------------------------
//
// A chain is a linked list from the innermost style out to the outermost, built
// once per `.style` access and shared by every call that follows. Each node
// stores a function rather than a string, because `rgb(255, 136, 0)` renders
// differently at each level and the level can change after the chain was built.

/**
 * @typedef {object} Styler
 * @property {(level: number) => string} openFor
 * @property {string} close
 * @property {Styler | undefined} parent
 * @property {Map<number, { openAll: string, closeAll: string, nodes: Styler[] }>} cache
 */

/** @returns {Styler} */
function link(openFor, close, parent) {
  return { openFor, close, parent, cache: new Map() };
}

/** Flatten a chain for one level. Cached, because it is on the hot path. */
function resolve(styler, level) {
  const hit = styler.cache.get(level);
  if (hit !== undefined) return hit;

  /** @type {Styler[]} */
  const nodes = [];
  for (let node = styler; node !== undefined; node = node.parent) nodes.push(node);
  nodes.reverse();

  let openAll = '';
  for (const node of nodes) openAll += node.openFor(level);
  let closeAll = '';
  for (let index = nodes.length - 1; index >= 0; index -= 1) closeAll += nodes[index].close;

  const resolved = { openAll, closeAll, nodes };
  styler.cache.set(level, resolved);
  return resolved;
}

/**
 * Split a styled string at every line break so the styles close before the
 * newline and reopen after it.
 *
 * Without this, a background colour applied to a multi-line string paints to the
 * right edge of the terminal on every line but the last, because the escape is
 * still open when the cursor wraps. It is the one piece of this file that exists
 * purely because of how terminals behave rather than what the spec says.
 */
function encaseLines(text, openAll, closeAll, firstBreak) {
  let out = '';
  let cursor = 0;
  let index = firstBreak;
  do {
    const crlf = text[index - 1] === '\r';
    out += text.slice(cursor, crlf ? index - 1 : index) + closeAll + (crlf ? '\r\n' : '\n') + openAll;
    cursor = index + 1;
    index = text.indexOf('\n', cursor);
  } while (index !== -1);
  return out + text.slice(cursor);
}

/**
 * The whole of the nesting problem, in six lines.
 *
 * `red('a' + green('b') + 'c')` produces an inner sequence that ends with SGR 39
 * -- reset foreground. Emit that naively and 'c' comes out unstyled, because the
 * inner close cancelled the outer colour too. The fix is to rewrite every
 * occurrence of an ancestor's close code into that ancestor's open code, so each
 * inner close doubles as an outer reopen. Walking innermost-first matters: an
 * outer node must not rewrite a close it did not own.
 */
function applyStyle(styler, level, input) {
  const text = typeof input === 'string' ? input : String(input);
  if (level === Level.NONE || styler === undefined) return text;

  const { openAll, closeAll, nodes } = resolve(styler, level);
  let body = text;
  if (body.includes(ESC)) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      body = body.replaceAll(nodes[index].close, nodes[index].openFor(level));
    }
  }
  const firstBreak = body.indexOf('\n');
  if (firstBreak !== -1) body = encaseLines(body, openAll, closeAll, firstBreak);
  return openAll + body + closeAll;
}

// ---------------------------------------------------------------------------
// The chainable builder, without a Proxy
// ---------------------------------------------------------------------------
//
// Every style is a getter on one shared prototype, and each builder is a real
// function with that prototype behind it. A Proxy would have been fewer lines and
// worse: property access on a Proxy defeats V8's inline caches, `typeof` and
// `instanceof` get surprising, and a stack trace through a Proxy trap is not
// something you want to hand a user. This way `colour.red` is a plain getter and
// `colour.red('x')` is a plain call.

const builderProto = Object.create(Function.prototype);

function createBuilder(root, styler) {
  const builder = (...args) => applyStyle(styler, root.level, args.length === 1 ? args[0] : args.join(' '));
  Object.setPrototypeOf(builder, builderProto);
  Object.defineProperty(builder, 'styler', { value: styler });
  Object.defineProperty(builder, 'root', { value: root });
  Object.defineProperty(builder, 'links', { value: new Map() });
  return builder;
}

/** Extend a builder by one style, reusing the chain if this style was taken before. */
function extend(builder, key, openFor, close) {
  const cached = builder.links.get(key);
  if (cached !== undefined) return cached;
  const next = createBuilder(builder.root, link(openFor, close, builder.styler));
  builder.links.set(key, next);
  return next;
}

for (const [name, style] of Object.entries(styles)) {
  Object.defineProperty(builderProto, name, {
    configurable: true,
    enumerable: true,
    get() {
      return extend(this, name, () => style.open, style.close);
    },
  });
}

Object.defineProperties(builderProto, {
  level: {
    configurable: true,
    get() { return this.root.level; },
    set(value) { this.root.level = clampLevel(value); },
  },

  /** True when this builder would emit anything at all. */
  enabled: { configurable: true, get() { return this.root.level > Level.NONE; } },

  rgb: {
    configurable: true,
    value(red, green, blue) {
      return extend(this, `rgb:${red},${green},${blue}`, (level) => rgbSequence(level, [red, green, blue], false), sgr(FOREGROUND_CLOSE));
    },
  },
  bgRgb: {
    configurable: true,
    value(red, green, blue) {
      return extend(this, `bgRgb:${red},${green},${blue}`, (level) => rgbSequence(level, [red, green, blue], true), sgr(BACKGROUND_CLOSE));
    },
  },
  hex: { configurable: true, value(hex) { return this.rgb(...hexToRgb(hex)); } },
  bgHex: { configurable: true, value(hex) { return this.bgRgb(...hexToRgb(hex)); } },
  ansi256: {
    configurable: true,
    value(code) {
      return extend(this, `ansi256:${code}`, (level) => ansi256Sequence(level, code, false), sgr(FOREGROUND_CLOSE));
    },
  },
  bgAnsi256: {
    configurable: true,
    value(code) {
      return extend(this, `bgAnsi256:${code}`, (level) => ansi256Sequence(level, code, true), sgr(BACKGROUND_CLOSE));
    },
  },
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function clampLevel(value) {
  const level = Number(value);
  if (!Number.isInteger(level) || level < Level.NONE || level > Level.TRUECOLOUR) {
    throw new RangeError(`level must be 0, 1, 2 or 3, received ${JSON.stringify(value)}`);
  }
  return level;
}

/**
 * Build an independent styling instance.
 *
 * Independent matters: a library that sets `level = 0` on a shared singleton
 * silences the application that imported it. Every consumer gets its own root, and
 * the default export is simply the one nirdep uses for itself.
 *
 * @param {{ level?: number, stream?: { isTTY?: boolean }, env?: NodeJS.ProcessEnv }} [options]
 */
export function createColour(options = {}) {
  const stream = options.stream ?? process.stdout;
  const root = { level: options.level === undefined ? detectLevel(stream, options.env) : clampLevel(options.level) };
  return createBuilder(root, undefined);
}

/**
 * Remove every ANSI escape sequence from a string. This is the entire
 * `strip-ansi` package, and it is one call into `node:util` -- included here so
 * that a migration off strip-ansi has somewhere to point without importing a
 * second module.
 */
export function strip(text) {
  return stripVTControlCharacters(String(text));
}

/** Width of a string as the terminal will draw it: escapes removed, then counted. */
export function visibleLength(text) {
  return [...strip(text)].length;
}

const colour = createColour();
export default colour;
export { colour };
