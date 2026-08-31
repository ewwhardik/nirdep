// The browser playground: one HTML file, no build tooling, no network.
//
// A judge should be able to click something and watch this work, and "watch" has to mean more
// than a screenshot. So the page carries three honest things and labels each one.
//
// The console is a replay. Every command it offers was really run here, at build time, by
// spawning `bin/nirdep.mjs` with FORCE_COLOR=3 against a freshly planted copy of the demo
// project; the bytes it printed -- exit code, colours and all -- are translated to spans and
// stored. Typing in it does not run anything. It says so, on the page, next to the prompt,
// because a terminal that pretends to execute is the kind of demo this project exists to
// argue against.
//
// The walkthrough is the same idea one layer up: `runDemo` is run here and every stage's real
// output is captured.
//
// The sandboxes are not recordings at all -- twelve of nirdep's own modules are embedded
// verbatim and loaded as ES modules through blob URLs, so the diff a visitor produces is
// produced by src/rules, and the version comparison is answered by src/runtime/semver,
// running in their browser.
//
// The loader needs each module's relative specifiers pointed at the blob URL of its
// dependency, and the offsets it uses are found by nirdep's own scanner, here, at build
// time. The tool that rewrites imports for a living rewrites its own to get into a browser.
//
// What it cannot do is say so on the page: src/patch/gate.mjs asks Node for a parser
// (node:vm) and there is no browser equivalent, so the sandbox shows a diff and admits the
// syntax gate is a thing only the CLI can run.
//
// Run: node tools/playground.mjs            write docs/index.html
//      node tools/playground.mjs --out X    write it somewhere else

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { findSpecifiers } from '../src/audit/imports.mjs';
import { RULES } from '../src/rules/registry.mjs';
import { ADVISORIES, COVERAGE, REVIEWED } from '../src/scan/advisories.mjs';
import { DEMO, runDemo } from '../src/demo/script.mjs';
import { demoSummary } from '../src/demo/report.mjs';
import { GLOSSARY, GUIDE, NEXT_STEPS, guideFor } from '../src/demo/guide.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The path the recording claims to have run in, so two builds agree byte for byte. */
const FIXED_ROOT = '/tmp/nirdep-demo';

// Markers, not escape sequences: the report is styled through hooks like any other caller,
// and a private-use code point is the one thing HTML escaping cannot collide with. Spelled
// as code points rather than pasted, for the same reason src/runtime/colour.mjs spells ESC.
const MARK = (n) => String.fromCharCode(0xE000 + n);
const OPENERS = Object.freeze({
  bold: MARK(1), dim: MARK(2), cyan: MARK(3), yellow: MARK(4), green: MARK(5), red: MARK(6),
});
const CLOSER = MARK(0);

/** Style hooks that mark instead of colouring, for a report that is going into HTML. */
const MARKED = Object.freeze(Object.fromEntries(
  Object.entries(OPENERS).map(([name, open]) => [name, (text) => `${open}${text}${CLOSER}`]),
));

/** Where the recording was actually made, filled in before anything is captured. */
const CAPTURE = { root: FIXED_ROOT };

/**
 * Every spelling of one directory this machine might print.
 *
 * Windows is the reason. A GitHub runner's os.tmpdir() answers with the 8.3 short name
 * (C:\Users\RUNNER~1\...) while a child process asked for its own cwd answers with the long
 * one (C:\Users\runneradmin\...). Fold only the string we were handed and the other spelling
 * survives, carrying a random mkdtemp suffix into the page -- which is invisible until the
 * test that builds the page twice and compares bytes fails, on Windows, and nowhere else.
 */
function aliases(dir) {
  const out = new Set();
  const add = (value) => {
    if (!value) return;
    out.add(value);
    out.add(value.split('\\').join('/'));
  };
  add(dir);
  try { add(realpathSync(dir)); } catch { /* already removed: the one spelling is all we get */ }
  return [...out].sort((a, b) => b.length - a.length);
}

const HERE = aliases(ROOT);

/** A temporary path is not a fact about the product, so it is replaced by a fixed one. */
function steady(text) {
  let out = String(text);
  for (const one of aliases(CAPTURE.root)) out = out.split(one).join(FIXED_ROOT);
  for (const one of HERE) out = out.split(one).join('/nirdep');
  return out;
}

const escaped = (text) => String(text)
  .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');

/** Marked text to HTML: escape first, then turn the markers into spans. */
function painted(text) {
  let out = escaped(steady(text));
  for (const [name, open] of Object.entries(OPENERS)) out = out.split(open).join(`<span class="s-${name}">`);
  return out.split(CLOSER).join('</span>');
}

