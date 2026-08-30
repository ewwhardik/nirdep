// Running the corpus, and reading back what happened.
//
// The vectors are driven by the files under tests/runtime, and those files are already the
// only implementation of "what a vector means". A second executor here would be a second
// answer to that question, the two would drift, and the one in src/ would be the one nobody
// runs -- so this spawns the real suite and reports its verdict rather than reimplementing
// it. Spawning the interpreter is the interpreter, not a tool: process.execPath is the same
// Node that is already running.
//
// TAP is parsed off the trailing summary rather than by counting lines. Node prints one
// summary at column zero and indents everything a subtest says, so the anchored patterns
// below cannot pick up a nested diagnostic by accident.

import { execFileSync } from 'node:child_process';

/** The counters Node prints at the end of a TAP run. */
const TALLIES = Object.freeze(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

/**
 * The summary of a TAP stream, plus the names of the top-level failures. Nested failures are
 * counted but not named: the outer test's name is the one worth printing, and the file and
 * line are in the suite's own output for whoever needs them.
 *
 * @param {string} text
 */
export function parseTap(text) {
  const counts = {};
  for (const name of TALLIES) {
    const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text);
    counts[name] = match === null ? null : Number(match[1]);
  }
  const failures = [...text.matchAll(/^not ok \d+ - (.+)$/gm)]
    .map((match) => match[1].replace(/ # (SKIP|TODO)\b.*$/, '').trim());
  // A run that never reached its own summary did not fail a test: it failed to start, which
  // is a different sentence and a different exit code.
  return { ...counts, failures, summarised: counts.tests !== null };
}

/** One child process per module, so a module's result is its own and a crash in one does not
 * take the numbers of the others with it. */
function spawnTap(root, files) {
  const args = ['--test', '--test-reporter=tap', ...files];
  // A test runner sets NODE_TEST_CONTEXT for the files it loads, and a child that sees it
  // reports to its parent in V8-serialised frames instead of honouring --test-reporter. That
  // is the right behaviour for a subtest and the wrong one for us, so the variable is dropped
  // rather than inherited: `nirdep conformance` has to print the same page whether it was run
  // from a shell or from inside somebody's own suite.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0, error: null };
  } catch (error) {
    return { stdout: error.stdout ?? '', status: error.status ?? null, error: error.status === null ? error : null };
  }
}

/**
 * @param {object} plan the result of conformancePlan
 * @param {{ spawn?: (root: string, files: string[]) => { stdout: string, status: number|null, error: Error|null } }} [options]
 */
export function runConformance(plan, options = {}) {
  const spawn = options.spawn ?? spawnTap;
  const blocked = [...plan.problems];
  if (!plan.present) blocked.push(`${plan.modules.length === 0 ? 'no modules' : 'no test files'} to run: the corpus ships with the repository, not with the artifact`);
  if (blocked.length > 0) {
    return { ran: false, blocked, plan, modules: [], totals: zero(plan), node: process.version };
  }

  const modules = plan.modules.map((one) => {
    const { stdout, status, error } = spawn(plan.root, one.drivers);
    const tap = parseTap(stdout);
    return {
      ...one,
      ran: tap.summarised,
      status,
      // A suite that could not be started reports no counts at all, rather than nought
      // failures, which would read as a pass.
      counts: tap.summarised
        ? { tests: tap.tests, pass: tap.pass, fail: tap.fail, skipped: tap.skipped, todo: tap.todo, cancelled: tap.cancelled }
        : null,
      failures: tap.failures,
      note: tap.summarised ? null : (error?.message ?? `the suite exited ${status} without a summary`),
    };
  });

  const totals = TALLIES.reduce((sum, name) => ({ ...sum, [name]: modules.reduce((count, one) => count + (one.counts?.[name] ?? 0), 0) }), {});
  return {
    ran: modules.every((one) => one.ran),
    blocked: [],
    plan,
    modules,
    totals: { ...totals, cases: plan.totals.cases, modules: modules.length, packages: plan.totals.packages, vectors: plan.totals.vectors },
    node: process.version,
  };
}

function zero(plan) {
  return { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, cases: plan.totals.cases, modules: plan.modules.length, packages: plan.totals.packages, vectors: plan.totals.vectors };
}

/**
 * 0 clean, 1 a case came back wrong, 2 nothing was measured. The third one matters: an
 * artifact without the vectors in it must not print a pass it did not earn.
 *
 * @param {object} result
 */
export function conformanceExitCode(result) {
  if (!result.ran) return 2;
  return result.totals.fail > 0 || result.totals.cancelled > 0 ? 1 : 0;
}
