#!/usr/bin/env node
// nirdep -- delete your dependencies.
//
// Published by Nastik AI. Developed by Hardik.
//
// This entry point stays thin on purpose. It reads its own metadata, builds one
// colour instance per stream, and hands a command table to createCli. Dispatch,
// generated help, did-you-mean, usage errors and exit codes all come from
// src/runtime/args.mjs; styling comes from src/runtime/colour.mjs. There is no
// argument parsing here and no help string written by hand.
//
// nirdep running on its own replacements for chalk, supports-color, minimist and
// commander is the whole correctness argument -- see STDLIB.md.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseToml } from '../src/meta/toml.mjs';
import { createColour } from '../src/runtime/colour.mjs';
import { createCli, EXIT, suggest } from '../src/runtime/args.mjs';
import { planProject, applyProject, DEFAULT_RUNTIME_DIR } from '../src/apply/project.mjs';
import { planReport, applyReport, exitCodeFor } from '../src/apply/report.mjs';
import { scanProject } from '../src/scan/project.mjs';
import { scanReport, scanExitCode } from '../src/scan/report.mjs';
import { catalogue, ejectPlan, ejectApply } from '../src/eject/project.mjs';
import { ejectReport, ejectList, ejectExitCode } from '../src/eject/report.mjs';
import { explainPackage, explainReport, explainList, explainExitCode } from '../src/explain/report.mjs';
import { guardProject, guardExitCode } from '../src/guard/project.mjs';
import { guardReport } from '../src/guard/report.mjs';
import { POLICY_FILE } from '../src/guard/policy.mjs';
import { conformancePlan, onlyModules } from '../src/conformance/plan.mjs';
import { runConformance, conformanceExitCode } from '../src/conformance/run.mjs';
import { conformanceReport } from '../src/conformance/report.mjs';
import { stdlibDocument } from '../src/stdlib/document.mjs';
import { stdlibAdoption, stdlibApply, stdlibPlan, STDLIB_FILE } from '../src/stdlib/project.mjs';
import { stdlibReport, stdlibExitCode } from '../src/stdlib/report.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Two instances, each detecting against the stream it writes to: piping stdout to
// a file must not strip the colour from an error still going to a terminal. This
// is nirdep running on its own replacement for supports-color, and the tests in
// tests/cli/ pass because a pipe detects level 0 and every style becomes the
// identity function, which is exactly the behaviour being claimed.
const out = createColour({ stream: process.stdout });
const err = createColour({ stream: process.stderr });

/** The six hooks runtime/args asks for, bound to one colour instance. */
const styleOf = (instance) => ({
  bold: (text) => instance.bold(text),
  dim: (text) => instance.dim(text),
  cyan: (text) => instance.cyan(text),
  yellow: (text) => instance.yellow(text),
  green: (text) => instance.green(text),
  red: (text) => instance.red(text),
});

function readMeta() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  let submission = null;
  try {
    submission = parseToml(readFileSync(join(ROOT, '.zero-dep.toml'), 'utf8'));
  } catch {
    // The metadata file is optional at runtime; absence is not an error.
  }
  return { manifest, submission };
}

const meta = readMeta();

function about() {
  const { manifest, submission } = meta;
  const field = (name) => out.dim(`${name}:`.padEnd(22));
  return [
    `${out.bold('nirdep')} ${out.cyan(manifest.version)}`,
    '',
    `${out.bold('nir')} (Sanskrit, "without") + ${out.bold('dep')}. Deletes your dependencies: a scope-aware`,
    'JavaScript codemod plus a standard-library runtime that replace the',
    'most-installed packages on npm.',
    '',
    `Published by ${out.bold('Nastik AI')}. Developed by ${out.bold('Hardik')}.`,
    `${field('Licence')}${manifest.license}`,
    `${field('Requires')}Node ${manifest.engines.node}   ${out.dim(`(running ${process.version})`)}`,
    `${field('Runtime dependencies')}${out.green('0')}   ${out.dim('(run "make verify" for the proof)')}`,
    `${field('Hackathon')}Zero Dependency, track ${submission?.track ?? '?'}.`,
    '',
  ].join('\n');
}

