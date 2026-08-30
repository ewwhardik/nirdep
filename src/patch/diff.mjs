// Myers diff, line by line, and a unified diff to print.
//
// `plan` has one job: show the user what `apply` will do, in the format every
// reviewer already knows. That means real hunks with real context, not "3 lines
// changed in 2 files", which is a progress bar pretending to be evidence.
//
// The algorithm is Myers 1986 -- the greedy edit-graph walk that git uses. It runs
// in O((N+M)D) where D is the size of the edit script, which is the useful shape
// here: a codemod changes a handful of lines in a large file, so D stays small and
// the file's size barely matters. Two things keep it honest on pathological input:
// the common prefix and suffix are trimmed before the search starts, and D is
// capped, past which we stop pretending and emit the whole file as one
// replacement.

/** How a line came out of the diff. */
export const OP = Object.freeze({ KEEP: ' ', ADD: '+', REMOVE: '-' });

/** Past this many differences we stop searching and replace the file wholesale. */
const MAX_D = 8000;

/**
 * Split into lines, keeping the information a diff needs and a naive split loses:
 * whether the text ended with a newline. `"a\n"` and `"a"` are different files and
 * a patch that confuses them adds or eats a byte.
 *
 * @param {string} text
 * @returns {{ lines: string[], endsWithNewline: boolean }}
 */
export function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: true };
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

/**
 * The edit graph walk. Returns the moves that turn `a` into `b`, or null when the
 * two are further apart than MAX_D, which is the signal to stop being clever.
 *
 * Each stored round keeps only the band of the frontier that round can reach --
 * k in [-d-1, d+1] -- because keeping the whole array every round is how a diff of
 * a large file turns into a memory problem.
 */
function walk(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[offset + 1] = 0;
  const trace = [];
  const limit = Math.min(max, MAX_D);
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

/** Read the frontier of round `d` out of its stored band. */
const band = (window, d, k) => window[k + d + 1];

/** Follow the trace backwards into a list of single-line moves, front to back. */
function retrace(trace, a, b) {
  const moves = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const window = trace[d];
    const k = x - y;
    const previousK = (k === -d || (k !== d && band(window, d, k - 1) < band(window, d, k + 1)))
      ? k + 1
      : k - 1;
    const previousX = band(window, d, previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      moves.push({ op: OP.KEEP, text: a[x] });
    }
    if (d > 0) {
      if (x === previousX) moves.push({ op: OP.ADD, text: b[previousY] });
      else moves.push({ op: OP.REMOVE, text: a[previousX] });
    }
    x = previousX;
    y = previousY;
  }
  moves.reverse();
  return moves;
}

/**
 * Lines with their terminators still attached, which is the representation that makes
 * the newline-at-end-of-file question answer itself: a piece without a trailing `\n`
 * can only be the last one, so `"a"` and `"a\n"` compare unequal and the diff reports
 * the change instead of losing it.
 */
function pieces(text) {
  const { lines, endsWithNewline } = splitLines(text);
  const last = lines.length - 1;
  return lines.map((line, n) => (n === last && !endsWithNewline ? line : `${line}\n`));
}

/** Strip the terminator back off, remembering when there wasn't one. */
const finish = (move) => (move.text.endsWith('\n')
  ? { op: move.op, text: move.text.slice(0, -1), noNewline: false }
  : { op: move.op, text: move.text, noNewline: true });

/** Count the moves, for a caller that wants a number rather than a diff. */
export function stat(ops) {
  let added = 0;
  let removed = 0;
  let kept = 0;
  for (const one of ops) {
    if (one.op === OP.ADD) added += 1;
    else if (one.op === OP.REMOVE) removed += 1;
    else kept += 1;
  }
  return Object.freeze({ added, removed, kept });
}

/**
 * Diff two texts by line.
 *
 * The matching head and tail are peeled off before the search, so a one-line change in
 * a thousand-line file is a one-line search. `truncated` is true when the middle was
 * too big to search and the whole of it became one delete-then-insert -- still a
 * correct patch, just an unhelpful one to read.
 *
 * @param {string} before
 * @param {string} after
 */
export function diffLines(before, after) {
  const a = pieces(before);
  const b = pieces(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const trace = walk(middleA, middleB);
  const truncated = trace === null;
  const middle = truncated
    ? [
      ...middleA.map((text) => ({ op: OP.REMOVE, text })),
      ...middleB.map((text) => ({ op: OP.ADD, text })),
    ]
    : retrace(trace, middleA, middleB);
  const ops = Object.freeze([
    ...a.slice(0, head).map((text) => ({ op: OP.KEEP, text })),
    ...middle,
    ...a.slice(a.length - tail).map((text) => ({ op: OP.KEEP, text })),
  ].map((move) => Object.freeze(finish(move))));
  return Object.freeze({ ops, truncated, ...stat(ops) });
}

/** Number each move on both sides. -1 means the move does not exist on that side. */
function positions(ops) {
  let oldLine = 0;
  let newLine = 0;
  return ops.map((one) => {
    const row = {
      ...one,
      oldIndex: one.op === OP.ADD ? -1 : oldLine,
      newIndex: one.op === OP.REMOVE ? -1 : newLine,
      oldBefore: oldLine,
      newBefore: newLine,
    };
    if (one.op !== OP.ADD) oldLine += 1;
    if (one.op !== OP.REMOVE) newLine += 1;
    return row;
  });
}

/**
 * Which stretches of the diff a reviewer needs: every change, plus `context` lines
 * either side. Two changes close enough to share their context share a hunk, because
 * the alternative prints the same lines twice with a header wedged between them.
 */
function hunks(rows, context) {
  const changed = rows.map((one) => one.op !== OP.KEEP);
  const spans = [];
  let n = 0;
  while (n < rows.length) {
    if (!changed[n]) {
      n += 1;
      continue;
    }
    let end = n;
    let scan = n;
    while (scan < rows.length) {
      if (changed[scan]) {
        end = scan;
        scan += 1;
        continue;
      }
      let run = scan;
      while (run < rows.length && !changed[run]) run += 1;
      if (run < rows.length && run - scan <= context * 2) {
        scan = run;
        continue;
      }
      break;
    }
    spans.push([Math.max(0, n - context), Math.min(rows.length - 1, end + context)]);
    n = end + 1;
  }
  return spans;
}

/**
 * A unified diff, the format `git diff` prints and `patch -p1` eats. Empty string when
 * the two texts are the same, so a caller can treat truthiness as "something changed".
 *
 * Ranges are always written with an explicit count -- `-4,1` rather than the `-4`
 * shorthand -- which patch(1) accepts and a human reads without counting.
 *
 * @param {string} before
 * @param {string} after
 * @param {{ fromFile?: string, toFile?: string, context?: number }} [options]
 * @returns {string}
 */
export function unified(before, after, options = {}) {
  const context = Math.max(0, options.context ?? 3);
  const fromFile = options.fromFile ?? 'a';
  const toFile = options.toFile ?? 'b';
  const rows = positions(diffLines(before, after).ops);
  const spans = hunks(rows, context);
  if (spans.length === 0) return '';
  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  for (const [start, end] of spans) {
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter((one) => one.op !== OP.ADD).length;
    const newCount = slice.filter((one) => one.op !== OP.REMOVE).length;
    const oldStart = slice[0].oldBefore + (oldCount === 0 ? 0 : 1);
    const newStart = slice[0].newBefore + (newCount === 0 ? 0 : 1);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const one of slice) {
      out.push(`${one.op}${one.text}`);
      if (one.noNewline) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}
