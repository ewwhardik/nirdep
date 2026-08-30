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
// What this deliberately does not do is check whether the replacement is being used. A
// project can pass the guard with none of nirdep in it, which is correct: the policy is
// about what is absent, and "you must depend on us instead" is not a guard, it is a lock-in.

import { scanProject } from '../scan/project.mjs';
import { ruleFor } from '../rules/registry.mjs';
import { SIGNAL, readPolicy } from './policy.mjs';

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
    module: rule === null ? null : rule.subpath.slice(rule.subpath.lastIndexOf('/') + 1),
  });
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
        guarded: 0, breached: 0, exempt: 0, direct: 0,
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

  return Object.freeze({
    root,
    policy: found,
    ran: true,
    // Kept whole so the report can quote the lockfile's own caveats rather than restate
    // them: "installed" means something weaker when the lockfile was not understood.
    lock: Object.freeze({ kind: scan.lock.kind, understood: scan.lock.understood, note: scan.lock.note ?? null }),
    source: Object.freeze({ counts: scan.source.counts, unparsed: scan.source.unparsed }),
    breaches: Object.freeze(breaches),
    exempt: Object.freeze(exempt),
    quiet: Object.freeze(quiet),
    max: Object.freeze({ limit: policy.max, direct, over }),
    counts: Object.freeze({
      guarded: rows.length,
      breached: breaches.length,
      exempt: exempt.length,
      direct,
    }),
  });
}

/** 0 clean, 1 a breach, 2 a policy we could not read. */
export function guardExitCode(result) {
  if (!result.ran) return 2;
  return result.counts.breached > 0 || result.max.over ? 1 : 0;
}
