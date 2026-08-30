// One file at a time is a demo. This is the part that has to hold across a repository.
//
// Three things change once the codemod meets a real tree, and all three are about
// refusing to be clever. It has to decide where the replacement actually lives on disk,
// because `nirdep/runtime/colour` only resolves if nirdep is installed, and installing a
// package to remove packages is a joke told at the user's expense. It has to read a file
// once and keep the bytes it read, because a rewrite planned against one version of a
// file and written against another is a corruption. And it has to hand every rewrite to
// Node's own parser before the write, then write nothing at all if any single file comes
// back unparseable -- a half-migrated tree is worse than an untouched one.
//
// Nothing here formats output. The CLI decides what a person reads; this decides what
// is true.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { selectFiles, displayPath } from '../fs/walk.mjs';
import { gate, kindFor } from '../patch/gate.mjs';
import { REPLACEABLE } from '../rules/registry.mjs';
import { planFile } from '../rules/rewrite.mjs';

/** What happened to one file. */
export const OUTCOME = Object.freeze({
  WRITTEN: 'written',
  WOULD_WRITE: 'would-write',
  UNCHANGED: 'unchanged',
  REJECTED: 'rejected',
  WAS_BROKEN: 'was-broken',
  UNREADABLE: 'unreadable',
});

/** The extensions worth opening. JSON has no imports; TypeScript is not this lexer's job. */
export const SOURCE_EXTENSIONS = Object.freeze(new Set(['.mjs', '.cjs', '.js', '.jsx']));

/** Where the ejected runtime goes when nobody says otherwise. */
export const DEFAULT_RUNTIME_DIR = 'nirdep/runtime';

/**
 * A cheap gate before the expensive one. Lexing every file in a repository to discover
 * that most of them never mention chalk is a waste of the user's afternoon, so a plain
 * substring test runs first. It over-accepts on purpose -- the word in a comment gets a
 * file lexed and then correctly left alone -- and it never under-accepts, because a
 * specifier that is not in the bytes cannot be in the tokens.
 */
export function mayMention(source) {
  for (const name of REPLACEABLE) if (source.includes(name)) return true;
  return false;
}

/**
 * `type` and the declared dependencies, or sane answers when there is no manifest.
 *
 * `scan` needs more of this file than `apply` does -- the ranges, which field each
 * dependency was declared in, and the scripts, because a package named in a script is
 * being used whether or not any source file imports it. It is still one reader: two
 * modules reading package.json differently is how they end up disagreeing about what
 * a project depends on.
 */
export function readManifest(root) {
  const empty = () => Object.freeze({
    found: false,
    type: 'commonjs',
    name: null,
    dependencies: Object.freeze(new Set()),
    development: Object.freeze(new Set()),
    ranges: Object.freeze(new Map()),
    scripts: Object.freeze(new Map()),
  });
  try {
    const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const named = (field) => Object.keys(raw[field] ?? {});
    const ranges = new Map();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(raw[field] ?? {})) if (!ranges.has(name)) ranges.set(name, range);
    }
    return Object.freeze({
      found: true,
      type: raw.type === 'module' ? 'module' : 'commonjs',
      name: typeof raw.name === 'string' ? raw.name : null,
      dependencies: Object.freeze(new Set([...named('dependencies'), ...named('devDependencies')])),
      development: Object.freeze(new Set(named('devDependencies'))),
      ranges: Object.freeze(ranges),
      scripts: Object.freeze(new Map(Object.entries(raw.scripts ?? {}).filter(([, one]) => typeof one === 'string'))),
    });
  } catch {
    // No manifest, or one that is not JSON. Node's own default is commonjs, so ours is too.
    return empty();
  }
}

/**
 * The specifier a rewritten import should point at.
 *
 * With a runtime directory, it is a relative path to a file that will exist after
 * `eject`, computed per importing file so a deep source file gets its `../../` right.
 * Without one, it is the package subpath, which is honest for a project that really does
 * depend on nirdep and is the reason `eject` exists for every project that does not.
 */
export function targetResolver(options = {}) {
  const root = options.root ?? '.';
  const into = options.runtimeDir ?? null;
  if (into === null) return (rule) => rule.target;
  const base = isAbsolute(into) ? into : resolvePath(root, into);
  return (rule, file) => {
    const leaf = `${rule.subpath.slice(rule.subpath.lastIndexOf('/') + 1)}.mjs`;
    const from = dirname(isAbsolute(file) ? file : resolvePath(root, file));
    const path = relative(from, join(base, leaf)).split(sep).join('/');
    return path.startsWith('.') ? path : `./${path}`;
  };
}

/**
 * Plan a whole tree. Reads, never writes.
 *
 * The bytes each plan was made against are kept on the entry. `applyProject` writes those
 * same bytes back with the edits spliced in, rather than re-reading a file that may have
 * moved under us between the two commands.
 *
 * @param {string} root
 * @param {{
 *   files?: string[], ignore?: Set<string>, exclude?: string|string[], include?: string|string[],
 *   runtimeDir?: string|null, read?: (file: string) => string,
 * }} [options]
 */
