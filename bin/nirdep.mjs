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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseToml } from '../src/meta/toml.mjs';
import { createColour } from '../src/runtime/colour.mjs';
import { createCli } from '../src/runtime/args.mjs';

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

// Every command that will exist, with the ones that do not yet marked. A table
// that lists the whole plan and says plainly which parts are unfinished is worth
// more than a short table that pretends to be complete; `ready: false` is what
// turns a name into an honest exit code 3 rather than a silent no-op. Options and
// positionals arrive with the implementations, so nothing here describes a flag
// that does not work.
const app = createCli({
  name: 'nirdep',
  version: meta.manifest.version,
  tagline: 'delete your dependencies',
  describe: 'nir (Sanskrit, "without") + dep. A scope-aware JavaScript codemod and a '
    + 'standard-library runtime that together replace the most-installed packages on npm.',
  footer: '(pending) commands are not implemented yet: they exit 3 and change nothing.\n'
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
    scan: { describe: 'report replaceable dependencies and their blast radius', ready: false },
    plan: { describe: 'show the rewrite as a unified diff, change nothing', ready: false },
    apply: { describe: 'rewrite call sites, gated through a syntax check', ready: false },
    eject: { describe: 'write nirdep/runtime into the target project', ready: false },
    guard: { describe: 'CI mode: fail if a replaceable dependency reappears', ready: false },
    conformance: { describe: 'pass, fail and skip counts per runtime module', ready: false },
    stdlibmd: { describe: "generate the target project's STDLIB.md", ready: false },
    explain: { describe: 'the replacement for a package, and the Node version it landed in', ready: false },
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
