// Handing the runtime over, so that the tool can leave.
//
// `apply --runtime nirdep/runtime` rewrites every `chalk` import into a relative path
// pointing at a file in that directory. This is the command that puts a file there.
// Without it the codemod's best case is swapping eight dependencies for one, which is a
// smaller number and the same problem.
//
// Three rules, and each one exists because the alternative is a support ticket.
//
// It never overwrites bytes it did not write. A file that is already there and already
// identical is not a conflict and not an error, so re-running eject is free; a file that
// differs is somebody's edit, and clobbering an edit is how a tool loses the benefit of
// the doubt. `--force` says so out loud.
//
// It is deterministic. No timestamp, no username, no "generated on" line -- eject the
// same module twice and the bytes are equal, which is what makes the comparison above
// mean anything at all.
//
// It keeps the copyright line and drops everything else. The banner names where the file
// came from and what it replaces, because a reviewer finding 900 unfamiliar lines in a
// diff deserves a first line that explains them. MIT asks for the notice; nothing asks
// for an advertisement.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_DIR } from '../apply/project.mjs';
import { present, readerFrom } from '../fs/read.mjs';
import { byField, displayPath, toPosix } from '../fs/walk.mjs';
import { RULES } from '../rules/registry.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** What was found at the destination, before anything was written. */
export const STATE = Object.freeze({
  NEW: 'new',
  SAME: 'same',
  DIFFERS: 'differs',
  UNREADABLE: 'unreadable',
});

/** And what happened to it afterwards. */
export const RESULT = Object.freeze({
  WRITTEN: 'written',
  WOULD_WRITE: 'would-write',
  SKIPPED: 'skipped',
  REFUSED: 'refused',
  FAILED: 'failed',
});

/**
 * The modules on offer, read off our own `exports` map rather than typed out here.
 *
 * A hand-written list is a list that disagrees with `package.json` the first time somebody
 * adds a module, and it disagrees in the direction that matters: `eject` would offer a
 * subpath that does not resolve, or quietly stop offering one that does. The download
 * figures and the "replaces" list come from the rule catalogue for the same reason.
 *
 * @param {{ read?: (file: string) => string }} [options]
 */
