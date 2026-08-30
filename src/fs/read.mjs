// The one seam every command reads through.
//
// Ten call sites were each spelling `options.read ?? ((file) => readFileSync(file, 'utf8'))`
// by hand. It is the hook the whole test suite hangs off -- a planted tree is a Map and a
// closure, never a temporary directory -- so ten copies of it is ten chances for one command
// to take a reader nobody can override.
//
// `present` is the other half. Absence and unreadability are different answers: a file that
// is not there is the ordinary case for `eject` and `stdlibmd`, and a file that is there and
// throws is a file to leave alone rather than overwrite on a hunch. Every reader in this
// project has to make that distinction, and getting it backwards loses somebody's work.

import { readFileSync } from 'node:fs';

/**
 * The text reader a command was given, or the real one.
 *
 * @param {{ read?: (file: string) => string }} [options]
 * @returns {(file: string) => string}
 */
export const readerFrom = (options = {}) => options.read ?? ((file) => readFileSync(file, 'utf8'));

/**
 * A read where absence is an answer rather than a failure. `missing` is ENOENT and its two
 * neighbours -- a path through a file, and a name too long for the filesystem both mean
 * "nothing is there" as surely as ENOENT does. Anything else comes back as `error`, and a
 * caller that overwrites on an `error` has destroyed a file it could not read.
 *
 * @param {(file: string) => string} read
 * @param {string} path
 * @returns {{ text: string|null, missing: boolean, error: Error|null }}
 */
export function present(read, path) {
  try {
    return { text: read(path), missing: false, error: null };
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ENAMETOOLONG';
    return { text: null, missing, error: missing ? null : error };
  }
}

/**
 * JSON where a missing or malformed file is not an error but a shape. Both callers want the
 * same fallback for both failures: a manifest that is not JSON tells you as little about the
 * project as one that is not there.
 *
 * @param {(file: string) => string} read
 * @param {string} path
 * @returns {object|null}
 */
export function readJson(read, path) {
  try {
    const value = JSON.parse(read(path));
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}
