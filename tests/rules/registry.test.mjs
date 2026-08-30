// The catalogue's own invariants.
//
// Nothing here tests a rewrite. It tests the table that decides which rewrites are
// allowed to exist, because that table is the only place where a wrong entry produces
// confident, green, broken output. Two properties carry most of the weight: a member list
// must match the module it claims to describe, and a rewrite entry must say what happens
// to all three binding shapes so no call site falls through a hole in the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION, AS, RULES, REPLACEABLE, REWRITABLE, ruleFor } from '../../src/rules/registry.mjs';
import * as colour from '../../src/runtime/colour.mjs';
import * as semver from '../../src/runtime/semver.mjs';

const rule = (name) => RULES.find((one) => one.package === name);

test('every rule is frozen and names a package once', () => {
  const seen = new Set();
  for (const one of RULES) {
    assert.ok(Object.isFrozen(one), `${one.package} is not frozen`);
    assert.equal(seen.has(one.package), false, `${one.package} is listed twice`);
    seen.add(one.package);
    assert.equal(typeof one.weekly === 'string' || one.weekly === undefined, true);
    assert.ok(one.target.startsWith('nirdep/'), `${one.package} points outside the runtime`);
    assert.equal(one.target, `nirdep/${one.subpath}`, `${one.package}: target and subpath disagree`);
  }
});

test('a rewrite rule answers for all three binding shapes', () => {
  for (const one of RULES) {
    if (one.action !== ACTION.REWRITE) continue;
    for (const shape of ['fromDefault', 'fromNamespace', 'fromNamed']) {
      assert.ok(shape in one, `${one.package} says nothing about a ${shape} binding`);
      if (one[shape] !== null) {
        assert.ok(Object.values(AS).includes(one[shape].as), `${one.package}.${shape} has no landing shape`);
        continue;
      }
      // A null shape is a refusal, and a refusal has to come with a sentence: the
      // decline message for that shape is what the user reads instead of a diff.
      const form = shape === 'fromDefault' ? 'default' : shape === 'fromNamed' ? 'named' : 'namespace';
      assert.equal(typeof one.declines?.[form], 'string', `${one.package} refuses a ${form} binding without saying why`);
      assert.ok(one.declines[form].length > 30, `${one.package}: "${one.declines[form]}" is not a reason`);
    }
    assert.ok(one.members instanceof Set, `${one.package} has no member list`);
  }
});

test('an advise rule advises and nothing else', () => {
  for (const one of RULES) {
    if (one.action !== ACTION.ADVISE) continue;
    assert.equal(typeof one.advice, 'string');
    assert.ok(one.advice.length > 80, `${one.package}: advice this short is a shrug`);
    assert.equal(one.members, undefined, `${one.package} carries a member list it can never use`);
    assert.equal(one.fromDefault, undefined, `${one.package} describes a rewrite it will never do`);
  }
});

test('the member lists are the modules, not a copy of them', () => {
  // The point of reading them off the runtime: a name in the list that the module does
  // not export is a rewrite that lands and then throws at run time.
  for (const name of Object.keys(semver.default)) {
    assert.ok(rule('semver').members.has(name), `semver.${name} is exported but not claimed`);
  }
  for (const name of rule('semver').members) {
    // Functions mostly, but semver's surface also carries MAX_LENGTH, RELEASE_TYPES and
    // SEMVER_SPEC_VERSION, which call sites read as properties. Claiming only the
    // callable half would refuse a file for reaching a constant that is right there.
    assert.notEqual(semver.default[name], undefined, `semver.${name} is claimed but is not exported`);
  }
  const chalk = rule('chalk');
  for (const name of Object.keys(colour.styles)) {
    assert.ok(chalk.members.has(name), `the style ${name} is implemented but not claimed`);
  }
  const instance = colour.default;
  for (const name of chalk.members) {
    assert.notEqual(instance[name], undefined, `chalk.${name} is claimed but the builder has no ${name}`);
  }
});

test('strip-ansi lands on a name the module really exports', () => {
  const one = rule('strip-ansi');
  assert.equal(one.fromDefault.as, AS.NAMED);
  assert.equal(typeof colour[one.fromDefault.name], 'function', 'the landing name is not exported');
});

test('lookup is by package root only', () => {
  assert.equal(ruleFor('chalk'), rule('chalk'));
  assert.equal(ruleFor('chalk/source'), null, 'a deep path is a different entry point');
  assert.equal(ruleFor('CHALK'), null);
  assert.equal(ruleFor('node:util'), null);
  assert.equal(ruleFor(''), null);
  assert.equal(ruleFor('@scope/chalk'), null);
});

test('the two lists the README quotes agree with the table', () => {
  assert.deepEqual([...REPLACEABLE], RULES.map((one) => one.package));
  assert.deepEqual([...REWRITABLE], RULES.filter((one) => one.action === ACTION.REWRITE).map((one) => one.package));
  assert.ok(REWRITABLE.length < REPLACEABLE.length, 'if everything is rewritable, something is being oversold');
});

test('every package named is one the runtime has an answer for', () => {
  // Read off the export map rather than typed here: a rule pointing at a subpath the
  // package does not publish is a rewrite the consumer cannot resolve.
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const subpaths = new Set(Object.keys(manifest.exports).filter((one) => one !== '.').map((one) => one.slice(2)));
  for (const one of RULES) assert.ok(subpaths.has(one.subpath), `${one.package} points at ${one.subpath}`);
});
