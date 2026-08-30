// Conformance for runtime/collect. Three tables under tests/vectors/collect/ carry the contract:
// paths (toPath, get, has), write (set, unset, pick, omit, merge) and values (cloneDeep, isEqual
// and the collection functions). The inputs were chosen by hand -- one per rule that has a wrong
// answer -- and the expectation column was filled in by calling lodash 4.18.1 as a black box,
// disclosed in STDLIB.md under Borrowed test data.
//
// One child process per row, which is not caution for its own sake: lodash's own `set` writes
// through inherited properties onto Object.prototype, so a second row sharing a process answers
// in a program the first row already damaged. That is also the headline divergence here, and it
// has a test of its own further down.
//
// A row carrying `why` is one this module answers differently on purpose. The cell is still
// asserted -- against `ours` -- and then has to survive a second test that gives every divergence
// a name and a count. Silent disagreement is what these tables exist to prevent.
//
// JSON holds none of what these functions are for: NaN, -0, undefined, a Map, a cycle, a symbol
// key, an array with a hole. Each travels tagged as {"$": kind}, and `dec` below is the decoder --
// this is the copy that ships, because a test may not import anything from outside the repository.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import * as collect from '../../src/runtime/collect.mjs';

const { toPath, get, has, set, unset, pick, omit, merge, cloneDeep, isEqual } = collect;
const { groupBy, keyBy, uniqBy, chunk, sortBy, debounce, throttle, CollectError } = collect;

const TAG = '$';

const table = (name) => JSON.parse(readFileSync(new URL(`../vectors/collect/${name}.json`, import.meta.url), 'utf8'));

function dec(node, root = { at: null }) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((one) => dec(one, root));
  if (!Object.hasOwn(node, TAG)) {
    const made = {};
    if (root.at === null) root.at = made;
    for (const [key, value] of Object.entries(node)) own(made, key, dec(value, root));
    return made;
  }
  switch (node[TAG]) {
    case 'undefined': return undefined;
    case '-0': return -0;
    case 'nan': return NaN;
    case 'inf': return node.of > 0 ? Infinity : -Infinity;
    case 'bigint': return BigInt(node.of);
    case 'symbol': return Symbol.for(node.of);
    case 'fn': return named(node.of ?? 'anonymous');
    case 'cycle': return root.at;
    case 'date': return more(node, new Date(node.of === null ? NaN : node.of), root);
    case 'regexp': return more(node, new RegExp(node.of, node.flags), root);
    case 'error': return more(node, new Error(node.of), root);
    case 'buffer': return Buffer.from(node.of, 'utf8');
    case 'bytes': return new Uint8Array(node.of);
    case 'map': return more(node, new Map(node.of.map(([k, v]) => [dec(k, root), dec(v, root)])), root);
    case 'set': return more(node, new Set(node.of.map((one) => dec(one, root))), root);
    case 'array': return fill(node, new Array(node.length), root);
    case 'bare': return fill(node, Object.create(null), root);
    case 'frozen': return Object.freeze(fill(node, {}, root));
    case 'object': return fill(node, {}, root);
    default: throw new Error(`unknown vector tag ${JSON.stringify(node[TAG])}`);
  }
}

function fill(node, made, root) {
  if (root.at === null) root.at = made;
  for (const [key, value] of node.of) own(made, dec(key, root), dec(value, root));
  return made;
}

/** The properties a Date or a Map has no business having, put back -- `merge` writes into whatever
 * the target already is, so a Date can come back wearing a `b`, and a row that recorded only the
 * timestamp would encode two different answers identically. */
function more(node, made, root) {
  for (const [key, value] of node.extra ?? []) own(made, dec(key, root), dec(value, root));
  return made;
}

/** Assignment cannot build these fixtures: `made['__proto__'] = x` sets the prototype instead of
 * making a property, which would quietly turn every pollution row into an empty object. */
