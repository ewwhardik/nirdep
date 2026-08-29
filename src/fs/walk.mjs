// Directory walking without glob.
//
// fs.globSync landed in Node 22 and would cover most of this, but we need
// ignore semantics (skip node_modules, dot directories, build output) and a
// predictable traversal order for reproducible builds, so we walk readdir
// ourselves. Order is sorted by name at every level: two runs on the same tree
// produce the same sequence, which is what `make repro` depends on.

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache']);

/**
 * Walk `root` and yield absolute file paths in a deterministic order.
 * @param {string} root
 * @param {{ ignore?: Set<string>, extensions?: Set<string>, followSymlinks?: boolean }} options
 */
export function* walk(root, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const extensions = options.extensions ?? null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Push directories in reverse so the sorted order survives the stack.
    const directories = [];
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(full);
      } else if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          if (statSync(full).isDirectory()) directories.push(full);
          else if (matches(entry.name, extensions)) yield full;
        } catch { /* broken link */ }
      } else if (entry.isFile() && matches(entry.name, extensions)) {
        yield full;
      }
    }
    for (let n = directories.length - 1; n >= 0; n -= 1) stack.push(directories[n]);
  }
}

function matches(name, extensions) {
  if (extensions === null) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.has(name.slice(dot));
}

/** Posix-style path relative to root, so reports read the same on every platform. */
export function displayPath(root, file) {
  return relative(root, file).split(sep).join('/');
}