// `plan` and `apply` are the same walk with one bit flipped, so they share their
// options and their reader. Keeping them one function is not a saving of lines; it
// is the guarantee that the diff you were shown is the diff that gets written.
const WORK_OPTIONS = {
  runtime: {
    type: 'string',
    describe: 'directory the ejected runtime lives in, relative to the project; '
      + 'imports are rewritten to a path into it rather than to the nirdep package',
  },
  context: { type: 'number', default: 3, describe: 'lines of context in the diff' },
  // Declared positive and negated by the parser, which is where --no-diff comes from:
  // spelling the negative form out as its own option would have produced two flags that
  // disagree with each other the first time somebody passed both.
  diff: { type: 'boolean', default: true, describe: 'include the unified diff' },
};

const WORK_POSITIONALS = [
  { name: 'path', describe: 'project directory to read (default: the current one)' },
];

// The walker swallows ENOENT at every level, which is right for a directory that
// vanishes mid-walk and wrong for the one the user named: a typo would otherwise be
// reported as a spotless project. So the root, and only the root, is checked up front.
function unreadableRoot(root) {
  let stat;
  try {
    stat = statSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return 'there is nothing there';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'it cannot be read';
    return error.message;
  }
  return stat.isDirectory() ? null : 'it is a file, not a directory';
}

function work(context, { write }) {
  const root = projectRoot(context);
  if (root === null) return EXIT.USAGE;
  const plan = planProject(root, { runtimeDir: context.options.runtime ?? null });
  if (!write) {
    context.out(planReport(plan, {
      style: context.style,
      context: context.options.context,
      diff: context.options.diff !== false,
    }));
  }
  const run = applyProject(plan, { write });
  if (write) context.out(applyReport(run, { style: context.style }));
  return exitCodeFor(run);
}

/** The directory a command was pointed at, or null once it has complained about it. */
function projectRoot(context) {
  const root = resolve(context.positionals.path ?? '.');
  const complaint = unreadableRoot(root);
  if (complaint === null) return root;
  context.err(`${context.errStyle.red('nirdep:')} ${context.command}: cannot read `
    + `${context.errStyle.bold(root)}: ${complaint}.\n`);
  return null;
}

// `scan` reads and never writes, which is why it is the command to run first and the
// only one that is safe to point at somebody else's repository.
function scan(context) {
  const root = projectRoot(context);
  if (root === null) return EXIT.USAGE;
  const result = scanProject(root);
  context.out(scanReport(result, { style: context.style }));
  return scanExitCode(result);
}

// `eject` is the other half of `apply --runtime`: one writes imports that point into a
// directory, this one puts the files there. Both default to the same directory, from the
// same constant, so the pair works without either flag being passed.
function eject(context) {
  if (context.options.list === true) {
    context.out(ejectList(catalogue(), { style: context.style }));
    return EXIT.OK;
  }
  const plan = ejectPlan({
    modules: context.positionals.module ?? [],
    into: context.options.into,
    cwd: process.cwd(),
  });
  const run = ejectApply(plan, {
    write: context.options['dry-run'] !== true,
    force: context.options.force === true,
  });
  context.out(ejectReport(run, { style: context.style }));
  return ejectExitCode(run);
}

