// The framework layer: dispatch, generated help and exit codes -- the part
// commander and yargs add on top of a parser. Streams and the environment are
// injected, so every case here drives the real dispatcher and reads its real
// output without spawning a process. tests/cli/entry.test.mjs does the spawning,
// once, against the shipped binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCli, EXIT } from '../../src/runtime/args.mjs';

/** A CLI wired to string sinks. Returns the app plus what it wrote. */
function harness(overrides = {}) {
  const written = { out: '', err: '' };
  const calls = [];
  const app = createCli({
    name: 'nirdep',
    version: '0.1.0',
    tagline: 'delete your dependencies',
    footer: 'Published by Nastik AI. Developed by Hardik.',
    out: (text) => { written.out += text; },
    err: (text) => { written.err += text; },
    options: {
      colour: { type: 'boolean', default: true, describe: 'styled output' },
      verbose: { type: 'count', short: 'v', describe: 'say more' },
    },
    commands: {
      scan: {
        describe: 'report replaceable dependencies',
        positionals: [{ name: 'target', required: true, describe: 'the project' }],
        options: { json: { type: 'boolean', describe: 'machine-readable' } },
        run: (context) => { calls.push(context); return undefined; },
      },
      plan: { describe: 'show the rewrite as a diff', ready: false },
      guard: { describe: 'fail if a dependency reappears', run: () => 7 },
      orphan: { describe: 'declared with no implementation' },
      secret: { describe: 'not in the help', hidden: true, run: () => 0 },
    },
    ...overrides,
  });
  return { app, written, calls, run: (...argv) => app.run(argv) };
}

test('no arguments prints the root help and succeeds', () => {
  const { written, run } = harness();
  assert.equal(run(), EXIT.OK);
  assert.match(written.out, /^nirdep 0\.1\.0 -- delete your dependencies/);
  assert.match(written.out, /Usage: nirdep <command> \[options\]/);
  assert.match(written.out, /Commands:/);
  assert.equal(written.err, '', 'help is not an error');
});

test('the three arguments that must always work', () => {
  for (const flag of ['--help', '-h']) {
    const { written, run } = harness();
    assert.equal(run(flag), EXIT.OK);
    assert.match(written.out, /Commands:/, flag);
  }
  for (const flag of ['--version', '-V']) {
    const { written, run } = harness();
    assert.equal(run(flag), EXIT.OK);
    assert.equal(written.out, '0.1.0\n', flag);
  }
});

test('the command list marks what is not built yet', () => {
  const { written, run } = harness();
  run();
  assert.match(written.out, /scan\s+report replaceable dependencies/);
  assert.match(written.out, /plan \(pending\)\s+show the rewrite as a diff/);
  assert.ok(!written.out.includes('not in the help'), 'a hidden command stays hidden');
  assert.ok(written.out.endsWith('Published by Nastik AI. Developed by Hardik.\n'));
});

test('a hidden command still runs', () => {
  const { run } = harness();
  assert.equal(run('secret'), EXIT.OK);
});

test('a command receives its parsed arguments', () => {
  const { calls, run } = harness();
  assert.equal(run('scan', './project', '--json', '-vv', '--', '--raw'), EXIT.OK);
  assert.equal(calls.length, 1);
  const [context] = calls;
  assert.equal(context.command, 'scan');
  assert.equal(context.positionals.target, './project');
  assert.equal(context.options.json, true);
  assert.equal(context.options.verbose, 2, 'a global option is merged into the command spec');
  assert.equal(context.options.colour, true, 'and so is its default');
  assert.deepEqual(context.rest, ['--raw']);
  assert.equal(typeof context.help, 'function');
});

test('a global option may come before the command name', () => {
  const { calls, run } = harness();
  assert.equal(run('--no-colour', 'scan', './p'), EXIT.OK);
  assert.equal(calls[0].options.colour, false);
  assert.equal(calls[0].positionals.target, './p');
});

test("a command's return value is the exit code", () => {
  const { run } = harness();
  assert.equal(run('guard'), 7);
});

test('an unimplemented command exits 3 and says so once', () => {
  const { written, run } = harness();
  assert.equal(run('plan'), EXIT.UNIMPLEMENTED);
  assert.match(written.err, /nirdep: "plan" is not implemented yet\./);
  assert.equal(written.out, '', 'nothing on stdout, so a pipe stays clean');
});

test('a command declared without an implementation is our bug, not the user\'s', () => {
  const { written, run } = harness();
  assert.equal(run('orphan'), EXIT.RUNTIME);
  assert.match(written.err, /has no implementation attached/);
});

test('an unknown command exits 2 with a suggestion', () => {
  const { written, run } = harness();
  assert.equal(run('sacn', './p'), EXIT.USAGE);
  assert.match(written.err, /unknown command "sacn"; did you mean scan\?/);
  assert.match(written.err, /Run "nirdep help" for the command list\./);
});

test('a command that is nothing like ours gets no invented suggestion', () => {
  const { written, run } = harness();
  assert.equal(run('xylophone'), EXIT.USAGE);
  assert.match(written.err, /unknown command "xylophone"\n/);
  assert.ok(!written.err.includes('did you mean'));
});

