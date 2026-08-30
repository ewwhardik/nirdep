// The one table in src/ that is not derived from code, checked against the code anyway.
//
// src/explain/facts.mjs says "node:util.styleText, added in 20.12.0". Two halves of that
// can rot: the API might not exist under the name we typed, and the version might be wrong
// or above the floor we ask for. So this asks the running Node for the first half, and our
// own semver replacement for the second -- which is the only comparator in the repository,
// self-hosting one more time.
//
// What it cannot check is the prose. A sentence claiming Node does something it does not is
// caught by a reader, not by a test, and that is why the file is kept short.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from '../../src/runtime/semver.mjs';
import { NODE_API, nodeApiFor } from '../../src/explain/facts.mjs';
import { RULES } from '../../src/rules/registry.mjs';
import { catalogue } from '../../src/eject/project.mjs';

const MANIFEST = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** Every API the table names, flattened, so a loop can ask about each one. */
const CLAIMS = Object.entries(NODE_API).flatMap(([subpath, entry]) => entry.has.map((one) => ({ subpath, ...one })));

test('every API the table claims is really on the module it names', async () => {
  for (const claim of CLAIMS) {
    // A variable specifier, so a module added to the table later is checked without this
    // test being edited -- and every one of them is a builtin, by construction.
    const module = await import(claim.module);
    assert.equal(claim.module.startsWith('node:'), true, `${claim.module} is spelled with the node: prefix`);
    assert.notEqual(module[claim.path], undefined, `${claim.module}.${claim.path} is there`);
  }
});

test('the versions are real, and none of them is above the floor we ask for', () => {
  for (const claim of CLAIMS) {
    assert.equal(semver.valid(claim.version), claim.version, `${claim.path} quotes a real version`);
    // If an API landed after our own engines floor, the floor is a lie: somebody on the
    // minimum supported Node would import this runtime and get undefined.
    assert.equal(
      semver.satisfies(claim.version, `<=${MANIFEST.engines.node.replace('>=', '')}`),
      true,
      `${claim.path} (${claim.version}) is at or below Node ${MANIFEST.engines.node}`,
    );
    // And the machine running the tests has to be at the floor too, or the check above
    // proves nothing about what a user will see.
    assert.equal(semver.satisfies(process.version.slice(1), MANIFEST.engines.node), true);
  }
});

test('every runtime module has a row, and every row is a runtime module', () => {
  const offered = new Set(catalogue().map((module) => module.subpath));
  assert.deepEqual([...Object.keys(NODE_API)].sort(), [...offered].sort());
  // Reached through the accessor rather than the object, because that is what the report
  // calls: a rule pointing at a subpath with no row would print two empty blocks.
  for (const rule of RULES) {
    const api = nodeApiFor(rule.subpath);
    assert.equal(api.lacks.length > 0, true, `${rule.package} has something Node does not do`);
  }
});

test('a subpath nobody has heard of gets an empty answer rather than a crash', () => {
  const api = nodeApiFor('runtime/nope');
  assert.deepEqual(api.has, []);
  assert.deepEqual(api.lacks, []);
});

test('the semver row is deliberately empty, and says so in the code', () => {
  // The one row with nothing in `has`. If somebody ever "fixes" it by inventing an API,
  // the argument for the file existing goes with it.
  assert.deepEqual(NODE_API['runtime/semver'].has, []);
  const source = readFileSync(new URL('../../src/explain/facts.mjs', import.meta.url), 'utf8');
  assert.match(source, /an empty `has` is not an oversight/);
});
