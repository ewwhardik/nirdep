// Numbers, measured. `node tools/bench.mjs` writes bench.json and prints a table.
//
// Every figure the playground shows comes out of this file, because a benchmark section with
// numbers typed by hand is an advertisement, and this project spends the rest of its
// documentation refusing to print figures it did not check. Three rules follow from that.
//
// It is committed as data. The page is built from bench.json rather than by running this, so
// two builds of the page are byte-identical even though two runs of a benchmark never are.
// The date, the Node version and the machine's own claim about its CPU go in the file, so a
// number can be doubted properly.
//
// A figure that could not be measured is `null`, never a plausible guess. The comparison
// against the real packages needs them on disk -- they are not in this repository and never
// will be -- so `--against <node_modules>` is how you opt in, and without it every
// `reference` field stays null and the page says "not measured here".
//
// Reference packages are called, never read. This is the same black-box rule the conformance
// harness follows: their versions are taken from their own package.json, their answers are
// taken from their exports, and not one line of their source is copied into or quoted by
// this repository.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES } from '../src/rules/registry.mjs';
import { planProject, applyProject } from '../src/apply/project.mjs';
import { checkByLexer } from '../src/patch/gate.mjs';
import { scanProject } from '../src/scan/project.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = ['args', 'collect', 'colour', 'glob', 'semver'];

/** The middle of several rounds, because the mean of a noisy sample is a story about noise. */
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const round = (value, places = 2) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/**
 * Time one operation. `iterations` is per round; the answer is the median round, so one
 * unlucky garbage collection costs a round rather than the figure.
 */
function timed(name, work, { iterations = 20000, rounds = 7 } = {}) {
  for (let n = 0; n < Math.min(iterations, 2000); n += 1) work(n);
  const each = [];
  for (let r = 0; r < rounds; r += 1) {
    const start = performance.now();
    for (let n = 0; n < iterations; n += 1) work(n);
    each.push(performance.now() - start);
  }
  const ms = median(each);
  return {
    name,
    iterations,
    rounds,
    ms: round(ms, 3),
    opsPerSecond: Math.round((iterations / ms) * 1000),
    nsPerOp: round((ms * 1e6) / iterations, 1),
  };
}

/** How long a cold import costs, with the module cache stepped around by a query string. */
async function coldStart(file, rounds = 5) {
  const url = pathToFileURL(join(ROOT, file)).href;
  const each = [];
  for (let r = 0; r < rounds; r += 1) {
    const start = performance.now();
    await import(`${url}?bench=${r}`);
    each.push(performance.now() - start);
  }
  return round(median(each), 3);
}

/** Bytes and files under a directory, which is what an install actually costs you. */
function weigh(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const here = stack.pop();
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const full = join(here, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { bytes += statSync(full).size; files += 1; }
    }
  }
  return { bytes, files };
}

// The corpora. Fixed, generated here rather than read from a file, so the same work is timed
// on both sides of every comparison and nobody has to trust a fixture.

const VERSIONS = Array.from({ length: 40 }, (_, n) => `${(n % 9) + 1}.${(n * 3) % 20}.${(n * 7) % 30}`);
const RANGES = ['^7.0.0', '~1.2.3', '>=2.0.0 <5.0.0', '1.x || >=3.4.5', '*', '4.2.0 - 6.1.0'];
const PATHS = Array.from({ length: 40 }, (_, n) => `src/${'deep/'.repeat(n % 4)}part${n}.${n % 3 === 0 ? 'mjs' : 'js'}`);
const PATTERNS = ['src/**/*.mjs', 'src/*/part?.js', 'src/**/{part1,part2}.*', '!src/deep/**', 'src/[a-p]*/**'];
const ROWS = Array.from({ length: 60 }, (_, n) => ({
  id: n,
  meta: { kind: `k${n % 5}`, tags: [`t${n % 3}`, `t${n % 7}`], deep: { at: { last: n } } },
}));

