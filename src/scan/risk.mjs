// What a lockfile says about a project that nobody asked it.
//
// Every finding here is derived from files already on disk: no network, no
// registry lookup, no live database. Two of them cross the tree against
// src/scan/advisories.mjs, which is a dated table in a source file covering the
// packages this project offers to replace and the incidents that happened beside
// them -- a neighbourhood, not the ecosystem, and the report says which. The rest
// is the part `npm audit` does not tell you at all: which packages run code when
// you install them, which ones their own authors have abandoned, which ones
// arrive without a hash to check, and which ones your source imports without ever
// declaring.
//
// A finding is a sentence with a number in it. A severity with no sentence is a
// colour, and a colour is not an argument.

import { auditTree, HAND, highestFixed, KIND, SOURCE } from './advisories.mjs';

const EMPTY = Object.freeze([]);

export const SEVERITY = Object.freeze({
  CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NOTE: 'note',
});

const ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, note: 4 });

export const FINDING = Object.freeze({
  COMPROMISED: 'compromised',
  VULNERABLE: 'vulnerable',
  IN_INCIDENT: 'in-incident',
  UNCHECKED: 'unchecked',
  INSTALL_SCRIPT: 'install-script',
  DEPRECATED: 'deprecated',
  NO_INTEGRITY: 'no-integrity',
  OFF_REGISTRY: 'off-registry',
  UNDECLARED: 'undeclared',
  UNUSED: 'unused',
  FLOATING: 'floating',
  NO_LOCKFILE: 'no-lockfile',
  DUPLICATE: 'duplicate',
  DEPTH: 'depth',
});

const finding = (code, severity, detail, subjects = EMPTY, id = null) => Object.freeze({
  code,
  severity,
  detail,
  // The advisory identifier where one exists, so a reader can go and check the
  // claim somewhere that is not this repository. Null everywhere else, because a
  // finding derived from arithmetic has nothing to cite.
  id,
  subjects: Object.freeze([...subjects]),
});

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Findings are sentences, and a sentence that does not agree with its own subject
// reads like a template with the numbers punched in, which is exactly the
// impression a report about somebody else's sloppiness should not give.
const is = (n) => (n === 1 ? 'is' : 'are');
const them = (n) => (n === 1 ? 'it' : 'them');
const list = (items, limit = 4) => {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
};

/** A range that resolves to whatever exists on install day rather than to a version. */
export function floats(range) {
  const text = String(range).trim();
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return true;
  if (text.startsWith('npm:') || text.startsWith('workspace:')) return false;
  // A tag is a moving target by design; a git branch is worse, because it moves and
  // nobody publishes a changelog for it.
  if (/^[a-z][a-z-]*$/i.test(text)) return true;
  return /#(?!semver:)/.test(text) && text.includes('git');
}

/**
 * Everything the lockfile can be asked directly, one pass over its entries.
 *
 * @param {Readonly<object>} lock
 * @returns {ReadonlyArray<object>}
 */
