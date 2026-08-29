// Conformance for runtime/colour. The tables in tests/vectors/colour/ are the
// contract; this file only drives them, so adding a case never means touching
// code. <ESC> in a vector stands for U+001B, which keeps control bytes out of the
// repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createColour, detectLevel, strip, visibleLength, styles, Level,
  hexToRgb, rgbToAnsi256, ansi256ToAnsi16, rgbToAnsi16,
} from '../../src/runtime/colour.mjs';

const ESC = '\u001B';
const expand = (text) => text.replaceAll('<ESC>', ESC);
const table = (name) => JSON.parse(readFileSync(new URL(`../vectors/colour/${name}.json`, import.meta.url), 'utf8')).cases;

/** Walk an ops list: a string is a property, an object is a method call. */
function chain(instance, ops) {
  let node = instance;
  for (const op of ops) node = typeof op === 'string' ? node[op] : node[op.m](...op.a);
  return node;
}

const label = (entry) => `${entry.ops.map((op) => (typeof op === 'string' ? op : `${op.m}(${op.a.join(',')})`)).join('.')} @ level ${entry.level}`;

for (const name of ['named', 'dynamic']) {
  test(`vector table: ${name}`, () => {
    const cases = table(name);
    assert.ok(cases.length > 0, 'the table is not empty');
    for (const entry of cases) {
      const produced = chain(createColour({ level: entry.level }), entry.ops)(expand(entry.in));
      assert.equal(produced, expand(entry.out), label(entry));
    }
  });
}

test('every style in the table is reachable on a builder, and closes correctly', () => {
  const instance = createColour({ level: Level.BASIC });
  for (const [styleName, style] of Object.entries(styles)) {
    const produced = instance[styleName]('x');
    assert.equal(produced, `${style.open}x${style.close}`, styleName);
  }
});

test('the close codes are the ones ECMA-48 actually defines', () => {
  // Not a tautology against our own table: these are the values a terminal
  // implements. Bold and dim share close 22, which is the one every naive
  // implementation gets wrong by emitting SGR 0 instead.
  assert.equal(styles.bold.codes[1], 22);
  assert.equal(styles.dim.codes[1], 22);
  assert.equal(styles.italic.codes[1], 23);
  assert.equal(styles.underline.codes[1], 24);
  assert.equal(styles.overline.codes[1], 55);
  assert.equal(styles.red.codes[1], 39);
  assert.equal(styles.bgRed.codes[1], 49);
  assert.equal(styles.redBright.codes[1], 39, 'a bright colour still closes with 39, not 99');
});

test('colour space conversion', () => {
  assert.deepEqual(hexToRgb('#ff8800'), [255, 136, 0]);
  assert.deepEqual(hexToRgb('ff8800'), [255, 136, 0]);
  assert.deepEqual(hexToRgb('#f80'), [255, 136, 0]);
  assert.deepEqual(hexToRgb('#FFF'), [255, 255, 255]);
  assert.throws(() => hexToRgb('#gggggg'), TypeError);
  assert.throws(() => hexToRgb('#ff88'), TypeError);

  assert.equal(rgbToAnsi256(0, 0, 0), 16);
  assert.equal(rgbToAnsi256(255, 255, 255), 231);
  assert.equal(rgbToAnsi256(255, 0, 0), 196);
  assert.equal(rgbToAnsi256(128, 128, 128), 244);
  assert.equal(rgbToAnsi256(7, 7, 7), 16, 'near-black greys clamp to the cube corner');
  assert.equal(rgbToAnsi256(250, 250, 250), 231, 'near-white greys clamp to the other corner');

  assert.equal(ansi256ToAnsi16(0), 30);
  assert.equal(ansi256ToAnsi16(7), 37);
  assert.equal(ansi256ToAnsi16(8), 90);
  assert.equal(ansi256ToAnsi16(15), 97);
  assert.equal(ansi256ToAnsi16(196), 91);
  assert.equal(rgbToAnsi16(255, 136, 0), 93);
});

test('the grey ramp is used for greys and the cube for everything else', () => {
  // A grey gradient must not land on the cube diagonal: six steps would band it.
  const ramp = [40, 80, 120, 160, 200].map((value) => rgbToAnsi256(value, value, value));
  assert.ok(ramp.every((code) => code >= 232), `expected the grey ramp, got ${ramp.join(', ')}`);
  assert.deepEqual(ramp, [...new Set(ramp)], 'each step is distinct');
  assert.ok(rgbToAnsi256(200, 100, 50) < 232, 'a non-grey uses the cube');
});

test('an out-of-range channel is refused rather than clamped silently', () => {
  const instance = createColour({ level: Level.TRUECOLOUR });
  assert.throws(() => instance.rgb(256, 0, 0)('x'), TypeError);
  assert.throws(() => instance.rgb(-1, 0, 0)('x'), TypeError);
  assert.throws(() => instance.rgb(1.5, 0, 0)('x'), TypeError);
  assert.throws(() => instance.ansi256(300)('x'), TypeError);
});
