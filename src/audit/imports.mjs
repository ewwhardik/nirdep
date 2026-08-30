// Finding every import in a file, without a parser.
//
// This is the primitive the zero-dependency proof stands on, and later the
// dependency audit too, so it lives in src/ where it can be tested rather than
// inside the tools/ script that first needed it.
//
// It is a scanner, not a parser: it matches the six syntactic positions a module
// specifier can appear in and reads the string literal out of each. That is
// deliberately blunt, and blunt in a specific direction — a specifier mentioned
// inside a comment or a string will be reported. For a proof of absence that is
// the right bias. A false positive costs one line of explanation; a false
// negative invalidates the only claim the project makes about itself. The real
// lexer in src/lex takes over the *rewriting* side; this stays as the belt.

import { isBuiltin } from 'node:module';

/**
 * The positions we read. Each pattern must capture the specifier in group 1.
 * @type {ReadonlyArray<{ kind: string, pattern: RegExp }>}
 */
export const SPECIFIER_PATTERNS = Object.freeze([
  { kind: 'import-from', pattern: /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g },
  { kind: 'import-bare', pattern: /\bimport\s*['"]([^'"]+)['"]/g },
  { kind: 'import-dynamic', pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  { kind: 'export-from', pattern: /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g },
  { kind: 'require', pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  { kind: 'create-require', pattern: /\bcreateRequire\s*\([^)]*\)\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
]);

/**
 * Ask the running Node whether a specifier resolves internally.
 *
 * `module.isBuiltin` rather than a set built from `builtinModules`, because
 * `builtinModules` gets three cases wrong for this purpose: it omits
 * prefix-only modules such as `node:test` and `node:sqlite`; it omits subpaths
 * such as `node:assert/strict`; and pairing every name with a `node:` form
 * would wrongly accept bare `test`, which resolves to a package on npm, not to
 * Node. Delegating also means the proof gets more accurate on newer Node
 * instead of drifting out of date.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isBuiltinSpecifier(specifier) {
  return isBuiltin(specifier);
}

/**
 * The package a specifier belongs to. `chalk/index.js` is chalk; `@scope/a/b` is
 * `@scope/a`, because a scope on its own is not a package and cutting at the first slash
 * would produce one.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * @param {string} specifier
 * @param {{ selfNames?: Set<string> }} [options]
 * @returns {'relative' | 'absolute' | 'subpath' | 'builtin' | 'self' | 'third-party'}
 */
export function classify(specifier, options = {}) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') return 'relative';
  if (specifier.startsWith('/')) return 'absolute';
  if (specifier.startsWith('#')) return 'subpath';
  if (isBuiltinSpecifier(specifier)) return 'builtin';
  if (options.selfNames === undefined) return 'third-party';
  // Two shapes of the same thing. A caller may register a whole specifier, which is what
  // this project's own runtime paths look like, or just the package name -- and a package
  // may import itself by name through its own `exports` map, so `demo/helper` inside
  // `demo` is a self reference. Missing that made `scan` report the project as one of its
  // own dependencies, which is a number nobody could act on.
  if (options.selfNames.has(specifier) || options.selfNames.has(packageOf(specifier))) return 'self';
  return 'third-party';
}

/**
 * Every specifier in a source file, in the order the matcher found them, with
 * duplicates from overlapping patterns collapsed by byte offset. Line numbers
 * are one-based so they can be pasted after a colon and clicked.
 *
 * @param {string} source
 * @returns {Array<{ specifier: string, kind: string, index: number, line: number }>}
 */
export function findSpecifiers(source) {
  /** @type {Map<number, { specifier: string, kind: string, index: number, line: number }>} */
  const byOffset = new Map();

  // One pass to build a line index, so we are not re-splitting the file for
  // every match. Files here are small, but the audit runs this over whole
  // repositories and the quadratic version is felt.
  const lineStarts = [0];
  for (let n = 0; n < source.length; n += 1) if (source[n] === '\n') lineStarts.push(n + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const { kind, pattern } of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const index = match.index + match[0].lastIndexOf(match[1]);
      if (byOffset.has(index)) continue;
      byOffset.set(index, { specifier: match[1], kind, index, line: lineOf(index) });
    }
  }

  return [...byOffset.values()].sort((a, b) => a.index - b.index);
}

/**
 * The audit answer for one file: every specifier, plus just the third-party ones.
 *
 * @param {string} source
 * @param {{ selfNames?: Set<string> }} [options]
 */
export function auditSource(source, options = {}) {
  const found = findSpecifiers(source).map((entry) => ({ ...entry, kind: entry.kind, category: classify(entry.specifier, options) }));
  return { specifiers: found, thirdParty: found.filter((entry) => entry.category === 'third-party') };
}
