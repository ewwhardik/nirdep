// Directory walking without glob.
//
// fs.globSync landed in Node 22 and would cover most of this, but we need ignore semantics
// (skip node_modules, dot directories, build output) and a predictable traversal order for
// reproducible builds, so we walk readdir ourselves. Order is sorted by name at every
// level: two runs on the same tree produce the same sequence, which is what `make repro`
// depends on.
//
// Two ways to say "not that", because they answer different questions. `ignore` is a Set of
// bare names and skips an entry wherever it appears -- one hash lookup per entry, which is
// what you want for the five names every project has. `exclude` is glob patterns matched
// against the path relative to the root, which is the only way to say "not tests/fixtures"
// without also losing src/fixtures. The patterns come from src/runtime/glob.mjs, this
// project's own matcher: the module was written because our own walk needed it, and a
// pattern layer built on a package we tell other people to delete would be a joke.
//
// Pruning follows globSync's rule. A directory whose relative path matches an `exclude`
// pattern is never opened, so the subtree costs nothing; a directory is only opened at all
// when some `include` pattern could still match inside it, which is what `partial: true`
// is for. Sorting is untouched by either, so the deterministic order survives.

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matcher } from '../runtime/glob.mjs';

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache']);

/** Patterns are written with forward slashes on every platform, so the path we test is. */
const SLASH = '/';

const asList = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Compile once per walk rather than once per entry. `dot: true` because the walk already
 * yields dotfiles by name, and a pattern that quietly skipped them would disagree with the
 * `ignore` Set sitting next to it.
 */
const compile = (patterns, extra) => asList(patterns).map((one) => matcher(one, { dot: true, ...extra }));

/**
 * Walk `root` and yield absolute file paths in a deterministic order.
 *
 * @param {string} root
 * @param {{
 *   ignore?: Set<string>,
 *   exclude?: string | string[],
 *   include?: string | string[],
 *   extensions?: Set<string>,
 *   followSymlinks?: boolean,
 * }} options
 */
export function* walk(root, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const extensions = options.extensions ?? null;
  const skips = compile(options.exclude);
  const wanted = compile(options.include);
  // The same patterns asked a weaker question: could anything under here still match?
  const reaches = wanted.length === 0 ? [] : compile(options.include, { partial: true });
  const stack = [{ dir: root, prefix: '' }];
  while (stack.length > 0) {
    const here = stack.pop();
    let entries;
    try {
      entries = readdirSync(here.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Push directories in reverse so the sorted order survives the stack.
    const directories = [];
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const path = here.prefix === '' ? entry.name : here.prefix + SLASH + entry.name;
      if (skips.some((test) => test(path))) continue;
      const full = join(here.dir, entry.name);
      if (entry.isDirectory()) {
        if (worthEntering(path, reaches)) directories.push({ dir: full, prefix: path });
      } else if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          if (statSync(full).isDirectory()) {
            if (worthEntering(path, reaches)) directories.push({ dir: full, prefix: path });
          } else if (keep(entry.name, path, extensions, wanted)) yield full;
        } catch { /* broken link */ }
      } else if (entry.isFile() && keep(entry.name, path, extensions, wanted)) {
        yield full;
      }
    }
    for (let n = directories.length - 1; n >= 0; n -= 1) stack.push(directories[n]);
  }
}

/** Extension first, because it is a substring compare and a pattern test is a walk. */
function keep(name, path, extensions, wanted) {
  if (!hasExtension(name, extensions)) return false;
  return wanted.length === 0 || wanted.some((test) => test(path));
}

/** No include patterns means every directory is worth opening, which is the old behaviour. */
function worthEntering(path, reaches) {
  return reaches.length === 0 || reaches.some((test) => test(path));
}

function hasExtension(name, extensions) {
  if (extensions === null) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.has(name.slice(dot));
}

/** Posix-style path relative to root, so reports read the same on every platform. */
export function displayPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * The file selection every project reader takes, in one place.
 *
 * `scan`, `plan`/`apply` and `stdlibmd` are three commands that have to agree about which
 * files count: a package the codemod never saw is a package `scan` should not have reported
 * as rewritten. They agree by calling this rather than by each spelling out the same four
 * options. `files` short-circuits the walk, which is how the tests plant a list.
 *
 * @param {string} root
 * @param {{ files?: string[] } & Parameters<typeof walk>[1]} [options]
 * @returns {string[]}
 */
export function selectFiles(root, options = {}) {
  if (options.files !== undefined) return options.files;
  return [...walk(root, {
    ignore: options.ignore,
    exclude: options.exclude,
    include: options.include,
    extensions: options.extensions,
    followSymlinks: options.followSymlinks,
  })];
}