function own(made, key, value) {
  Object.defineProperty(made, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Two functions are never deepStrictEqual, so a row's function is compared by how it prints. */
function named(name) {
  const made = (one) => one;
  Object.defineProperty(made, 'name', { value: name, configurable: true });
  return made;
}

// -- calling the row ---------------------------------------------------------

/** How each op is called. `unset` answers twice -- a boolean and the object it edited -- because
 * either half alone would hide half the bug. */
const RUN = {
  toPath: ([text]) => toPath(text),
  get: ([object, path, fallback]) => get(object, path, fallback),
  has: ([object, path]) => has(object, path),
  set: ([object, path, value]) => set(object, path, value),
  unset: ([object, path]) => [unset(object, path), object],
  pick: ([object, ...paths]) => pick(object, ...paths),
  omit: ([object, ...paths]) => omit(object, ...paths),
  merge: ([object, ...sources]) => merge(object, ...sources),
  cloneDeep: ([value]) => cloneDeep(value),
  isEqual: ([left, right]) => isEqual(left, right),
  groupBy: ([collection, by]) => groupBy(collection, by),
  keyBy: ([collection, by]) => keyBy(collection, by),
  uniqBy: ([collection, by]) => uniqBy(collection, by),
  chunk: ([array, size]) => chunk(array, size),
  sortBy: ([collection, by]) => sortBy(collection, by),
};

const show = (thing) => {
  // An Error is compared by what it says, for two reasons: no two stacks are alike, and a *clone*
  // of an Error carries Error.prototype without the internal slot that makes the runtime's own
  // type tag say "Error" -- which is by itself enough for deepStrictEqual to call it a mismatch.
  if (thing instanceof Error) return `${thing.name}: ${thing.message} ${inspect({ ...thing })}`;
  try {
    return inspect(thing, { depth: 8, sorted: true, breakLength: 100 });
  } catch {
    return `<no-inspect: ${Reflect.ownKeys(thing).length} own keys>`;
  }
};

/** deepStrictEqual is the first opinion only: it compares Dates by getTime(), so two Invalid
 * Dates are never equal to it. A printed form settles those. */
function alike(left, right) {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return show(left) === show(right);
  }
}

/** What the row expects of us: the reference's answer, except where the row names a reason. */
const expected = (row) => {
  if (row.oursThrows !== undefined) return { throws: row.oursThrows };
  if (Object.hasOwn(row, 'ours')) return { out: row.ours };
  if (row.throws !== undefined) return { throws: row.throws };
  return { out: row.out };
};

const label = (row) => `${row.op}(${row.in.map((one) => JSON.stringify(one)).join(', ')})`;

function check(row) {
  const at = label(row);
  const want = expected(row);
  let got;
  try {
    got = { out: RUN[row.op](row.in.map((one) => dec(one))) };
  } catch (error) {
    got = { throws: error.code ?? error.name };
  }
  if (want.throws !== undefined) {
    assert.equal(got.throws, want.throws, `${at} should have thrown ${want.throws}`);
    return;
  }
  assert.equal(got.throws, undefined, `${at} threw ${got.throws}`);
  const wanted = dec(want.out);
  assert.ok(alike(got.out, wanted), `${at}\n  got    ${show(got.out)}\n  wanted ${show(wanted)}`);
}

// -- the three tables --------------------------------------------------------

test('the paths table: toPath, get and has', () => {
  const { cases } = table('paths');
  assert.equal(cases.length, 43);
  for (const row of cases) check(row);
});

test('the write table: set, unset, pick, omit and merge', () => {
  const { cases } = table('write');
  assert.equal(cases.length, 50);
  for (const row of cases) check(row);
});

test('the values table: cloneDeep, isEqual and the collections', () => {
  const { cases } = table('values');
  assert.equal(cases.length, 54);
  for (const row of cases) check(row);
});

test('every divergence in the tables has a name and a count', () => {
  // Fifteen of 147 rows disagree with lodash, and each one falls into a cause named below. A new
  // disagreement cannot arrive quietly: it lands in UNKNOWN and the counts stop adding up.
  const tally = new Map();
  const unknown = [];
  const REASONS = new Set(['brackets', 'own', 'unsafe', 'primitive', 'symbols', 'bytes', 'bare', 'error', 'iterable', 'nan']);
  for (const name of ['paths', 'write', 'values']) {
    for (const row of table(name).cases) {
      const claims = Object.hasOwn(row, 'ours') || row.oursThrows !== undefined;
      assert.equal(claims, row.why !== undefined, `${label(row)} carries one half of a divergence`);
      if (row.why === undefined) continue;
      if (!REASONS.has(row.why)) unknown.push(`${label(row)} claims ${row.why}`);
      tally.set(row.why, (tally.get(row.why) ?? 0) + 1);
    }
  }
  assert.deepEqual(unknown, [], 'a disagreement with no recorded cause');
  assert.deepEqual(Object.fromEntries([...tally].sort()), {
    // A deep write never follows a property the object does not own, and never follows a key that
    // reaches the prototype at all. Between them these two are the module's reason to exist.
    own: 1,
    unsafe: 4,
    // A bracket quotes what is inside it, so `a[x.y]` is two keys. lodash's regular expression
    // takes only a number or a quoted string there and reads the rest as if the brackets were
    // never typed, which makes the same path three keys.
    brackets: 3,
    // merge into a primitive gives the primitive back rather than a boxed wrapper; a typed-array
    // source stays a typed array; a symbol key on a source is merged rather than skipped.
    primitive: 1,
    bytes: 1,
    symbols: 1,
    // A clone that keeps what the original was made with: the null prototype, and the Error.
    bare: 1,
    error: 1,
    // A Set is a collection. lodash hands back {} for anything that is not array-like.
    iterable: 1,
    // Two NaN criteria tie, instead of a comparator that answers "greater" in both directions and
    // never reaches the second criterion.
    nan: 1,
  });
});

// -- the bug the tables cannot show ------------------------------------------

test('a deep write never follows a property the object does not own', () => {
  // The four prototype-pollution CVEs in lodash's history are one bug, and a three-name blocklist
  // is the wrong shape for it. `toString` is on nobody's blocklist: lodash walks into the
  // *inherited* Object.prototype.toString, materialises it and writes there, after which every
  // object in the program carries the value and an unrelated `_.pick({}, 'toString')` hands it
  // back. Here the walk stops at the first key the object does not own and makes its own container.
  const target = {};
  set(target, 'toString.polluted', 'yes');
  assert.equal(Object.prototype.toString.polluted, undefined, 'Object.prototype was written to');
  assert.equal({}.toString.polluted, undefined, 'an unrelated object can see the write');
  assert.equal(Object.hasOwn(target, 'toString'), true, 'the write went somewhere else entirely');
  assert.deepEqual(target.toString, { polluted: 'yes' });
  assert.equal(typeof {}.toString, 'function', 'and toString still works everywhere else');
});

test('omit copies own keys only, which is also why its result can be printed', () => {
  // lodash copies inherited keys here, so `_.omit(Buffer.from('hi'), '0')` returns a plain object
  // wearing all 90-odd methods of Buffer.prototype -- including `inspect`, which then throws
  // ERR_INVALID_ARG_TYPE the moment anything tries to log the result.
  const left = omit(Buffer.from('hi'), '0');
  assert.deepEqual(Reflect.ownKeys(left), ['1']);
  assert.equal(inspect(left), "{ '1': 105 }");
});

test('every refusal carries a code, and the codes are the documented pair', () => {
  const code = (run) => {
    let error = null;
    try {
      run();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CollectError, `${run} did not throw a CollectError`);
    assert.ok(error instanceof Error, 'so an existing catch still catches it');
    assert.equal(error.name, 'CollectError');
    return error.code;
  };
  // A payload that arrives in JSON is a bug in whoever parsed it. Skipping the key in silence lets
  // the same bug ship twice, so the write path says so out loud instead.
  const payload = JSON.parse('{"__proto__":{"x":1}}');
  assert.equal(code(() => set({}, '__proto__.x', 1)), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => set({}, 'a.constructor.b', 1)), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => set({}, 'a.prototype', 1)), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => unset({ a: 1 }, '__proto__')), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => merge({}, payload)), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => merge({}, JSON.parse('{"a":{"__proto__":{"x":1}}}'))), 'ERR_UNSAFE_KEY');
  assert.equal(code(() => debounce(null)), 'ERR_NOT_A_FUNCTION');
  assert.equal(code(() => throttle(42)), 'ERR_NOT_A_FUNCTION');
  assert.equal({}.x, undefined, 'a refusal that leaked the write it refused');
  assert.equal(Object.prototype.x, undefined);
});

