// Editing files by byte range, and refusing to when the ranges disagree.
//
// The lexer next door hands back offsets. This turns a list of offsets into a new
// file, and it is deliberately the dullest module in the project: it does not know
// what JavaScript is, it does not reformat, it does not reflow, it does not have an
// opinion about your semicolons. It copies bytes and splices in replacements. A
// codemod that goes through a printer comes back with your blank lines rearranged
// and your comments in new places, and then you are diffing a whole file to find
// the two lines you asked for.
//
// Two rules earn their keep here. Every edit must carry a reason, because `plan`
// prints reasons and an edit nobody can explain has no business in a patch. And two
// edits that overlap are a bug in the caller, not a merge to attempt: whichever one
// lost would be silently dropped, which is how a rewrite half-happens.

/** A patch failed for a reason the caller can act on. */
export class PatchError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    Object.assign(this, detail);
  }
}

const fail = (code, message, detail) => {
  throw new PatchError(code, message, detail);
};

const isIndex = (value) => Number.isInteger(value) && value >= 0;

/** Do two half-open ranges share a byte? Touching end-to-start does not count. */
const overlaps = (one, other) => one.start < other.end && other.start < one.end;

/**
 * Sort into apply order: by start, then by the order they were added. The second key
 * matters for two inserts at the same offset, where the caller's order is the only
 * information available about which text comes first.
 */
const inOrder = (one, other) => (one.start - other.start) || (one.seq - other.seq);

/**
 * Apply a list of edits to a string. Right to left, so an offset is never stale by
 * the time it is used. Exported on its own because it is worth being able to test
 * the splicing without building a patch around it.
 *
 * @param {string} source
 * @param {ReadonlyArray<{ start: number, end: number, text: string }>} edits
 * @returns {string}
 */
export function applyEdits(source, edits) {
  const ordered = [...edits].sort(inOrder);
  let out = source;
  for (let n = ordered.length - 1; n >= 0; n -= 1) {
    const one = ordered[n];
    out = out.slice(0, one.start) + one.text + out.slice(one.end);
  }
  return out;
}

/**
 * Collect edits against one file, then apply them all at once.
 *
 * Nothing is written to `source`; the patch holds the edits and hands back a new
 * string when asked. Rules add edits, `plan` prints them, `apply` writes them, and
 * the same object serves all three, so the diff a user approves is the diff that
 * runs.
 *
 * @param {string} source
 * @param {{ file?: string }} [options]
 */
export function createPatch(source, options = {}) {
  if (typeof source !== 'string') fail('NOT_A_STRING', 'a patch needs source text');
  const file = options.file ?? '<memory>';
  const edits = [];

  const record = (start, end, text, why, kind) => {
    if (!isIndex(start) || !isIndex(end)) {
      fail('BAD_RANGE', `${file}: an edit range must be two offsets`, { start, end });
    }
    if (end < start) fail('BAD_RANGE', `${file}: an edit ends before it starts`, { start, end });
    if (end > source.length) {
      fail('BAD_RANGE', `${file}: an edit runs past the end of the file`, { start, end, length: source.length });
    }
    if (typeof text !== 'string') fail('BAD_TEXT', `${file}: replacement text must be a string`, { start, end });
    // An edit with no reason cannot appear in a report, and a rewrite nobody can
    // explain is a rewrite nobody should approve.
    if (typeof why !== 'string' || why.trim() === '') {
      fail('NO_REASON', `${file}: every edit must say why it exists`, { start, end });
    }
    const one = {
      start, end, text, why, kind, seq: edits.length, was: source.slice(start, end),
    };
    for (const existing of edits) {
      if (!overlaps(one, existing)) continue;
      fail('OVERLAPPING_EDITS', `${file}: two edits want the same bytes (${existing.start}-${existing.end} and ${start}-${end})`, {
        first: existing.why, second: why, start, end,
      });
    }
    edits.push(one);
    return one;
  };

  return {
    /** Overwrite `[start, end)` with `text`. */
    replace(start, end, text, why) {
      record(start, end, text, why, 'replace');
      return this;
    },
    /** Put `text` at `at`, moving nothing. */
    insert(at, text, why) {
      record(at, at, text, why, 'insert');
      return this;
    },
    /** Delete `[start, end)`. */
    remove(start, end, why) {
      record(start, end, '', why, 'remove');
      return this;
    },
    get size() {
      return edits.length;
    },
    /** The edits in apply order, frozen, safe to print. */
    list() {
      return Object.freeze([...edits].sort(inOrder).map((one) => Object.freeze({ ...one })));
    },
    /**
     * The result. `changed` is false when every edit put back what was already
     * there — a rule that matched and had nothing to do is not a change, and
     * reporting it as one would make `plan` noisy and `apply` rewrite mtimes for
     * nothing.
     */
    apply() {
      const list = this.list();
      const after = applyEdits(source, list);
      return Object.freeze({
        file,
        before: source,
        after,
        edits: list,
        changed: after !== source,
        bytes: Object.freeze({ before: source.length, after: after.length }),
      });
    },
  };
}