function fromLock(lock, direct) {
  const found = [];
  const scripts = [];
  const deprecated = [];
  const unhashed = [];
  const offRegistry = [];
  let deepest = 0;
  for (const one of lock.packages) {
    if (one.installScript) scripts.push(`${one.name}@${one.version}`);
    if (one.deprecated !== null) deprecated.push(one);
    if (one.integrity === null && one.source === 'registry') unhashed.push(`${one.name}@${one.version}`);
    if (one.source === 'git' || one.source === 'http') offRegistry.push(`${one.name} (${one.source})`);
    if (one.depth > deepest) deepest = one.depth;
  }
  if (scripts.length > 0) {
    const n = scripts.length;
    found.push(finding(FINDING.INSTALL_SCRIPT, SEVERITY.HIGH,
      `${count(n, 'package')} ${n === 1 ? 'runs its' : 'run their'} own code during install, before anything of `
      + `yours does: ${list(scripts)}. That is the part of a dependency no code review covers.`, scripts));
  }
  if (deprecated.length > 0) {
    const sample = deprecated[0];
    found.push(finding(FINDING.DEPRECATED, SEVERITY.MEDIUM,
      `${count(deprecated.length, 'package')} in this tree ${is(deprecated.length)} deprecated by `
      + `${deprecated.length === 1 ? 'its own author' : 'their own authors'}, and the message is sitting in your `
      + `lockfile. ${sample.name}@${sample.version}: "${sample.deprecated.replace(/\s+/g, ' ').trim()}"`,
      deprecated.map((one) => `${one.name}@${one.version}`)));
  }
  if (unhashed.length > 0) {
    found.push(finding(FINDING.NO_INTEGRITY, SEVERITY.HIGH,
      `${count(unhashed.length, 'registry package')} ${is(unhashed.length)} recorded without an integrity hash, `
      + `so a reinstall cannot tell whether it got the same bytes as last time: ${list(unhashed)}.`, unhashed));
  }
  if (offRegistry.length > 0) {
    const n = offRegistry.length;
    found.push(finding(FINDING.OFF_REGISTRY, SEVERITY.MEDIUM,
      `${count(n, 'package')} ${n === 1 ? 'comes' : 'come'} from somewhere other than a registry, so nothing `
      + `published is being pinned: ${list(offRegistry)}.`, offRegistry));
  }
  const duplicated = [...lock.byName.entries()]
    .map(([name, entries]) => [name, new Set(entries.map((one) => one.version)).size])
    .filter(([, versions]) => versions > 1)
    .sort((a, b) => b[1] - a[1]);
  if (duplicated.length > 0) {
    const n = duplicated.length;
    found.push(finding(FINDING.DUPLICATE, SEVERITY.LOW,
      `${count(n, 'package')} ${is(n)} installed at more than one version `
      + `(${list(duplicated.map(([name, versions]) => `${name} ×${versions}`))}), which is install weight `
      + `twice over and a patch applied to one copy that does not reach the other.`,
      duplicated.map(([name]) => name)));
  }
  if (deepest > 0) {
    found.push(finding(FINDING.DEPTH, SEVERITY.NOTE,
      `${count(lock.count, 'installed package')} under `
      + `${count(direct, 'direct dependency', 'direct dependencies')}, `
      + `nested ${deepest} deep. ${lock.note}.`));
  }
  return found;
}

/** A package named in a script is in use, whether or not any source file imports it. */
function inScripts(name, manifest) {
  for (const command of manifest.scripts.values()) {
    if (command.includes(name)) return true;
  }
  return false;
}

/**
 * The three findings that need the source as well as the lockfile, and the one that
 * needs neither.
 *
 * @param {{ manifest: object, lock: object, used: Set<string> }} world
 * @returns {Array<object>}
 */
