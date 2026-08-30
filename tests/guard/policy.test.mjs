// The policy reader, and the mistakes it refuses to shrug at.
//
// Every case here goes through the `read` hook rather than a temporary directory, because
// what is being tested is the decision order -- named file, then dotfile, then the manifest,
// then the default -- and that reads better as a table of filenames than as a tree on disk.
//
// The assertions worth reading twice are the ones about problems. A config with three
// mistakes in it has to produce three lines: a reader that throws on the first one turns a
// five-minute fix into three runs, and a reader that ignores the rest is how a build stays
// green while the guard does nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import {
  ADVISORY, DEFAULT_POLICY, POLICY_FILE, SIGNAL, SOURCE, readPolicy, validatePolicy,
} from '../../src/guard/policy.mjs';
import { REPLACEABLE } from '../../src/rules/registry.mjs';

/** A `read` that answers for the files named and throws ENOENT for anything else, which is
 * what node:fs does and therefore what readPolicy has to cope with. */
function reader(files) {
  return (file) => {
    const key = basename(file);
    if (!(key in files)) {
      const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return files[key];
  };
}

const dotfile = (policy) => JSON.stringify({ guard: policy });
const only = (raw) => validatePolicy(raw).problems;

test('no policy anywhere is not no opinion', () => {
  const found = readPolicy('/nowhere', { read: reader({}) });
  assert.equal(found.source, SOURCE.DEFAULT);
  assert.equal(found.path, null);
  assert.equal(found.written, false, 'nobody wrote this down, and the report says so');
  assert.deepEqual(found.problems, []);
  assert.deepEqual([...found.policy.deny], [...REPLACEABLE]);
  assert.deepEqual([...found.policy.signals], [SIGNAL.DECLARED, SIGNAL.INSTALLED, SIGNAL.IMPORTED]);
  assert.equal(found.policy.dev, true);
  assert.equal(found.policy.max, null);
});

test('the dotfile is read in both of the shapes people write', () => {
  const sectioned = readPolicy('/p', { read: reader({ [POLICY_FILE]: dotfile({ max: 4 }) }) });
  assert.equal(sectioned.source, SOURCE.FILE);
  assert.equal(sectioned.path, POLICY_FILE);
  assert.equal(sectioned.written, true);
  assert.equal(sectioned.policy.max, 4);

  // A file that is nothing but policy keys is taken as the policy. Reading it strictly
  // would mean silently ignoring a file whose only purpose was to be read.
  const bare = readPolicy('/p', { read: reader({ [POLICY_FILE]: JSON.stringify({ max: 2, dev: false }) }) });
  assert.equal(bare.written, true);
  assert.equal(bare.policy.max, 2);
  assert.equal(bare.policy.dev, false);
});

test('a dotfile with no policy in it is the default, and does not pretend otherwise', () => {
  const found = readPolicy('/p', { read: reader({ [POLICY_FILE]: JSON.stringify({ eject: { into: 'lib' } }) }) });
  assert.equal(found.source, SOURCE.FILE);
  assert.equal(found.written, false, 'the file exists; a guard policy does not');
  assert.deepEqual(found.problems, []);
  assert.equal(found.policy.max, DEFAULT_POLICY.max);
});

test('the manifest is the second place to look, and only if the dotfile is absent', () => {
  const files = { 'package.json': JSON.stringify({ nirdep: { guard: { max: 9 } } }) };
  const manifest = readPolicy('/p', { read: reader(files) });
  assert.equal(manifest.source, SOURCE.MANIFEST);
  assert.equal(manifest.path, 'package.json');
  assert.equal(manifest.policy.max, 9);

  const both = readPolicy('/p', { read: reader({ ...files, [POLICY_FILE]: dotfile({ max: 1 }) }) });
  assert.equal(both.source, SOURCE.FILE, 'the dotfile wins');
  assert.equal(both.policy.max, 1);
});

test('a file the user named and we cannot read is their problem to hear about', () => {
  const named = readPolicy('/p', { read: reader({}), policyFile: 'ci/guard.json' });
  assert.equal(named.problems.length, 1);
  assert.match(named.problems[0], /^ci\/guard\.json cannot be read: ENOENT/);

  // The dotfile being absent is the normal case and says nothing at all.
  assert.deepEqual(readPolicy('/p', { read: reader({}) }).problems, []);
});

test('broken JSON is reported as a sentence, not thrown', () => {
  const found = readPolicy('/p', { read: reader({ [POLICY_FILE]: '{ "guard": { ' }) });
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0], new RegExp(`^${POLICY_FILE.replace('.', '\\.')} is not valid JSON: `));
});

test('a config with four mistakes produces four lines', () => {
  const problems = only({ signal: ['imported'], dev: 'yes', max: -2, allow: { chalk: 1 } });
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /unknown policy key "signal", did you mean "signals"\?/);
  assert.match(problems.join('\n'), /"dev" has to be true or false/);
  assert.match(problems.join('\n'), /"max" has to be a whole number/);
  assert.match(problems.join('\n'), /"allow" needs a reason per package, and chalk has none/);
});