// -- the two that own a clock ------------------------------------------------

/** node:test's fake clock, which is the whole reason debounce reads its timers off globalThis and
 * its clock off Date at the moment it needs them rather than capturing either at import. A real
 * `wait` here would mean a suite that sleeps for seconds and fails on a loaded machine. */
const withClock = (run) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    run(mock.timers);
  } finally {
    mock.timers.reset();
  }
};

test('debounce puts the call off until the calls stop', () => {
  withClock((clock) => {
    const seen = [];
    const later = debounce((n) => { seen.push(n); return n * 2; }, 100);
    assert.equal(later(1), undefined, 'nothing has been called, so there is no result to report');
    later(2);
    assert.equal(later.pending(), true);
    clock.tick(99);
    assert.deepEqual(seen, [], 'called one millisecond early');
    clock.tick(1);
    assert.deepEqual(seen, [2], 'the last arguments win, and only they are used');
    assert.equal(later.pending(), false);
    // A later call reports the previous result until its own lands -- lodash does the same, and a
    // call site written against it may be reading that value.
    assert.equal(later(3), 4);
    assert.equal(later.flush(), 6, 'flush calls it now and hands back what it returned');
    assert.deepEqual(seen, [2, 3]);
    later(4);
    later.cancel();
    clock.tick(500);
    assert.deepEqual(seen, [2, 3], 'a cancelled call still arrived');
  });
});