function fromProject(world) {
  const { manifest, lock, used } = world;
  const found = [];
  const undeclared = [...used].filter((name) => !manifest.dependencies.has(name)).sort();
  if (undeclared.length > 0) {
    const n = undeclared.length;
    const installed = undeclared.filter((name) => lock.byName.has(name));
    // A phantom dependency that is nevertheless installed is the more alarming case, so
    // the sentence names how many of them the lockfile is quietly covering for.
    let hoisted = `${installed.length} of them are`;
    if (n === 1) hoisted = 'It is';
    else if (installed.length === 1) hoisted = 'One of them is';
    found.push(finding(FINDING.UNDECLARED, SEVERITY.HIGH,
      `${count(n, 'package')} ${is(n)} imported by this project's source and declared in no `
      + `dependency field: ${list(undeclared)}. `
      + (installed.length > 0
        ? `${hoisted} in the lockfile anyway, hoisted there by something else, which is why this works on `
          + 'your machine and fails on a clean install.'
        : `Nothing installs ${them(n)}, so this only runs where `
          + `${n === 1 ? 'it already happens' : 'they already happen'} to be.`),
      undeclared));
  }
  // Only reported when the package brought no executable and is named in no script:
  // a linter used through its bin, or a tool invoked by `npm run`, is in use even
  // though nothing imports it, and calling that dead weight would just be wrong.
  const unused = [...manifest.dependencies]
    .filter((name) => !used.has(name) && !inScripts(name, manifest))
    .filter((name) => (lock.byName.get(name) ?? []).every((one) => one.hasBin !== true))
    .sort();
  if (unused.length > 0 && used.size > 0) {
    const n = unused.length;
    found.push(finding(FINDING.UNUSED, SEVERITY.LOW,
      `${count(n, 'declared dependency', 'declared dependencies')} ${is(n)} imported by no file here and `
      + `named in no script: ${list(unused)}. Either something else needs ${them(n)} at run time or `
      + `${n === 1 ? 'it is' : 'they are'} install weight nobody is carrying on purpose.`, unused));
  }
  const floating = [...manifest.ranges.entries()].filter(([, range]) => floats(range)).map(([name]) => name).sort();
  if (floating.length > 0) {
    const n = floating.length;
    found.push(finding(FINDING.FLOATING, lock.understood ? SEVERITY.LOW : SEVERITY.MEDIUM,
      `${count(n, 'dependency', 'dependencies')} ${is(n)} declared with a range that resolves to `
      + `whatever exists on install day: ${list(floating)}.`
      + (lock.understood
        ? ` The lockfile is holding ${them(n)} still for now.`
        : ` Nothing is holding ${them(n)} still.`),
      floating));
  }
  if (lock.kind === 'none' && manifest.dependencies.size > 0) {
    const n = manifest.dependencies.size;
    found.push(finding(FINDING.NO_LOCKFILE, SEVERITY.MEDIUM,
      `${count(n, 'dependency', 'dependencies')} ${is(n)} declared and no lockfile is `
      + 'committed, so two installs a week apart are two different programs. Everything below this line is '
      + 'read from package.json alone; the transitive tree is invisible from here.'));
  }
  return found;
}

/** `name@version`, which is how a hit should be quoted back to whoever installed it. */
const at = (one) => `${one.package}@${one.version}`;

/**
 * The two findings that come from the advisory table, and the two that come from
 * the gaps in it.
 *
 * An incident hit is reported one row at a time, because each is a separate story
 * and there are never many. A flaw hit is grouped by package, because one stale
 * lodash answers five advisories and printing it five times would bury the rest
 * of the report under a single dependency. Everything the table clears is silent.
 *
 * @param {Readonly<object>} audit the result of auditTree
 * @returns {Array<object>}
 */
