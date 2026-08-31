// Conformance for runtime/args, the parser layer. The table in
// tests/vectors/args/parse.json is the contract and this file only drives it, so
// adding a case never means touching code. What stays here is everything a JSON
// table cannot express: functions in a spec, thrown SpecErrors, and the two
// prototype-pollution proofs, which have to look at the prototype itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse, normaliseSpec, tokenise, isSafeKey, toKebab, toCamel,
  parseNumber, parseBoolean, editDistance, suggest,
  visibleWidth, wrap, columns, optionLabel, usageLine, renderHelp,
  ArgsError, SpecError,
} from '../../src/runtime/args.mjs';

const ESC = '\u001B';

// assert.throws() does not hand the error back, and every one of these cases is
// about the error's code rather than about the fact that something failed.
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

const table = JSON.parse(readFileSync(new URL('../vectors/args/parse.json', import.meta.url), 'utf8'));

test('vector table: the parser', () => {
  assert.ok(table.cases.length > 50, 'the table is worth having');
  for (const entry of table.cases) {
    const spec = table.specs[entry.spec];
    assert.ok(spec !== undefined, `${entry.name}: spec ${entry.spec} exists`);
    const where = `${entry.name} :: ${entry.spec} ${JSON.stringify(entry.argv)}`;

    if (entry.throws !== undefined) {
      const error = caught(() => parse(entry.argv, spec, { env: entry.env ?? {} }));
      assert.ok(error instanceof ArgsError, `${where}: threw an ArgsError, got ${error}`);
      assert.equal(error.code, entry.throws, where);
      assert.ok(error.message.length > 0, `${where}: the error says something`);
      continue;
    }

    const result = parse(entry.argv, spec, { env: entry.env ?? {} });
    for (const [key, expected] of Object.entries(entry.values ?? {})) {
      // null is the table's way of writing "absent": JSON has no undefined.
      if (expected === null) assert.ok(!(key in result.values), `${where}: ${key} is absent`);
      else assert.deepEqual(result.values[key], expected, `${where}: values.${key}`);
    }
    for (const [key, expected] of Object.entries(entry.positionals ?? {})) {
      if (expected === null) assert.ok(!(key in result.positionals), `${where}: positional ${key} is absent`);
      else assert.deepEqual(result.positionals[key], expected, `${where}: positionals.${key}`);
    }
    if (entry.rest !== undefined) assert.deepEqual(result.rest, entry.rest, `${where}: rest`);
    if (entry.unknown !== undefined) assert.deepEqual(result.unknown, entry.unknown, `${where}: unknown`);
  }
});

// ---------------------------------------------------------------------------
// Prototype pollution
//
// The two minimist advisories, CVE-2020-7598 and CVE-2021-44906, both reduce to
// assigning a key that came from argv. The feature that carried them -- dot
// notation -- does not exist here, so the first test proves the vector never
// arrives; the second proves that even a spec that names the key is refused, so
// the guard is at the assignment site and not only at the front door.

test('no command line can reach Object.prototype', () => {
  const spec = { strict: false, options: { safe: { type: 'string' } } };
  const attacks = [
    ['--__proto__=polluted'],
    ['--__proto__.polluted=yes'],
    ['--constructor.prototype.polluted=yes'],
    ['--prototype=polluted'],
    ['-x', '--__proto__[polluted]=yes'],
  ];
  for (const argv of attacks) {
    const result = parse(argv, spec);
    assert.equal({}.polluted, undefined, `${argv.join(' ')}: the prototype is clean`);
    assert.equal(Object.prototype.polluted, undefined, `${argv.join(' ')}: still clean`);
    assert.equal(Object.getPrototypeOf(result.values), Object.prototype, 'the result is an ordinary object');
    assert.ok(!Object.hasOwn(result.values, '__proto__'), 'nothing was assigned');
  }
});

test('a spec cannot declare a forbidden key either', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.equal(isSafeKey(key), false, key);
    const error = caught(() => normaliseSpec({ options: { [key]: { type: 'string' } } }));
    assert.ok(error instanceof SpecError, `${key}: refused as a spec key`);
  }
  assert.equal(isSafeKey('output'), true);
  assert.equal(isSafeKey(''), false);
  assert.equal(isSafeKey(null), false);
});

