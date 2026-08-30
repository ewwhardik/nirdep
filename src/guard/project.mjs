// The command a CI job runs: did a dependency we already removed come back?
//
// `scan` reads a project three ways and prints everything it found. This asks one question
// of the same three readers and answers it with an exit code, because that is the only part
// of a report a build machine can act on. The three readers matter individually: a package
// can be declared and never installed (somebody edited the manifest), installed and never
// declared (a phantom dependency arriving through somebody else's tree), or imported and
// neither (a line that has been broken since it was written). Each of those is a different
// conversation, so each is reported as its own signal rather than folded into one boolean.
//
// There is a second question, and it is the one a build machine is better placed to ask than
// a person: is any version in this lockfile one the advisory table already knows about? A
// dependency coming back is a decision somebody made and can defend. A malicious release
// arriving four levels down is neither, and it is why this command has a policy key of its
// own for it rather than a flag somebody remembers to pass.
//
// What this deliberately does not do is check whether the replacement is being used. A
// project can pass the guard with none of nirdep in it, which is correct: the policy is
// about what is absent, and "you must depend on us instead" is not a guard, it is a lock-in.

import { scanProject } from '../scan/project.mjs';
import { KIND, VERDICT, highestFixed } from '../scan/advisories.mjs';
import { moduleOf, ruleFor } from '../rules/registry.mjs';
import { ADVISORY, SIGNAL, readPolicy } from './policy.mjs';

const EMPTY = Object.freeze([]);

/**
 * One guarded package, and where it was found. `signals` is only the ones the policy asked
 * about; `seen` is everything, so the report can say "installed, but you are not watching
 * that" instead of pretending not to have noticed.
 */
function inspect(name, world) {
  const { policy, manifest, lock, imported } = world;
  const use = imported.get(name);
  const dev = manifest.development.has(name);
  const declared = manifest.dependencies.has(name) && (policy.dev || !dev);
  const versions = (lock.byName.get(name) ?? EMPTY).map((one) => one.version).filter((one) => one !== null);
  const seen = [];
  if (manifest.dependencies.has(name)) seen.push(SIGNAL.DECLARED);
  if (lock.byName.has(name)) seen.push(SIGNAL.INSTALLED);
  if (use !== undefined) seen.push(SIGNAL.IMPORTED);

  const signals = [];
  if (declared && policy.signals.includes(SIGNAL.DECLARED)) signals.push(SIGNAL.DECLARED);
  // A dev-only dependency is still installed, so `dev: false` has to silence the lockfile
  // signal too or the flag would do nothing on a real project.
  if (lock.byName.has(name) && policy.signals.includes(SIGNAL.INSTALLED) && (policy.dev || !dev)) {
    signals.push(SIGNAL.INSTALLED);
  }
  if (use !== undefined && policy.signals.includes(SIGNAL.IMPORTED)) signals.push(SIGNAL.IMPORTED);

  const rule = ruleFor(name);
  return Object.freeze({
    name,
    signals: Object.freeze(signals),
    seen: Object.freeze(seen),
    dev,
    range: manifest.ranges.get(name) ?? null,
    versions: Object.freeze([...new Set(versions)].sort()),
    files: use === undefined ? 0 : use.files.length,
    sites: use === undefined ? 0 : use.sites.length,
    first: use === undefined || use.sites.length === 0 ? null : use.sites[0],
    replaceable: rule !== null,
    action: rule?.action ?? null,
    target: rule?.target ?? null,
    module: rule === null ? null : moduleOf(rule.subpath),
  });
}

/**
 * A malicious release in your tree is the one thing on this page nobody chose. An exemption
 * written against a package name is consent to its being installed, which is not the same
 * conversation: "the logo needs 256 colours" is not consent to ship a wallet stealer. So a
 * flaw with a fix can be waived by name with a reason beside it, and an exact release
 * published to do harm cannot be waived at all -- only the level can silence one, and
 * writing `advisories: "off"` in a committed file is a loud thing to have done.
 */
const unwaivable = (row) => row.kind === KIND.INCIDENT && row.verdict === VERDICT.HIT;

/** One row per package and version, from the advisory findings the level admits. */
function group(rows) {
  const groups = new Map();
  for (const one of rows) {
    const key = `${one.package}@${one.version ?? ''}`;
    const found = groups.get(key);
    if (found === undefined) groups.set(key, [one]);
    else found.push(one);
  }
  return [...groups.values()];
}

/**
 * What the advisory table says about this tree, narrowed to what this policy fails on.
 *
 * Grouped by package and version rather than by advisory row, because one stale lodash
 * answers five CVEs and a build log that prints it five times has buried whatever came after
 * it. The findings arrive severity-first, so the first of a group is the one worth quoting,
 * and the fix is the highest across the whole group: clearing one advisory while staying
 * inside another is the upgrade nobody notices they did not finish.
 */
