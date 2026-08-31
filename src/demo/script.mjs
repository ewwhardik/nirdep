// `nirdep demo` -- the whole argument, on a project that exists for about a second.
//
// Every other command reports on a tree somebody else owns, which makes them awkward to
// show: a judge with no project to hand has nothing to point them at, and a screenshot of
// a report proves nothing about a report. So this one brings its own project, and the only
// claim it makes is one you can watch happen -- a file that cannot load, then the same
// file running, with nothing installed in between.
//
// It is a composition and not a re-implementation. Every stage below calls the same
// function the corresponding command calls, so a demo that passes and a command that fails
// is not a state this file can be in.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { planProject, applyProject } from '../apply/project.mjs';
import { planReport, applyReport } from '../apply/report.mjs';
import { scanProject } from '../scan/project.mjs';
import { scanReport } from '../scan/report.mjs';
import { ejectPlan, ejectApply } from '../eject/project.mjs';
import { ejectReport } from '../eject/report.mjs';
import { styleOf } from '../text/format.mjs';

/** The fixture, as data. project.json's own note says why it is not a .mjs file. */
export const DEMO = Object.freeze(JSON.parse(
  readFileSync(new URL('./project.json', import.meta.url), 'utf8'),
));

/** The stages, in order, so a caller can number them before the first one has run. */
export const DEMO_STAGES = Object.freeze([
  'plant', 'before', 'scan', 'plan', 'eject', 'apply', 'after',
]);

/** The default writer, kept as a seam so a test can plant a tree without a disk. */
const saveFile = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

/**
 * Write the demo project into `at`.
 *
 * @param {string} at directory to write into
 * @param {{ save?: (file: string, text: string) => void }} [options]
 * @returns {string} the directory, for chaining
 */
export function plantDemo(at, options = {}) {
  const save = options.save ?? saveFile;
  for (const [path, text] of Object.entries(DEMO.project)) save(join(at, path), text);
  return at;
}

/** The runtime modules this project turns out to need, taken from the plan's own targets. */
export const modulesFor = (plan) => [...new Set(
  plan.changes.map((change) => basename(change.target, '.mjs')),
)].sort();

/** One step of the walkthrough, as data, so the renderer has no decisions left to make. */
const stage = (name, title, command, text, ok = true) => Object.freeze({
  name, title, command, text, ok,
});

const firstLine = (text) => String(text).split('\n')[0];

/**
 * Import a module and expect to be turned away.
 *
 * This is the one claim in the demo a reader cannot check for themselves, so if the
 * import unexpectedly succeeds it says so, rather than narrating a failure that did not
 * happen.
 */
async function refused(file, load) {
  try {
    await load(pathToFileURL(file).href);
    return { ok: false, message: 'it loaded, so something is installed after all' };
  } catch (error) {
    return { ok: true, message: `${error.code ?? 'Error'}: ${firstLine(error.message)}` };
  }
}

/** Arguments as somebody would have typed them, cut to fit a line. */
const asTyped = (value) => {
  const text = JSON.stringify(value);
  return text.length <= 34 ? text : `${text.slice(0, 31)}...`;
};

/** Call each export the fixture nominates and compare what came back with what it promised. */
async function demonstrate(at, load) {
  const results = [];
  for (const check of DEMO.demonstrate) {
    const label = `${check.export}(${check.arguments.map(asTyped).join(', ')})`;
    try {
      // Three imports, one after another, because the order is half the story.
      const module = await load(pathToFileURL(join(at, check.module)).href);
      const got = String(module[check.export](...check.arguments));
      const plain = stripVTControlCharacters(got);
      results.push({ ...check, label, got, plain, ok: plain === check.expect, error: null });
    } catch (error) {
      results.push({
        ...check, label, got: null, plain: null, ok: false, error: firstLine(error.message),
      });
    }
  }
  return results;
}

