// Reading the project for evidence of the migration, and writing the document out.
//
// Two jobs, both of which touch somebody else's disk, which is why they are in the same file
// and out of src/stdlib/document.mjs.
//
// The first is adoption: once `apply` or `eject` has run, the packages are gone from the
// manifest and a scan of the project has nothing left to report -- which is exactly the
// moment the document is worth generating. So the imports are read a second time, looking
// for the replacement rather than for the package. A copy in the tree is identified by the
// banner eject wrote at the top of it, not by its file name: a project with its own
// src/args.mjs is not a project that adopted ours, and guessing from the name would put a
// claim in a document that the code does not support.
//
// There is a third form, and nirdep is the project that has it: a relative import that
// resolves to our own src/runtime/<name>.mjs is not a copy of the replacement, it is the
// replacement. Without that case the tool would generate a document about itself saying it
// had replaced nothing, which is the one project where that sentence is provably wrong.
//
// The second is the write, and it follows eject: identical is not a conflict, different is
// somebody's edit, and an edit is not ours to overwrite without being told twice. A STDLIB.md
// is a document a person is meant to finish by hand, so this refusal matters more here than
// it does for a vendored module.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSpecifiers } from '../audit/imports.mjs';
import { SOURCE_EXTENSIONS } from '../apply/project.mjs';
import { catalogue } from '../eject/project.mjs';
import { displayPath, walk } from '../fs/walk.mjs';
import { RULES } from '../rules/registry.mjs';

/** The file this command writes, unless told otherwise. */
export const STDLIB_FILE = 'STDLIB.md';

/** What happened to it. */
export const RESULT = Object.freeze({
  WRITTEN: 'written',
  WOULD_WRITE: 'would-write',
  SAME: 'same',
  REFUSED: 'refused',
  FAILED: 'failed',
});

const moduleOf = (subpath) => subpath.slice(subpath.lastIndexOf('/') + 1);
const MODULES = Object.freeze([...new Set(RULES.map((rule) => moduleOf(rule.subpath)))]);

/** The package form, as `apply` writes it without --runtime. */
const PACKAGE_FORM = /^nirdep\/runtime\/([a-z0-9-]+)(?:\.mjs)?$/;
/** The first line of a file eject wrote. Quoted from its banner, which is the only claim of
 * provenance a vendored copy carries. */
const VENDORED = /vendored from nirdep\/runtime\/([a-z0-9-]+)/;

/**
 * Which replacements this project imports, and from where.
 *
 * A second walk over the tree, after scanProject's. That is real duplicated I/O and it is
 * accepted: the scan keeps third-party specifiers only, a vendored copy is a relative path,
 * and widening the scan's record to carry relative imports would change a structure that
 * four commands already read.
 *
 * @param {string} root
 * @returns {Map<string, { sites: Array<object>, files: string[], vendored: boolean, home: boolean }>}
 */
export function stdlibAdoption(root, options = {}) {
  const read = options.read ?? ((file) => readFileSync(file, 'utf8'));
  const files = options.files ?? [...walk(root, { ignore: options.ignore, extensions: SOURCE_EXTENSIONS })];
  const found = new Map();
  // Where each module's one true copy lives, taken off our own exports map rather than off a
  // guess at the layout. An import that lands on one of these paths is the runtime itself.
  const home = new Map((options.catalogue ?? catalogue({ read: options.readMeta ?? read }))
    .map((module) => [resolve(module.source), module.name]));

  const record = (name, path, line, specifier, kind) => {
    let one = found.get(name);
    if (one === undefined) {
      one = { sites: [], files: new Set(), vendored: false, home: false };
      found.set(name, one);
    }
    one.sites.push({ path, line, specifier, kind });
    one.files.add(path);
    if (kind === 'copy') one.vendored = true;
    if (kind === 'source') one.home = true;
  };

  for (const file of files) {
    const path = displayPath(root, file);
    let source;
    try {
      source = read(file);
    } catch {
      continue; // an unreadable file is the scan's finding to report, not this one's
    }
    for (const one of findSpecifiers(source)) {
      const asPackage = PACKAGE_FORM.exec(one.specifier);
      if (asPackage !== null) {
        if (MODULES.includes(asPackage[1])) record(asPackage[1], path, one.line, one.specifier, 'package');
        continue;
      }
      if (!one.specifier.startsWith('.')) continue;
      const leaf = one.specifier.slice(one.specifier.lastIndexOf('/') + 1);
      if (!MODULES.includes(leaf.replace(/\.mjs$/, '')) || !leaf.endsWith('.mjs')) continue;
      const target = resolve(dirname(file), one.specifier);
      const ours = home.get(target);
      if (ours !== undefined) {
        record(ours, path, one.line, one.specifier, 'source');
        continue;
      }
      // Only now is a file opened, and only the head of it: the name got us this far and the
      // banner is what decides.
      let banner;
      try {
        banner = read(target).slice(0, 200);
      } catch {
        continue;
      }
      const vendored = VENDORED.exec(banner);
      if (vendored !== null && MODULES.includes(vendored[1])) {
        record(vendored[1], path, one.line, one.specifier, 'copy');
      }
    }
  }

  return new Map([...found.entries()].map(([name, one]) => [name, Object.freeze({
    sites: Object.freeze(one.sites),
    files: Object.freeze([...one.files].sort()),
    vendored: one.vendored,
    home: one.home,
  })]));
}

/**
 * Where the document would go, and what is already there.
 *
 * @param {object} document the result of stdlibDocument
 * @param {{ root: string, file?: string, read?: (file: string) => string }} options
 */
export function stdlibPlan(document, options) {
  const read = options.read ?? ((file) => readFileSync(file, 'utf8'));
  const file = options.file ?? STDLIB_FILE;
  const path = resolve(options.root, file);
  let existing = null;
  let unreadable = null;
  try {
    existing = read(path);
  } catch (error) {
    // ENOENT is the ordinary case. Anything else is a file that is there and cannot be
    // compared, which is not a file to overwrite on a hunch.
    if (error.code !== 'ENOENT') unreadable = error.message;
  }
  return Object.freeze({
    document,
    path,
    display: displayPath(options.root, path),
    existing,
    unreadable,
    same: existing === document.markdown,
  });
}

/**
 * @param {object} plan the result of stdlibPlan
 * @param {{ write?: boolean, force?: boolean, writeFile?: (path: string, text: string) => void }} [options]
 */
export function stdlibApply(plan, options = {}) {
  const write = options.write !== false;
  const writeOut = options.writeFile ?? ((path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  });

  const decide = () => {
    if (plan.unreadable !== null) {
      return [RESULT.REFUSED, `it is there and cannot be read: ${plan.unreadable}`];
    }
    if (plan.same) return [RESULT.SAME, null];
    if (plan.existing !== null && options.force !== true) {
      return [RESULT.REFUSED, 'it is there and says something else; --force to replace it'];
    }
    if (!write) return [RESULT.WOULD_WRITE, null];
    try {
      writeOut(plan.path, plan.document.markdown);
      return [RESULT.WRITTEN, null];
    } catch (error) {
      return [RESULT.FAILED, error.message];
    }
  };

  const [result, reason] = decide();
  return Object.freeze({
    ...plan, result, reason, replaced: plan.existing !== null && result === RESULT.WRITTEN, wrote: write,
  });
}
