// The four lines a build log should contain, and the two states they get read in.
//
// A green report is never read. A red one is read in a hurry by somebody who wants the
// package, the file, the line and the command, and nothing else. So the assertions here are
// about what is on the page and where: a sentence that has moved into a footnote has failed
// even if every word of it is still true.
//
// The scan is stubbed for the reason tests/guard/project.test.mjs gives. Prose is folded at
// 80 columns, so a sentence assertion reads through `flat` and a layout assertion matches on
// `^` with the `m` flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardProject } from '../../src/guard/project.mjs';
import { POLICY_FILE, SIGNAL } from '../../src/guard/policy.mjs';
import { guardReport } from '../../src/guard/report.mjs';

/** Whitespace-collapsed, so a folded sentence can be asserted as a sentence. */
const flat = (text) => text.replace(/\s+/g, ' ');

const ENOENT = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };

function scanOf(packages, extra = {}) {
  const dependencies = new Set();
  const development = new Set();
  const ranges = new Map();
  const byName = new Map();
  const source = [];
  for (const [name, state] of Object.entries(packages)) {
    if (state.declared !== undefined) {
      dependencies.add(name);
      ranges.set(name, state.declared);
      if (state.dev === true) development.add(name);
    }
    if (state.installed !== undefined) byName.set(name, state.installed.map((version) => ({ name, version })));
    if (state.sites !== undefined) {
      source.push({ name, files: [...new Set(state.sites.map((one) => one.path))], sites: state.sites });
    }
  }
  return {
    manifest: { name: 'demo', dependencies, development, ranges },
    lock: { kind: extra.kind ?? 'npm', understood: extra.understood ?? true, note: extra.note ?? null, byName },
    source: { counts: { scanned: extra.scanned ?? 12, opened: 2, lexed: 2 }, unparsed: [], packages: source },
    counts: { direct: extra.direct ?? dependencies.size },
  };
}

const site = (path, line) => ({ path, line, specifier: 'chalk', form: 'default' });

/** A rendered page, from a stubbed scan and either a policy file or none. */
function page(packages, { policy, overrides, ...extra } = {}) {
  const result = guardProject('/demo', {
    scan: scanOf(packages, extra),
    read: policy === undefined ? ENOENT : () => JSON.stringify(policy),
    overrides,
  });
  return guardReport(result);
}

test('a breach gets the package, the presence, the first line and the command', () => {
  const text = page({ chalk: { declared: '^5.3.0', installed: ['5.3.0'], sites: [site('src/a.mjs', 1), site('src/b.mjs', 9)] } });
  assert.match(text, /^1 package came back$/m);
  assert.match(text, /^ {2}chalk {9}declared \^5\.3\.0 {2}installed 5\.3\.0 {2}imported 2 sites in 2 files$/m);
  assert.match(text, /^ {16}first at src\/a\.mjs:1$/m);
  // Where it goes and who moves it, packed onto one line while they fit. The pair is two
  // segments rather than one sentence so that a wide name column splits them instead of
  // running the row off the side of the terminal.
  assert.match(text, /^ {16}-> nirdep\/runtime\/colour {2}rewrite it: nirdep plan \.$/m);
  assert.match(text, /^FAIL: 1 of 8 watched packages present\.$/m);
});

test('a package that has to be moved by hand is sent to explain, not to plan', () => {
  const text = page({ minimist: { declared: '^1.2.8', dev: true } });
  assert.match(text, /declared \^1\.2\.8 \(dev\)/, 'development is marked, because it changes what to do');
  assert.match(text, /^ {16}-> nirdep\/runtime\/args {2}by hand: nirdep explain minimist$/m);
  assert.equal(/nirdep plan/.test(text), false);
});

test('a denied package we do not replace is told the truth about it', () => {
  const text = page({ 'left-pad': { declared: '^1.3.0' } }, { policy: { guard: { deny: ['left-pad'] } } });
  assert.match(text, /denied by this policy, and not a package nirdep replaces/);
  assert.equal(/->/.test(text), false, 'no arrow, because there is nowhere to point it');
});

