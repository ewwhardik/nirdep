// `stdlibmd` against a real project, which is the only way to test a command that reads a
// tree and writes a file into it.
//
// The unit tests decide what the document says. What only a child process can show is the
// part a person actually does: print it, read it, write it, run it again, and find that the
// second run did not quietly replace the paragraphs they wrote in between.
//
// The fixture is the guard vector, for the reason that file gives: a real specifier in a
// .mjs file under tests/ is a third-party dependency as far as tools/verify.mjs can tell, so
// planted projects live in JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from './environment.mjs';

const BIN = fileURLToPath(new URL('../../bin/nirdep.mjs', import.meta.url));
const VECTOR = JSON.parse(readFileSync(new URL('../vectors/guard/project.json', import.meta.url), 'utf8'));

function run(args = [], env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment({ NO_COLOR: '1', ...env }),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Whitespace-collapsed, so a folded sentence can be asserted as a sentence. */
const flat = (text) => text.replace(/\s+/g, ' ');

/** chalk declared, installed and imported; minimist dev-only; a semver in the lockfile that
 * nobody asked for. Two replaceable dependencies and no third-party remainder. */
function plant() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-stdlibmd-'));
  for (const [path, text] of Object.entries(VECTOR.project)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

test('by default it prints the document and touches nothing', () => {
  const root = plant();
  const { code, stdout, stderr } = run(['stdlibmd', root]);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^# STDLIB\.md — painted$/m);
  assert.match(flat(stdout), /painted declares 2 direct dependencies\. 2 of them are packages nirdep replaces with a standard-library module, and removing them takes 2 of the 3 installed packages out of the tree/);
  assert.match(stdout, /^\| `chalk` \| 319\.8M \| `nirdep\/runtime\/colour` \| codemod \| 1 in 1 file \|$/m);
  assert.equal(existsSync(join(root, 'STDLIB.md')), false, 'a command that prints is a command you can run on somebody else repo');
  // Piped, it is a markdown file. Styling it would make a document nobody can commit.
  const painted = run(['stdlibmd', root], { NO_COLOR: undefined, FORCE_COLOR: '3' });
  assert.equal(painted.stdout, stdout);
});

test('--write puts the same bytes on disk, and says what it logged', () => {
  const root = plant();
  const printed = run(['stdlibmd', root]).stdout;
  const { code, stdout } = run(['stdlibmd', '--write', root]);
  assert.equal(code, 0);
  assert.match(stdout, /^ {2}written {6}STDLIB\.md {2}\d+ lines, \d+ bytes$/m);
  assert.match(flat(stdout), /2 packages logged as replaced across 2 runtime modules, and 0 dependencies left in place/);
  assert.match(flat(stdout), /The tables are derived and will be right\. The prose is not written/);
  // The file is the document, byte for byte: what was shown is what got written.
  assert.equal(readFileSync(join(root, 'STDLIB.md'), 'utf8'), printed);
  assert.equal(stdout.includes('# STDLIB.md'), false, 'the page is the receipt, not a second copy of the file');
});

test('running it twice is free, which is what makes it safe in a script', () => {
  const root = plant();
  run(['stdlibmd', '--write', root]);
  const again = run(['stdlibmd', '--write', root]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /^ {2}up to date {3}STDLIB\.md$/m);
});

test('a document somebody has finished by hand is not ours to replace', () => {
  const root = plant();
  const file = join(root, 'STDLIB.md');
  run(['stdlibmd', '--write', root]);
  const mine = `${readFileSync(file, 'utf8')}\n## Why chalk\n\nBecause I like colours.\n`;
  writeFileSync(file, mine, 'utf8');

  const refused = run(['stdlibmd', '--write', root]);
  assert.equal(refused.code, 2, 'the user resolves this one, so it is not a 1');
  assert.match(refused.stdout, /^ {2}refused {6}STDLIB\.md {2}\d+ lines, \d+ bytes$/m);
  assert.match(refused.stdout, /it is there and says something else; --force to replace it/);
  assert.equal(readFileSync(file, 'utf8'), mine, 'the paragraph they wrote is still there');

  const forced = run(['stdlibmd', '--write', '--force', root]);
  assert.equal(forced.code, 0);
  assert.match(forced.stdout, /^ {2}written {6}STDLIB\.md/m);
  assert.equal(readFileSync(file, 'utf8').includes('Because I like colours'), false);
});

test('--dry-run and --out are about the file, and neither of them invents a directory', () => {
  const root = plant();
  const dry = run(['stdlibmd', '--write', '--dry-run', '--out', 'docs/STDLIB.md', root]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /^ {2}would write {2}docs\/STDLIB\.md {2}\d+ lines, \d+ bytes$/m);
  assert.match(dry.stdout, /^nothing was written: this was a dry run\.$/m);
  assert.equal(existsSync(join(root, 'docs')), false, 'a dry run that leaves a directory behind has written to the tree');

  const wet = run(['stdlibmd', '--write', '--out', 'docs/STDLIB.md', root]);
  assert.equal(wet.code, 0);
  assert.match(wet.stdout, /^ {2}written {6}docs\/STDLIB\.md/m);
  assert.match(readFileSync(join(root, 'docs/STDLIB.md'), 'utf8'), /^# STDLIB\.md — painted$/m);
  assert.equal(existsSync(join(root, 'STDLIB.md')), false, 'the default is a default, not a second write');
});

test('a directory that is not there is a usage error, not an empty document', () => {
  const { code, stdout, stderr } = run(['stdlibmd', join(plant(), 'nope')]);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^nirdep: stdlibmd: cannot read .*nope: there is nothing there\.$/m);
});

test('after the migration the document logs the copy in the tree, not the package', () => {
  // The sequence this command exists for, run end to end: take the runtime, point the
  // imports at it, then generate the write-up. The document has to survive the packages
  // being gone -- at that point an import is the only evidence left that anything happened.
  const root = plant();
  // eject writes relative to where it was run, so this one needs a cwd rather than a path.
  const ejected = execFileSync(process.execPath, [BIN, 'eject', '--into', 'vendor'], {
    cwd: root, encoding: 'utf8', env: childEnvironment({ NO_COLOR: '1' }),
  });
  assert.match(ejected, /next: nirdep apply --runtime vendor \./);
  assert.equal(run(['apply', '--runtime', 'vendor', '--no-diff', root]).code, 0);

  const { code, stdout } = run(['stdlibmd', root]);
  assert.equal(code, 0);
  assert.match(flat(stdout), /In this project the replacement is a copy in the tree rather than a package, imported from 1 file, 1 site\./);
  // minimist is an advise rule, so nothing rewrote it and there is nothing to claim.
  const args = stdout.slice(stdout.indexOf('### runtime/args'));
  assert.equal(/In this project the replacement/.test(args), false);
});

test('it documents itself, and no command is pending any more', () => {
  const { code, stdout } = run(['stdlibmd', '--help']);
  assert.equal(code, 0);
  assert.match(flat(stdout), /--write .*write the file instead of printing it/);
  assert.match(flat(stdout), /--out <string> .*file to write, relative to the project \[default "STDLIB\.md"\]/);
  assert.match(flat(stdout), /--force .*replace a file that says something else/);
  assert.match(flat(stdout), /--dry-run .*say what would be written and write nothing/);
  assert.equal(/\(pending\)/.test(stdout), false);

  // And the command list itself, which used to carry a row that exited 3 and did nothing.
  const all = run(['help']);
  assert.match(flat(all.stdout), /stdlibmd generate the target project's STDLIB\.md from its own dependencies/);
  assert.equal(/\(pending\)/.test(all.stdout), false);
  assert.match(all.stdout, /^Every command above is implemented\./m);
});