/** One synthetic repository, big enough that a per-file cost is visible. */
function plantTree(count) {
  const root = mkdtempSync(join(tmpdir(), 'nirdep-bench-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'bench-subject',
    type: 'module',
    dependencies: { chalk: '^5.3.0', semver: '^7.5.0', lodash: '^4.17.21', minimist: '^1.2.8' },
  }, null, 2), 'utf8');
  const mentions = (n) => [
    `import chalk from ${JSON.stringify('chalk')};`,
    `import { satisfies } from ${JSON.stringify('semver')};`,
    `import { get } from ${JSON.stringify('lodash')};`,
    '',
    `export const line${n} = (v) => chalk.red.bold(satisfies(v, '^1.0.0') ? get({ a: 1 }, 'a') : 'no');`,
    '',
  ].join('\n');
  const plain = (n) => `export const quiet${n} = (a, b) => a + b;\n`;
  for (let n = 0; n < count; n += 1) {
    writeFileSync(join(root, 'src', `file${n}.mjs`), n % 3 === 0 ? mentions(n) : plain(n), 'utf8');
  }
  return root;
}

/** The reference packages, if the caller pointed at an installed copy of them. */
async function references(against) {
  if (against === null) return null;
  const { createRequire } = await import('node:module');
  const need = createRequire(join(against, 'bench-anchor.cjs'));
  const load = (name) => {
    try {
      const version = JSON.parse(readFileSync(join(against, name, 'package.json'), 'utf8')).version;
      return { version, api: need(name) };
    } catch (error) {
      return { version: null, api: null, why: error.message };
    }
  };
  return {
    dir: against,
    semver: load('semver'),
    minimatch: load('minimatch'),
    lodash: load('lodash'),
    chalk: load('chalk'),
  };
}

