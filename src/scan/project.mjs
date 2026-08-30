// Putting the three readers in the same room and seeing whether they agree.
//
// `scan` answers one question -- what would it cost to stop depending on this? -- from
// three sources that each know a different part of it. package.json says what was
// promised. The lockfile says what actually arrives. The source says what is really
// used. Most of the interesting findings are disagreements between them: a package
// imported but never declared, a package declared but never imported, a range that
// promises less than the lock delivers.
//
// The number this module exists to produce is the blast radius: for one direct
// dependency, how much of the tree is reachable only through it. That is the honest
// version of "removing chalk saves you 4 packages", and it is honest because it is
// computed from the lockfile's own edges rather than from a table somebody typed. It is
// also approximate in a way this module says out loud -- the edges are followed by
// package name, not by name and version -- and every record carries that admission.
//
// Nothing here formats anything. src/scan/report.mjs does that.

import { readFileSync } from 'node:fs';
import { walk, displayPath } from '../fs/walk.mjs';
import { analyse } from '../lex/bindings.mjs';
import { auditSource, classify, packageOf } from '../audit/imports.mjs';
import { SOURCE_EXTENSIONS, readManifest } from '../apply/project.mjs';
import { ACTION, ruleFor } from '../rules/registry.mjs';
import { readLock } from './lockfile.mjs';
import { assess, summarise } from './risk.mjs';

/**
 * The package a specifier belongs to. Re-exported rather than reimplemented: the same
 * rule decides whether `demo/helper` is this project importing itself, and two copies of
 * it would eventually disagree about a scoped name.
 *
 * @param {string} specifier
 * @returns {string}
 */
export const packageName = packageOf;

/** How a package's imports were read: by the lexer, or by the blunt scanner it fell back to. */
export const READ = Object.freeze({ LEXED: 'lexed', SCANNED: 'scanned' });

const EMPTY = Object.freeze([]);

/**
 * Every third-party import in the tree, by package.
 *
 * Two readers, in order of trust. `auditSource` is a regex scanner that over-accepts:
 * it finds a specifier mentioned in a comment as readily as one that is imported. It
 * runs first because it is cheap, and a file it finds nothing in cannot contain an
 * import the lexer would find either. When it does find something, the lexer runs and
 * its answer replaces the guess. A file the lexer refuses is reported, and the blunt
 * answer is kept for it rather than dropped -- with `read: 'scanned'` recorded against
 * every package it contributed, so nothing downstream can pretend otherwise.
 */
function readSource(root, options) {
  const read = options.read ?? ((file) => readFileSync(file, 'utf8'));
  const selfNames = new Set(options.selfNames ?? EMPTY);
  const found = options.files ?? [...walk(root, { ignore: options.ignore, extensions: SOURCE_EXTENSIONS })];
  const byPackage = new Map();
  const unparsed = [];
  const unanalysable = [];
  let scanned = 0;
  let opened = 0;
  let lexed = 0;
  const unreadable = [];

  const record = (specifier, path, line, form, how) => {
    const name = packageName(specifier);
    let one = byPackage.get(name);
    if (one === undefined) {
      one = { name, specifiers: new Set(), files: new Set(), forms: new Set(), sites: [], read: READ.LEXED };
      byPackage.set(name, one);
    }
    one.specifiers.add(specifier);
    one.files.add(path);
    one.forms.add(form);
    one.sites.push({ path, line, specifier, form });
    if (how === READ.SCANNED) one.read = READ.SCANNED;
  };

  for (const file of found) {
    scanned += 1;
    const path = displayPath(root, file);
    let source;
    try {
      source = read(file);
    } catch (error) {
      unreadable.push({ path, detail: error.message });
      continue;
    }
    const guessed = auditSource(source, { selfNames }).thirdParty;
    if (guessed.length === 0) continue;
    opened += 1;
    let analysis;
    try {
      analysis = analyse(source, { file: path });
      lexed += 1;
    } catch (error) {
      // The blunt answer is worse but it is not nothing, and a file that will not lex is
      // exactly the file whose imports somebody should look at by hand.
      unparsed.push({ path, detail: error.message });
      for (const one of guessed) record(one.specifier, path, one.line, one.kind, READ.SCANNED);
      continue;
    }
    for (const dependency of analysis.dependencies) {
      if (classify(dependency.specifier, { selfNames }) !== 'third-party') continue;
      record(dependency.specifier, path, dependency.line, dependency.form, READ.LEXED);
    }
    for (const one of analysis.unanalysable) unanalysable.push({ path, line: one.line, reason: one.reason });
  }

  return { byPackage, counts: { scanned, opened, lexed }, unparsed, unanalysable, unreadable };
}

/**
 * The lockfile's edges, collapsed to one node per package name.
 *
 * A lockfile is a graph over name-and-version pairs, and this is a graph over names:
 * four copies of semver become one node whose edges are the union of all four. That
 * loses precision in one direction only -- a name-level graph can say a package is
 * reachable when the specific installed copy is not -- so every number derived from it
 * is an upper bound, and `approximate` on each record says so. The alternative, keeping
 * versions apart, needs each edge's resolved range, which two of the three lockfile
 * formats do not write down.
 *
 * @param {Readonly<object>} lock
 * @returns {Map<string, Set<string>>}
 */
export function buildGraph(lock) {
  const graph = new Map();
  for (const one of lock.packages) {
    let edges = graph.get(one.name);
    if (edges === undefined) {
      edges = new Set();
      graph.set(one.name, edges);
    }
    for (const name of one.requires) edges.add(name);
  }
  return graph;
}

