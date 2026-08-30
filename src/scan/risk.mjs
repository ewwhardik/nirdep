// What a lockfile says about a project that nobody asked it.
//
// Every finding here is derived from files already on disk: no network, no
// registry lookup, no advisory database. That rules out the one thing people
// expect from the word "risk" -- known vulnerabilities -- and `scan` says so
// rather than implying it checked. What is left is still worth printing, because
// it is the part `npm audit` does not tell you: which packages run code when you
// install them, which ones their own authors have abandoned, which ones arrive
// without a hash to check, and which ones your source imports without ever
// declaring.
//
// A finding is a sentence with a number in it. A severity with no sentence is a
// colour, and a colour is not an argument.

const EMPTY = Object.freeze([]);

export const SEVERITY = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NOTE: 'note' });

const ORDER = Object.freeze({ high: 0, medium: 1, low: 2, note: 3 });

export const FINDING = Object.freeze({
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

const finding = (code, severity, detail, subjects = EMPTY) => Object.freeze({
  code,
  severity,
  detail,
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

/**
 * Every finding, worst first, then alphabetically so two runs read the same.
 *
 * @param {{ manifest: object, lock: object, used?: Set<string>, direct?: number }} world
 * @returns {ReadonlyArray<object>}
 */
export function assess(world) {
  const used = world.used ?? new Set();
  const direct = world.direct ?? world.manifest.dependencies.size;
  const found = [...fromLock(world.lock, direct), ...fromProject({ ...world, used })];
  found.sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.code.localeCompare(b.code));
  return Object.freeze(found);
}

/**
 * How many of each severity, for a headline that agrees with the list under it.
 *
 * @param {ReadonlyArray<object>} findings
 * @returns {Readonly<{ high: number, medium: number, low: number, note: number, total: number }>}
 */
export function summarise(findings) {
  const counts = { high: 0, medium: 0, low: 0, note: 0, total: findings.length };
  for (const one of findings) counts[one.severity] += 1;
  return Object.freeze(counts);
}