/** Same work, both sides, or one side and an honest null. */
function compare(name, ours, theirs, options) {
  const mine = timed(name, ours, options);
  const reference = theirs === null ? null : timed(name, theirs, options);
  return {
    name,
    ours: mine,
    reference,
    ratio: reference === null ? null : round(mine.opsPerSecond / reference.opsPerSecond, 2),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--against');
  const against = at === -1 ? null : argv[at + 1];
  const out = join(ROOT, 'bench.json');

  const semver = await import('../src/runtime/semver.mjs');
  const glob = await import('../src/runtime/glob.mjs');
  const collect = await import('../src/runtime/collect.mjs');
  const colour = await import('../src/runtime/colour.mjs');
  const reference = await references(against);
  const ref = (name) => (reference?.[name]?.api ?? null);

  // What the five files cost you to keep, against what they replace.
  const modules = [];
  for (const name of MODULES) {
    const file = `src/runtime/${name}.mjs`;
    const text = readFileSync(join(ROOT, file), 'utf8');
    const rules = RULES.filter((one) => one.subpath === `runtime/${name}`);
    modules.push({
      module: name,
      file,
      bytes: Buffer.byteLength(text),
      lines: text.split('\n').length - 1,
      replaces: rules.map((one) => one.package),
      weekly: rules.map((one) => one.weekly ?? null),
      coldStartMs: await coldStart(file),
    });
  }

  // Per-operation, ours against theirs. Every pair does identical work on identical input;
  // where a reference package is not on this machine the second half of the pair is null.
  const paint = colour.createColour({ level: 3 });
  const theirSemver = ref('semver');
  const theirMinimatch = ref('minimatch');
  const theirLodash = ref('lodash');
  const theirChalk = ref('chalk');
  const chalkAt3 = theirChalk === null ? null
    : (typeof theirChalk.Instance === 'function' ? new theirChalk.Instance({ level: 3 }) : theirChalk);
  const mm = theirMinimatch === null ? null : (theirMinimatch.minimatch ?? theirMinimatch);
  const pair = (n, list) => list[n % list.length];

  const operations = [
    compare('semver.satisfies',
      (n) => semver.satisfies(pair(n, VERSIONS), pair(n, RANGES)),
      theirSemver === null ? null : (n) => theirSemver.satisfies(pair(n, VERSIONS), pair(n, RANGES))),
    compare('semver.parse',
      (n) => semver.parse(pair(n, VERSIONS)),
      theirSemver === null ? null : (n) => theirSemver.parse(pair(n, VERSIONS))),
    compare('glob.minimatch',
      (n) => glob.minimatch(pair(n, PATHS), pair(n, PATTERNS)),
      mm === null ? null : (n) => mm(pair(n, PATHS), pair(n, PATTERNS))),
    compare('collect.get',
      (n) => collect.get(pair(n, ROWS), 'meta.deep.at.last'),
      theirLodash === null ? null : (n) => theirLodash.get(pair(n, ROWS), 'meta.deep.at.last')),
    compare('collect.cloneDeep',
      (n) => collect.cloneDeep(pair(n, ROWS)),
      theirLodash === null ? null : (n) => theirLodash.cloneDeep(pair(n, ROWS)), { iterations: 5000 }),
    compare('collect.isEqual',
      (n) => collect.isEqual(pair(n, ROWS), pair(n + 1, ROWS)),
      theirLodash === null ? null : (n) => theirLodash.isEqual(pair(n, ROWS), pair(n + 1, ROWS))),
    compare('collect.groupBy',
      () => collect.groupBy(ROWS, 'meta.kind'),
      theirLodash === null ? null : () => theirLodash.groupBy(ROWS, 'meta.kind'), { iterations: 2000 }),
    compare('colour.red.bold',
      () => paint.red.bold('build failed'),
      chalkAt3 === null ? null : () => chalkAt3.red.bold('build failed')),
  ];

  // And the tool on a repository, which is the number a person actually waits on.
  const files = 300;
  const tree = plantTree(files);
  const pipeline = [];
  try {
    const stage = (name, work, note = null) => {
      const each = [];
      let last = null;
      for (let r = 0; r < 5; r += 1) {
        const start = performance.now();
        last = work();
        each.push(performance.now() - start);
      }
      const ms = median(each);
      pipeline.push({ name, files, ms: round(ms, 2), filesPerSecond: Math.round((files / ms) * 1000), note });
      return last;
    };
    stage('scan', () => scanProject(tree), 'every file lexed, every import resolved, the lockfile read');
    const plan = stage('plan', () => planProject(tree, { runtimeDir: 'vendor/nirdep' }),
      'bindings resolved and the byte ranges worked out, nothing written');
    stage('apply, real syntax gate', () => applyProject(plan, { write: false }),
      'each rewritten file goes to Node\'s own parser, which is a process spawn per file');
    stage('apply, lexer gate only', () => applyProject(plan, { write: false, check: checkByLexer }),
      'the same run with the browser\'s weaker check, so the gate\'s price is visible');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }

  const install = [];
  for (const name of ['chalk', 'semver', 'minimatch', 'lodash']) {
    const entry = reference?.[name] ?? null;
    if (entry === null || entry.version === null) continue;
    install.push({ package: name, version: entry.version, ...weigh(join(against, name)) });
  }

  const data = {
    version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    measured: new Date().toISOString().slice(0, 10),
    node: process.version,
    cpu: cpus()[0]?.model ?? null,
    platform: `${process.platform} ${process.arch}`,
    referenceDir: against === null ? null : 'an npm install outside this repository',
    modules,
    operations,
    pipeline,
    install,
  };
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  const width = (text, n) => String(text).padEnd(n);
  console.log(`bench.json written -- ${modules.length} modules, ${operations.length} operations, node ${process.version}`);
  for (const one of operations) {
    const theirs = one.reference === null ? 'not measured here' : `${one.reference.opsPerSecond.toLocaleString('en-US')}/s`;
    const ratio = one.ratio === null ? '' : ` (${one.ratio}x)`;
    console.log(`  ${width(one.name, 22)} ${width(`${one.ours.opsPerSecond.toLocaleString('en-US')}/s`, 16)} vs ${theirs}${ratio}`);
  }
  for (const one of pipeline) console.log(`  ${width(one.name, 22)} ${one.ms} ms for ${one.files} files (${one.filesPerSecond}/s)`);
  if (install.length === 0) console.log('  no reference packages measured: pass --against <node_modules> to compare on disk');
}

await main();