export function planProject(root, options = {}) {
  const manifest = readManifest(root);
  const read = options.read ?? ((file) => readFileSync(file, 'utf8'));
  const resolve = targetResolver({ root, runtimeDir: options.runtimeDir ?? null });
  const found = selectFiles(root, { ...options, extensions: SOURCE_EXTENSIONS });
  const entries = [];
  let scanned = 0;
  let opened = 0;

  for (const file of found) {
    scanned += 1;
    const shown = displayPath(root, file);
    let source;
    try {
      source = read(file);
    } catch (error) {
      entries.push(Object.freeze({
        file, path: shown, source: null, plan: null, edits: 0,
        outcome: OUTCOME.UNREADABLE, detail: error.message,
      }));
      continue;
    }
    if (!mayMention(source)) continue;
    opened += 1;
    const plan = planFile(source, { file: shown, resolve });
    const edits = plan.patch === null ? 0 : plan.patch.size;
    entries.push(Object.freeze({
      file,
      path: shown,
      source,
      plan,
      edits,
      kind: kindFor(shown, manifest.type),
      outcome: edits > 0 ? OUTCOME.WOULD_WRITE : OUTCOME.UNCHANGED,
      detail: null,
    }));
  }

  // Sorted by path rather than by walk order: a report a person reads and a report a CI
  // job diffs against yesterday's both want the same sequence every time.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const changes = entries.flatMap((entry) => (entry.plan?.changes ?? []).map((one) => ({ ...one, path: entry.path })));
  const declined = entries.flatMap((entry) => (entry.plan?.declined ?? []).map((one) => ({ ...one, path: entry.path })));
  return Object.freeze({
    root,
    manifest,
    runtimeDir: options.runtimeDir ?? null,
    files: Object.freeze(entries),
    changes: Object.freeze(changes),
    declined: Object.freeze(declined),
    counts: Object.freeze({
      scanned,
      opened,
      touched: entries.filter((one) => one.edits > 0).length,
      changes: changes.length,
      declined: declined.length,
    }),
  });
}

/**
 * Turn a plan into text, and optionally into writes.
 *
 * Every rewritten file goes through Node's parser first, and one that comes back broken
 * because of us stops the whole run: with `write` set, files are only opened after every
 * gate has passed. A file that did not parse before we touched it is a different animal
 * and `blame` is what tells them apart. That one is reported and skipped, because our
 * reading of its bindings was guesswork, but it does not hold back the rest of the tree --
 * somebody else's broken file is not a reason to refuse to migrate a repository.
 *
 * @param {ReturnType<typeof planProject>} plan
 * @param {{ write?: boolean, save?: (file: string, text: string) => void }} [options]
 */
export function applyProject(plan, options = {}) {
  const save = options.save ?? ((file, text) => writeFileSync(file, text, 'utf8'));
  const results = [];
  const pending = [];

  for (const entry of plan.files) {
    if (entry.edits === 0 || entry.plan?.patch === null) {
      results.push(Object.freeze({ ...withoutSource(entry), after: null, gate: null }));
      continue;
    }
    const after = entry.plan.patch.apply().after;
    const verdict = gate(entry.source, after, { kind: entry.kind, filename: entry.path });
    if (!verdict.ok) {
      const ours = verdict.blame === 'patch';
      results.push(Object.freeze({
        ...withoutSource(entry),
        after: null,
        gate: verdict,
        outcome: ours ? OUTCOME.REJECTED : OUTCOME.WAS_BROKEN,
        detail: ours
          ? `the rewrite would not parse: ${verdict.after.error?.message ?? 'no message'}`
          : `this file did not parse before the rewrite either, so its bindings were read from a guess: ${verdict.before.error?.message ?? 'no message'}`,
      }));
      continue;
    }
    pending.push({ entry, after, verdict });
  }

  const rejected = results.some((one) => one.outcome === OUTCOME.REJECTED);
  const writing = options.write === true && !rejected;
  for (const { entry, after, verdict } of pending) {
    let outcome = writing ? OUTCOME.WRITTEN : OUTCOME.WOULD_WRITE;
    let detail = rejected ? 'held back: another file in this run failed its syntax check' : null;
    if (writing) {
      try {
        save(entry.file, after);
      } catch (error) {
        outcome = OUTCOME.REJECTED;
        detail = `the file would not save: ${error.message}`;
      }
    }
    results.push(Object.freeze({ ...withoutSource(entry), after, gate: verdict, outcome, detail }));
  }

  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const count = (name) => results.filter((one) => one.outcome === name).length;
  return Object.freeze({
    root: plan.root,
    wrote: writing,
    halted: rejected,
    files: Object.freeze(results),
    counts: Object.freeze({
      written: count(OUTCOME.WRITTEN),
      wouldWrite: count(OUTCOME.WOULD_WRITE),
      unchanged: count(OUTCOME.UNCHANGED),
      rejected: count(OUTCOME.REJECTED),
      wasBroken: count(OUTCOME.WAS_BROKEN),
      unreadable: count(OUTCOME.UNREADABLE),
    }),
  });
}

/** The plan keeps the file's bytes; a result does not need to carry them around. */
function withoutSource(entry) {
  const { source, ...rest } = entry;
  return rest;
}