function fromAdvisories(audit) {
  const found = [];
  for (const hit of audit.hits) {
    if (hit.advisory.kind !== KIND.INCIDENT) continue;
    const { advisory } = hit;
    found.push(finding(FINDING.COMPROMISED, SEVERITY.CRITICAL,
      `${at(hit)} is a release that was published to do harm, on ${advisory.when}: ${advisory.what}`
      + (advisory.hand === HAND.AUTHOR
        ? " The hand was the maintainer's own, so no review of the version you approved would have found "
          + 'what was in the one you got.'
        : '')
      + (advisory.also === null ? '' : ` It arrived alongside ${advisory.also}, which is worth checking too.`)
      + (hit.places.length === 0 ? '' : ` Installed at ${list(hit.places)}.`),
      [at(hit)], advisory.id));
  }
  const grouped = new Map();
  for (const hit of audit.hits) {
    if (hit.advisory.kind !== KIND.FLAW) continue;
    const key = at(hit);
    const rows = grouped.get(key);
    if (rows === undefined) grouped.set(key, [hit]);
    else rows.push(hit);
  }
  for (const [subject, rows] of grouped) {
    // Worst severity, and the most recent of those, which is the one a reader is
    // most likely to recognise and the one a fix has to clear anyway.
    const ranked = [...rows].sort((a, b) => (ORDER[a.advisory.severity] - ORDER[b.advisory.severity])
      || (a.advisory.when < b.advisory.when ? 1 : -1));
    const worst = ranked[0].advisory;
    const ids = ranked.map((one) => one.advisory.id).filter((one) => one !== null);
    const fixed = highestFixed(rows);
    const n = rows.length;
    found.push(finding(FINDING.VULNERABLE, worst.severity,
      `${subject} is inside ${count(n, 'published advisory', 'published advisories')}`
      // The list is dropped when there is one of them, because the next sentence quotes
      // that identifier anyway and printing it twice in two lines reads like a mail merge.
      + `${ids.length === 0 || n === 1 ? '' : ` (${list(ids, 6)})`}. `
      + `${n === 1 ? '' : 'The worst of them, '}${worst.id ?? worst.when}: ${worst.what}`
      + (fixed === null ? '' : ` Fixed in ${fixed}.`)
      + (rows[0].replaceable ? ' This is a package nirdep replaces outright.' : ''),
      [subject], worst.id));
  }
  // A name match is not a verdict, and this is the finding that has to say so in
  // its own sentence rather than in a footnote somebody scrolls past.
  if (audit.unversioned.length > 0) {
    const names = [...new Set(audit.unversioned.map((one) => one.package))].sort();
    const n = names.length;
    const dated = [...new Set(audit.unversioned.map((one) => one.advisory.when))].sort();
    found.push(finding(FINDING.IN_INCIDENT, SEVERITY.LOW,
      `${count(n, 'package')} in this tree ${is(n)} named in a supply-chain incident whose affected releases `
      + `this table does not record: ${list(names, 8)}. `
      // A colon, not a full stop: every story in the table is written to follow one, so
      // joining with a stop would start a sentence in lower case.
      + `${dated.length === 1 ? dated[0] : dated.join(', ')}: `
      + `${audit.unversioned[0].advisory.what} This is a match on ${n === 1 ? 'a name' : 'names'} and not a `
      + `verdict on your versions; go and look ${them(n)} up.`,
      names));
  }
  if (audit.unknown.length > 0) {
    const names = [...new Set(audit.unknown.map((one) => one.package))].sort();
    const n = names.length;
    found.push(finding(FINDING.UNCHECKED, SEVERITY.NOTE,
      `${count(n, 'package')} in the advisory table could not be checked against a version here: `
      + `${list(names, 8)}. `
      + (audit.source === SOURCE.MANIFEST
        ? 'No lockfile was read, so what is declared is a range and not the thing that gets installed.'
        : 'The lockfile records something other than a version for '
          + `${n === 1 ? 'it' : 'them'} -- a path, a URL, a tag -- so no range comparison applies.`),
      names));
  }
  return found;
}

/**
 * Every finding, worst first, then alphabetically so two runs read the same.
 *
 * @param {{ manifest: object, lock: object, used?: Set<string>, direct?: number,
 *   advisories?: object }} world
 * @returns {ReadonlyArray<object>}
 */
export function assess(world) {
  const used = world.used ?? new Set();
  const direct = world.direct ?? world.manifest.dependencies.size;
  // Computed here when the caller did not, so `assess` is one call rather than a
  // sequence somebody can get half right.
  const audit = world.advisories ?? auditTree(world);
  const found = [
    ...fromAdvisories(audit),
    ...fromLock(world.lock, direct),
    ...fromProject({ ...world, used }),
  ];
  found.sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.code.localeCompare(b.code));
  return Object.freeze(found);
}

/**
 * How many of each severity, for a headline that agrees with the list under it.
 *
 * @param {ReadonlyArray<object>} findings
 * @returns {Readonly<object>}
 */
export function summarise(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, note: 0, total: findings.length };
  for (const one of findings) counts[one.severity] += 1;
  return Object.freeze(counts);
}
