// What there is to test, discovered rather than declared.
//
// A conformance table is worth exactly as much as its provenance. A hand-typed one --
// "colour: 74 cases, passing" -- is a claim about a number somebody wrote down once, and it
// stays green after the cases are deleted. So nothing here is typed: the modules come from
// the rule catalogue, the packages each one replaces come from the same place, the case
// counts are the length of the arrays in the vector files, and a test file belongs to a
// module because it reads that module.
//
// The corpus lives with the repository and not with the artifact, because package.json
// "files" ships bin, src and the documents. That is deliberate -- nobody wants 1,400 test
// vectors in their node_modules -- and it means this command has a third answer besides pass
// and fail: the vectors are not here, so nothing was measured.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpecifiers } from '../audit/imports.mjs';
import { readerFrom } from '../fs/read.mjs';
import { displayPath, walk } from '../fs/walk.mjs';
import { moduleOf, RULES } from '../rules/registry.mjs';

/** The repository this source file is part of, which is the tree being tested. Unlike every
 * other command, conformance does not take a path: it reports on nirdep, not on your project.
 * Not exported: `options.root` is how a caller says otherwise, and a second way in would be
 * a second thing to keep true. */
const SELF = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Where the two halves of the corpus live, relative to the root. */
export const VECTORS = 'tests/vectors';
export const DRIVERS = 'tests/runtime';

/**
 * The runtime modules, in the order the catalogue lists them, each with the packages it
 * stands in for. Derived, so a rule added to the registry appears here without an edit.
 */
export const MODULES = Object.freeze(
  [...new Set(RULES.map((rule) => moduleOf(rule.subpath)))].map((name) => Object.freeze({
    name,
    subpath: `runtime/${name}`,
    packages: Object.freeze(RULES.filter((rule) => moduleOf(rule.subpath) === name).map((rule) => Object.freeze({
      name: rule.package,
      action: rule.action,
      weekly: rule.weekly,
    }))),
  })),
);

/** The module a source file reads, or null. A file may touch two runtime modules -- the
 * registry's own test does -- so this takes the first, and only files under tests/runtime
 * are ever asked, which keeps "tests the module" apart from "happens to use it". */
function moduleRead(source) {
  for (const found of findSpecifiers(source)) {
    const match = /(?:^|\/)runtime\/([a-z0-9-]+)\.mjs$/.exec(found.specifier);
    if (match !== null) return match[1];
  }
  return null;
}

/** Every case array in a vector file. One key today, and reading the file rather than
 * assuming means a vector file with no cases in it shows up as a nought instead of as
 * nothing at all. */
function casesIn(parsed) {
  return Array.isArray(parsed.cases) ? parsed.cases.length : 0;
}

/**
 * What is on disk, before anything is run.
 *
 * @param {{ root?: string, read?: (file: string) => string, list?: (dir: string) => string[] }} [options]
 */
export function conformancePlan(options = {}) {
  const root = options.root ?? SELF;
  const read = readerFrom(options);
  const list = options.list ?? ((dir) => [...walk(join(root, dir), { extensions: new Set(['.json', '.mjs']) })]
    .map((file) => displayPath(root, file)));

  const problems = [];
  const vectorFiles = list(VECTORS).filter((file) => file.endsWith('.json'));
  const driverFiles = list(DRIVERS).filter((file) => file.endsWith('.test.mjs'));

  /** @type {Map<string, { vectors: object[], drivers: string[] }>} */
  const byModule = new Map(MODULES.map((one) => [one.name, { vectors: [], drivers: [] }]));

  for (const file of vectorFiles) {
    const name = file.slice(VECTORS.length + 1, file.indexOf('/', VECTORS.length + 1));
    const bucket = byModule.get(name);
    if (bucket === undefined) continue; // vectors for the codemod layers, which `make test` covers
    try {
      bucket.vectors.push({ file, cases: casesIn(JSON.parse(read(join(root, file)))) });
    } catch (error) {
      problems.push(`${file} cannot be read: ${error.message}`);
    }
  }

  const strays = [];
  for (const file of driverFiles) {
    let name = null;
    try {
      name = moduleRead(read(join(root, file)));
    } catch (error) {
      problems.push(`${file} cannot be read: ${error.message}`);
      continue;
    }
    const bucket = name === null ? undefined : byModule.get(name);
    if (bucket === undefined) strays.push(file);
    else bucket.drivers.push(file);
  }

  const modules = MODULES.map((one) => {
    const bucket = byModule.get(one.name);
    return {
      ...one,
      vectors: bucket.vectors,
      drivers: bucket.drivers,
      cases: bucket.vectors.reduce((sum, vector) => sum + vector.cases, 0),
    };
  });

  return {
    root,
    // Not "did we find some files": a module with vectors and no driver has a corpus nobody
    // reads, which is the failure this whole file exists to make visible.
    present: modules.every((one) => one.drivers.length > 0),
    modules,
    strays,
    problems,
    totals: totalsOf(modules),
  };
}

/** What a set of modules adds up to. Counted twice in this file -- once for the whole plan
 * and once for the subset `--only` leaves -- and a second copy of the arithmetic is how a
 * filtered run ends up reporting the unfiltered corpus. */
function totalsOf(modules) {
  return Object.freeze({
    modules: modules.length,
    packages: modules.reduce((sum, one) => sum + one.packages.length, 0),
    vectors: modules.reduce((sum, one) => sum + one.vectors.length, 0),
    cases: modules.reduce((sum, one) => sum + one.cases, 0),
  });
}

/**
 * The plan narrowed to the modules asked for by name.
 *
 * @param {object} plan
 * @param {string[]} names
 * @returns {{ plan: object, unknown: string[] }}
 */
export function onlyModules(plan, names) {
  if (names.length === 0) return { plan, unknown: [] };
  const known = new Set(plan.modules.map((one) => one.name));
  const unknown = names.filter((name) => !known.has(name));
  const wanted = new Set(names);
  const modules = plan.modules.filter((one) => wanted.has(one.name));
  return {
    plan: {
      ...plan,
      modules,
      totals: totalsOf(modules),
    },
    unknown,
  };
}