test('debounce: the leading edge, and the cap that promises a call anyway', () => {
  withClock((clock) => {
    const seen = [];
    const first = debounce((n) => seen.push(n), 100, { leading: true, trailing: false });
    first('a');
    first('b');
    assert.deepEqual(seen, ['a'], 'leading calls on the first one, not the second');
    clock.tick(200);
    assert.deepEqual(seen, ['a'], 'and trailing:false means the last one is dropped');

    // Without a cap, a caller that never pauses for `wait` never gets a call at all. maxWait is
    // the promise that one lands every 250ms regardless -- here, calls arrive every 50ms forever.
    const capped = [];
    const often = debounce((n) => capped.push(n), 100, { maxWait: 250 });
    for (let n = 0; n < 10; n += 1) {
      often(n);
      clock.tick(50);
    }
    assert.deepEqual(capped, [4, 9], 'the cap came due once, then the calls stopped and it ran');
  });
});

test('throttle is debounce with the cap set to the wait', () => {
  withClock((clock) => {
    const seen = [];
    const rated = throttle((n) => seen.push(n), 100);
    rated(1);
    rated(2);
    clock.tick(50);
    rated(3);
    assert.deepEqual(seen, [1], 'the first call goes straight through, the rest wait');
    clock.tick(50);
    assert.deepEqual(seen, [1, 3], 'and the most recent one goes when the window turns over');
    clock.tick(200);
    assert.deepEqual(seen, [1, 3], 'a window with no calls in it invents one');
  });
});

// -- the promises in the header ---------------------------------------------

test('the module parses paths with a character loop, not a pattern', () => {
  // lodash's path parser is a memoised regular expression, and its `trim` was CVE-2020-28500 --
  // a ReDoS in the same file. Nothing here is compiled, so no input can make it backtrack.
  const source = readFileSync(new URL('../../src/runtime/collect.mjs', import.meta.url), 'utf8');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const banned of ['.match(', '.matchAll(', '.replace(', '.split(', '.search(', '.test(', '.exec(']) {
    assert.equal(stripped.includes(banned), false, `${banned} appears in the module`);
  }
  // One `new RegExp` survives, in cloneDeep: copying a pattern the caller already compiled is not
  // the same thing as compiling one to read input with. It is followed by nothing that runs it.
  assert.equal(stripped.split('new RegExp(').length - 1, 1, 'a second RegExp appeared');
  // With the comments gone, a `/` can only be a pattern literal or a division, and the file
  // divides exactly once -- to tell -0 from 0, where `Object.is` would read worse in context.
  const slashed = stripped.split('\n').filter((line) => line.includes('/')).map((line) => line.trim());
  assert.deepEqual(slashed, ["if (typeof value === 'number' && value === 0 && 1 / value === -Infinity) return '-0';"]);
});

test('the default export is the shape a default binding of lodash expects', () => {
  // The codemod checks a call site against these names and refuses the file rather than rewriting a
  // call into something that would throw at run time, so the list is part of the contract.
  const members = Object.keys(collect.default).sort();
  assert.deepEqual(members, [
    'CollectError', 'chunk', 'cloneDeep', 'debounce', 'get', 'groupBy', 'has', 'isEqual', 'keyBy',
    'merge', 'omit', 'pick', 'set', 'sortBy', 'throttle', 'toPath', 'uniqBy', 'unset',
  ]);
  assert.equal(Object.isFrozen(collect.default), true, 'a replacement that can be monkey-patched');
  for (const name of members) {
    assert.equal(collect.default[name], collect[name], `${name} is not the named export`);
  }
});