/** The fixture as a listing, so the sizes make it plain how small the project is. */
function treeText(s) {
  const paths = Object.keys(DEMO.project).sort();
  const width = Math.max(...paths.map((path) => path.length));
  return paths.map((path) => `  ${path.padEnd(width)}  `
    + s.dim(`${Buffer.byteLength(DEMO.project[path])} bytes`)).join('\n');
}

/** The payoff, printed with whatever the ejected colour module decided to emit. */
const checksText = (checks, s) => checks.map((one) => {
  const head = one.error === null
    ? `  ${s.green('->')} ${one.label} ${s.dim('=')} ${one.got}`
      + (one.ok ? '' : ` ${s.red(`expected ${one.expect}`)}`)
    : `  ${s.red('->')} ${one.label} ${s.red(one.error)}`;
  return `${head}\n     ${s.dim(one.why)}`;
}).join('\n');

/**
 * Run the walkthrough.
 *
 * Stages are emitted as they finish, because the point is watching it happen and a wall
 * of text that arrives at once is not that. The return value carries the same list plus
 * every underlying result, for the tests and for anyone who would rather have the numbers
 * than the prose.
 *
 * @param {{ root: string, style?: object, emit?: (stage: object) => void,
 *   load?: (url: string) => Promise<object>, context?: number, diff?: boolean,
 *   save?: (file: string, text: string) => void }} options
 */
export async function runDemo(options) {
  const { root, style } = options;
  const emit = options.emit ?? (() => {});
  const load = options.load ?? ((url) => import(url));
  const s = styleOf(style);
  const stages = [];
  const step = (one) => { stages.push(one); emit(one); return one; };
  const at = join(root, 'project');

  plantDemo(at, options);
  plantDemo(join(root, 'before'), options);
  step(stage('plant', 'A project with six dependencies and no node_modules',
    `cd ${DEMO.name}`, treeText(s)));

  const entry = DEMO.demonstrate[0].module;
  const before = await refused(join(root, 'before', entry), load);
  step(stage('before', 'As it stands, it cannot load at all',
    `node --input-type=module -e "import './${entry}'"`,
    `  ${(before.ok ? s.red : s.yellow)(before.message)}\n`
    + `  ${s.dim('a rejected import is cached by its URL, so that was a second copy of the')}\n`
    + `  ${s.dim('tree; the one every stage below works on has never been imported.')}`,
    before.ok));

  const scanned = scanProject(at);
  step(stage('scan', 'What is in there, and what is already wrong with it',
    'nirdep scan', scanReport(scanned, { style }).trimEnd()));

  const plan = planProject(at, { runtimeDir: DEMO.runtimeDir });
  step(stage('plan', 'What a machine may change, and what it may not',
    `nirdep plan --runtime ${DEMO.runtimeDir}`,
    planReport(plan, { style, context: options.context ?? 2, diff: options.diff !== false }).trimEnd()));

  const modules = modulesFor(plan);
  const ejected = ejectApply(ejectPlan({ cwd: at, into: DEMO.runtimeDir, modules }), { write: true });
  step(stage('eject', 'The replacements, copied in as ordinary files you own',
    `nirdep eject ${modules.join(' ')} --into ${DEMO.runtimeDir}`,
    ejectReport(ejected, { style }).trimEnd()));

  const applied = applyProject(plan, { write: true });
  step(stage('apply', 'Rewritten, every file through the syntax gate first',
    `nirdep apply --runtime ${DEMO.runtimeDir}`, applyReport(applied, { style }).trimEnd()));

  const checks = await demonstrate(at, load);
  step(stage('after', 'The same files, running, with nothing installed',
    'node', checksText(checks, s), checks.every((one) => one.ok)));

  return Object.freeze({
    root: at,
    stages: Object.freeze(stages),
    scanned,
    plan,
    ejected,
    applied,
    modules: Object.freeze(modules),
    checks: Object.freeze(checks),
    ok: stages.every((one) => one.ok),
  });
}
