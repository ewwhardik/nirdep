// Reading what a package manager wrote down, without asking it anything.
//
// `scan` needs the transitive tree, and the only offline record of it is the
// lockfile. Reading one is explicitly allowed by the hackathon rules and is
// disclosed in STDLIB.md; running `npm ls` would not be, and would also need a
// network and a node_modules directory to be right.
//
// Three formats, three readers, one shape out. npm's is JSON and is read
// completely. yarn's and pnpm's are line-oriented and are read as far as this
// tool needs and no further: name, version, resolution, engines and edges. What
// each reader ignores is recorded in `note` and printed by `scan`, because a
// number derived from a file we only half understood should say so.
//
// Nothing here is a YAML parser. pnpm and yarn berry write a small, regular
// subset -- two-space indentation, one scalar or one inline map per line -- and
// that subset is what `readIndented` understands. Anything else makes the reader
// give up honestly rather than guess.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The lockfiles we look for, in the order a project with several should be believed. */
export const LOCKFILES = Object.freeze([
  { kind: 'npm', file: 'package-lock.json' },
  { kind: 'npm', file: 'npm-shrinkwrap.json' },
  { kind: 'pnpm', file: 'pnpm-lock.yaml' },
  { kind: 'yarn', file: 'yarn.lock' },
  { kind: 'bun', file: 'bun.lockb' },
]);

export const SOURCE = Object.freeze({
  REGISTRY: 'registry',
  GIT: 'git',
  HTTP: 'http',
  FILE: 'file',
  LINK: 'link',
  ROOT: 'root',
  UNKNOWN: 'unknown',
});

const EMPTY = Object.freeze([]);

/** A lockfile entry, frozen, with every field present whether or not it was recorded. */
function entry(fields) {
  return Object.freeze({
    name: fields.name,
    version: fields.version ?? null,
    place: fields.place ?? fields.name,
    depth: fields.depth ?? 0,
    dev: fields.dev === true,
    optional: fields.optional === true,
    peer: fields.peer === true,
    deprecated: fields.deprecated ?? null,
    installScript: fields.installScript === true,
    hasBin: fields.hasBin === true,
    resolved: fields.resolved ?? null,
    integrity: fields.integrity ?? null,
    source: fields.source ?? SOURCE.UNKNOWN,
    engines: fields.engines ?? null,
    requires: Object.freeze(fields.requires ?? EMPTY),
  });
}

/**
 * Where a package came from, read off its resolution rather than guessed from its
 * name. A tarball over plain http and a git URL are both installs that no registry
 * ever saw, which is a thing `scan` should be able to say out loud.
 *
 * @param {string|null} resolved
 * @returns {string}
 */
export function sourceOf(resolved) {
  if (resolved === null || resolved === undefined || resolved === '') return SOURCE.UNKNOWN;
  if (resolved.startsWith('file:')) return SOURCE.FILE;
  if (resolved.startsWith('link:')) return SOURCE.LINK;
  if (resolved.startsWith('git+') || resolved.startsWith('git:') || resolved.includes('#commit=')) return SOURCE.GIT;
  if (/^https?:\/\//.test(resolved) === false) return SOURCE.UNKNOWN;
  // A registry is a registry by shape, not by hostname: private mirrors are the
  // normal case in the kind of repository this tool is aimed at. The fragment goes
  // first, because yarn classic appends the tarball's sha1 to the URL.
  const url = resolved.split('#')[0];
  return /\/-\/[^/]+\.tgz$/.test(url) || /registry[./]/.test(url) ? SOURCE.REGISTRY : SOURCE.HTTP;
}

/**
 * A yarn berry resolution is a descriptor, not a URL: `chalk@npm:4.1.2` names the
 * registry, `pkg@workspace:.` this repository, `pkg@patch:...` a local patch
 * applied on top of whatever came before.
 *
 * @param {string} resolution
 * @returns {string}
 */
export function resolutionSource(resolution) {
  if (resolution.startsWith('http')) return sourceOf(resolution);
  if (resolution.includes('@npm:')) return SOURCE.REGISTRY;
  if (resolution.includes('@workspace:')) return SOURCE.LINK;
  if (resolution.includes('@file:') || resolution.includes('@portal:')) return SOURCE.FILE;
  if (resolution.includes('@git') || resolution.includes('@patch:')) return SOURCE.GIT;
  return SOURCE.UNKNOWN;
}

/**
 * The name in `node_modules/a/node_modules/b` is `b`, and the depth is 2. Scoped
 * names keep their scope. A path with no `node_modules` in it is a workspace, and
 * its key is its directory.
 *
 * @param {string} place
 * @returns {{ name: string, depth: number, workspace: boolean }}
 */
export function placeToName(place) {
  const parts = place.split('node_modules/');
  if (parts.length === 1) return { name: place, depth: 0, workspace: true };
  return { name: parts[parts.length - 1].replace(/\/$/, ''), depth: parts.length - 1, workspace: false };
}

const names = (object) => Object.keys(object ?? {});
const edges = (record) => [...names(record.dependencies), ...names(record.optionalDependencies)];

/**
 * npm, lockfileVersion 2 and 3: one flat `packages` map keyed by install path.
 * This is the format that records the two facts nothing else does --
 * `hasInstallScript` and `deprecated` -- which is most of why `scan` has anything
 * interesting to say.
 */
function readNpmPackages(raw) {
  const found = [];
  const roots = new Set();
  for (const [place, record] of Object.entries(raw.packages)) {
    if (place === '') {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const name of names(record[field])) roots.add(name);
      }
      continue;
    }
    const { name, depth, workspace } = placeToName(place);
    // A workspace entry is a directory in this repository, not an install. Its
    // dependencies are already in the tree under their own keys.
    if (workspace) continue;
    found.push(entry({
      name: record.name ?? name,
      version: record.version,
      place,
      depth,
      dev: record.dev,
      optional: record.optional,
      peer: record.peer,
      deprecated: typeof record.deprecated === 'string' ? record.deprecated : null,
      installScript: record.hasInstallScript,
      // Two spellings for one fact: npm 7 and 8 wrote `hasBin: true`, npm 9 and later
      // write the `bin` map itself. Accepting both is cheaper than deciding which npm
      // produced the file.
      hasBin: record.bin !== undefined || record.hasBin === true,
      resolved: record.resolved ?? null,
      integrity: record.integrity ?? null,
      source: record.link === true ? SOURCE.LINK : sourceOf(record.resolved ?? null),
      engines: record.engines?.node ?? null,
      requires: edges(record),
    }));
  }
  return { found, roots };
}