// ---------------------------------------------------------------------------
// Spec validation. Every one of these is a mistake by whoever wrote the spec, so
// it must be a SpecError and must never surface to a user as a usage error.

test('a bad spec throws SpecError, not ArgsError', () => {
  const bad = [
    ['an unknown type', { options: { a: { type: 'integer' } } }],
    ['a two-letter short name', { options: { a: { short: 'ab' } } }],
    ['a non-alphanumeric short name', { options: { a: { short: '-' } } }],
    ['two options on one long name', { options: { dryRun: {}, 'dry-run': {} } }],
    ['two options on one short name', { options: { a: { short: 'x' }, b: { short: 'x' } } }],
    ['multiple on a boolean', { options: { a: { type: 'boolean', multiple: true } } }],
    ['multiple on a count', { options: { a: { type: 'count', multiple: true } } }],
    ['choices that are not a list', { options: { a: { type: 'string', choices: 'ab' } } }],
    ['a coerce that is not a function', { options: { a: { type: 'string', coerce: 'Number' } } }],
    ['a conflict with nothing', { options: { a: { conflicts: ['ghost'] } } }],
    ['an implication of nothing', { options: { a: { implies: ['ghost'] } } }],
    ['a nameless positional', { positionals: [{ type: 'string' }] }],
    ['a boolean positional', { positionals: [{ name: 'a', type: 'boolean' }] }],
    ['a variadic that is not last', { positionals: [{ name: 'a', variadic: true }, { name: 'b' }] }],
    ['a required positional after an optional one', { positionals: [{ name: 'a' }, { name: 'b', required: true }] }],
  ];
  for (const [why, spec] of bad) {
    const error = caught(() => normaliseSpec(spec));
    assert.ok(error instanceof SpecError, `${why}: SpecError, got ${error}`);
    assert.ok(!(error instanceof ArgsError), `${why}: not reported as a user error`);
  }
});

test('an empty spec parses an empty command line', () => {
  const result = parse([], {});
  assert.deepEqual(result.values, {});
  assert.deepEqual(result.positionals, { _: [] });
  assert.deepEqual(result.rest, []);
  assert.deepEqual(result.tokens, []);
});

test('normaliseSpec is idempotent, so a spec can be reused', () => {
  const normalised = normaliseSpec({ options: { force: { type: 'boolean' } } });
  const first = parse(['--force'], normalised);
  const second = parse([], normalised);
  assert.equal(first.values.force, true);
  assert.ok(!('force' in second.values), 'the second parse does not see the first');
});

test('an array default is cloned, not shared between parses', () => {
  const spec = { options: { tag: { type: 'string', multiple: true, default: ['a'] } } };
  const normalised = normaliseSpec(spec);
  const first = parse([], normalised);
  first.values.tag.push('mutated');
  const second = parse([], normalised);
  assert.deepEqual(second.values.tag, ['a'], 'the default was not mutated by the first parse');
});

// ---------------------------------------------------------------------------
// Functions in a spec: the part the JSON table cannot hold.

test('coerce runs after typing and choices', () => {
  const seen = [];
  const spec = {
    options: {
      when: { type: 'string', coerce: (value) => new Date(`${value}T00:00:00Z`).getUTCFullYear() },
      size: { type: 'number', coerce: (value) => { seen.push(value); return value * 2; } },
      mode: { type: 'string', choices: ['fast'], coerce: (value) => value.toUpperCase() },
    },
  };
  const result = parse(['--when=2026-08-31', '--size=21', '--mode=fast'], spec);
  assert.equal(result.values.when, 2026);
  assert.equal(result.values.size, 42);
  assert.deepEqual(seen, [21], 'coerce received a number, not the string');
  assert.equal(result.values.mode, 'FAST');
});

test('a coerce that throws becomes a usage error, not a crash', () => {
  const spec = {
    options: {
      port: {
        type: 'number',
        coerce: (value) => {
          if (!Number.isInteger(value)) throw new Error('must be a whole number');
          return value;
        },
      },
    },
  };
  assert.equal(parse(['--port=8080'], spec).values.port, 8080);
  const error = caught(() => parse(['--port=80.5'], spec));
  assert.ok(error instanceof ArgsError);
  assert.equal(error.code, 'INVALID_VALUE');
  assert.match(error.message, /must be a whole number/);
});

