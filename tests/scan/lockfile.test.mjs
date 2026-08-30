// The lockfile readers, driven from text rather than from a package manager.
//
// Every fixture is a string in tests/vectors/scan/locks.json, so the suite needs no
// network, no node_modules and no npm on the path -- which is the same reason the reader
// exists. The `read` hook is injected, so nothing here touches a real file either.
//
// The assertions worth having are the ones about disagreement: that a name-level count is
// not an entry count, that a peer suffix does not become a second package, and that a
// format the reader does not understand says so in `understood` instead of returning a
// confident zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCKFILES, SOURCE, descriptorName, findLock, placeToName, pnpmKey, readLock, resolutionSource, sourceOf,
} from '../../src/scan/lockfile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCKS = JSON.parse(readFileSync(join(HERE, '..', 'vectors', 'scan', 'locks.json'), 'utf8'));

/** A reader that knows about exactly the files named, and ENOENTs on everything else. */
function reader(files) {
  return (path) => {
    const name = path.split(/[\\/]/).pop();
    if (Object.prototype.hasOwnProperty.call(files, name)) return files[name];
    const error = new Error(`ENOENT: no such file, open '${path}'`);
    error.code = 'ENOENT';
    throw error;
  };
}

const lockOf = (files) => readLock('/project', { read: reader(files) });
const named = (lock, name) => lock.packages.filter((one) => one.name === name);
const one = (lock, name) => {
  const list = named(lock, name);
  assert.equal(list.length, 1, `expected exactly one ${name}`);
  return list[0];
};

test('a resolution says where a package came from', () => {
  assert.equal(sourceOf('https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz'), SOURCE.REGISTRY);
  assert.equal(sourceOf('https://npm.internal.example.com/chalk/-/chalk-4.1.2.tgz'), SOURCE.REGISTRY);
  assert.equal(sourceOf('https://example.com/tarballs/thing-1.0.0.tar.gz'), SOURCE.HTTP);
  assert.equal(sourceOf('git+ssh://git@github.com/a/b.git#abc'), SOURCE.GIT);
  assert.equal(sourceOf('git://github.com/a/b.git'), SOURCE.GIT);
  assert.equal(sourceOf('https://example.com/a/b#commit=abc'), SOURCE.GIT);
  assert.equal(sourceOf('file:../local'), SOURCE.FILE);
  assert.equal(sourceOf('link:../local'), SOURCE.LINK);
  assert.equal(sourceOf(null), SOURCE.UNKNOWN);
  assert.equal(sourceOf(''), SOURCE.UNKNOWN);
  assert.equal(sourceOf('who knows'), SOURCE.UNKNOWN);
  // yarn classic appends the tarball's sha1 as a fragment; the shape check runs on the
  // URL, not on the fragment, or every yarn entry would look like an unknown source.
  assert.equal(sourceOf('https://registry.yarnpkg.com/chalk/-/chalk-4.1.2.tgz#abc'), SOURCE.REGISTRY);
});

test("a berry resolution is a descriptor, not a URL", () => {
  assert.equal(resolutionSource('chalk@npm:4.1.2'), SOURCE.REGISTRY);
  assert.equal(resolutionSource('demo@workspace:.'), SOURCE.LINK);
  assert.equal(resolutionSource('thing@file:./vendor/thing'), SOURCE.FILE);
  assert.equal(resolutionSource('thing@portal:../thing'), SOURCE.FILE);
  assert.equal(resolutionSource('thing@git@github.com:a/b.git'), SOURCE.GIT);
  assert.equal(resolutionSource('chalk@patch:chalk@4.1.2#./p.patch'), SOURCE.GIT);
  assert.equal(resolutionSource('https://example.com/a.tar.gz'), SOURCE.HTTP);
  assert.equal(resolutionSource('thing@unheard-of:x'), SOURCE.UNKNOWN);
});