/**
 * npm, lockfileVersion 1: a nested tree, no install scripts recorded, no
 * deprecations. Old, still in the wild, and cheap enough to support that refusing
 * would be a worse answer than saying which two findings cannot apply.
 */
function readNpmTree(raw) {
  const found = [];
  const roots = new Set(names(raw.dependencies));
  const visit = (record, place, depth) => {
    for (const [name, one] of Object.entries(record ?? {})) {
      const here = `${place}node_modules/${name}`;
      found.push(entry({
        name,
        version: one.version,
        place: here,
        depth,
        dev: one.dev,
        optional: one.optional,
        resolved: one.resolved ?? null,
        integrity: one.integrity ?? null,
        source: sourceOf(one.resolved ?? null),
        requires: names(one.requires),
      }));
      visit(one.dependencies, `${here}/`, depth + 1);
    }
  };
  visit(raw.dependencies, '', 1);
  return { found, roots };
}

/** `"chalk@npm:^4.1.2"` and `chalk@^4.1.2` both name chalk. The `@` of a scope is not a separator. */
export function descriptorName(text) {
  const bare = text.trim().replace(/^["']|["']$/g, '');
  const at = bare.lastIndexOf('@');
  return at <= 0 ? bare : bare.slice(0, at);
}

const unquote = (text) => text.trim().replace(/^["']|["']$/g, '');
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * One line of the small subset both yarn berry and pnpm write: `key: value`,
 * `key value`, or `key:` opening a block. Returns null for a line this reader is
 * not willing to guess at, which is how `understood` ends up false.
 */
function readField(line) {
  const text = line.trim();
  const colon = text.indexOf(':');
  if (colon > 0 && (text[colon + 1] === ' ' || colon === text.length - 1)) {
    return { key: text.slice(0, colon), value: unquote(text.slice(colon + 1)) };
  }
  const space = text.indexOf(' ');
  if (space > 0) return { key: text.slice(0, space), value: unquote(text.slice(space + 1)) };
  return null;
}

/**
 * yarn, classic and berry. Blocks at indentation zero, fields at two, edges at
 * four. Neither format records which packages are direct dependencies, so `roots`
 * comes back empty and the caller falls back to the manifest -- said plainly here
 * because a blast radius attributed to the wrong root would be worse than none.
 */
function readYarn(text) {
  const found = [];
  let version = text.includes('__metadata') ? null : 1;
  let current = null;
  let inside = null;
  // A berry lockfile lists the repository itself as a workspace entry. npm's reader
  // skips those keys for the same reason: the project is not one of its own packages.
  const close = () => {
    if (current !== null && String(current.resolved ?? '').includes('@workspace:') === false) found.push(entry(current));
    current = null;
    inside = null;
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      close();
      const header = line.trim().replace(/:$/, '');
      if (header === '__metadata') { inside = '__metadata'; continue; }
      const name = descriptorName(header.split(',')[0]);
      current = { name, place: name, depth: 1, requires: [] };
      continue;
    }
    const field = readField(line);
    if (field === null) continue;
    if (current === null) {
      if (inside === '__metadata' && field.key === 'version') version = Number(field.value);
      continue;
    }
    if (indent >= 4) {
      if (inside === 'dependencies') current.requires.push(field.key.replace(/^["']|["']$/g, ''));
      continue;
    }
    inside = field.value === '' ? field.key : null;
    if (field.key === 'version') current.version = field.value;
    else if (field.key === 'resolved') {
      current.resolved = field.value;
      current.source = sourceOf(field.value);
    } else if (field.key === 'resolution') {
      current.resolved = field.value;
      current.source = resolutionSource(field.value);
    } else if (field.key === 'integrity' || field.key === 'checksum') current.integrity = field.value;
  }
  close();
  return { found, roots: new Set(), version };
}

/**
 * A pnpm entry key, across four lockfile generations: `/chalk/5.3.0`, `/chalk@5.3.0`,
 * `chalk@5.6.2`, and any of them with a peer suffix -- `react-dom@18.2.0(react@18.2.0)`
 * or the older `react-dom/18.2.0_react@18.2.0`. The peer suffix is dropped: two
 * entries that differ only by whose peer they were built against are the same
 * package at the same version, and counting them twice would inflate every number
 * this tool prints.
 *
 * @param {string} key
 * @returns {{ name: string, version: string|null }}
 */
export function pnpmKey(key) {
  let text = key.trim().replace(/:$/, '');
  if (text.startsWith('/')) text = text.slice(1);
  const paren = text.indexOf('(');
  if (paren !== -1) text = text.slice(0, paren);
  // The name ends at the first separator past any scope. A package name may contain dots
  // and underscores -- lodash._basecopy is a real package -- but never an `@` beyond its
  // scope, and never a slash beyond it either. Cutting at the last separator instead is
  // what turned `react-dom/18.2.0_react@18.2.0` into a package called
  // `react-dom/18.2.0_react`, and then into a second copy of react-dom.
  const afterScope = text.startsWith('@') ? text.indexOf('/') + 1 : 0;
  const cut = (index) => {
    if (index <= 0) return null;
    // A peer suffix rides on the version, either `_react@18.2.0` or a bare hash. No
    // version contains an underscore, so the first one ends the part worth keeping.
    const version = text.slice(index + 1).split('_')[0];
    return /^\d/.test(version) ? { name: text.slice(0, index), version } : null;
  };
  const marks = [text.indexOf('@', afterScope), text.indexOf('/', afterScope)]
    .filter((one) => one > 0)
    .sort((a, b) => a - b);
  for (const mark of marks) {
    const split = cut(mark);
    if (split !== null) return split;
  }
  // Nothing version-shaped anywhere: a `file:` or `github.com/...` key, which is a real
  // thing pnpm writes. Naming it in full is less wrong than inventing a version for it.
  return cut(text.lastIndexOf('/')) ?? { name: text, version: null };
}

/** `{integrity: sha512-x, tarball: y}` -- pnpm's one inline map, read without a YAML parser. */
function inlineMap(text) {
  const body = text.trim().replace(/^\{|\}$/g, '');
  const map = new Map();
  for (const pair of body.split(',')) {
    const colon = pair.indexOf(':');
    if (colon > 0) map.set(pair.slice(0, colon).trim(), unquote(pair.slice(colon + 1)));
  }
  return map;
}

/**
 * pnpm. Sections at indentation zero, entries at two, fields at four, edges at six.
 * `importers` gives the direct dependencies, which is one thing yarn's lockfile
 * cannot tell us. Install scripts are only recorded by pnpm 6 and 7, as
 * `requiresBuild`; on 9 that finding cannot be reported and `note` says so.
 */
function readPnpm(text) {
  const byKey = new Map();
  const roots = new Set();
  let version = null;
  let section = null;
  let block = null;
  let current = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    const field = readField(line);
    if (field === null) continue;
    if (indent === 0) {
      if (field.key === 'lockfileVersion') version = Number.parseFloat(field.value);
      section = field.key;
      block = null;
      current = null;
      continue;
    }
    if (section === 'importers' || section === 'dependencies' || section === 'devDependencies') {
      // Two shapes: a workspace lockfile nests importer directories, a single-package
      // one lists its dependencies straight under the section.
      if (section !== 'importers' && indent === 2) roots.add(field.key);
      if (section === 'importers' && indent === 4) block = field.key;
      if (section === 'importers' && indent === 6 && block !== null && block.endsWith('ependencies')) {
        roots.add(field.key);
      }
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') continue;
    if (indent === 2) {
      const { name, version } = pnpmKey(field.key);
      const id = `${name}@${version ?? '?'}`;
      current = byKey.get(id) ?? { name, version, place: name, depth: 1, requires: [] };
      byKey.set(id, current);
      block = null;
      continue;
    }
    if (current === null) continue;
    if (indent >= 6) {
      if (block === 'dependencies' || block === 'optionalDependencies') current.requires.push(field.key);
      continue;
    }
    if (field.value === '') { block = field.key; continue; }
    block = null;
    if (field.key === 'resolution') {
      const map = inlineMap(field.value);
      current.integrity = map.get('integrity') ?? null;
      current.resolved = map.get('tarball') ?? map.get('directory') ?? null;
      current.source = current.resolved === null ? SOURCE.REGISTRY : sourceOf(current.resolved);
      if (map.has('directory')) current.source = SOURCE.FILE;
      if (map.get('type') === 'git') current.source = SOURCE.GIT;
    } else if (field.key === 'engines') current.engines = inlineMap(field.value).get('node') ?? null;
    else if (field.key === 'deprecated') current.deprecated = field.value;
    else if (field.key === 'requiresBuild') current.installScript = field.value === 'true';
    else if (field.key === 'hasBin') current.hasBin = field.value === 'true';
    else if (field.key === 'dev') current.dev = field.value === 'true';
  }
  return { found: [...byKey.values()].map(entry), roots, version };
}

// What each reader knows it is not reading. `scan` prints the note for the lockfile
// it used, so every count it derives arrives with the limits of its source attached.
const NOTES = Object.freeze({
  'npm-3': 'read in full: install paths, install scripts, deprecations and dev, optional and peer flags',
  'npm-1': 'lockfileVersion 1 records neither install scripts nor deprecations, so those two findings cannot be reported',
  pnpm: 'read as an indented subset, not as YAML; install scripts are only recorded by pnpm 6 and 7 as requiresBuild',
  yarn: 'yarn records no dev flags, no install scripts, no deprecations and no list of direct dependencies, '
    + 'so those come from package.json instead',
  bun: 'bun.lockb is a binary format; reading it would need bun itself, which this tool will not run',
  none: 'no lockfile, so only what package.json declares is known -- the transitive tree is invisible',
});

/**
 * Which lockfile a project has, if any. First match wins, in the order of LOCKFILES:
 * a repository mid-migration between two package managers has two, and npm's is the
 * one that records the most.
 *
 * @param {string} root
 * @param {{ read?: (path: string) => string }} [options]
 * @returns {{ kind: string, file: string, text: string|null }}
 */
export function findLock(root, options = {}) {
  const read = options.read ?? ((path) => readFileSync(path, 'utf8'));
  for (const candidate of LOCKFILES) {
    try {
      // The read is what proves the file is there; bun's is binary, so its presence
      // is the whole finding and its contents are dropped on the floor.
      const text = read(join(root, candidate.file));
      return { kind: candidate.kind, file: candidate.file, text: candidate.kind === 'bun' ? '' : text };
    } catch {
      // Absent, or unreadable, which for this purpose is the same thing.
    }
  }
  return { kind: 'none', file: null, text: null };
}

/**
 * Read a project's lockfile into one shape, whatever wrote it.
 *
 * @param {string} root
 * @param {{ read?: (path: string) => string }} [options]
 * @returns {Readonly<object>}
 */
export function readLock(root, options = {}) {
  const found = findLock(root, options);
  const empty = { packages: EMPTY, byName: new Map(), roots: new Set(), version: null };
  if (found.kind === 'none' || found.kind === 'bun') {
    return freezeLock({ ...empty, kind: found.kind, file: found.file, understood: false, note: NOTES[found.kind] });
  }
  let read;
  let note;
  let version = null;
  try {
    if (found.kind === 'npm') {
      const raw = JSON.parse(found.text);
      version = raw.lockfileVersion ?? 1;
      read = raw.packages === undefined ? readNpmTree(raw) : readNpmPackages(raw);
      note = NOTES[raw.packages === undefined ? 'npm-1' : 'npm-3'];
    } else {
      read = found.kind === 'pnpm' ? readPnpm(found.text) : readYarn(found.text);
      note = NOTES[found.kind];
      version = read.version ?? null;
    }
  } catch (error) {
    return freezeLock({
      ...empty,
      kind: found.kind,
      file: found.file,
      understood: false,
      note: `${found.file} could not be read: ${error.message}`,
    });
  }
  const byName = new Map();
  for (const one of read.found) {
    const list = byName.get(one.name);
    if (list === undefined) byName.set(one.name, [one]);
    else list.push(one);
  }
  return freezeLock({
    kind: found.kind,
    file: found.file,
    version,
    understood: read.found.length > 0,
    note,
    packages: Object.freeze(read.found),
    byName,
    roots: read.roots,
  });
}

function freezeLock(fields) {
  return Object.freeze({
    ...fields,
    packages: Object.isFrozen(fields.packages) ? fields.packages : Object.freeze(fields.packages),
    count: fields.packages.length,
    names: fields.byName.size,
  });
}