test('coerce applies to a positional as well', () => {
  const spec = { positionals: [{ name: 'target', coerce: (value) => value.replace(/\/+$/, '') }] };
  assert.equal(parse(['./project///'], spec).positionals.target, './project');
});

test('a default is applied to a positional that was not given', () => {
  const spec = { positionals: [{ name: 'target', default: '.' }] };
  assert.equal(parse([], spec).positionals.target, '.');
  assert.equal(parse(['./x'], spec).positionals.target, './x');
});

// ---------------------------------------------------------------------------
// Tokens. Exposed for the same reason util.parseArgs exposes them: a caller who
// disagrees with our accumulation can do their own, and the CLI layer uses them
// to find a subcommand without parsing twice.

test('tokens describe the command line, in order', () => {
  const spec = normaliseSpec({ options: { output: { type: 'string', short: 'o' }, force: { type: 'boolean' } } });
  const tokens = tokenise(['scan', '-o', 'out.txt', '--force', '--', 'raw'], spec);
  assert.deepEqual(tokens.map((token) => token.kind), ['positional', 'option', 'option', 'terminator', 'rest']);
  assert.equal(tokens[0].value, 'scan');
  assert.equal(tokens[1].flag, 'o');
  assert.equal(tokens[1].value, 'out.txt');
  assert.equal(tokens[1].short, true);
  assert.equal(tokens[2].flag, 'force');
  assert.equal(tokens[4].value, 'raw');
  // Indices point back into the original argv, which is what lets the CLI layer
  // lift a command name out without reassembling the line by hand.
  assert.deepEqual(tokens.map((token) => token.index), [0, 1, 3, 4, 5]);
});

test('provided distinguishes a given value from a default', () => {
  const spec = { options: { colour: { type: 'boolean', default: true }, force: { type: 'boolean' } } };
  const quiet = parse([], spec);
  assert.equal(quiet.values.colour, true);
  assert.equal(quiet.provided.has('colour'), false, 'a default is not a statement of intent');
  const loud = parse(['--colour'], spec);
  assert.equal(loud.provided.has('colour'), true);
  assert.equal(loud.provided.has('force'), false);
});

test('the environment counts as provided, so a conflict still fires', () => {
  const spec = {
    options: {
      quiet: { type: 'boolean', env: 'NIRDEP_QUIET', conflicts: ['verbose'] },
      verbose: { type: 'boolean' },
    },
  };
  const error = caught(() => parse(['--verbose'], spec, { env: { NIRDEP_QUIET: '1' } }));
  assert.ok(error instanceof ArgsError);
  assert.equal(error.code, 'CONFLICT');
});

test('an unknown option carries suggestions on the error', () => {
  const spec = { options: { output: { type: 'string' }, verbose: { type: 'count' } } };
  const error = caught(() => parse(['--outpit=x'], spec));
  assert.equal(error.code, 'UNKNOWN_OPTION');
  assert.deepEqual(error.suggestions, ['output']);
  assert.match(error.message, /did you mean --output\?/);
  assert.equal(error.flag, 'outpit');
});

// ---------------------------------------------------------------------------
// Naming and scalars.

test('kebab and camel conversion round-trip the shapes a spec uses', () => {
  const pairs = [['dryRun', 'dry-run'], ['output', 'output'], ['HTTPProxy', 'http-proxy'], ['level2', 'level2'], ['aB', 'a-b']];
  for (const [camel, kebab] of pairs) assert.equal(toKebab(camel), kebab, camel);
  assert.equal(toCamel('dry-run'), 'dryRun');
  assert.equal(toCamel('dry_run'), 'dryRun');
  assert.equal(toCamel('no-colour'), 'noColour');
  assert.equal(toCamel('output'), 'output');
});