test('an install path gives up a name and a depth', () => {
  assert.deepEqual(placeToName('node_modules/chalk'), { name: 'chalk', depth: 1, workspace: false });
  assert.deepEqual(placeToName('node_modules/@scope/a'), { name: '@scope/a', depth: 1, workspace: false });
  assert.deepEqual(placeToName('node_modules/a/node_modules/b'), { name: 'b', depth: 2, workspace: false });
  assert.deepEqual(placeToName('node_modules/a/node_modules/b/node_modules/c'),
    { name: 'c', depth: 3, workspace: false });
  // No node_modules segment at all is a directory in this repository, not an install.
  assert.deepEqual(placeToName('packages/inner'), { name: 'packages/inner', depth: 0, workspace: true });
});

test('a descriptor keeps the @ of its scope', () => {
  assert.equal(descriptorName('chalk@^4.1.2'), 'chalk');
  assert.equal(descriptorName('"chalk@npm:^4.1.2"'), 'chalk');
  assert.equal(descriptorName('@scope/a@1.0.0'), '@scope/a');
  assert.equal(descriptorName('@scope/a'), '@scope/a');
  assert.equal(descriptorName('chalk'), 'chalk');
});

test('a pnpm key parses across four lockfile generations', () => {
  assert.deepEqual(pnpmKey('/chalk/4.1.2'), { name: 'chalk', version: '4.1.2' });
  assert.deepEqual(pnpmKey('/chalk@5.3.0'), { name: 'chalk', version: '5.3.0' });
  assert.deepEqual(pnpmKey('chalk@5.6.2'), { name: 'chalk', version: '5.6.2' });
  assert.deepEqual(pnpmKey('/@scope/a/1.0.0'), { name: '@scope/a', version: '1.0.0' });
  assert.deepEqual(pnpmKey('@scope/a@1.0.0'), { name: '@scope/a', version: '1.0.0' });
  // A peer suffix, either spelling, is not a different package.
  assert.deepEqual(pnpmKey('react-dom@18.2.0(react@18.2.0)'), { name: 'react-dom', version: '18.2.0' });
  assert.deepEqual(pnpmKey('/react-dom/18.2.0_react@18.2.0'), { name: 'react-dom', version: '18.2.0' });
  assert.deepEqual(pnpmKey('  chalk@5.6.2:  '), { name: 'chalk', version: '5.6.2' });
  // A name with an underscore in it is not a peer suffix: lodash._basecopy shipped.
  assert.deepEqual(pnpmKey('/lodash._basecopy/4.5.1'), { name: 'lodash._basecopy', version: '4.5.1' });
  assert.deepEqual(pnpmKey('/react-dom/18.2.0_abc123'), { name: 'react-dom', version: '18.2.0' });
  // Keys with no version in them at all, which pnpm does write.
  assert.deepEqual(pnpmKey('mystery'), { name: 'mystery', version: null });
  assert.deepEqual(pnpmKey('file:../lib'), { name: 'file:../lib', version: null });
  assert.deepEqual(pnpmKey('@scope/only'), { name: '@scope/only', version: null });
});

test('the first lockfile in LOCKFILES order wins', () => {
  const both = { 'package-lock.json': LOCKS.npm3, 'yarn.lock': LOCKS.yarnClassic };
  assert.equal(findLock('/project', { read: reader(both) }).file, 'package-lock.json');
  assert.equal(findLock('/project', { read: reader({ 'yarn.lock': LOCKS.yarnClassic }) }).kind, 'yarn');
  assert.deepEqual(findLock('/project', { read: reader({}) }), { kind: 'none', file: null, text: null });
  // Order is a claim about which reader records the most, so it is worth pinning down.
  assert.deepEqual(LOCKFILES.map((entry) => entry.file), [
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  ]);
});

