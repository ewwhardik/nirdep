// The text layer: everything about how a report is measured, folded and padded, and
// nothing about what it says.
//
// A style hook set, a plural, and a fold. They were private to src/apply/report.mjs
// until `scan` needed the same fold at the same width, and two copies of a text
// measurement is how two commands end up wrapping at different columns for no reason a
// user could explain. The same argument then repeated itself five more times, so the
// paragraph folder, the note under a row, the footer field, the verdict line and the
// column width all live here now: seven reports, one measuring tape.
//
// None of this knows what colour is. The CLI passes in hooks from src/runtime/colour.mjs
// when the stream is a terminal and passes nothing when it is a pipe, so a report is
// testable without an escape sequence anywhere near it.
//
// One deliberate exception, so the next consolidation pass does not "fix" it:
// src/runtime/colour.mjs and src/runtime/args.mjs carry their own copies of PLAIN and of
// a wrap. They are published subpaths that `nirdep eject` vendors as single files, so an
// import of this module would leave somebody's tree with a dangling path.

/** No colour, no styling: the shape every hook has, for callers that do not care. */
export const PLAIN = Object.freeze({
  bold: (text) => text,
  dim: (text) => text,
  cyan: (text) => text,
  yellow: (text) => text,
  green: (text) => text,
  red: (text) => text,
});

/**
 * A caller's hooks over ours, so a partial set is allowed: a style object with only
 * `red` still gets a working `dim`.
 *
 * @param {object|null|undefined} given
 * @returns {object}
 */
export const styleOf = (given) => ({ ...PLAIN, ...(given ?? {}) });

/**
 * `1 file`, `2 files`, `1 dependency`, `2 dependencies`. The plural is a parameter
 * because English does not derive it, and a report that says "1 dependencys" has just
 * told the reader how much care went into the rest of it.
 *
 * @param {number} count
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The width every folded sentence in this project uses, chosen to fit an 80-column terminal
 * with room for a four-space indent. */
export const WIDTH = 76;

/**
 * Fold a sentence at a width, indenting the continuations. No styling: this measures, and
 * a string with escape sequences in it does not measure the way it looks.
 *
 * @param {string} text
 * @param {number} [width]
 * @param {string} [indent]
 * @returns {string}
 */
export function wrap(text, width = WIDTH, indent = '    ') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line !== '') lines.push(line);
  return lines.join(`\n${indent}`);
}

/**
 * A fixed-width label, padded on the right so a column of them lines up. Padding is
 * applied before styling by the caller, because the style hooks add bytes that are not
 * columns.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export const pad = (text, width) => (text.length >= width ? text : text + ' '.repeat(width - text.length));

/** The whole line, as opposed to the folding width inside a four-space indent. Every page
 * in this project is written for the same terminal. */
export const COLUMNS = WIDTH + 4;

/** Styling does nothing, for the one line of every report that has nothing to say. */
const same = (line) => line;

/**
 * One folded, uniformly styled paragraph at a given indent. `wrap` counts characters, so a
 * styled paragraph has to be measured first and painted line by line afterwards. `lead` is
 * the first line's prefix, which is how a bullet gets a hanging indent instead of
 * continuations that read as items of their own.
 *
 * @param {string} text
 * @param {string} [indent]
 * @param {(line: string) => string} [paint]
 * @param {string} [lead]
 * @returns {string}
 */
export function folded(text, indent = '  ', paint = same, lead = indent) {
  return wrap(text, WIDTH - (indent.length - 4), indent)
    .split('\n')
    .map((line, index) => `${index === 0 ? lead : indent}${paint(line.trimStart())}`)
    .join('\n');
}

/**
 * A note under a row: folded to the terminal against a gutter of a fixed width, painted
 * after the measuring, and returned as lines because the caller is building a page.
 *
 * @param {string} plain
 * @param {string} gutter
 * @param {(line: string) => string} [paint]
 * @returns {string[]}
 */