// `guard` is `scan` with an opinion and an exit code. It is the command that goes in CI,
// which is why the policy comes off disk rather than out of flags: a rule somebody wrote
// down and committed is reviewable, and a rule spelled out in a workflow file is not.
function guard(context) {
  const root = projectRoot(context);
  if (root === null) return EXIT.USAGE;
  const result = guardProject(root, {
    policyFile: context.options.policy ?? null,
    overrides: {
      // Only what was actually typed. `dev` defaults to true inside the policy, so reading
      // the flag's own default here would silently overrule a policy that said false.
      dev: context.provided.has('dev') ? context.options.dev : undefined,
      max: context.provided.has('max') ? context.options.max : undefined,
      allow: context.provided.has('allow') ? context.options.allow : undefined,
    },
  });
  context.out(guardReport(result, { style: context.style }));
  return guardExitCode(result);
}

// `conformance` is the only command that reports on nirdep instead of on your project, so
// it takes module names rather than a path. It runs the real suite in a child process: the
// files under tests/runtime are already the only definition of what a vector means, and a
// second executor living in src/ would be a second definition that nobody runs.
function conformance(context) {
  const { plan, unknown } = onlyModules(conformancePlan(), context.positionals.module ?? []);
  if (unknown.length > 0) {
    const known = conformancePlan().modules.map((one) => one.name);
    const near = suggest(unknown[0], known);
    context.err(`${context.errStyle.red('nirdep:')} conformance: no runtime module `
      + `${context.errStyle.bold(unknown[0])}`
      + `${near.length > 0 ? `, did you mean ${near.join(' or ')}?` : `. There are ${known.join(', ')}.`}\n`);
    return EXIT.USAGE;
  }
  const result = runConformance(plan);
  context.out(conformanceReport(result, { style: context.style, verbose: context.options.verbose > 0 }));
  return conformanceExitCode(result);
}

// `stdlibmd` writes the document this competition asks every entry for, about the project it
// is pointed at. It prints to stdout by default so it can be redirected or read before it is
// believed; --write puts it on disk and refuses to clobber a version somebody has edited.
function stdlibmd(context) {
  const root = projectRoot(context);
  if (root === null) return EXIT.USAGE;
  const document = stdlibDocument(scanProject(root), {
    adoption: stdlibAdoption(root),
    version: meta.manifest.version,
  });
  if (context.options.write !== true) {
    context.out(document.markdown);
    return EXIT.OK;
  }
  const run = stdlibApply(
    stdlibPlan(document, { root, file: context.options.out }),
    { write: context.options['dry-run'] !== true, force: context.options.force === true },
  );
  context.out(stdlibReport(run, { style: context.style }));
  return stdlibExitCode(run);
}

// `explain` answers the question a reviewer asks about any codemod: how do you know that
// was safe? One package name in, and out comes the rule, what Node already does, and the
// import forms the rewriter refuses along with the reason for each refusal.
function explain(context) {
  const name = context.positionals.package;
  if (name === undefined || name === '') {
    context.out(explainList({ style: context.style }));
    return EXIT.OK;
  }
  const answer = explainPackage(name);
  context.out(explainReport(answer, { style: context.style }));
  return explainExitCode(answer);
}

