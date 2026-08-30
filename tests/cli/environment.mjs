// The environment a spawned CLI is allowed to see.
//
// Every test in this directory runs bin/nirdep.mjs as a child process and reads what it
// printed, which proves something only if the output is a function of the arguments. It was
// not. The child inherited process.env, and runtime/colour reads seventeen variables out of
// it to decide whether a stream can render colour.
//
// On a laptop none of them are set, so all of these tests passed. On GitHub Actions `CI` and
// `GITHUB_ACTIONS` are both set, `detectLevel` correctly answers truecolour -- that is what
// supports-color does, and our own conformance vectors assert it -- and eighteen tests that
// expected a plain pipe went red for a reason that was never in the code. The tool was right
// and the harness was reading the machine it happened to be on.
//
// So a child gets a scrubbed environment. PATH and the platform's own variables stay, because
// a process has to be able to start; every variable the tool makes a decision from is removed,
// and the test that cares about one sets it explicitly.

/**
 * Every name `detectLevel` reads, including the ones a CI provider sets to announce itself.
 * Kept in the order that function checks them, so the two lists can be compared by eye.
 */
export const INFLUENCES = Object.freeze([
  'FORCE_COLOR', 'NO_COLOR', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'CI', 'CI_NAME',
  'GITHUB_ACTIONS', 'GITEA_ACTIONS', 'CIRCLECI',
  'TRAVIS', 'APPVEYOR', 'GITLAB_CI', 'BUILDKITE', 'DRONE', 'TEAMCITY_VERSION',
]);

/**
 * The parent's environment with every influence removed, then the overrides applied. A value
 * of `undefined` deletes, which is how a caller asks for a variable to be absent rather than
 * empty -- an empty FORCE_COLOR is itself a request for colour.
 *
 * @param {Record<string, string|undefined>} [overrides]
 * @returns {Record<string, string>}
 */
export function childEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of INFLUENCES) delete env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
