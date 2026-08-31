// The claims the browser playground makes about itself, asserted.
//
// Two of them matter enough to be tested rather than eyeballed. The page says it makes no
// requests, which is a property of the bytes and can be read off them. And it says the
// sandboxes run nirdep's own modules rather than a description of them -- which is only true
// if the embedded closure still loads as ES modules with nothing but the shim under it. So
// this test rebuilds the closure on disk the way the browser rebuilds it in blob URLs, imports
// it, and asks it the questions the panels ask.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'nirdep-page-test-'));

/** Build the page somewhere harmless, and hand back the bytes. */
function build(name) {
  const out = join(HOME, name);
  execFileSync(process.execPath, ['tools/playground.mjs', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  return readFileSync(out, 'utf8');
}

const PAGE = build('one.html');

/** The JSON island, read the way the page reads it. */
function island(page) {
  const open = '<script type="application/json" id="nirdep-data">';
  const start = page.indexOf(open);
  assert.notEqual(start, -1, 'the data island is in the page');
  const end = page.indexOf('<', start + open.length);
  return JSON.parse(page.slice(start + open.length, end));
}

const DATA = island(PAGE);

test('two builds of the page are byte-identical', () => {
  assert.equal(build('two.html'), PAGE);
});

test('the page makes no requests', () => {
  // A link a person can click is not a request the page makes, so the repository is allowed
  // and everything else is not: no stylesheet, no script src, no image, no font, no fetch.
  const urls = [...PAGE.matchAll(/https?:\/\/[^"'\s)<]+/g)].map((one) => one[0]);
  for (const url of urls) assert.match(url, /^https:\/\/github\.com\//, `${url} is a link, not a fetch`);
  assert.equal(/<script[^>]+src=/.test(PAGE), false, 'no external script');
  assert.equal(/<link[^>]+href=/.test(PAGE), false, 'no external stylesheet or font');
  assert.equal(/<img|<iframe|@import|url\(http/.test(PAGE), false, 'nothing fetched from markup or CSS');
  for (const name of ['fetch(', 'XMLHttpRequest', 'importScripts', 'EventSource', 'WebSocket']) {
    assert.equal(PAGE.includes(name), false, `${name} is not in the page`);
  }
});

test('the page script parses as a module', () => {
  const open = '<script type="module">';
  const start = PAGE.indexOf(open) + open.length;
  const end = PAGE.indexOf('</scr' + 'ipt>', start);
  const file = join(HOME, 'app.mjs');
  writeFileSync(file, PAGE.slice(start, end));
  execFileSync(process.execPath, ['--check', file], { encoding: 'utf8' });
});

test('every module the loader needs is embedded, dependencies first', () => {
  const seen = new Set();
  for (const path of DATA.order) {
    const one = DATA.modules[path];
    assert.ok(one, `${path} is embedded`);
    assert.ok(one.text.length > 0, `${path} has bytes`);
    for (const edit of one.edits) {
      assert.ok(DATA.modules[edit.to], `${path} needs ${edit.to}`);
      assert.ok(seen.has(edit.to), `${edit.to} is loaded before ${path}`);
      // The offset has to still be the specifier, or the loader splices over live code.
      const quoted = one.text.slice(edit.index, edit.index + edit.length);
      assert.equal(quoted.includes('\n'), false, `the edit in ${path} lands inside one line`);
    }
    seen.add(path);
  }
  assert.equal(DATA.order[0], 'node', 'the shim is first, because nothing it imports exists');
  for (const path of Object.keys(DATA.modules)) assert.ok(seen.has(path), `${path} is ordered`);
  for (const entry of Object.values(DATA.entries)) assert.ok(DATA.modules[entry], `${entry} is embedded`);
});

test('the syntax gate is not embedded, because a browser cannot run it', () => {
  assert.equal(DATA.modules['src/patch/gate.mjs'], undefined);
  assert.match(PAGE, /node:vm/, 'and the page says so out loud');
});

test('the recording is a real run: seven stages, each with the output it printed', () => {
  assert.equal(DATA.stages.length, 7);
  for (const stage of DATA.stages) {
    assert.match(stage.command, /^(nirdep|node|cd)\b/, `${stage.name} names a command`);
    assert.ok(stage.title.length > 0, `${stage.name} has a title`);
    assert.ok(stage.guide !== null, `${stage.name} has guide text`);
  }
  const names = DATA.stages.map((one) => one.name);
  assert.deepEqual(names, ['plant', 'before', 'scan', 'plan', 'eject', 'apply', 'after']);
  // The one temporary path the page may name is the fixed one the recording claims to have
  // run in; the machine that built it is nobody's business and would break reproducibility.
  for (const path of [...PAGE.matchAll(/\/tmp\/[\w.-]+/g)].map((one) => one[0])) {
    assert.equal(path, '/tmp/nirdep-demo', 'the only temporary path on the page is the fixed one');
  }
  assert.equal(PAGE.includes(HOME), false, 'the build output path is not in the page');
});

test('the figures on the page come from the rule table, not from prose', () => {
  const table = new Map(DATA.rules.map((one) => [one.package, one.weekly]));
  assert.equal(table.get('chalk'), '319.8M');
  for (const [name, weekly] of table) {
    assert.match(weekly, /^(\d+(\.\d+)?[KMB]|--|—)$/, `${name}'s figure is a figure or a dash`);
  }
  for (const module of ['colour', 'semver', 'glob', 'collect']) {
    assert.ok(DATA.rules.some((one) => one.module === module), `${module} has at least one package`);
  }
});

test('the embedded closure still loads as ES modules and answers the panels', async () => {
  // Same substitution the page does with blob URLs, done with filenames instead: each
  // module's specifiers are pointed at the file its dependency was written to.
  const names = new Map(DATA.order.map((path, index) => [path, `m${index}.mjs`]));
  const dir = join(HOME, 'closure');
  mkdirSync(dir, { recursive: true });
  for (const path of DATA.order) {
    const one = DATA.modules[path];
    let text = one.text;
    for (let n = one.edits.length - 1; n >= 0; n -= 1) {
      const edit = one.edits[n];
      text = text.slice(0, edit.index) + `./${names.get(edit.to)}` + text.slice(edit.index + edit.length);
    }
    writeFileSync(join(dir, names.get(path)), text);
  }
  const load = (path) => import(pathToFileURL(join(dir, names.get(path))).href);

  const semver = await load(DATA.entries.semver);
  assert.equal(semver.satisfies('7.5.0', '^7.0.0'), true);
  assert.equal(semver.satisfies('8.0.0', '^7.0.0'), false);

  const shim = await load('node');
  shim.mount(DATA.tree);
  const glob = await load(DATA.entries.glob);
  const found = glob.globSync('src/**/*.mjs', { cwd: '.' });
  assert.ok(found.includes('src/api/deep/nested/thing.mjs'), 'the walk reaches the bottom of the tree');
  assert.equal(found.includes('package.json'), false, 'and stops where the pattern does');

  const collect = await load(DATA.entries.collect);
  assert.deepEqual(Object.keys(collect.groupBy([{ k: 'a' }, { k: 'b' }, { k: 'a' }], 'k')), ['a', 'b']);

  const colour = await load(DATA.entries.colour);
  const painted = colour.createColour({ level: 3 }).red.bold('x');
  assert.equal(colour.strip(painted), 'x');
  assert.ok(painted.length > 1, 'level 3 writes the codes');

  const rewrite = await load(DATA.entries.rewrite);
  const diff = await load(DATA.entries.diff);
  const source = DATA.before['src/report.mjs'];
  const plan = rewrite.planFile(source, {
    file: 'src/report.mjs',
    resolve: (rule) => `../${DATA.project.runtimeDir}/${rule.subpath.split('/').pop()}.mjs`,
  });
  assert.equal(plan.changes.length, 2, 'chalk and semver both move');
  const after = plan.patch.apply().after;
  assert.match(diff.unified(source, after, { context: 2 }), /^\+import chalk from/m);
  assert.equal(after.includes("'chalk'"), false, 'and the old specifier is gone');
});

test('every node the app reaches for is in the markup, and every button opens something', () => {
  // A page cannot be clicked in this test runner, and the failure a browser would show for a
  // renamed id is a silent one: the panel simply never fills. So the wiring is checked as
  // text -- every `$('x')` against an `id="x"`, every tab against its panel, every
  // `data-open` and `data-term` against a modal and a glossary entry.
  const ids = new Set([...PAGE.matchAll(/\sid="([\w-]+)"/g)].map((one) => one[1]));
  for (const [, id] of PAGE.matchAll(/\$\('([\w-]+)'\)/g)) {
    assert.ok(ids.has(id), `the app asks for #${id}, which is not in the page`);
  }
  const tabs = [...PAGE.matchAll(/data-tab="([\w-]+)"/g)].map((one) => one[1]);
  assert.deepEqual(tabs, ['console', 'walk', 'stories', 'bench', 'codemod', 'modules', 'story'],
    'seven tabs, in the order a visitor should meet them');
  for (const tab of tabs) assert.ok(ids.has(`panel-${tab}`), `${tab} has a panel`);
  for (const [, name] of PAGE.matchAll(/data-open="([\w-]+)"/g)) {
    assert.ok(ids.has(`modal-${name}`), `data-open="${name}" has a modal`);
  }
  for (const [, term] of PAGE.matchAll(/data-term="([\w -]+)"/g)) {
    assert.ok(DATA.glossary[term], `data-term="${term}" is a word the glossary defines`);
  }
  // The four module cards are filled from the rule table by name, so a card naming a module
  // nothing replaces would render an empty pill.
  for (const [, name] of PAGE.matchAll(/data-module="([\w-]+)"/g)) {
    assert.ok(DATA.rules.some((one) => one.module === name), `${name} is a module in the table`);
  }
});

test('the coach marks point at nodes that exist, so the tour cannot narrate a blank page', () => {
  const ids = new Set([...PAGE.matchAll(/\sid="([\w-]+)"/g)].map((one) => one[1]));
  const open = PAGE.indexOf('const TOUR = [');
  assert.notEqual(open, -1, 'the tour is a list, not a sequence of calls');
  const tour = PAGE.slice(open, PAGE.indexOf('];', open));
  const targets = [...tour.matchAll(/at: '#?([\w-]+)'/g)].map((one) => one[1]);
  assert.ok(targets.length >= 4, 'a tour worth taking has several steps');
  for (const target of targets) assert.ok(ids.has(target), `the tour points at #${target}`);
});

test('the guide the page teaches from is the guide the CLI prints', async () => {
  const guide = await import(new URL('../../src/demo/guide.mjs', import.meta.url));
  assert.deepEqual(Object.keys(DATA.glossary), Object.keys(guide.GLOSSARY));
  assert.deepEqual(DATA.next.map((one) => one.command), guide.NEXT_STEPS.map((one) => one.command));
  for (const stage of DATA.stages) assert.deepEqual(stage.guide, guide.guideFor(stage.name));
});

test('the console is a replay of real runs, and says so where a visitor will read it', () => {
  // Every entry has to carry output, because a recorded command that printed nothing is a
  // command that did not run. `explain` is the exception nothing makes: all fourteen print.
  assert.equal(DATA.console.length, 14);
  const seen = new Set();
  for (const run of DATA.console) {
    assert.match(run.line, /^nirdep [a-z-]/, `${run.line} is a nirdep command line`);
    assert.ok(run.lines > 0, `${run.line} printed something`);
    assert.ok(run.html.length > 0, `${run.line} has bytes to show`);
    assert.equal(typeof run.code, 'number', `${run.line} recorded an exit code`);
    assert.ok(['orient', 'before', 'move', 'after'].includes(run.beat), `${run.line} has a beat`);
    assert.ok(run.note.length > 0, `${run.line} has a note`);
    seen.add(run.beat);
  }
  assert.deepEqual([...seen], ['orient', 'before', 'move', 'after'], 'all four beats are used');
  // The order is the argument: a scan before the rewrite and the same scan after it.
  const lines = DATA.console.map((one) => one.line);
  const applied = lines.findIndex((one) => one.startsWith('nirdep apply'));
  assert.notEqual(applied, -1, 'the rewrite is in the session');
  assert.ok(lines.indexOf('nirdep scan .') < applied, 'a scan is replayed before the apply');
  assert.ok(lines.lastIndexOf('nirdep scan .') > applied,
    'and again after it, which is the whole point of keeping state across the fourteen runs');
  assert.match(PAGE, /replay/i, 'the page uses the word rather than implying execution');
});

test('every advisory row belongs to exactly one story, so the stories cannot go stale', async () => {
  const table = await import(new URL('../../src/scan/advisories.mjs', import.meta.url));
  assert.equal(DATA.coverage.rows, table.ADVISORIES.length);
  assert.equal(DATA.coverage.reviewed, table.REVIEWED);
  const claimed = new Set();
  for (const story of DATA.stories) {
    assert.ok(story.rows.length > 0, `${story.id} is about at least one row`);
    for (const field of ['title', 'hook', 'plain', 'answer', 'proof']) {
      assert.ok(story[field].length > 0, `${story.id} has ${field}`);
    }
    for (const row of story.rows) {
      const key = `${row.id}|${row.package}|${row.when}`;
      assert.equal(claimed.has(key), false, `${key} is claimed twice`);
      claimed.add(key);
      assert.ok(['flaw', 'incident'].includes(row.kind), `${row.id} has a kind`);
      assert.equal(typeof row.replaced, 'boolean', `${row.id} knows whether nirdep replaces it`);
    }
  }
  assert.equal(claimed.size, table.ADVISORIES.length, 'no row is left out of the stories');
});

test('the benchmark section is read from committed data, never measured at build time', () => {
  const bench = JSON.parse(readFileSync(join(ROOT, 'bench.json'), 'utf8'));
  assert.deepEqual(DATA.bench, bench, 'the page shows the file, unaltered');
  assert.match(bench.measured, /^\d{4}-\d{2}-\d{2}$/, 'a figure carries the day it was taken');
  assert.ok(bench.node.startsWith('v'), 'and the Node it was taken on');
  for (const one of bench.operations) {
    assert.ok(one.ours.opsPerSecond > 0, `${one.name} measured our side`);
    // A missing reference package is null, never a plausible guess.
    if (one.reference === null) assert.equal(one.ratio, null, `${one.name} claims no ratio it cannot support`);
    else assert.ok(one.ratio > 0, `${one.name} has a ratio`);
  }
  for (const one of bench.modules) {
    assert.ok(one.bytes > 0 && one.lines > 0, `${one.module} was weighed`);
  }
  assert.ok(bench.pipeline.some((one) => one.name.includes('real syntax gate')),
    'the expensive gate is measured, not hidden');
});