/**
 * Every name reachable from any of `seeds`, the seeds included. Iterative rather than
 * recursive: dependency graphs have cycles, and a peer-dependency cycle in a real
 * lockfile is common enough that a recursive walk would be a crash waiting for a user.
 *
 * @param {Map<string, Set<string>>} graph
 * @param {Iterable<string>} seeds
 * @returns {Set<string>}
 */
export function reachable(graph, seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of graph.get(name) ?? EMPTY) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

/**
 * What would leave the tree if `going` were removed from `roots`.
 *
 * Not the union of what each one owns: two packages being removed together can strand a
 * third that neither of them owned alone. The subtraction is done once, over the whole
 * set, which is the only way to get that case right.
 *
 * @returns {Array<string>}
 */
export function strandedBy(graph, roots, going) {
  const staying = [...roots].filter((name) => !going.has(name));
  const before = reachable(graph, roots);
  const after = reachable(graph, staying);
  return [...before].filter((name) => !after.has(name)).sort();
}

/** One row of the blast radius table: a direct dependency and what hangs off it alone. */
function radiusFor(name, world) {
  const { graph, roots, manifest, lock, byPackage } = world;
  const rule = ruleFor(name);
  const mine = reachable(graph, [name]);
  const others = reachable(graph, [...roots].filter((one) => one !== name));
  const own = [...mine].filter((one) => !others.has(one)).sort();
  const usage = byPackage.get(name);
  return Object.freeze({
    name,
    range: manifest.ranges.get(name) ?? null,
    declared: manifest.dependencies.has(name),
    dev: manifest.development.has(name),
    versions: Object.freeze([...new Set((lock.byName.get(name) ?? EMPTY).map((one) => one.version))].sort()),
    installed: lock.byName.has(name),
    tree: mine.size,
    own: Object.freeze(own),
    shared: mine.size - own.length,
    replaceable: rule !== null,
    action: rule?.action ?? null,
    target: rule?.target ?? null,
    files: usage === undefined ? 0 : usage.files.size,
    sites: usage === undefined ? 0 : usage.sites.length,
    // The one caveat that has to travel with the number rather than sit in a footnote.
    approximate: lock.understood,
  });
}

/**
 * Read a project three ways and report where the three disagree.
 *
 * @param {string} root
 * @param {{ files?: string[], ignore?: Set<string>, read?: (file: string) => string }} [options]
 */
export function scanProject(root, options = {}) {
  const manifest = readManifest(root);
  const lock = readLock(root, options);
  const selfNames = manifest.name === null ? [] : [manifest.name];
  const source = readSource(root, { ...options, selfNames });
  const graph = buildGraph(lock);

  // yarn's lockfile records no list of direct dependencies, so the manifest is the only
  // answer there; npm's and pnpm's do, and theirs includes what a workspace declared.
  const roots = new Set([...lock.roots, ...manifest.dependencies]);
  const used = new Set(source.byPackage.keys());
  const findings = assess({ manifest, lock, used, direct: roots.size });

  const radius = [...roots].map((name) => radiusFor(name, { graph, roots, manifest, lock, byPackage: source.byPackage }))
    .sort((a, b) => Number(b.replaceable) - Number(a.replaceable)
      || b.own.length - a.own.length
      || a.name.localeCompare(b.name));

  const replaceable = radius.filter((one) => one.replaceable);
  const going = new Set(replaceable.map((one) => one.name));
  // With no lockfile there is no tree, so nothing can be stranded in it. Running the
  // subtraction over an empty graph would return the seeds themselves and report "1 of 0
  // installed names", which is a sentence that should never have to be read twice.
  const stranded = lock.understood ? strandedBy(graph, roots, going) : [];

  return Object.freeze({
    root,
    manifest,
    lock,
    graph: Object.freeze({ names: graph.size, understood: lock.understood }),
    source: Object.freeze({
      counts: Object.freeze(source.counts),
      unparsed: Object.freeze(source.unparsed),
      unanalysable: Object.freeze(source.unanalysable),
      unreadable: Object.freeze(source.unreadable),
      packages: Object.freeze([...source.byPackage.values()]
        .map((one) => Object.freeze({
          name: one.name,
          read: one.read,
          declared: manifest.dependencies.has(one.name),
          dev: manifest.development.has(one.name),
          range: manifest.ranges.get(one.name) ?? null,
          rule: ruleFor(one.name) ?? null,
          specifiers: Object.freeze([...one.specifiers].sort()),
          files: Object.freeze([...one.files].sort()),
          sites: Object.freeze(one.sites),
        }))
        .sort((a, b) => b.sites.length - a.sites.length || a.name.localeCompare(b.name))),
    }),
    findings,
    summary: summarise(findings),
    radius: Object.freeze(radius),
    // What a whole migration is worth, as one subtraction rather than a sum of rows.
    removable: Object.freeze({
      direct: Object.freeze(replaceable.map((one) => one.name)),
      rewritable: Object.freeze(replaceable.filter((one) => one.action === ACTION.REWRITE).map((one) => one.name)),
      stranded: Object.freeze(stranded),
      count: stranded.length,
      of: lock.names,
    }),
    counts: Object.freeze({
      direct: roots.size,
      declared: manifest.dependencies.size,
      dev: manifest.development.size,
      installed: lock.count,
      names: lock.names,
      imported: source.byPackage.size,
      replaceable: replaceable.length,
    }),
  });
}