/**
 * Every module the sandboxes need, plus every module those need, keyed by repository path.
 * Relative specifiers are resolved here so the browser does not have to know what a path is.
 *
 * @param {string[]} entries
 */
function closure(entries) {
  const files = new Map();
  const walk = (relative) => {
    if (files.has(relative)) return;
    const text = readFileSync(join(ROOT, relative), 'utf8');
    const edits = [];
    files.set(relative, { text, edits });
    for (const found of findSpecifiers(text)) {
      const to = found.specifier.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(relative), found.specifier))
        : 'node';
      edits.push({ index: found.index, length: found.specifier.length, to });
      if (to !== 'node') walk(to);
    }
    edits.sort((a, b) => a.index - b.index);
  };
  for (const entry of entries) walk(entry);
  return files;
}

/** Dependencies before the files that import them, so a blob URL always exists in time. */
function ordered(files) {
  const out = [];
  const done = new Set();
  const visit = (relative) => {
    if (done.has(relative)) return;
    done.add(relative);
    for (const edit of files.get(relative).edits) if (edit.to !== 'node') visit(edit.to);
    out.push(relative);
  };
  for (const relative of files.keys()) visit(relative);
  return out;
}

/** The fake disk the glob panel walks: a repository shape, not a toy. */
const TREE = Object.freeze([
  'package.json', 'README.md', 'bin/cli.mjs', 'src/index.mjs', 'src/util/dates.mjs',
  'src/util/dates.test.mjs', 'src/api/users.mjs', 'src/api/users.test.mjs', 'src/api/orders.mjs',
  'src/api/deep/nested/thing.mjs', 'test/fixtures/one.json', 'test/fixtures/two.json',
  'docs/guide.md', 'docs/img/logo.svg', 'node_modules/chalk/index.js', '.github/workflows/ci.yml',
]);

/* ---------- the console: real runs, recorded ---------- */