test('a signal the policy is not watching is printed dim rather than dropped', () => {
  const text = page(
    { chalk: { declared: '^5.3.0', installed: ['5.3.0'], sites: [site('src/a.mjs', 3)] } },
    { policy: { guard: { signals: [SIGNAL.IMPORTED] } } },
  );
  assert.match(text, /^ {2}chalk {9}imported 1 site in 1 file$/m);
  assert.match(text, /also declared and installed, which this policy does not watch/);
});

test('a green report counts what it watched without contradicting the block below it', () => {
  const clean = page({});
  assert.match(clean, /^nothing came back$/m);
  assert.match(clean, /^ {2}none of the 8 watched packages is declared, installed or imported$/m);
  assert.match(clean, /^PASS: 8 packages watched, nothing to report\.$/m);

  const allowed = page(
    { chalk: { declared: '^5.3.0', sites: [site('src/a.mjs', 1)] } },
    { policy: { guard: { allow: { chalk: 'DEP-14, the logo needs 256 colours' } } } },
  );
  assert.match(allowed, /^ {2}none of the other 7 watched packages is declared, installed or imported$/m);
  assert.match(allowed, /^allowed by policy$/m);
  assert.match(allowed, /^ {16}DEP-14, the logo needs 256 colours$/m);
  assert.match(allowed, /^PASS: 8 packages watched, 1 allowed by name, nothing to report\.$/m);
});

test('an exemption with no reason beside it says that, rather than nothing', () => {
  const text = page({ chalk: { declared: '^5.3.0' } }, { policy: { guard: { allow: ['chalk'] } } });
  assert.match(text, /^ {16}no reason recorded$/m);
});

test('a package present but unwatched is named under a green result', () => {
  const text = page(
    { minimist: { declared: '^1.2.8', installed: ['1.2.8'] }, semver: { installed: ['7.6.0'] } },
    { policy: { guard: { signals: [SIGNAL.IMPORTED] } } },
  );
  assert.match(text, /^ {2}2 others present but not watched here: minimist, semver$/m);
  assert.match(text, /^PASS:/m);
});

test('the cap is reported whichever side of it the project is on', () => {
  const over = page({ chalk: { sites: [site('src/a.mjs', 1)] } }, { policy: { guard: { max: 2 } }, direct: 5 });
  assert.match(over, /^over the cap: 5 direct dependencies, and the policy allows 2$/m);

  const under = page({}, { policy: { guard: { max: 9 } }, direct: 1 });
  assert.match(under, /^under the cap: 1 direct dependency, and the policy allows 9$/m);
  assert.match(under, /^PASS:/m);
});

test('the cap can fail a build on its own, and the last line says which question failed', () => {
  const text = page({}, { policy: { guard: { max: 2 } }, direct: 5 });
  assert.match(text, /^FAIL: 5 direct dependencies, over the cap of 2\.$/m);
});

test('a green build is auditable: the footer says who decided that', () => {
  const text = page({}, { policy: { guard: { signals: [SIGNAL.IMPORTED], dev: false, max: 3, allow: ['chalk'] } } });
  // The prefix and the file name are a layout assertion; the rest is a sentence, and it
  // folds, so it is read through `flat`.
  assert.match(text, new RegExp(`^policy {4}${POLICY_FILE.replace('.', '\\.')}: `, 'm'));
  assert.match(flat(text), new RegExp(`${POLICY_FILE.replace('.', '\\.')}: 8 packages denied, `
    + 'imported only, runtime only, at most 3 direct dependencies, 1 allowed'));
});

test('a file with no guard section in it is not somebody having chosen this', () => {
  const text = page({}, { policy: { eject: { into: 'lib' } } });
  assert.match(flat(text), /has no guard section, so the default applies: 8 packages denied, all three signals/);
});