export function catalogue(options = {}) {
  const read = readerFrom(options);
  const manifest = JSON.parse(read(join(ROOT, 'package.json')));
  const entries = [];
  for (const [subpath, file] of Object.entries(manifest.exports ?? {})) {
    if (!subpath.startsWith('./runtime/')) continue;
    const name = subpath.slice('./runtime/'.length);
    const rules = RULES.filter((rule) => rule.subpath === `runtime/${name}`);
    entries.push(Object.freeze({
      name,
      subpath: `runtime/${name}`,
      target: `${manifest.name}/runtime/${name}`,
      leaf: `${name}.mjs`,
      source: join(ROOT, file.replace(/^\.\//, '')),
      replaces: Object.freeze(rules.map((rule) => rule.package)),
      version: manifest.version,
    }));
  }
  return Object.freeze(entries.sort(byField('name')));
}

/** The provenance header. Six lines, so nobody has to guess what the next 900 are. */
function banner(module) {
  const replaces = module.replaces.length > 0
    ? `Replaces ${module.replaces.join(', ')}.`
    : 'A standard-library module with no package to replace.';
  return [
    `// ${module.leaf} -- vendored from ${module.target}, version ${module.version}.`,
    `// ${replaces}`,
    '//',
    '// A copy, not a dependency: nothing to install, nothing to bump, nothing in a',
    '// lockfile. Edit it, rename it, delete the half you do not use. The line below is',
    '// the only string attached, and it is attached by the licence rather than by us.',
    '//',
    '// MIT. Copyright (c) 2026 Hardik (Nastik AI).',
    '',
    '',
  ].join('\n');
}

/**
 * What eject would write, and what is already there. Reads; writes nothing.
 *
 * @param {{ modules?: string[], into?: string, cwd?: string, read?: (file: string) => string }} [options]
 */
export function ejectPlan(options = {}) {
  const read = readerFrom(options);
  const available = catalogue({ read });
  const cwd = resolve(options.cwd ?? '.');
  const into = options.into ?? DEFAULT_RUNTIME_DIR;
  const base = isAbsolute(into) ? into : resolve(cwd, into);

  const asked = options.modules ?? [];
  const unknown = asked.filter((name) => !available.some((module) => module.name === name));
  const chosen = asked.length === 0
    ? available
    : available.filter((module) => asked.includes(module.name));

  const files = chosen.map((module) => {
    const file = join(base, module.leaf);
    const text = `${banner(module)}${read(module.source)}`;
    // Absent is the whole point of the command; unreadable is a file to leave alone.
    const found = present(read, file);
    const state = found.error !== null
      ? STATE.UNREADABLE
      : found.missing ? STATE.NEW : found.text === text ? STATE.SAME : STATE.DIFFERS;
    return Object.freeze({
      module: module.name,
      target: module.target,
      replaces: module.replaces,
      file,
      path: displayPath(cwd, file),
      bytes: Buffer.byteLength(text),
      lines: text.split('\n').length - 1,
      text,
      state,
      reason: state === STATE.UNREADABLE ? 'it is there but cannot be read' : null,
    });
  });

  return Object.freeze({
    // As the user spelled it, because it is about to be printed back at them inside the
    // `apply --runtime` line that makes the ejected files reachable.
    into: toPosix(into),
    dir: base,
    files: Object.freeze(files),
    available: Object.freeze(available.map((module) => module.name)),
    unknown: Object.freeze(unknown),
  });
}

/**
 * Write the plan out, or count what it would have written.
 *
 * @param {object} plan the result of ejectPlan
 * @param {{ write?: boolean, force?: boolean, mkdir?: (dir: string) => void, writeFile?: (file: string, text: string) => void }} [options]
 */
export function ejectApply(plan, options = {}) {
  const write = options.write === true;
  const force = options.force === true;
  const mkdir = options.mkdir ?? ((dir) => { mkdirSync(dir, { recursive: true }); });
  const put = options.writeFile ?? ((file, text) => { writeFileSync(file, text, 'utf8'); });

  const counts = { written: 0, wouldWrite: 0, skipped: 0, refused: 0, failed: 0 };
  const files = [];
  let made = false;

  for (const entry of plan.files) {
    const blocked = entry.state === STATE.DIFFERS && !force ? 'it differs from what eject would write'
      : entry.state === STATE.UNREADABLE ? entry.reason
        : null;
    if (entry.state === STATE.SAME) {
      counts.skipped += 1;
      files.push({ ...entry, result: RESULT.SKIPPED, reason: 'already identical' });
      continue;
    }
    if (blocked !== null) {
      counts.refused += 1;
      files.push({ ...entry, result: RESULT.REFUSED, reason: blocked });
      continue;
    }
    if (!write) {
      counts.wouldWrite += 1;
      files.push({ ...entry, result: RESULT.WOULD_WRITE, reason: null });
      continue;
    }
    try {
      // Once, and only if there is something to put in it: a dry run that leaves an empty
      // directory behind has written to a tree it promised not to touch.
      if (!made) { mkdir(plan.dir); made = true; }
      put(entry.file, entry.text);
      counts.written += 1;
      files.push({ ...entry, result: RESULT.WRITTEN, reason: null });
    } catch (error) {
      counts.failed += 1;
      files.push({ ...entry, result: RESULT.FAILED, reason: error.message });
    }
  }

  return Object.freeze({
    into: plan.into,
    dir: plan.dir,
    wrote: write,
    forced: force,
    unknown: plan.unknown,
    available: plan.available,
    files: Object.freeze(files.map((entry) => Object.freeze(entry))),
    counts: Object.freeze(counts),
  });
}
