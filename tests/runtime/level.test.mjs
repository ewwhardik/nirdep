// Capability detection: the supports-color replacement. Table-driven, because the
// whole value of this function is the matrix, and a matrix belongs in data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLevel, createColour, Level } from '../../src/runtime/colour.mjs';

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

const CASES = [
  // [name, stream, env, expected]
  ['a pipe with no hints stays silent', PIPE, {}, Level.NONE],
  ['a bare TTY with no TERM stays silent', TTY, {}, Level.NONE],
  ['xterm on a TTY gets the sixteen', TTY, { TERM: 'xterm' }, Level.BASIC],
  ['xterm-256color gets the palette', TTY, { TERM: 'xterm-256color' }, Level.ANSI256],
  ['screen-256color gets the palette', TTY, { TERM: 'screen-256color' }, Level.ANSI256],
  ['COLORTERM=truecolor wins over TERM', TTY, { TERM: 'xterm', COLORTERM: 'truecolor' }, Level.TRUECOLOUR],
  ['COLORTERM=24bit is the same claim', TTY, { TERM: 'xterm', COLORTERM: '24bit' }, Level.TRUECOLOUR],
  ['an unrecognised COLORTERM still means colour', TTY, { COLORTERM: 'yes' }, Level.BASIC],
  ['kitty advertises truecolour', TTY, { TERM: 'xterm-kitty' }, Level.TRUECOLOUR],
  ['TERM=dumb means dumb, TTY or not', TTY, { TERM: 'dumb' }, Level.NONE],
  ['TERM=linux gets the sixteen', TTY, { TERM: 'linux' }, Level.BASIC],
  ['rxvt gets the sixteen', TTY, { TERM: 'rxvt-unicode' }, Level.BASIC],

  ['iTerm 3 is truecolour', TTY, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.19' }, Level.TRUECOLOUR],
  ['iTerm 2 is the palette', TTY, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9.0' }, Level.ANSI256],
  ['Terminal.app is the palette', TTY, { TERM_PROGRAM: 'Apple_Terminal' }, Level.ANSI256],
  ['the VS Code terminal is truecolour', TTY, { TERM_PROGRAM: 'vscode' }, Level.TRUECOLOUR],

  ['NO_COLOR silences a capable terminal', TTY, { TERM: 'xterm-256color', NO_COLOR: '1' }, Level.NONE],
  ['an empty NO_COLOR is not a request', TTY, { TERM: 'xterm', NO_COLOR: '' }, Level.BASIC],
  ['FORCE_COLOR beats NO_COLOR, being the more specific instruction', PIPE, { NO_COLOR: '1', FORCE_COLOR: '3' }, Level.TRUECOLOUR],
  ['FORCE_COLOR=0 silences a TTY', TTY, { TERM: 'xterm-256color', FORCE_COLOR: '0' }, Level.NONE],
  ['FORCE_COLOR=false silences a TTY', TTY, { TERM: 'xterm-256color', FORCE_COLOR: 'false' }, Level.NONE],
  ['an empty FORCE_COLOR means the sixteen', PIPE, { FORCE_COLOR: '' }, Level.BASIC],
  ['FORCE_COLOR=true means the sixteen', PIPE, { FORCE_COLOR: 'true' }, Level.BASIC],
  ['FORCE_COLOR=2 pins the palette on a pipe', PIPE, { FORCE_COLOR: '2' }, Level.ANSI256],
  ['FORCE_COLOR above 3 clamps', PIPE, { FORCE_COLOR: '9' }, Level.TRUECOLOUR],
  ['nonsense in FORCE_COLOR is treated as a yes', PIPE, { FORCE_COLOR: 'yes please' }, Level.BASIC],

  ['GitHub Actions renders truecolour on a pipe', PIPE, { CI: 'true', GITHUB_ACTIONS: 'true' }, Level.TRUECOLOUR],
  ['GitLab CI renders the sixteen', PIPE, { CI: 'true', GITLAB_CI: 'true' }, Level.BASIC],
  ['Travis renders the sixteen', PIPE, { CI: 'true', TRAVIS: 'true' }, Level.BASIC],
  ['codeship is recognised by name', PIPE, { CI: 'true', CI_NAME: 'codeship' }, Level.BASIC],
  ['an unknown CI on a pipe gets nothing', PIPE, { CI: 'true' }, Level.NONE],
  ['an unknown CI on a TTY falls through to TERM', TTY, { CI: 'true', TERM: 'xterm-256color' }, Level.ANSI256],
  ['no stream at all is treated as not a TTY', undefined, { TERM: 'xterm-256color' }, Level.NONE],
];

test('level detection matrix', () => {
  for (const [name, stream, env, expected] of CASES) {
    assert.equal(detectLevel(stream, env), expected, name);
  }
});

test('a detected level of zero makes every style the identity function', () => {
  const instance = createColour({ stream: { isTTY: false }, env: {} });
  assert.equal(instance.level, Level.NONE);
  assert.equal(instance.red.bold.underline('x'), 'x');
  assert.equal(instance.hex('#ff8800')('x'), 'x');
  assert.equal(instance.enabled, false);
});

test('instances are independent, so a library cannot silence its host', () => {
  const library = createColour({ level: Level.TRUECOLOUR });
  const application = createColour({ level: Level.TRUECOLOUR });
  library.level = Level.NONE;
  assert.equal(library.red('x'), 'x');
  assert.notEqual(application.red('x'), 'x');
});

test('the level can be raised after chains were built, and old chains follow', () => {
  const instance = createColour({ level: Level.NONE });
  const warn = instance.hex('#ff8800').bold;
  assert.equal(warn('x'), 'x');
  instance.level = Level.TRUECOLOUR;
  assert.equal(warn('x'), '\u001B[38;2;255;136;0m\u001B[1mx\u001B[22m\u001B[39m');
  instance.level = Level.BASIC;
  assert.equal(warn('x'), '\u001B[93m\u001B[1mx\u001B[22m\u001B[39m');
});

test('an invalid level is refused', () => {
  assert.throws(() => createColour({ level: 4 }), RangeError);
  assert.throws(() => createColour({ level: -1 }), RangeError);
  assert.throws(() => { createColour({ level: 0 }).level = 'red'; }, RangeError);
});