// Every command in the plan, and every one of them now implemented. The table used
// to carry `ready: false` rows, which printed as (pending) and exited 3 rather than
// pretending to work; the mechanism stays in src/runtime/args.mjs because a half
// finished command is a thing to declare, not to hide, but there is nothing left
// here to declare. Options and positionals arrive with the implementations, so
// nothing here describes a flag that does not work.
const app = createCli({
  name: 'nirdep',
  version: meta.manifest.version,
  tagline: 'delete your dependencies',
  describe: 'nir (Sanskrit, "without") + dep. A scope-aware JavaScript codemod and a '
    + 'standard-library runtime that together replace the most-installed packages on npm.',
  footer: 'Every command above is implemented. "make conformance" is the receipt.\n'
    + 'Published by Nastik AI. Developed by Hardik.',
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  style: styleOf(out),
  errStyle: styleOf(err),
  env: process.env,
  options: {
    colour: { type: 'boolean', default: true, describe: 'styled output; NO_COLOR and FORCE_COLOR are honoured' },
    // The American spelling, hidden: the project is written in British English,
    // but nobody should have to guess which one this binary wants.
    color: { type: 'boolean', default: true, hidden: true },
    verbose: { type: 'count', short: 'v', describe: 'say more; repeat for more still' },
  },
  commands: {
    scan: {
      describe: 'report replaceable dependencies and their blast radius',
      positionals: WORK_POSITIONALS,
      run: (context) => scan(context),
    },
    plan: {
      describe: 'show the rewrite as a unified diff, change nothing',
      options: WORK_OPTIONS,
      positionals: WORK_POSITIONALS,
      run: (context) => work(context, { write: false }),
    },
    apply: {
      describe: 'rewrite call sites, gated through a syntax check',
      options: WORK_OPTIONS,
      positionals: WORK_POSITIONALS,
      run: (context) => work(context, { write: true }),
    },
    eject: {
      describe: 'copy a runtime module into your own tree, no package required',
      options: {
        into: {
          type: 'string',
          default: DEFAULT_RUNTIME_DIR,
          describe: 'directory to write into, relative to here',
        },
        force: { type: 'boolean', describe: 'overwrite a file that differs from ours' },
        'dry-run': { type: 'boolean', describe: 'say what would be written and write nothing' },
        list: { type: 'boolean', describe: 'show the modules and what each one replaces' },
      },
      positionals: [
        { name: 'module', variadic: true, describe: 'which modules to copy (default: all of them)' },
      ],
      run: (context) => eject(context),
    },
    guard: {
      describe: 'CI mode: fail if a replaceable dependency reappears',
      options: {
        policy: { type: 'string', describe: `policy file to read (default: ${POLICY_FILE}, then package.json)` },
        dev: { type: 'boolean', default: true, describe: 'count devDependencies as dependencies' },
        max: { type: 'number', describe: 'fail above this many direct dependencies' },
        allow: { type: 'string', multiple: true, describe: 'a package to permit this run, repeatable' },
      },
      positionals: WORK_POSITIONALS,
      run: (context) => guard(context),
    },
    conformance: {
      describe: 'run the vector corpus: pass, fail and skip counts per runtime module',
      positionals: [
        { name: 'module', variadic: true, describe: 'which modules to check (default: all of them)' },
      ],
      run: (context) => conformance(context),
    },
    stdlibmd: {
      describe: "generate the target project's STDLIB.md from its own dependencies",
      options: {
        write: { type: 'boolean', describe: 'write the file instead of printing it' },
        out: { type: 'string', default: STDLIB_FILE, describe: 'file to write, relative to the project' },
        force: { type: 'boolean', describe: 'replace a file that says something else' },
        'dry-run': { type: 'boolean', describe: 'say what would be written and write nothing' },
      },
      positionals: WORK_POSITIONALS,
      run: (context) => stdlibmd(context),
    },
    explain: {
      describe: 'why a package can be replaced, and whether a machine may do it',
      positionals: [
        { name: 'package', describe: 'a package name (default: list all of them)' },
      ],
      run: (context) => explain(context),
    },
    about: { describe: 'attribution, version and supported Node range', run: (context) => { context.out(about()); } },
    help: { describe: 'this text', run: (context) => { context.out(app.help()); } },
  },
});

const argv = process.argv.slice(2);

// --colour is parsed per command, which is too late to decide how to paint the
// help text, so the two spellings are read straight off argv before anything is
// written. NO_COLOR and FORCE_COLOR are already handled inside createColour.
if (['--no-colour', '--no-color', '--colour=false', '--color=false'].some((flag) => argv.includes(flag))) {
  out.level = 0;
  err.level = 0;
}

// --about is the spelling people try first, and createCli has no hook for a flag
// that runs before dispatch. Rewriting it into the command it aliases is a line;
// inventing a hook for one alias would be a feature.
process.exitCode = app.run(argv[0] === '--about' ? ['about', ...argv.slice(1)] : argv);