export function note(plain, gutter, paint = same) {
  return wrap(plain, COLUMNS - gutter.length, '').split('\n').map((line) => `${gutter}${paint(line)}`);
}

/**
 * A footer line: a label in a gutter, and prose folded to sit under itself rather than
 * under the label.
 *
 * @param {string} label
 * @param {string} text
 * @param {(line: string) => string} [paint]
 * @param {number} [gutter]
 * @returns {string[]}
 */
export function labelled(label, text, paint = same, gutter = 10) {
  const indent = ' '.repeat(gutter);
  return wrap(text, COLUMNS - gutter, '').split('\n')
    .map((line, index) => (index === 0 ? `${paint(pad(label, gutter))}${paint(line)}` : `${indent}${paint(line)}`));
}

/**
 * The last line of a page, folded. The label is the first word and so never moves, which
 * is what lets it be painted after the measuring is done.
 *
 * @param {string} label
 * @param {string} rest
 * @param {(line: string) => string} [paint]
 * @returns {string[]}
 */
export function verdictOf(label, rest, paint = same) {
  const [first, ...more] = wrap(`${label}${rest}`, COLUMNS, '').split('\n');
  return [`${paint(label)}${first.slice(label.length)}`, ...more];
}

/**
 * The width of a column of names. `Math.max()` of nothing is `-Infinity`, which `pad` then
 * turns into a RangeError, so an empty table is a floor of zero rather than a crash; a
 * caller with a heading to fit passes its own.
 *
 * @param {Iterable<string>} items
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
export function columnWidth(items, bounds = {}) {
  const { min = 0, max = Infinity } = bounds;
  let width = min;
  for (const item of items) width = Math.max(width, String(item).length);
  return Math.min(width, max);
}

/**
 * The verb English does not derive either. `plural` counts a noun; this one agrees with a
 * count it does not print, for the sentences where the number is already elsewhere.
 *
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export const agree = (count, one, many) => (count === 1 ? one : many);

/**
 * A list of names, cut short before it stops being readable. The tail is counted rather
 * than dropped, because "and 40 more" is information and a truncated list is not.
 *
 * @param {string[]} names
 * @param {number} [limit]
 * @returns {string}
 */
export const listOf = (names, limit = 12) => (names.length > limit
  ? `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`
  : names.join(', '));

/**
 * How big a file we just wrote is. Two commands write files and both had this phrase spelled
 * by hand with the numbers interpolated raw, which is how a one-line file gets reported as
 * "1 lines" -- a grammar slip in the one sentence that is about our own output, in a tool
 * whose entire pitch is that the tables can be trusted.
 *
 * @param {{ lines: number, bytes: number }} counts
 * @returns {string}
 */
export const sizeOf = ({ lines, bytes }) => `${plural(lines, 'line')}, ${plural(bytes, 'byte')}`;

/** The tail of a dry run, spelled once. `eject` and `stdlibmd` both end this way, and two
 * commands describing the same nothing in two different sentences reads as two tools. */
export const DRY_RUN = 'nothing was written: this was a dry run.';

/**
 * The suggestion tail, or nothing at all. Seven sites asked this question in three different
 * shapes, and a tool that says "did you mean" three ways has three authors rather than one.
 * Empty in, empty out, so a caller that wants to list the whole known set instead writes that
 * as a plain else rather than a ternary inside a template.
 *
 * `quote` is for names that came out of somebody's config file: those can be blank, or have a
 * space in them, and an unquoted suggestion of `""` is not a suggestion. Our own command and
 * module names cannot, so they read better bare.
 *
 * @param {string[]} near candidates, already scored and cut by `suggest`
 * @param {{ quote?: boolean, lead?: string }} [options]
 * @returns {string}
 */
export const didYouMean = (near, { quote = false, lead = ', ' } = {}) => (near.length === 0
  ? ''
  : `${lead}did you mean ${near.map((one) => (quote ? `"${one}"` : one)).join(' or ')}?`);
