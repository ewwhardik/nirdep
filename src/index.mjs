// The package entry point, which exists because `exports["."]` in package.json
// promises it. It is a re-export surface and nothing else: no side effects, no
// process access, no work done at import time, so that `import 'nirdep'` in a
// build script costs three module loads and changes nothing about the process.
//
// The runtime modules are namespaced rather than flattened. `colour.red` and
// `semver.major` collide with nothing, whereas a flat surface would put `parse`
// (args), `parse` (semver) and `parse` (toml) in the same bag. Anyone who wants a
// bare name should import the subpath — `nirdep/runtime/semver` — which is also
// the import `nirdep eject` rewrites, and which loads that module alone.

export * as colour from './runtime/colour.mjs';
export * as args from './runtime/args.mjs';
export * as semver from './runtime/semver.mjs';
export * as glob from './runtime/glob.mjs';
export * as collect from './runtime/collect.mjs';

export { default as colourDefault } from './runtime/colour.mjs';
export { default as semverDefault } from './runtime/semver.mjs';
export { default as globDefault } from './runtime/glob.mjs';
export { default as collectDefault } from './runtime/collect.mjs';

/** Attribution, kept here so a consumer can print it without reading our manifest. */
export const ABOUT = Object.freeze({
  name: 'nirdep',
  publisher: 'Nastik AI',
  developer: 'Hardik',
  licence: 'MIT',
  runtime: Object.freeze(['runtime/colour', 'runtime/args', 'runtime/semver', 'runtime/glob',
    'runtime/collect']),
});
