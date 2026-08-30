// What conformance knows before it runs anything, and how it knows it.
//
// The one property worth a test here is that nothing is typed. A hand-written table would
// pass every assertion below on the day it was written and stay green after the vectors were
// deleted, so these cases delete things: a driver, a vector file, a whole module's corpus,
// and check that the plan notices rather than reporting a smaller pass.
//
// The fixture's file contents carry relative specifiers on purpose. A relative path is not a
// dependency, so unlike tests/vectors/guard/project.json this fixture can be a string in a
// .mjs file without tools/verify.mjs counting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { conformancePlan, onlyModules, MODULES, DRIVERS, VECTORS } from '../../src/conformance/plan.mjs';

const ROOT = '/demo';

/** A tree, as a map of repository-relative path to contents. */
function tree(files) {
  return {
    root: ROOT,
    list: (dir) => Object.keys(files).filter((file) => file.startsWith(`${dir}/`)),
    read: (absolute) => {
      const file = absolute.slice(ROOT.length + 1).split('\\').join('/');
      if (!(file in files)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return files[file];
    },
  };
}

const vector = (count) => JSON.stringify({ note: 'a fixture', cases: Array.from({ length: count }, (_, n) => ({ n })) });
/** A driver reads the module it drives, which is how the plan attributes it. */
const driver = (module) => `import * as one from '../../src/runtime/${module}.mjs';\nexport default one;\n`;

const full = () => tree({
  [`${VECTORS}/colour/named.json`]: vector(38),
  [`${VECTORS}/colour/dynamic.json`]: vector(36),
  [`${VECTORS}/args/parse.json`]: vector(94),
  [`${VECTORS}/semver/ranges.json`]: vector(432),
  // A vector directory for a layer that is not a runtime module: covered by `make test`,
  // and none of conformance's business.
  [`${VECTORS}/lex/tokens.json`]: vector(49),
  [`${DRIVERS}/colour.test.mjs`]: driver('colour'),
  [`${DRIVERS}/level.test.mjs`]: driver('colour'),
  [`${DRIVERS}/args.test.mjs`]: driver('args'),
  [`${DRIVERS}/semver.test.mjs`]: driver('semver'),
});

const moduleNamed = (plan, name) => plan.modules.find((one) => one.name === name);

test('the modules and the packages they replace come off the rule catalogue', () => {
  assert.deepEqual(MODULES.map((one) => one.name), ['colour', 'semver', 'args']);
  const colour = MODULES.find((one) => one.name === 'colour');
  assert.equal(colour.subpath, 'runtime/colour');
  assert.deepEqual(colour.packages.map((one) => one.name),
    ['chalk', 'strip-ansi', 'supports-color', 'ansi-styles']);
  // The weekly figure travels with the package, so the page can say what the corpus is
  // standing in for without a second table to keep in step.
  assert.equal(colour.packages[0].weekly, '319.8M');
});

test('a case count is the length of an array in a file, not a number somebody typed', () => {
  const plan = conformancePlan(full());
  assert.equal(moduleNamed(plan, 'colour').cases, 74);
  assert.equal(moduleNamed(plan, 'args').cases, 94);
  assert.equal(plan.totals.cases, 74 + 94 + 432);
  assert.equal(plan.totals.vectors, 4, 'the lex vectors belong to another layer');
  assert.equal(plan.present, true);
  assert.deepEqual(plan.problems, []);
});

test('a test file belongs to the module it reads', () => {
  const plan = conformancePlan(full());
  assert.deepEqual(moduleNamed(plan, 'colour').drivers,
    [`${DRIVERS}/colour.test.mjs`, `${DRIVERS}/level.test.mjs`]);
  assert.deepEqual(moduleNamed(plan, 'semver').drivers, [`${DRIVERS}/semver.test.mjs`]);
  assert.deepEqual(plan.strays, []);
});

test('a driver that reads no runtime module is named rather than counted', () => {
  const files = full();
  const plan = conformancePlan(tree({
    ...Object.fromEntries(files.list(VECTORS).map((file) => [file, files.read(join(ROOT, file))])),
    ...Object.fromEntries(files.list(DRIVERS).map((file) => [file, files.read(join(ROOT, file))])),
    [`${DRIVERS}/helpers.test.mjs`]: 'export const nothing = 1;\n',
  }));
  assert.deepEqual(plan.strays, [`${DRIVERS}/helpers.test.mjs`]);
  assert.equal(plan.present, true, 'a stray is a thing to mention, not a reason to refuse');
});

test('a module with a corpus and nobody reading it is not a pass', () => {
  // The failure this file exists for. Delete the driver and the vectors are still on disk,
  // still countable, and no longer checked by anything -- which a report that only counted
  // files would print as green.
  const plan = conformancePlan(tree({
    [`${VECTORS}/colour/named.json`]: vector(38),
    [`${VECTORS}/args/parse.json`]: vector(94),
    [`${VECTORS}/semver/ranges.json`]: vector(432),
    [`${DRIVERS}/colour.test.mjs`]: driver('colour'),
    [`${DRIVERS}/args.test.mjs`]: driver('args'),
  }));
  assert.equal(plan.present, false);
  assert.deepEqual(moduleNamed(plan, 'semver').drivers, []);
  assert.equal(moduleNamed(plan, 'semver').cases, 432, 'the corpus is still there, and still counted');
});

test('a vector file we cannot parse is a problem with a name on it', () => {
  const plan = conformancePlan(tree({
    [`${VECTORS}/colour/named.json`]: '{ "cases": [ oops',
    [`${VECTORS}/args/parse.json`]: vector(94),
    [`${VECTORS}/semver/ranges.json`]: vector(432),
    [`${DRIVERS}/colour.test.mjs`]: driver('colour'),
    [`${DRIVERS}/args.test.mjs`]: driver('args'),
    [`${DRIVERS}/semver.test.mjs`]: driver('semver'),
  }));
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], new RegExp(`^${VECTORS}/colour/named\\.json cannot be read: `));
  assert.equal(moduleNamed(plan, 'colour').cases, 0, 'no guess at what was in it');
});

