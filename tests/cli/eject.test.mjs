// `eject` as a binary, and then the copy it made, running on its own.
//
// The unit tests cover what eject decides. What only a child process and a real directory
// can show is the claim the command exists for: after `eject` and `apply`, a project whose
// imports named chalk and semver runs with nothing installed. Nothing to install, no
// nirdep on disk beside it, no node_modules at all.
//
// The last two tests load the ejected files by URL rather than by specifier. That is not
// squeamishness: tools/verify.mjs reads every .mjs file in this repository looking for
// import-shaped text, and a test that spelled the specifier out would be counted as a
// dependency of the project it is testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { findSpecifiers, isBuiltinSpecifier } from '../../src/audit/imports.mjs';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
const TREE = JSON.parse(readFileSync(new URL('../vectors/rules/tree.json', import.meta.url), 'utf8'));

function run(args = [], options = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1' };
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, cwd: options.cwd,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** An empty directory to eject into. */
const bare = () => mkdtempSync(join(tmpdir(), 'nirdep-eject-'));

/** The fixture project: imports chalk and semver, has no node_modules, cannot run. */
function plant() {
  const root = bare();
  for (const [path, text] of Object.entries(TREE.project)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

const at = (root, ...parts) => join(root, ...parts);

test('eject writes the runtime into a directory that was not there', () => {
  const root = bare();
  const { code, stdout, stderr } = run(['eject'], { cwd: root });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  for (const leaf of ['args.mjs', 'colour.mjs', 'semver.mjs']) {
    assert.equal(existsSync(at(root, 'nirdep', 'runtime', leaf)), true, `${leaf} is there`);
  }
  assert.match(stdout, /written {5}colour {2}nirdep\/runtime\/colour\.mjs/);
  assert.match(stdout, /next: nirdep apply --runtime nirdep\/runtime \./);
});

test('a second run writes nothing and says why, rather than churning the tree', () => {
  const root = bare();
  run(['eject', 'colour', '--into', 'lib'], { cwd: root });
  const first = readFileSync(at(root, 'lib', 'colour.mjs'), 'utf8');
  const { code, stdout } = run(['eject', 'colour', '--into', 'lib'], { cwd: root });
  assert.equal(code, 0, 're-running eject is free');
  assert.match(stdout, /up to date {2}colour/);
  assert.equal(readFileSync(at(root, 'lib', 'colour.mjs'), 'utf8'), first, 'and deterministic');
});

test('--dry-run leaves no directory behind at all', () => {
  const root = bare();
  const { code, stdout } = run(['eject', '--dry-run'], { cwd: root });
  assert.equal(code, 0);
  assert.match(stdout, /would add/);
  assert.match(stdout, /nothing was written: this was a dry run\./);
  assert.equal(existsSync(at(root, 'nirdep')), false, 'an empty directory is still a change');
});

test('an edited copy is refused, and --force is how you overrule that', () => {
  const root = bare();
  run(['eject', 'semver', '--into', 'lib'], { cwd: root });
  const mine = `${readFileSync(at(root, 'lib', 'semver.mjs'), 'utf8')}\n// my patch\n`;
  writeFileSync(at(root, 'lib', 'semver.mjs'), mine, 'utf8');
  const refused = run(['eject', 'semver', '--into', 'lib'], { cwd: root });
  assert.equal(refused.code, 2, 'the user has a decision to make, so it is their exit code');
  assert.match(refused.stdout, /refused {5}semver/);
  assert.equal(readFileSync(at(root, 'lib', 'semver.mjs'), 'utf8'), mine, 'the edit survived the refusal');
  const forced = run(['eject', 'semver', '--into', 'lib', '--force'], { cwd: root });
  assert.equal(forced.code, 0);
  assert.notEqual(readFileSync(at(root, 'lib', 'semver.mjs'), 'utf8'), mine);
});

test('a module that does not exist is a usage error with one suggestion', () => {
  const { code, stdout } = run(['eject', 'colours'], { cwd: bare() });
  assert.equal(code, 2);
  assert.match(stdout, /no such runtime module: colours {2}did you mean colour\?/);
  assert.match(stdout, /there are 4: args, colour, glob, semver/);
});

test('--list names the modules and what each one replaces', () => {
  const { code, stdout } = run(['eject', '--list']);
  assert.equal(code, 0);
  assert.match(stdout, /^runtime modules$/m);
  assert.match(stdout, /replaces minimist, commander, yargs/);
  assert.match(stdout, /replaces semver/);
});

test('an ejected module imports nothing but node builtins, and works', async () => {
  const root = bare();
  run(['eject', 'colour', 'semver', '--into', 'lib'], { cwd: root });

  // The dependency proof, applied to the file we just handed somebody else. If an ejected
  // module needed a package, eject would be moving the problem rather than solving it.
  for (const leaf of ['colour.mjs', 'semver.mjs']) {
    const text = readFileSync(at(root, 'lib', leaf), 'utf8');
    for (const found of findSpecifiers(text)) {
      assert.equal(isBuiltinSpecifier(found.specifier), true, `${leaf} reaches for ${found.specifier}`);
    }
  }

  // Loaded from a temporary directory with no package.json, no node_modules and no nirdep
  // anywhere above it. If the file only worked inside this repository, this is where that
  // would show.
  const colour = await import(pathToFileURL(at(root, 'lib', 'colour.mjs')).href);
  const painted = colour.createColour({ level: 3 }).red.bold('x');
  assert.notEqual(painted, 'x', 'level 3 paints');
  assert.equal(stripVTControlCharacters(painted), 'x', 'and closes what it opened');
  assert.equal(colour.createColour({ level: 0 }).red('x'), 'x');

  const semver = await import(pathToFileURL(at(root, 'lib', 'semver.mjs')).href);
  assert.equal(semver.satisfies('1.2.3', '^1.0.0'), true);
  assert.equal(semver.satisfies('1.2.3-beta', '>=1.0.0'), false, 'the prerelease rule came with it');
});

test('eject then apply makes a project run with nothing installed', async () => {
  // Two copies of the same fixture, because a failed dynamic import is cached by URL: the
  // "before" check would poison the "after" one if both loaded the same path.
  const doomed = plant();
  await assert.rejects(() => import(pathToFileURL(at(doomed, 'src', 'report.mjs')).href), /Cannot find package/);

  const root = plant();
  assert.equal(run(['eject', '--into', 'vendor'], { cwd: root }).code, 0);
  const applied = run(['apply', '--runtime', 'vendor', '--no-diff', root], { cwd: root });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /written {6}src\/report\.mjs/);

  // After: the same file, the same exported function, no packages and no nirdep in sight.
  const report = await import(pathToFileURL(at(root, 'src', 'report.mjs')).href);
  assert.equal(stripVTControlCharacters(report.ok('1.2.3')), 'yes');
  assert.equal(stripVTControlCharacters(report.ok('0.9.0')), 'no');
});

test('eject documents itself as a finished command', () => {
  const { stdout } = run(['eject', '--help']);
  assert.match(stdout, /copy a runtime module into your own tree, no package required/);
  assert.match(stdout, /\[module\.\.\.\] {2}which modules to copy \(default: all of them\)/);
  assert.match(stdout, /--into <string> {2}directory to write into, relative to here/);
  assert.match(stdout, /--force/);
  assert.match(run(['help']).stdout, /\n {2}eject {2,}copy a runtime module/);
});
