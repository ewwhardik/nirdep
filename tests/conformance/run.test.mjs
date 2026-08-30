// Reading a TAP stream, and the three answers a run can give.
//
// The interesting cases are the ones where nothing came back. A suite that crashed before it
// printed a summary has nought failures in exactly the same way a clean suite does, and the
// difference between those two is the difference between a green build and a lie. So the
// parser reports whether it saw a summary at all, and the exit code has a third value for
// "nothing was measured" rather than folding it into pass or fail.
//
// `spawn` is injected: these cases are about the reader, and a real child process per case
// would test Node's test runner instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformancePlan, MODULES } from '../../src/conformance/plan.mjs';
import { conformanceExitCode, parseTap, runConformance } from '../../src/conformance/run.mjs';

/** A TAP stream, as Node writes one: the summary at column zero, everything else indented. */
function tap({ pass = 0, fail = 0, skipped = 0, todo = 0, cancelled = 0, failures = [], nested = [] } = {}) {
  const lines = [];
  let n = 0;
  for (const name of failures) lines.push(`not ok ${(n += 1)} - ${name}`);
  for (const name of nested) lines.push(`    not ok 1 - ${name}`, '    1..1');
  lines.push(`1..${n}`, `# tests ${pass + fail + skipped + todo}`, '# suites 0',
    `# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`, `# skipped ${skipped}`,
    `# todo ${todo}`, '# duration_ms 12.34');
  return lines.join('\n');
}

const plan = () => conformancePlan();
const spawning = (stdout, status = 0) => () => ({ stdout, status, error: null });

test('the summary is read off the counters, and only the top-level ones', () => {
  const parsed = parseTap(tap({ pass: 3, fail: 1, skipped: 1, failures: ['a range that selects nothing'], nested: ['inner'] }));
  assert.equal(parsed.tests, 5);
  assert.equal(parsed.pass, 3);
  assert.equal(parsed.fail, 1);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.summarised, true);
  // The nested failure is counted by Node in `fail` and deliberately not named here: the
  // outer test's name is the one worth printing beside a module.
  assert.deepEqual(parsed.failures, ['a range that selects nothing']);
});

test('a skip directive is not read as part of the name', () => {
  const parsed = parseTap('not ok 1 - the oracle harness # SKIP no oracle on this machine\n# tests 1\n# pass 0\n# fail 1\n# skipped 1\n# todo 0\n# cancelled 0\n');
  assert.deepEqual(parsed.failures, ['the oracle harness']);
});

test('a stream with no summary in it is not a stream with no failures', () => {
  const parsed = parseTap('SyntaxError: Unexpected token\n');
  assert.equal(parsed.summarised, false);
  assert.equal(parsed.tests, null, 'no number is better than nought');
  assert.deepEqual(parsed.failures, []);
});

test('a clean run is a pass per module and one exit code for the lot', () => {
  const result = runConformance(plan(), { spawn: spawning(tap({ pass: 12 })) });
  assert.equal(result.ran, true);
  assert.equal(result.modules.length, MODULES.length);
  assert.equal(result.totals.tests, MODULES.length * 12, 'one module per corpus, twelve tests each');
  assert.equal(result.totals.fail, 0);
  // The case count comes from the plan, not from the runner: they measure different things
  // and the page prints both.
  assert.equal(result.totals.cases > 1000, true);
  assert.equal(conformanceExitCode(result), 0);
});

test('one failing case fails the command', () => {
  const result = runConformance(plan(), { spawn: spawning(tap({ pass: 11, fail: 1, failures: ['coerce, right to left'] }), 1) });
  assert.equal(result.totals.fail, MODULES.length, 'once per module, since every module got the same stub');
  assert.equal(conformanceExitCode(result), 1);
  assert.deepEqual(result.modules[0].failures, ['coerce, right to left']);
});

test('a skip is reported and does not fail the build', () => {
  const result = runConformance(plan(), { spawn: spawning(tap({ pass: 11, skipped: 1 })) });
  assert.equal(result.totals.skipped, MODULES.length);
  assert.equal(conformanceExitCode(result), 0, 'an admitted gap is a thing to print, not a red build');
});

test('a cancelled test fails, because nobody knows what it would have said', () => {
  const result = runConformance(plan(), { spawn: spawning(tap({ pass: 11, cancelled: 1 })) });
  assert.equal(conformanceExitCode(result), 1);
});

test('a suite that never started is exit 2 rather than a pass', () => {
  const result = runConformance(plan(), { spawn: () => ({ stdout: 'Cannot find module\n', status: 1, error: null }) });
  assert.equal(result.ran, false);
  assert.equal(result.modules[0].counts, null);
  assert.match(result.modules[0].note, /exited 1 without a summary/);
  assert.equal(conformanceExitCode(result), 2);
});

test('a corpus that is not in this tree stops the run and says why', () => {
  const absent = conformancePlan({ root: '/nowhere', list: () => [], read: () => { throw new Error('ENOENT'); } });
  const result = runConformance(absent, { spawn: () => { throw new Error('nothing should have been spawned'); } });
  assert.equal(result.ran, false);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0], /ships with the repository, not with the artifact/);
  assert.equal(conformanceExitCode(result), 2);
});

test('a vector file that will not parse blocks the run instead of being run around', () => {
  const broken = { ...conformancePlan(), problems: ['tests/vectors/colour/named.json cannot be read: bad JSON'] };
  const result = runConformance(broken, { spawn: () => { throw new Error('nothing should have been spawned'); } });
  assert.equal(result.ran, false);
  assert.deepEqual(result.blocked, ['tests/vectors/colour/named.json cannot be read: bad JSON']);
  assert.equal(conformanceExitCode(result), 2);
});

test('each module is its own child process, so one crash keeps the other numbers', () => {
  const seen = [];
  const result = runConformance(plan(), {
    spawn: (root, files) => {
      seen.push(files);
      return files.some((file) => file.includes('semver'))
        ? { stdout: 'boom\n', status: null, error: new Error('spawn failed') }
        : { stdout: tap({ pass: 5 }), status: 0, error: null };
    },
  });
  assert.equal(seen.length, MODULES.length);
  assert.equal(result.modules.filter((one) => one.ran).length, MODULES.length - 1);
  assert.equal(result.totals.pass, (MODULES.length - 1) * 5, 'the ones that ran still report what they found');
  assert.match(result.modules.find((one) => one.name === 'semver').note, /spawn failed/);
  assert.equal(conformanceExitCode(result), 2);
});