test('an unknown signal names the three, and an empty list is refused outright', () => {
  assert.match(only({ signals: ['imports'] })[0], /unknown signal "imports", did you mean "imported"\?/);
  assert.match(only({ signals: ['imports'] })[0], /the three are declared, installed, imported/);
  // Nothing watched means nothing can fail, which is a guard that reports PASS for ever.
  assert.match(only({ signals: [] })[0], /"signals" is empty, so the guard would pass on anything/);
});

test('allow takes a list of names or a map of reasons, and nothing else', () => {
  const listed = validatePolicy({ allow: ['chalk', 'semver'] });
  assert.deepEqual(listed.problems, []);
  assert.deepEqual([...listed.policy.allow.keys()], ['chalk', 'semver']);
  assert.equal(listed.policy.allow.get('chalk'), null, 'a bare name has no reason recorded');

  const explained = validatePolicy({ allow: { chalk: 'DEP-14, the logo needs 256 colours' } });
  assert.deepEqual(explained.problems, []);
  assert.equal(explained.policy.allow.get('chalk'), 'DEP-14, the logo needs 256 colours');

  assert.match(only({ allow: 'chalk' })[0], /"allow" has to be a list of names, or an object of name to reason/);
  assert.match(only({ deny: [1, 2] })[0], /"deny" has to be a list of package names/);
  assert.match(only(['deny'])[0], /the guard policy has to be an object, and this is an array/);
});

test('a policy that fails validation still hands back a usable default', () => {
  // The caller stops on `problems`, but nothing downstream should have to test for it
  // before reading a field: a half-built policy object is a second failure mode.
  const { policy } = validatePolicy({ dev: 'yes', signals: ['nonsense'] });
  assert.equal(policy.dev, true);
  assert.deepEqual([...policy.signals], [...DEFAULT_POLICY.signals]);
});

test('flags are the last word, and the report is told which ones spoke', () => {
  const found = readPolicy('/p', {
    read: reader({ [POLICY_FILE]: dotfile({ dev: true, max: 10, allow: { chalk: 'written down' } }) }),
    overrides: { dev: false, max: 2, allow: ['minimist'] },
  });
  assert.deepEqual([...found.overridden], ['dev', 'max', 'allow']);
  assert.equal(found.policy.dev, false);
  assert.equal(found.policy.max, 2);
  // A flag adds an exemption; it does not throw away the ones somebody committed.
  assert.equal(found.policy.allow.get('chalk'), 'written down');
  assert.equal(found.policy.allow.get('minimist'), 'passed on the command line');
});

test('an override that was not typed is not an override', () => {
  const found = readPolicy('/p', {
    read: reader({ [POLICY_FILE]: dotfile({ dev: false }) }),
    // This is the shape bin/nirdep.mjs passes for a flag the user left alone. Reading the
    // flag's own default here instead would quietly overrule the policy on every run.
    overrides: { dev: undefined, max: undefined, allow: undefined },
  });
  assert.deepEqual([...found.overridden], []);
  assert.equal(found.source, SOURCE.FILE, 'still the file, because nothing overrode it');
  assert.equal(found.policy.dev, false);
});

test('flags with no policy on disk are their own source', () => {
  const found = readPolicy('/p', { read: reader({}), overrides: { max: 0 } });
  assert.equal(found.source, SOURCE.FLAGS);
  assert.equal(found.policy.max, 0, 'zero is a cap, not an absent one');
});

test('the advisory level is a ladder, and the default is on', () => {
  // Default-on is the claim: a version the table already names is a regression whether or not
  // anybody chose to install it, so silence has to be something somebody wrote down.
  assert.equal(DEFAULT_POLICY.advisories, ADVISORY.HITS);
  assert.equal(validatePolicy(undefined).policy.advisories, ADVISORY.HITS);

  for (const level of Object.values(ADVISORY)) {
    const checked = validatePolicy({ advisories: level });
    assert.deepEqual(checked.problems, []);
    assert.equal(checked.policy.advisories, level);
  }
});

test('true and false are a second spelling of the two ends of that ladder', () => {
  // Nobody types "hits" the first time. Both booleans map onto a level that already exists,
  // so the report still prints one word and there is no third state to reason about.
  assert.equal(validatePolicy({ advisories: true }).policy.advisories, ADVISORY.HITS);
  assert.equal(validatePolicy({ advisories: false }).policy.advisories, ADVISORY.OFF);
  assert.deepEqual(validatePolicy({ advisories: true }).problems, []);
});

test('a level nobody defined is a problem with a suggestion, not a shrug', () => {
  assert.match(only({ advisories: 'incident' })[0], /unknown advisory level "incident", did you mean "incidents"\?/);
  assert.match(only({ advisories: 'incident' })[0], /the four are off, incidents, hits, all/);
  assert.match(only({ advisories: 42 })[0], /unknown advisory level 42/);
  // And the policy handed back is still usable, so a caller that ignores problems fails
  // closed rather than reading undefined as "off".
  assert.equal(validatePolicy({ advisories: 'nope' }).policy.advisories, ADVISORY.HITS);
});
