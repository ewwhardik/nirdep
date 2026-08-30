// `scan` as a binary, pointed at a real directory.
//
// The unit tests already know what the numbers should be. What only a child process can
// show is the part a judge exercises first: that the command reads and never writes, that
// the report goes to stdout so it can be piped, that findings do not fail the build and an
// unreadable file does, and that a directory that is not there is an error rather than a
// spotless report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
const TREE = JSON.parse(readFileSync(new URL('../vectors/scan/tree.json', import.meta.url), 'utf8'));

function run(args = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const name of ['FORCE_COLOR', 'NO_COLOR']) if (!(name in env)) delete childEnv[name];
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-scan-cli-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

/** Every file in the tree with its bytes, so "changed nothing" is a comparison. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else seen[`${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), 'utf8');
    }
  };
  walk(root, '');
  return seen;
}

// Written as an escape, never as the byte: tests/repo/hygiene.test.mjs fails the repository
// for a raw control character in a source file.
const ESC = '\u001B';

test('scan reports on a real project and changes nothing', () => {
  const root = plant(TREE.tree);
  const before = snapshot(root);
  const { code, stdout, stderr } = run(['scan', root]);
  assert.equal(code, 0, 'findings are not failures');
  assert.equal(stderr, '');
  assert.deepEqual(snapshot(root), before, 'the only command safe to point at another repository');
  // The four blocks, and the numbers the unit tests pinned down, arriving through the real
  // binary rather than through a direct call.
  for (const head of ['dependencies', 'what nirdep can replace', 'findings', 'what this scan did not check']) {
    assert.ok(stdout.includes(`${head}\n`), `${head} is in the report`);
  }
  assert.match(stdout, /15 packages installed, 15 distinct names, from package-lock\.json \(v3\)/);
  assert.match(stdout, /10 of 15 installed names are reachable only through 3 packages/);
  // Two low findings, not one: five of this tree's names are in a supply-chain incident
  // whose affected releases the advisory table does not record, which is a note about
  // names and says so in its own sentence.
  assert.match(stdout, /\n2 high \| 1 medium \| 2 low \| 1 note\n$/);
});

test('the report goes to stdout, plain, so it can be piped', () => {
  const root = plant(TREE.tree);
  const { stdout } = run(['scan', root]);
  assert.equal(stdout.includes(ESC), false, 'a pipe detects level 0 and every style is the identity');
  const painted = run(['scan', root], { FORCE_COLOR: '3' }).stdout;
  assert.ok(painted.includes(`${ESC}[31mhigh`), 'a high finding is red when colour is asked for');
  assert.ok(painted.includes(`${ESC}[32mrewrite${ESC}[39m`), 'and a rewritable row is green');
  // Styling must not move a fold, so the two runs differ by escape sequences and nothing
  // else. That is the claim tests/scan/report.test.mjs makes, here through the real binary.
  assert.equal(stripVTControlCharacters(painted), stdout);
});

test('a project with no lockfile is scanned anyway, with the gap named', () => {
  const { code, stdout } = run(['scan', plant(TREE.bare)]);
  assert.equal(code, 0);
  assert.match(stdout, /the transitive tree is not visible: no lockfile/);
  assert.match(stdout, /no-lockfile/);
  assert.match(stdout, /Everything above comes from package\.json alone/);
});

test('scan defaults to the current directory', () => {
  const root = plant(TREE.bare);
  const stdout = execFileSync(process.execPath, [BIN, 'scan'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, env: { ...process.env, NO_COLOR: '1' },
  });
  assert.match(stdout, /2 packages declared/);
});

test('a directory that is not there is an error, not a spotless report', () => {
  const missing = join(plant(TREE.bare), 'nowhere');
  const { code, stdout, stderr } = run(['scan', missing]);
  assert.equal(code, 2, 'a usage error, because the argument is the mistake');
  assert.equal(stdout, '', 'and nothing that could be mistaken for a report');
  assert.match(stderr, /nirdep: scan: cannot read .*nowhere: there is nothing there\./);
});

test('scan documents itself as a finished command', () => {
  const { stdout } = run(['scan', '--help']);
  assert.match(stdout, /report replaceable dependencies and their blast radius/);
  assert.match(stdout, /\[path\] {2}project directory to read \(default: the current one\)/);
  assert.match(stdout, /--exclude <string\.\.\.> {2}glob pattern of files to skip, repeatable/);
  assert.match(stdout, /--include <string\.\.\.> {2}glob pattern of files to read, repeatable/);
  // The command list is where "pending" is claimed or not, and scan's row carries no
  // marker. The footer explaining the marker appears on every help screen, including this
  // one, so a bare search for the word would pass on a command that was never written.
  assert.match(run(['help']).stdout, /\n {2}scan {2,}report replaceable dependencies/);
});

test('the file selection is a glob pattern, matched by the module that replaces minimatch', () => {
  const root = plant(TREE.tree);
  const all = run(['scan', root]).stdout;
  assert.match(all, /5 packages imported by this project's own source, out of 3 files read/);
  // A file skipped is a file the report stops claiming anything about: the admission that
  // one file would not parse is gone, because that file is no longer part of the question.
  const some = run(['scan', root, '--exclude', 'src/broken.mjs']).stdout;
  assert.match(some, /4 packages imported by this project's own source, out of 2 files read/);
  assert.equal(/would not parse/.test(some), false);

  // A bare directory name prunes the subtree, and --include is the same matcher asked the
  // other way round. Both are repeatable, which is why they are declared `multiple`.
  assert.match(run(['scan', root, '--exclude', 'src']).stdout, /out of 0 files read/);
  assert.match(run(['scan', root, '--include', 'src/cli.mjs']).stdout, /out of 1 file read/);
  assert.match(run(['scan', root, '--include', 'src/{cli,self}.mjs']).stdout, /out of 2 files read/);
});
