// The three things every report in this project needs and none of them wants to own.
//
// A style hook set, a plural, and a fold. They were private to src/apply/report.mjs
// until `scan` needed the same fold at the same width, and two copies of a text
// measurement is how two commands end up wrapping at different columns for no reason a
// user could explain.
//
// None of this knows what colour is. The CLI passes in hooks from src/runtime/colour.mjs
// when the stream is a terminal and passes nothing when it is a pipe, so a report is
// testable without an escape sequence anywhere near it.

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