test('the number grammar refuses what minimist would reinterpret', () => {
  assert.equal(parseNumber('42', 'n'), 42);
  assert.equal(parseNumber('-0.5', 'n'), -0.5);
  assert.equal(parseNumber('+3', 'n'), 3);
  assert.equal(parseNumber('1e-3', 'n'), 0.001);
  for (const text of ['0x10', '0b1', '1_000', '1.2.3', 'NaN', 'Infinity', '', ' 1', '1 ', '--']) {
    const error = caught(() => parseNumber(text, 'n'));
    assert.equal(error?.code, 'INVALID_VALUE', JSON.stringify(text));
  }
});

test('the boolean table is case-insensitive and closed', () => {
  for (const yes of ['true', 'TRUE', '1', 'yes', 'Y', 'on']) assert.equal(parseBoolean(yes, 'b'), true, yes);
  for (const no of ['false', 'FALSE', '0', 'no', 'N', 'off', '']) assert.equal(parseBoolean(no, 'b'), false, no);
  assert.equal(caught(() => parseBoolean('maybe', 'b'))?.code, 'INVALID_VALUE');
});

// ---------------------------------------------------------------------------
// Did you mean. Optimal string alignment, so a transposition is one edit.

test('a transposition costs one edit, which is the point', () => {
  assert.equal(editDistance('sacn', 'scan'), 1);
  assert.equal(editDistance('', 'scan'), 4);
  assert.equal(editDistance('scan', 'scan'), 0);
  assert.equal(editDistance('scan', 'span'), 1, 'one substitution');
  assert.equal(editDistance('scan', 'plan'), 2, 'two substitutions');
  // The comparison that matters: a swap and a pair of substitutions both change
  // two letters, and only the swap should read as a near miss.
  assert.ok(editDistance('sacn', 'scan') < editDistance('scan', 'plan'));
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('abcd', 'badc'), 2, 'two independent swaps');
});

test('suggestions are offered when they are worth offering', () => {
  const commands = ['scan', 'plan', 'apply', 'eject', 'guard', 'conformance', 'explain', 'help'];
  assert.deepEqual(suggest('sacn', commands), ['scan']);
  assert.deepEqual(suggest('aply', commands), ['apply']);
  assert.deepEqual(suggest('conf', commands), ['conformance'], 'a prefix is always worth offering');
  assert.deepEqual(suggest('scan', commands), [], 'an exact match needs no suggestion');
  assert.deepEqual(suggest('xylophone', commands), [], 'nothing near means nothing offered');
  assert.ok(suggest('an', commands).length <= 3, 'never more than the limit');
  assert.deepEqual(suggest('SACN', commands), ['scan'], 'case is not a typo worth punishing');
});

// ---------------------------------------------------------------------------
// Help rendering. Measured visibly, because the describe column arrives styled.

test('width is measured as a terminal counts it', () => {
  assert.equal(visibleWidth('plain'), 5);
  assert.equal(visibleWidth(`${ESC}[1mbold${ESC}[22m`), 4);
  assert.equal(visibleWidth(`${ESC}[38;2;255;136;0mhex${ESC}[39m`), 3);
});

test('wrapping counts visible characters, not escape bytes', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrap('short', 40), ['short']);
  assert.deepEqual(wrap('unbreakablesingleword', 5), ['unbreakablesingleword']);
  const styled = `${ESC}[31mred${ESC}[39m word`;
  assert.deepEqual(wrap(styled, 8), [styled], 'eight visible characters fit, escapes and all');
});

test('the label column is padded by visible width', () => {
  const rows = [
    { label: `${ESC}[36m-o, --output${ESC}[39m`, describe: 'where to write' },
    { label: '    --force', describe: 'do it anyway' },
  ];
  const lines = columns(rows, { width: 60 });
  const at = lines.map((line) => visibleWidth(line) - visibleWidth(line.replace(/^.*?(?=where|do it)/s, '')));
  assert.equal(at[0], at[1], 'both describe columns start at the same visible offset');
});

