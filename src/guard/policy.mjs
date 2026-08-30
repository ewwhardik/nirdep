// The policy `guard` enforces, and the refusal to guess at one.
//
// A guard is only worth having if it fails for a reason somebody wrote down, so this reads
// the policy from a file rather than inventing defaults per run, and it is strict about
// what it accepts: an unknown key is an error, not a shrug. A typo in a CI config that
// silently disables the check is worse than no check at all -- the build stays green and
// the dependency comes back anyway.
//
// Two places to put it, in order: `.nirdeprc.json` beside the manifest, or a `nirdep.guard`
// object inside package.json for projects that would rather not add a dotfile. With
// neither, the default is the honest one for this tool: every package nirdep can replace is
// denied, in all three of the places a dependency can hide, and a version the advisory table
// already knows about fails the build whether or not anybody chose to install it.

import { join } from 'node:path';
import { readerFrom } from '../fs/read.mjs';
import { suggest } from '../runtime/args.mjs';
import { REPLACEABLE } from '../rules/registry.mjs';
import { didYouMean } from '../text/format.mjs';

/** The three places a dependency can come back, which are the three readers `scan` has. */
export const SIGNAL = Object.freeze({ DECLARED: 'declared', INSTALLED: 'installed', IMPORTED: 'imported' });

const SIGNALS = Object.freeze(Object.values(SIGNAL));

/** Where the policy came from, which the report prints so a green build is auditable. */
export const SOURCE = Object.freeze({ DEFAULT: 'default', FILE: 'file', MANIFEST: 'manifest', FLAGS: 'flags' });

export const POLICY_FILE = '.nirdeprc.json';

/**
 * How much of the advisory table is allowed to fail a build.
 *
 * A ladder rather than a set: each level contains the one below it, so the report can print
 * the policy as one word and a reader can tell at a glance which way to move it. `incidents`
 * is the level for a project that cannot upgrade today but would still like to know if it is
 * shipping a wallet stealer.
 */
export const ADVISORY = Object.freeze({
  OFF: 'off', INCIDENTS: 'incidents', HITS: 'hits', ALL: 'all',
});

const LEVELS = Object.freeze(Object.values(ADVISORY));

const KEYS = Object.freeze(['deny', 'allow', 'dev', 'signals', 'max', 'advisories']);

/**
 * No policy on disk is not "no opinion". The default is the claim this tool makes: these
 * packages have replacements, so their coming back is a regression like any other -- and a
 * version the table already knows about is a regression whether or not anybody chose it.
 */
export const DEFAULT_POLICY = Object.freeze({
  deny: Object.freeze([...REPLACEABLE]),
  allow: Object.freeze(new Map()),
  dev: true,
  signals: Object.freeze([...SIGNALS]),
  max: null,
  advisories: ADVISORY.HITS,
});

const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Turn whatever was in the file into a policy, or into a list of complaints.
 *
 * The complaints are strings rather than exceptions because a config with three mistakes in
 * it should produce three lines, not one line three runs in a row.
 *
 * @param {unknown} raw
 * @returns {{ policy: object, problems: string[] }}
 */
export function validatePolicy(raw) {
  const problems = [];
  if (raw === undefined || raw === null) return { policy: DEFAULT_POLICY, problems };
  if (!isPlain(raw)) {
    problems.push(`the guard policy has to be an object, and this is ${Array.isArray(raw) ? 'an array' : typeof raw}`);
    return { policy: DEFAULT_POLICY, problems };
  }

  for (const key of Object.keys(raw)) {
    if (KEYS.includes(key)) continue;
    const near = suggest(key, KEYS, 1);
    problems.push(`unknown policy key "${key}"${didYouMean(near, { quote: true })}`);
  }

  const names = (key) => {
    const value = raw[key];
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) {
      problems.push(`"${key}" has to be a list of package names`);
      return null;
    }
    return value;
  };

  const deny = names('deny');
  // `allow` earns a sentence: an exemption with no reason beside it is the one that is
  // still there two years later and nobody remembers why.
  let allow = null;
  if (raw.allow !== undefined) {
    if (Array.isArray(raw.allow)) {
      if (raw.allow.some((one) => typeof one !== 'string')) problems.push('"allow" has to be a list of package names');
      else allow = new Map(raw.allow.map((name) => [name, null]));
    } else if (isPlain(raw.allow)) {
      const bad = Object.entries(raw.allow).filter(([, reason]) => typeof reason !== 'string');
      if (bad.length > 0) problems.push(`"allow" needs a reason per package, and ${bad[0][0]} has none`);
      else allow = new Map(Object.entries(raw.allow));
    } else {
      problems.push('"allow" has to be a list of names, or an object of name to reason');
    }
  }

  let dev = null;
  if (raw.dev !== undefined) {
    if (typeof raw.dev !== 'boolean') problems.push('"dev" has to be true or false');
    else dev = raw.dev;
  }

  let signals = null;
  if (raw.signals !== undefined) {
    const listed = names('signals');
    if (listed !== null) {
      const unknown = listed.filter((one) => !SIGNALS.includes(one));
      if (unknown.length > 0) {
        const near = suggest(unknown[0], SIGNALS, 1);
        problems.push(`unknown signal "${unknown[0]}"${didYouMean(near, { quote: true })}`
          + ` -- the three are ${SIGNALS.join(', ')}`);
      } else if (listed.length === 0) problems.push('"signals" is empty, so the guard would pass on anything');
      else signals = listed;
    }
  }

  let max = null;
  if (raw.max !== undefined && raw.max !== null) {
    if (typeof raw.max !== 'number' || !Number.isInteger(raw.max) || raw.max < 0) {
      problems.push('"max" has to be a whole number of direct dependencies, or null');
    } else max = raw.max;
  }

  let advisories = null;
  if (raw.advisories !== undefined && raw.advisories !== null) {
    // `true` and `false` are what people actually type in a CI config, and reading them as
    // the two ends of the ladder is a second spelling rather than a shrug: both map onto a
    // level that already exists, and the report prints the level rather than the boolean.
    if (typeof raw.advisories === 'boolean') advisories = raw.advisories ? ADVISORY.HITS : ADVISORY.OFF;
    else if (typeof raw.advisories !== 'string' || !LEVELS.includes(raw.advisories)) {
      const near = typeof raw.advisories === 'string' ? suggest(raw.advisories, LEVELS, 1) : [];
      problems.push(`unknown advisory level ${JSON.stringify(raw.advisories)}`
        + `${didYouMean(near, { quote: true })}`
        + ` -- the four are ${LEVELS.join(', ')}`);
    } else advisories = raw.advisories;
  }

  return {
    policy: Object.freeze({
      deny: Object.freeze(deny ?? DEFAULT_POLICY.deny),
      allow: Object.freeze(allow ?? DEFAULT_POLICY.allow),
      dev: dev ?? DEFAULT_POLICY.dev,
      signals: Object.freeze(signals ?? DEFAULT_POLICY.signals),
      max: max ?? null,
      advisories: advisories ?? DEFAULT_POLICY.advisories,
    }),
    problems,
  };
}