test('npm lockfileVersion 3 is read in full', () => {
  const lock = lockOf({ 'package-lock.json': LOCKS.npm3 });
  assert.equal(lock.kind, 'npm');
  assert.equal(lock.version, 3);
  assert.equal(lock.understood, true);
  // Eleven package entries, minus the root key and minus the workspace directory.
  assert.equal(lock.count, 10);
  assert.equal(lock.names, 10);
  assert.deepEqual([...lock.roots].sort(), ['chalk', 'minimist', 'rimraf']);

  const chalk = one(lock, 'chalk');
  assert.equal(chalk.version, '4.1.2');
  assert.equal(chalk.source, SOURCE.REGISTRY);
  assert.deepEqual(chalk.requires, ['ansi-styles']);
  assert.equal(chalk.dev, false);
  assert.equal(chalk.depth, 1);

  const rimraf = one(lock, 'rimraf');
  assert.equal(rimraf.dev, true);
  assert.match(rimraf.deprecated, /no longer supported/);
  assert.equal(rimraf.hasBin, true, 'npm 9 writes a bin map');
  assert.equal(one(lock, 'glob').hasBin, true, 'npm 7 wrote hasBin instead');

  assert.equal(one(lock, 'node-sass').installScript, true);
  assert.equal(one(lock, 'node-sass').engines, '>=8');
  assert.equal(one(lock, 'minimist').integrity, null, 'recorded without a hash');
  assert.equal(one(lock, 'left-pad').source, SOURCE.GIT);
  assert.equal(one(lock, 'tar-thing').source, SOURCE.HTTP);
  assert.equal(one(lock, 'linked').source, SOURCE.LINK, 'link: true beats whatever resolved says');
  assert.equal(lock.packages.some((entry) => entry.name === 'packages/inner'), false, 'a workspace is not an install');
});

test('npm lockfileVersion 1 is a nested tree with two findings missing', () => {
  const lock = lockOf({ 'npm-shrinkwrap.json': LOCKS.npm1 });
  assert.equal(lock.kind, 'npm');
  assert.equal(lock.version, 1);
  assert.equal(lock.file, 'npm-shrinkwrap.json');
  assert.equal(lock.count, 3);
  assert.deepEqual([...lock.roots].sort(), ['ansi-styles', 'chalk']);
  assert.deepEqual(one(lock, 'chalk').requires, ['ansi-styles']);
  // The nested copy keeps its depth, which is the one thing this format says clearly.
  assert.equal(one(lock, 'color-convert').depth, 2);
  assert.equal(one(lock, 'color-convert').place, 'node_modules/ansi-styles/node_modules/color-convert');
  assert.equal(one(lock, 'chalk').installScript, false);
  assert.equal(one(lock, 'chalk').deprecated, null);
  assert.match(lock.note, /records neither install scripts nor deprecations/);
});

test('a lockfile that will not parse is reported, not guessed at', () => {
  const lock = lockOf({ 'package-lock.json': LOCKS.broken });
  assert.equal(lock.kind, 'npm');
  assert.equal(lock.understood, false);
  assert.equal(lock.count, 0);
  assert.equal(lock.names, 0);
  assert.match(lock.note, /package-lock\.json could not be read:/);
});

test('yarn classic gives up its edges and no dev flags', () => {
  const lock = lockOf({ 'yarn.lock': LOCKS.yarnClassic });
  assert.equal(lock.kind, 'yarn');
  assert.equal(lock.version, 1);
  assert.equal(lock.understood, true);
  assert.equal(lock.count, 3);
  assert.deepEqual(one(lock, 'chalk').requires, ['ansi-styles', 'supports-color']);
  assert.equal(one(lock, 'chalk').integrity, 'sha512-aaa');
  assert.equal(one(lock, 'chalk').source, SOURCE.REGISTRY);
  assert.equal(one(lock, 'left-pad').source, SOURCE.HTTP, 'a codeload tarball is not a registry');
  // The absence that matters: yarn names no direct dependencies, so the caller must
  // fall back to the manifest rather than believe an empty set.
  assert.equal(lock.roots.size, 0);
  assert.match(lock.note, /no list of direct dependencies/);
});