test('a vector file with no cases in it counts nought, which is visible', () => {
  const plan = conformancePlan(tree({
    [`${VECTORS}/colour/named.json`]: JSON.stringify({ note: 'somebody emptied this' }),
    [`${VECTORS}/args/parse.json`]: vector(94),
    [`${VECTORS}/semver/ranges.json`]: vector(432),
    [`${DRIVERS}/colour.test.mjs`]: driver('colour'),
    [`${DRIVERS}/args.test.mjs`]: driver('args'),
    [`${DRIVERS}/semver.test.mjs`]: driver('semver'),
  }));
  assert.deepEqual(moduleNamed(plan, 'colour').vectors, [{ file: `${VECTORS}/colour/named.json`, cases: 0 }]);
  assert.deepEqual(plan.problems, [], 'an empty file parses, so it is not a problem -- it is a nought');
});

test('a tree with no corpus in it is not a project with no failures', () => {
  const plan = conformancePlan(tree({}));
  assert.equal(plan.present, false);
  assert.equal(plan.totals.cases, 0);
  assert.equal(plan.totals.modules, 3, 'the modules are known from the catalogue either way');
});

test('naming a module narrows the plan and its totals together', () => {
  const { plan, unknown } = onlyModules(conformancePlan(full()), ['semver']);
  assert.deepEqual(unknown, []);
  assert.deepEqual(plan.modules.map((one) => one.name), ['semver']);
  assert.equal(plan.totals.cases, 432, 'the total is of what will run, not of what exists');
  assert.equal(plan.totals.packages, 1);
});

test('a module name we do not have comes back rather than being ignored', () => {
  const { unknown } = onlyModules(conformancePlan(full()), ['colour', 'chalk']);
  assert.deepEqual(unknown, ['chalk']);
});

test('this repository is its own fixture, and the numbers are real', () => {
  // The one case that reads the actual tree. If tests/vectors or tests/runtime moves, this
  // is what says so, and it is the check that keeps the other cases from testing a fiction.
  const plan = conformancePlan();
  assert.equal(plan.present, true, 'every runtime module has a driver in this repository');
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.totals.cases > 1000, true, `only ${plan.totals.cases} cases found`);
  assert.equal(plan.totals.packages, 8);
  for (const one of plan.modules) {
    assert.equal(one.vectors.length > 0, true, `${one.name} has vector files`);
    assert.equal(one.drivers.length > 0, true, `${one.name} has a driver`);
  }
});