/** JSON, with the parse error kept as a sentence rather than thrown at the user. */
function parse(text, where, problems) {
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${where} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

/**
 * Find the policy, read it, and say where it came from.
 *
 * @param {string} root the project being guarded
 * @param {{ policyFile?: string|null, read?: (file: string) => string, overrides?: object }} [options]
 */
export function readPolicy(root, options = {}) {
  const read = readerFrom(options);
  const problems = [];
  let source = SOURCE.DEFAULT;
  let path = null;
  let raw;

  const named = options.policyFile ?? null;
  const file = named === null ? join(root, POLICY_FILE) : named;
  let text;
  try {
    text = read(file);
  } catch (error) {
    // A file the user named and we cannot read is their problem to hear about. The default
    // dotfile being absent is the normal case and says nothing.
    if (named !== null) problems.push(`${named} cannot be read: ${error.message}`);
    text = null;
  }
  if (text !== null) {
    source = SOURCE.FILE;
    path = named ?? POLICY_FILE;
    const whole = parse(text, path, problems);
    if (whole !== undefined && !isPlain(whole)) {
      problems.push(`${path} has to contain an object`);
    } else if (isPlain(whole)) {
      // Two shapes accepted, because both are things people write. The dotfile is nirdep's
      // own config, so a `guard` section leaves room for the next command's settings beside
      // it; a file that is nothing but policy keys is taken as the policy itself rather
      // than ignored, which is the failure mode a strict reading would have.
      if (whole.guard !== undefined) raw = whole.guard;
      else if (Object.keys(whole).some((key) => KEYS.includes(key))) raw = whole;
    }
  }

  if (source === SOURCE.DEFAULT) {
    let manifest;
    try {
      manifest = parse(read(join(root, 'package.json')), 'package.json', problems);
    } catch {
      manifest = undefined;
    }
    const inside = isPlain(manifest) && isPlain(manifest.nirdep) ? manifest.nirdep.guard : undefined;
    if (inside !== undefined) {
      source = SOURCE.MANIFEST;
      path = 'package.json';
      raw = inside;
    }
  }

  const checked = validatePolicy(raw);
  problems.push(...checked.problems);

  // Flags are the last word, and they say so in the report: a policy printed as "from
  // .nirdeprc.json" when a flag overrode half of it would be a lie with a receipt.
  const overrides = options.overrides ?? {};
  const applied = Object.keys(overrides).filter((key) => overrides[key] !== undefined && overrides[key] !== null);
  const policy = applied.length === 0 ? checked.policy : Object.freeze({
    ...checked.policy,
    ...Object.fromEntries(applied.map((key) => [key, overrides[key]])),
    allow: overrides.allow === undefined || overrides.allow === null
      ? checked.policy.allow
      : Object.freeze(new Map([...checked.policy.allow, ...overrides.allow.map((name) => [name, 'passed on the command line'])])),
  });

  return Object.freeze({
    source: applied.length > 0 && source === SOURCE.DEFAULT ? SOURCE.FLAGS : source,
    path,
    // Whether anybody actually wrote a policy down. A file that exists with no policy in it
    // is the default, and the report says so rather than implying somebody chose this.
    written: raw !== undefined,
    overridden: Object.freeze(applied),
    policy,
    problems: Object.freeze(problems),
  });
}