test('yarn berry reads its descriptors and skips its own workspace', () => {
  const lock = lockOf({ 'yarn.lock': LOCKS.yarnBerry });
  assert.equal(lock.version, 6);
  assert.equal(lock.count, 2, 'the repository itself is not one of its own packages');
  assert.equal(one(lock, 'chalk').version, '4.1.2');
  assert.equal(one(lock, 'chalk').source, SOURCE.REGISTRY);
  assert.equal(one(lock, 'chalk').integrity, '10c0/abc', 'berry spells it checksum');
  assert.deepEqual(one(lock, 'chalk').requires, ['ansi-styles']);
  assert.equal(one(lock, '@scope/thing').version, '1.0.0');
});

test('pnpm 9 reads importers for roots and snapshots for edges', () => {
  const lock = lockOf({ 'pnpm-lock.yaml': LOCKS.pnpm9 });
  assert.equal(lock.kind, 'pnpm');
  assert.equal(lock.version, 9);
  assert.equal(lock.count, 3);
  assert.deepEqual([...lock.roots].sort(), ['chalk', 'semver']);
  assert.equal(one(lock, 'chalk').integrity, 'sha512-aaa');
  assert.equal(one(lock, 'chalk').source, SOURCE.REGISTRY);
  assert.match(one(lock, 'chalk').engines, /\^12\.17\.0/);
  assert.equal(one(lock, 'semver').hasBin, true);
  // The edges live in a second section on this generation, keyed the same way, which is
  // the whole reason entries are merged by name and version rather than appended.
  assert.deepEqual(one(lock, 'semver').requires, ['lru-cache']);
  assert.match(lock.note, /requiresBuild/);
});

test('pnpm 5.4 keys its packages differently and does record install scripts', () => {
  const lock = lockOf({ 'pnpm-lock.yaml': LOCKS.pnpm5 });
  assert.equal(lock.version, 5.4);
  assert.equal(lock.count, 4);
  assert.deepEqual([...lock.roots].sort(), ['chalk', 'node-sass']);
  assert.deepEqual(one(lock, 'chalk').requires, ['ansi-styles']);
  assert.equal(one(lock, 'node-sass').installScript, true, 'requiresBuild is pnpm 6 and 7 for hasInstallScript');
  assert.equal(one(lock, 'node-sass').dev, true);
  assert.match(one(lock, 'node-sass').deprecated, /no longer supported/);
  assert.equal(named(lock, 'react-dom').length, 1, 'a peer suffix is not a second package');
});

test('bun and no lockfile both admit the tree is invisible', () => {
  const bun = lockOf({ 'bun.lockb': 'binary bytes would be here' });
  assert.equal(bun.kind, 'bun');
  assert.equal(bun.understood, false);
  assert.equal(bun.count, 0);
  assert.match(bun.note, /will not run/);

  const none = lockOf({});
  assert.equal(none.kind, 'none');
  assert.equal(none.file, null);
  assert.equal(none.understood, false);
  assert.equal(none.roots.size, 0);
  assert.match(none.note, /transitive tree is invisible/);
});

test('every reader returns the same shape, so the caller has no special cases', () => {
  const shapes = [
    lockOf({ 'package-lock.json': LOCKS.npm3 }),
    lockOf({ 'yarn.lock': LOCKS.yarnBerry }),
    lockOf({ 'pnpm-lock.yaml': LOCKS.pnpm9 }),
    lockOf({}),
  ];
  for (const lock of shapes) {
    assert.deepEqual(Object.keys(lock).sort(), [
      'byName', 'count', 'file', 'kind', 'names', 'note', 'packages', 'roots', 'understood', 'version',
    ]);
    assert.equal(Object.isFrozen(lock), true);
    assert.equal(lock.count, lock.packages.length);
    assert.equal(lock.names, lock.byName.size);
    for (const entry of lock.packages) {
      assert.equal(Object.isFrozen(entry), true);
      assert.deepEqual(Object.keys(entry).sort(), [
        'deprecated', 'depth', 'dev', 'engines', 'hasBin', 'installScript', 'integrity',
        'name', 'optional', 'peer', 'place', 'requires', 'resolved', 'source', 'version',
      ]);
    }
  }
});