function alarmsFrom(audit, policy) {
  const level = policy.advisories;
  if (level === ADVISORY.OFF) return { alarms: EMPTY, waived: EMPTY };
  const rows = level === ADVISORY.INCIDENTS
    ? audit.hits.filter((one) => one.advisory.kind === KIND.INCIDENT)
    : [...audit.hits];
  if (level === ADVISORY.ALL) rows.push(...audit.unversioned, ...audit.unknown);

  const alarms = [];
  const waived = [];
  for (const all of group(rows)) {
    const [first] = all;
    const row = {
      name: first.package,
      package: first.package,
      version: first.version,
      verdict: first.verdict,
      kind: first.advisory.kind,
      severity: first.advisory.severity,
      id: first.advisory.id,
      when: first.advisory.when,
      hand: first.advisory.hand,
      what: first.advisory.what,
      unrecorded: first.advisory.unrecorded,
      fixed: highestFixed(all),
      advisories: all.length,
      dev: first.dev,
      place: first.places.length > 0 ? first.places[0] : null,
      allowed: policy.allow.has(first.package),
      replaceable: first.replaceable,
      action: ruleFor(first.package)?.action ?? null,
      target: ruleFor(first.package)?.target ?? null,
    };
    if (row.allowed && !unwaivable(row)) waived.push(Object.freeze({ ...row, reason: policy.allow.get(row.name) }));
    else alarms.push(Object.freeze(row));
  }
  return { alarms: Object.freeze(alarms), waived: Object.freeze(waived) };
}

/**
 * Run the policy over a project.
 *
 * @param {string} root
 * @param {{ policyFile?: string|null, overrides?: object, scan?: object, read?: (file: string) => string }} [options]
 */
export function guardProject(root, options = {}) {
  const found = readPolicy(root, { ...options, policyFile: options.policyFile ?? null });
  // A policy we could not understand stops here. Guarding against half a policy would be
  // the same class of mistake as the typo that produced it.
  if (found.problems.length > 0) {
    return Object.freeze({
      root, policy: found, ran: false, breaches: EMPTY, exempt: EMPTY, quiet: EMPTY, counts: Object.freeze({
        guarded: 0, breached: 0, exempt: 0, alarming: 0, direct: 0,
      }),
    });
  }

  const scan = options.scan ?? scanProject(root, options);
  const { policy } = found;
  const imported = new Map(scan.source.packages.map((one) => [one.name, one]));
  const world = { policy, manifest: scan.manifest, lock: scan.lock, imported };

  // Everything the policy names, plus anything imported or installed that it names by
  // pattern -- there is no pattern support, so this is just the deny list, sorted for a
  // stable report.
  const guarded = [...new Set(policy.deny)].sort();
  const rows = guarded.map((name) => inspect(name, world));
  const breaches = rows.filter((one) => one.signals.length > 0 && !policy.allow.has(one.name));
  const exempt = rows.filter((one) => one.signals.length > 0 && policy.allow.has(one.name))
    .map((one) => Object.freeze({ ...one, reason: policy.allow.get(one.name) }));
  const quiet = rows.filter((one) => one.signals.length === 0);

  // The cap is a second, blunter question: never mind which packages, how many are there?
  // A project that replaced chalk and added two other things has not got smaller.
  const direct = scan.counts.direct;
  const over = policy.max !== null && direct > policy.max;

  // The fourth reader, and the only one here that can fail a build over something nobody
  // chose. `scan` has already crossed the table against this tree, so this reads the record
  // it left rather than auditing again: two answers to one question is one answer too many.
  // A scan that carried no advisory pass is reported as unchecked, never as clean.
  const audit = scan.advisories ?? null;
  const { alarms, waived } = audit === null ? { alarms: EMPTY, waived: EMPTY } : alarmsFrom(audit, policy);
  const advisories = Object.freeze({
    level: policy.advisories,
    ran: audit !== null && policy.advisories !== ADVISORY.OFF,
    source: audit?.source ?? null,
    reviewed: audit?.reviewed ?? null,
    coverage: audit?.coverage ?? null,
    matched: audit?.matched ?? 0,
    alarms,
    waived,
    counts: Object.freeze({
      alarming: alarms.length,
      waived: waived.length,
      hits: audit?.counts.hits ?? 0,
      incidents: audit?.counts.incidents ?? 0,
      flaws: audit?.counts.flaws ?? 0,
      unversioned: audit?.counts.unversioned ?? 0,
      unknown: audit?.counts.unknown ?? 0,
    }),
  });

  return Object.freeze({
    root,
    policy: found,
    ran: true,
    // Kept whole so the report can quote the lockfile's own caveats rather than restate
    // them: "installed" means something weaker when the lockfile was not understood.
    lock: Object.freeze({
      kind: scan.lock.kind,
      file: scan.lock.file ?? null,
      understood: scan.lock.understood,
      note: scan.lock.note ?? null,
    }),
    source: Object.freeze({ counts: scan.source.counts, unparsed: scan.source.unparsed }),
    breaches: Object.freeze(breaches),
    exempt: Object.freeze(exempt),
    quiet: Object.freeze(quiet),
    advisories,
    max: Object.freeze({ limit: policy.max, direct, over }),
    counts: Object.freeze({
      guarded: rows.length,
      breached: breaches.length,
      exempt: exempt.length,
      alarming: alarms.length,
      direct,
    }),
  });
}

/** 0 clean, 1 a breach, 2 a policy we could not read. */
export function guardExitCode(result) {
  if (!result.ran) return 2;
  return result.counts.breached > 0 || result.max.over || result.counts.alarming > 0 ? 1 : 0;
}