test('an over-long label takes its own line', () => {
  const lines = columns([{ label: '--a-very-long-flag-name-indeed <string>', describe: 'note' }], { width: 60, maximum: 20 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /--a-very-long-flag-name-indeed/);
  assert.match(lines[1], /^\s+note$/);
});

test('option labels show the shapes a reader will actually type', () => {
  const spec = normaliseSpec({
    options: {
      output: { type: 'string', short: 'o' },
      colour: { type: 'boolean', default: true },
      force: { type: 'boolean' },
      include: { type: 'string', multiple: true, placeholder: 'glob' },
      verbose: { type: 'count', short: 'v' },
    },
  });
  const label = (key) => optionLabel(spec.options.find((option) => option.key === key));
  assert.equal(label('output'), '-o, --output <string>');
  assert.equal(label('colour'), '    --[no-]colour', 'the [no-] form only where negating is the useful direction');
  assert.equal(label('force'), '    --force');
  assert.equal(label('include'), '    --include <glob...>');
  assert.equal(label('verbose'), '-v, --verbose');
});

test('the usage line is built from the spec, so it cannot go stale', () => {
  const spec = normaliseSpec({
    options: { force: { type: 'boolean' } },
    positionals: [{ name: 'target', required: true }, { name: 'extra', variadic: true }],
  });
  assert.equal(usageLine('nirdep scan', spec), 'nirdep scan [options] <target> [extra...]');
  assert.equal(usageLine('nirdep', spec, { hasCommands: true }), 'nirdep <command> [options] <target> [extra...]');
  assert.equal(usageLine('bare', normaliseSpec({})), 'bare');
});

test('generated help states every fact a reader needs', () => {
  const text = renderHelp({
    name: 'nirdep scan',
    version: '0.1.0',
    tagline: 'delete your dependencies',
    describe: 'Report replaceable dependencies and their blast radius.',
    footer: 'Published by Nastik AI. Developed by Sai Ram Dash (Hardik).',
    spec: {
      options: {
        output: { type: 'string', short: 'o', describe: 'where to write', env: 'NIRDEP_OUT' },
        level: { type: 'number', choices: [0, 1, 2], default: 1, describe: 'how deep to look' },
        mode: { type: 'string', required: true, describe: 'how to run' },
        secret: { type: 'string', hidden: true, describe: 'never shown' },
      },
      positionals: [{ name: 'target', required: true, describe: 'the project to scan' }],
    },
  }, { width: 78 });

  assert.match(text, /^nirdep scan 0\.1\.0 -- delete your dependencies\n/);
  assert.match(text, /Usage: nirdep scan \[options\] <target>/);
  assert.match(text, /Arguments:\n\s+<target>\s+the project to scan/);
  assert.match(text, /-o, --output <string>\s+where to write \[or NIRDEP_OUT\]/);
  assert.match(text, /--level <number>\s+how deep to look \[one of 0, 1, 2; default 1\]/);
  assert.match(text, /--mode <string>\s+how to run \[required\]/);
  assert.ok(!text.includes('never shown'), 'a hidden option is hidden');
  assert.ok(text.endsWith('Published by Nastik AI. Developed by Sai Ram Dash (Hardik).\n'), 'the footer is last');
  assert.ok(!text.includes(ESC), 'unstyled by default: this file passes no style hooks');
  assert.ok(!text.includes('\n\n\n'), 'no run of blank lines');
});

test('the style hooks are used where they are given, and only there', () => {
  const descriptor = {
    name: 'nirdep',
    spec: { options: { force: { type: 'boolean', describe: 'do it anyway' } } },
    commands: [{ name: 'scan', describe: 'look', ready: true }, { name: 'plan', describe: 'diff', ready: false }],
  };
  const marked = renderHelp(descriptor, { style: { bold: (t) => `<b>${t}</b>`, cyan: (t) => `<c>${t}</c>`, yellow: (t) => `<y>${t}</y>`, dim: (t) => `<d>${t}</d>` } });
  assert.match(marked, /<b>nirdep<\/b>/);
  assert.match(marked, /<b>Usage:<\/b>/);
  assert.match(marked, /<c>scan<\/c>/);
  assert.match(marked, /<d>plan<\/d> <y>\(pending\)<\/y>\s+diff/, 'the marker sits in the label column, beside the name');
  const plain = renderHelp(descriptor);
  for (const tag of ['<b>', '<c>', '<y>', '<d>']) {
    assert.ok(!plain.includes(tag), `the default style is the identity, not a colour decision (${tag})`);
  }
  assert.match(plain, /Usage: nirdep <command> \[options\]/, 'the angle brackets that remain are placeholders');
});