/** Which SGR parameters this page understands, which is exactly the set colour.mjs emits. */
const SGR = Object.freeze({ 1: 'bold', 2: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan' });
const SGR_CLOSE = new Set(['0', '22', '23', '24', '27', '39', '49']);

/**
 * A terminal's own bytes to marked text. Opens are pushed, closes pop, and anything this
 * project does not emit is dropped rather than guessed at -- the alternative is a page that
 * invents a colour the CLI never printed.
 *
 * @param {string} text
 */
function marked(text) {
  const ESC = String.fromCharCode(27);
  let out = '';
  let open = 0;
  let n = 0;
  while (n < text.length) {
    if (text[n] !== ESC || text[n + 1] !== '[') { out += text[n]; n += 1; continue; }
    const end = text.indexOf('m', n + 2);
    if (end === -1) { out += text[n]; n += 1; continue; }
    for (const code of text.slice(n + 2, end).split(';')) {
      if (SGR_CLOSE.has(code) || code === '') { if (open > 0) { out += CLOSER; open -= 1; } continue; }
      const name = SGR[Number(code)];
      if (name !== undefined) { out += OPENERS[name]; open += 1; }
    }
    n = end + 1;
  }
  while (open > 0) { out += CLOSER; open -= 1; }
  return out;
}

/** Lay the demo project down on disk, the same table `nirdep demo` plants. */
function plantDemo(root) {
  for (const [path, text] of Object.entries(DEMO.project)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
}

/**
 * The session, in the order a person would type it. Each entry is run for real; `note` is the
 * one line the page prints under the output, and `beat` groups the buttons.
 */
const SESSION = Object.freeze([
  { args: ['--about'], beat: 'orient', note: 'Who wrote it, what it needs, and the dependency count it claims.' },
  { args: ['--help'], beat: 'orient', note: 'Eleven commands, all implemented. The help text is generated by runtime/args, not written by hand.' },
  { args: ['explain'], beat: 'orient', note: 'The whole replacement table: every package, and whether a machine is allowed to touch it.' },
  { args: ['explain', 'chalk'], beat: 'orient', note: 'One package, in full: the argument for the rewrite and the exact shape that would stop it.' },
  { args: ['scan', '.'], beat: 'before', note: 'Before anything moves: what is replaceable here, how far it reaches, and what the lockfile says.' },
  { args: ['scan', '.', '--verbose'], beat: 'before', note: 'The same walk, saying more -- per-file call sites and the blast radius subtraction.' },
  { args: ['eject', '--list'], beat: 'move', note: 'The five files on offer, and what each one replaces. Nothing is written yet.' },
  { args: ['plan', '.', '--runtime', DEMO.runtimeDir], beat: 'move', note: 'The rewrite as a unified diff. This command cannot write; that is the point of having two.' },
  { args: ['eject', '--into', DEMO.runtimeDir], beat: 'move', note: 'The replacements copied into the project as ordinary files it now owns.' },
  { args: ['apply', '.', '--runtime', DEMO.runtimeDir], beat: 'move', note: 'The same diff, written -- each file through Node\'s own parser first, and a failure holds back the rest.' },
  { args: ['scan', '.'], beat: 'after', note: 'The same command as before, on the migrated tree. Nothing replaceable left.' },
  { args: ['guard', '.'], beat: 'after', note: 'CI mode. Exit 0 today; exit 1 the day somebody reinstalls one of these.' },
  { args: ['stdlibmd', '.'], beat: 'after', note: 'The disclosure document, generated from the project\'s own dependencies rather than from a template.' },
  { args: ['conformance'], beat: 'after', note: 'The vector corpus, per module. A skip is printed as a skip; nothing here rounds up to a pass.' },
]);

/**
 * Run every entry, in order, against one planted project. State carries forward on purpose:
 * `scan` after `apply` is only interesting because the `apply` above it really happened.
 */
function session() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-console-'));
  const bin = join(ROOT, 'bin', 'nirdep.mjs');
  const runs = [];
  // Forced to level 3 so the recording carries every style the CLI can print, and NO_COLOR
  // removed rather than emptied, because Node warns about the pair and a warning on stderr
  // would be captured as if nirdep had printed it.
  const env = { ...process.env, FORCE_COLOR: '3' };
  delete env.NO_COLOR;
  CAPTURE.root = root;
  try {
    plantDemo(root);
    for (const one of SESSION) {
      let stdout = '';
      let stderr = '';
      let code = 0;
      try {
        stdout = execFileSync(process.execPath, [bin, ...one.args], {
          cwd: root, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024,
        });
      } catch (error) {
        stdout = error.stdout ?? '';
        stderr = error.stderr ?? '';
        code = error.status ?? 1;
      }
      const text = `${stdout}${stderr}`;
      runs.push({
        line: `nirdep ${one.args.join(' ')}`,
        beat: one.beat,
        note: one.note,
        code,
        html: painted(marked(text.replace(/\n+$/, ''))),
        lines: text.trimEnd() === '' ? 0 : text.trimEnd().split('\n').length,
      });
    }
    return runs;
  } finally {
    rmSync(root, { recursive: true, force: true });
    CAPTURE.root = FIXED_ROOT;
  }
}

/* ---------- the stories, tied to the advisory table ---------- */

/**
 * Each story names the rows it is about, and every row in src/scan/advisories.mjs has to be
 * named by exactly one of them. The build fails otherwise, because four stories that quietly
 * stop covering the table are four stories nobody notices going out of date.
 */
function stories() {
  const written = JSON.parse(readFileSync(join(ROOT, 'tools', 'playground', 'stories.json'), 'utf8'));
  const claimed = new Map();
  const out = written.map((story) => {
    const rows = ADVISORIES.filter((row) => (story.pick.ids !== undefined
      ? story.pick.ids.includes(row.id)
      : row.kind === story.pick.kind));
    for (const row of rows) {
      const key = `${row.id}|${row.package}|${row.when}`;
      if (claimed.has(key)) throw new Error(`${key} is claimed by both ${claimed.get(key)} and ${story.id}`);
      claimed.set(key, story.id);
    }
    return {
      ...story,
      pick: undefined,
      rows: rows.map((row) => ({
        id: row.id,
        package: row.package,
        kind: row.kind,
        severity: row.severity,
        when: row.when,
        hand: row.hand,
        range: row.range,
        fixed: row.fixed,
        what: row.what,
        group: row.group ?? null,
        replaced: RULES.some((rule) => rule.package === row.package),
      })),
    };
  });
  if (claimed.size !== ADVISORIES.length) {
    const loose = ADVISORIES.filter((row) => !claimed.has(`${row.id}|${row.package}|${row.when}`))
      .map((row) => `${row.id} ${row.package}`);
    throw new Error(`${loose.length} advisory rows belong to no story: ${loose.join(', ')}`);
  }
  return out;
}

/** What the page imports by name. Everything these reach is pulled in behind them. */
const ENTRIES = Object.freeze({
  rewrite: 'src/rules/rewrite.mjs',
  registry: 'src/rules/registry.mjs',
  diff: 'src/patch/diff.mjs',
  imports: 'src/audit/imports.mjs',
  semver: 'src/runtime/semver.mjs',
  glob: 'src/runtime/glob.mjs',
  collect: 'src/runtime/collect.mjs',
  colour: 'src/runtime/colour.mjs',
  args: 'src/runtime/args.mjs',
});

/** Run the real demo once, with the markers standing in for its colours, and keep it all. */
async function record() {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-page-'));
  CAPTURE.root = root;
  const seen = [];
  try {
    const result = await runDemo({
      root, style: MARKED, context: 2, diff: true, emit: (one) => seen.push(one),
    });
    return {
      ok: result.ok,
      stages: seen.map((one, index) => ({
        step: index + 1,
        name: one.name,
        title: steady(one.title),
        command: steady(one.command),
        ok: one.ok,
        html: painted(one.text),
        guide: guideFor(one.name),
      })),
      // No tree line: the page is not a directory anybody can cd into, and a summary that
      // says otherwise would be the first lie on it.
      summary: painted(demoSummary(result, { style: MARKED, guide: true })),
      before: Object.fromEntries(Object.entries(DEMO.project)),
      after: Object.fromEntries(result.applied.files
        .filter((one) => typeof one.after === 'string')
        .map((one) => [one.path.split('\\').join('/'), one.after])),
      modules: [...result.modules],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    CAPTURE.root = FIXED_ROOT;
  }
}

/** The rule table, minus the parts only a codemod needs, so the page can cite real figures. */
const table = () => RULES.map((rule) => ({
  package: rule.package,
  weekly: rule.weekly,
  action: rule.action,
  module: rule.subpath.slice(rule.subpath.lastIndexOf('/') + 1),
  note: rule.note,
}));

/** Everything the page needs, as one JSON object. */
function payload(recording) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = closure(Object.values(ENTRIES));
  const modules = Object.fromEntries([...files].map(([relative, one]) => [relative, one]));
  // The shim is a module like any other, keyed by the name every builtin specifier was
  // resolved to. Ordering puts it first because nothing it imports exists to import.
  modules.node = { text: readFileSync(join(ROOT, 'tools', 'playground', 'node-shim.mjs'), 'utf8'), edits: [] };
  // Read, never run. A page whose numbers came from a benchmark executed at build time would
  // change every time it was built, and a figure that moves on its own is a figure nobody can
  // check. `node tools/bench.mjs` writes this file; this only reads it back.
  const bench = JSON.parse(readFileSync(join(ROOT, 'bench.json'), 'utf8'));
  return {
    version: manifest.version,
    repository: (manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, ''),
    project: { name: DEMO.name, runtimeDir: DEMO.runtimeDir },
    stages: recording.stages,
    summary: recording.summary,
    before: recording.before,
    after: recording.after,
    vendored: recording.modules,
    glossary: GLOSSARY,
    guide: GUIDE,
    next: NEXT_STEPS,
    rules: table(),
    console: session(),
    stories: stories(),
    coverage: { ...COVERAGE, reviewed: REVIEWED, rows: ADVISORIES.length },
    bench,
    order: ['node', ...ordered(files)],
    modules,
    entries: ENTRIES,
    tree: TREE,
    seed: DEMO.project['src/report.mjs'],
  };
}

/** The page: a template with three holes in it, because a template engine is a dependency. */
function render(data) {
  const page = readFileSync(join(ROOT, 'tools', 'playground', 'page.html'), 'utf8');
  // `</script>` inside a JSON island would close the tag it is written in, and a lone `<`
  // is enough to make a parser guess. Both are escaped as code points, which JSON.parse
  // reads back as the characters they stand for.
  const json = JSON.stringify(data).split('<').join('\\u003c').split('>').join('\\u003e');
  const fills = { DATA: json, VERSION: data.version, REPOSITORY: data.repository };
  // The holes are checked in the template, not in the output: the embedded modules carry
  // JSDoc like `@param {{ ... }}`, so a brace pair downstream of the fill is a fact about
  // nirdep's source rather than a hole somebody forgot.
  const holes = [...page.matchAll(/\{\{([A-Z]+)\}\}/g)].map((one) => one[1]);
  for (const name of new Set(holes)) {
    if (!(name in fills)) throw new Error(`the page template asks for {{${name}}}, which nothing fills`);
  }
  let filled = page;
  for (const [name, value] of Object.entries(fills)) filled = filled.split(`{{${name}}}`).join(value);
  return filled;
}

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const recording = await record();
const data = payload(recording);
const html = render(data);
const out = flag('out') ?? join(ROOT, 'docs', 'index.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);

const bytes = Buffer.byteLength(html);
process.stdout.write(`${out}\n`);
process.stdout.write(`  ${recording.stages.length} stages recorded, ${data.console.length} commands replayed,`
  + ` ${Object.keys(data.modules).length} modules embedded\n`);
process.stdout.write(`  ${data.stories.length} stories over ${data.coverage.rows} advisory rows,`
  + ` ${data.bench.operations.length} measured operations\n`);
process.stdout.write(`  ${(bytes / 1024).toFixed(1)} KiB, no network, no build step\n`);
process.exitCode = recording.ok ? 0 : 1;