test('a flag that overruled the policy is named in the same line as the policy', () => {
  const text = page({}, { policy: { guard: { dev: true, max: 10 } }, overrides: { dev: false, max: 2 } });
  assert.match(flat(text), /runtime only, at most 2 direct dependencies, dev and max from the command line/);
});

test('what was read, and what could not be', () => {
  assert.match(page({}, { scanned: 12 }), /^read {6}npm lockfile, 12 source files scanned$/m);

  const blind = page({}, { understood: false, kind: 'none', note: 'no lockfile, so only what package.json declares is known' });
  assert.match(blind, /^read {6}no usable lockfile, so only package\.json and 12 source files$/m);
  // The caveat travels with the line it qualifies. Moved to the bottom of the page it would
  // be read after the verdict, which is too late to change what the verdict meant.
  assert.match(flat(blind), /Installed-but-undeclared packages cannot be seen from here: no lockfile, so only what package\.json declares is known\./);
});

test('a policy that cannot be read prints every mistake and guards nothing', () => {
  const text = page({ chalk: { declared: '^5.3.0' } }, { policy: { guard: { signal: [], dev: 'yes' } } });
  assert.match(text, /^guard cannot run: 2 problems in the policy$/m);
  assert.match(text, /^ {2}- unknown policy key "signal", did you mean "signals"\?$/m);
  assert.match(text, /^ {2}- "dev" has to be true or false$/m);
  assert.match(flat(text), /A policy that cannot be read is worse than none: it would pass a build for the wrong reason\./);
  assert.equal(/FAIL|PASS/.test(text), false, 'no verdict, because nothing was checked');
});

test('a name too long for the column takes a line of its own', () => {
  const long = 'a-package-with-a-name-nobody-should-have-chosen';
  const text = page(
    { [long]: { declared: '^1.0.0' }, chalk: { declared: '^5.3.0', installed: ['5.3.0', '4.1.2'] } },
    { policy: { guard: { deny: [long, 'chalk'] } } },
  );
  // The column is capped, so the other rows keep a readable indent instead of being pushed
  // halfway across the terminal by one name.
  assert.match(text, /^ {2}chalk {19} {2}declared \^5\.3\.0 {2}installed 4\.1\.2, 5\.3\.0$/m);
  assert.match(text, new RegExp(`^ {2}${long}$`, 'm'));
  assert.match(text, /^ {28}declared \^1\.0\.0$/m);
  assert.match(flat(text), /denied by this policy, and not a package nirdep replaces/);
  for (const line of text.split('\n')) assert.equal(line.length <= 80, true, line);
});

test('nothing on the page is wider than a terminal', () => {  const text = page({
    chalk: { declared: '^5.3.0', installed: ['5.3.0', '4.1.2'], sites: [site('src/a.mjs', 1)] },
    minimist: { declared: '^1.2.8', dev: true, installed: ['1.2.8'] },
    'supports-color': { sites: [site('src/deep/nested/module/with/a/long/name.mjs', 214)] },
  }, { policy: { guard: { max: 1, allow: { semver: 'the oracle harness needs it' } } }, direct: 6, understood: false, kind: 'none', note: 'no lockfile' });
  for (const line of text.split('\n')) {
    assert.equal(line.length <= 80, true, `${line.length} columns: ${line}`);
  }
});

test('styling is a hook, and the fold counts characters rather than bytes', () => {
  const packages = { chalk: { declared: '^5.3.0', sites: [site('src/a.mjs', 1)] } };
  const plain = page(packages);
  const loud = guardReport(
    guardProject('/demo', { scan: scanOf(packages), read: ENOENT }),
    { style: { red: (text) => `<<${text}>>`, dim: (text) => `((${text}))`, bold: (text) => `[[${text}]]` } },
  );
  assert.equal(loud.split('\n').length, plain.split('\n').length);
  assert.match(loud, /<<FAIL>>/);
  assert.equal(plain.includes('<<'), false);
});