test('a usage error names the command and points at its help', () => {
  const { written, run } = harness();
  assert.equal(run('scan'), EXIT.USAGE);
  assert.match(written.err, /nirdep: scan: <target> is required/);
  assert.match(written.err, /Run "nirdep help scan" for the options\./);
});

test('an unknown option on a command is a usage error, with a suggestion', () => {
  const { written, run } = harness();
  assert.equal(run('scan', './p', '--jsen'), EXIT.USAGE);
  assert.match(written.err, /unknown option --jsen; did you mean --json\?/);
});

test('help for a command renders that command, not the root', () => {
  const { written, run } = harness();
  assert.equal(run('help', 'scan'), EXIT.OK);
  assert.match(written.out, /^nirdep scan\n/);
  assert.match(written.out, /Usage: nirdep scan \[options\] <target>/);
  assert.match(written.out, /--json\s+machine-readable/);
  assert.match(written.out, /-v, --verbose\s+say more/, 'the global options are listed too');
  assert.ok(!written.out.includes('Commands:'), 'a command has no subcommands');
});

test('--help anywhere after the command shows the command help', () => {
  for (const argv of [['scan', '--help'], ['scan', './p', '--help'], ['scan', '-h']]) {
    const { written, run } = harness();
    assert.equal(run(...argv), EXIT.OK, argv.join(' '));
    assert.match(written.out, /Usage: nirdep scan/, argv.join(' '));
  }
});

test('help for an unknown command is a usage error, not an empty page', () => {
  const { written, run } = harness();
  assert.equal(run('help', 'sacn'), EXIT.USAGE);
  assert.match(written.err, /did you mean scan\?/);
});

test('bare help is the root help', () => {
  const { written, run } = harness();
  assert.equal(run('help'), EXIT.OK);
  assert.match(written.out, /Commands:/);
});

test('the injected environment is what the commands see', () => {
  const written = { out: '', err: '' };
  const seen = [];
  const app = createCli({
    name: 'nirdep',
    version: '0.1.0',
    env: { NIRDEP_OUT: 'from-env' },
    out: (text) => { written.out += text; },
    err: (text) => { written.err += text; },
    commands: {
      scan: {
        options: { output: { type: 'string', env: 'NIRDEP_OUT' } },
        run: (context) => { seen.push(context.options.output); },
      },
    },
  });
  assert.equal(app.run(['scan']), EXIT.OK);
  assert.equal(app.run(['scan', '--output=explicit']), EXIT.OK);
  assert.deepEqual(seen, ['from-env', 'explicit'], 'the environment fills in, the flag overrides');
});

test('the style hooks reach both the help and the errors', () => {
  const { written, run } = harness({ style: { red: (text) => `<r>${text}</r>`, bold: (text) => `<b>${text}</b>` } });
  assert.equal(run('nope'), EXIT.USAGE);
  assert.match(written.err, /<r>nirdep:<\/r> unknown command <b>"nope"<\/b>/);
});

test('stderr is styled independently of stdout', () => {
  // Capability detection is per stream, so the two sinks get their own style
  // objects: piping stdout to a file must not strip the colour from a message
  // still going to a terminal. bin/nirdep.mjs passes two colour instances in
  // for exactly this reason, and this is the test that says the wiring works.
  const { written, run } = harness({
    style: { bold: (text) => `<out>${text}</out>` },
    errStyle: { bold: (text) => `<err>${text}</err>`, red: (text) => `[${text}]` },
  });
  assert.equal(run('nope'), EXIT.USAGE);
  assert.match(written.err, /\[nirdep:\] unknown command <err>"nope"<\/err>/, 'the error uses errStyle');
  assert.ok(!written.err.includes('<out>'), 'and not the stdout style');
  const help = harness({
    style: { bold: (text) => `<out>${text}</out>` },
    errStyle: { bold: (text) => `<err>${text}</err>` },
  });
  assert.equal(help.run('help'), EXIT.OK);
  assert.match(help.written.out, /<out>Commands:<\/out>/, 'the help uses style');
  assert.ok(!help.written.out.includes('<err>'), 'and not the stderr style');
});

test('errStyle falls back to style when only one opinion is given', () => {
  const { written, run } = harness({ style: { red: (text) => `<r>${text}</r>` } });
  assert.equal(run('nope'), EXIT.USAGE);
  assert.match(written.err, /<r>nirdep:<\/r>/, 'one style object paints both streams');
});

test('exit codes are the documented set, and distinct', () => {
  assert.deepEqual(EXIT, { OK: 0, RUNTIME: 1, USAGE: 2, UNIMPLEMENTED: 3 });
  assert.equal(Object.isFrozen(EXIT), true);
});

test('a thrown error that is not an ArgsError is not swallowed', () => {
  const app = createCli({
    name: 'nirdep',
    out: () => {},
    err: () => {},
    commands: { scan: { run: () => { throw new TypeError('a real bug'); } } },
  });
  assert.throws(() => app.run(['scan']), TypeError, 'the dispatcher does not hide a genuine crash');
});
