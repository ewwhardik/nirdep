// The parts of lodash a program actually uses, and nothing else.
//
// Replaces the sixteen functions that make up most real lodash traffic: get, set, has, unset,
// pick, omit, cloneDeep, merge, isEqual, groupBy, keyBy, uniqBy, chunk, sortBy, debounce and
// throttle. The copy measured here is 1051 files and 2.1MB installed, 17,259 lines of it in one
// file, and the usual reason a project carries all of that is two of these sixteen names. No
// download figure is quoted because none could be checked from here; the file count can be.
//
// Its advisory record is the argument for this file. CVE-2018-3721 and CVE-2018-16487 were
// prototype pollution in `merge`; CVE-2019-10744 was the same bug again in `defaultsDeep`, by a
// route the first fix left open; CVE-2020-8203 was the same bug a third time in `set` and
// `zipObjectDeep`; CVE-2020-28500 was a ReDoS in `trim`, and CVE-2021-23337 was command
// injection in `template`. Four of those six are one bug: a deep write that will follow any key
// it is handed, including `__proto__`. A blocklist bolted onto a recursive assignment is the
// wrong shape for it, which is why the fix needed three attempts.
//
// So the write path here refuses those keys structurally and loudly: `set`, `unset` and `merge`
// throw a CollectError with code ERR_UNSAFE_KEY rather than skipping the key in silence. A
// payload that arrives in JSON is a bug in whoever parsed it, and a tool that drops it quietly
// is a tool that lets the same bug ship twice. This is a deliberate divergence from lodash,
// which returns normally; it is named in STDLIB.md.
//
// What Node already answers is used rather than reimplemented: `Object.groupBy` does the
// grouping, `Object.hasOwn` the ownership, `Array.prototype.sort` the stable sort,
// `Intl.Collator` nothing at all because lodash does not sort that way either. What Node
// answers *nearly* is the interesting entry: `structuredClone` is a deep clone in the platform,
// and it is not this one -- it throws on a function, drops a class's prototype, turns a getter
// into data and cannot be talked out of any of it. The comment above cloneDeep says which to
// reach for.
//
// It contains no regular expression, for the same reason `runtime/glob` does not: lodash's own
// path parser is a memoised RegExp, and `trim`'s was CVE-2020-28500. The path scanner below is
// a character loop, so no input can make it backtrack.

/** A refusal, not a failure. `code` is the part a caller can branch on. */
export class CollectError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}

/** The three keys that turn a deep write into a prototype rewrite. `constructor` is here
 * because `obj.constructor.prototype` reaches the same place by a longer road. */
const UNSAFE = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

const OBJECT_TAG = '[object Object]';
const tagOf = (value) => Object.prototype.toString.call(value);
const isObjectLike = (value) => value !== null && typeof value === 'object';

/**
 * Whether a value is an object with no class of its own: a literal, a `null`-prototype bag, or
 * one of either from another realm. The realm case is why the constructor is inspected at all --
 * an object made inside node:vm has a different `Object.prototype`, and treating it as a class
 * instance would make `merge` assign it by reference instead of merging into it.
 */
function isPlainObject(value) {
  if (!isObjectLike(value) || tagOf(value) !== OBJECT_TAG) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const ctor = Object.hasOwn(proto, 'constructor') ? proto.constructor : null;
  return Object.getPrototypeOf(proto) === null && typeof ctor === 'function' && ctor.name === 'Object';
}

/** Whether a key addresses an array slot rather than a property. `'01'` is a property: it is
 * not what `Array.prototype` would have produced, so it cannot be treated as an index. */
function isIndexKey(key) {
  if (typeof key === 'number') return Number.isInteger(key) && key >= 0;
  if (typeof key !== 'string' || key.length === 0 || key.length > 10) return false;
  for (let at = 0; at < key.length; at += 1) {
    const code = key.charCodeAt(at);
    if (code < 48 || code > 57) return false;
  }
  return key.length === 1 || key.charCodeAt(0) !== 48;
}

/** A path element as a property key. Symbols pass through; everything else is a string, and
 * `-0` keeps its sign so it cannot be confused with the first slot of an array. */
function toKey(value) {
  if (typeof value === 'string' || typeof value === 'symbol') return value;
  if (typeof value === 'number' && value === 0 && 1 / value === -Infinity) return '-0';
  return `${value}`;
}

const DOT = 46;
const LBRACKET = 91;
const RBRACKET = 93;
const QUOTE = 39;
const DQUOTE = 34;
const BACKSLASH = 92;

/**
 * `'users[0].name'` to `['users', '0', 'name']`, one character at a time.
 *
 * lodash does this with a memoised regular expression whose cache is a global object keyed by
 * the untrusted string it was handed. This is a loop over the characters: brackets take
 * anything up to the closing one, a quoted bracket honours backslash escapes, and an empty
 * segment stays in the list because `a..b` addresses a property whose name is empty and
 * silently dropping it would read a different object than the caller wrote.
 *
 * One divergence, and it favours the brackets. Here a bracket quotes whatever is inside it, so
 * `a[x.y]` is two keys and the second is named `x.y`. lodash's regular expression accepts only a
 * number or a quoted string inside brackets and reads anything else as though the brackets were
 * not typed at all, which makes `a[x.y]` three keys. Brackets that mean nothing are a worse
 * answer than brackets that mean what they look like.
 *
 * @param {string|number|symbol|Array<string|number|symbol>} value
 * @returns {Array<string|symbol>}
 */
export function toPath(value) {
  if (Array.isArray(value)) return value.map(toKey);
  if (typeof value === 'symbol') return [value];
  const text = value === null || value === undefined ? '' : `${value}`;
  const keys = [];
  let at = 0;
  if (text.charCodeAt(0) === DOT) keys.push('');
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === DOT) {
      at += 1;
      if (at === text.length || text.charCodeAt(at) === DOT) keys.push('');
      continue;
    }
    if (code === RBRACKET) {
      // A closing bracket with nothing open is nothing, and skipping a character is how a
      // scanner declines to loop forever on it.
      at += 1;
      continue;
    }
    if (code === LBRACKET) {
      at += 1;
      const quote = text.charCodeAt(at);
      let out = '';
      if (quote === QUOTE || quote === DQUOTE) {
        at += 1;
        while (at < text.length && text.charCodeAt(at) !== quote) {
          if (text.charCodeAt(at) === BACKSLASH) at += 1;
          out += text[at];
          at += 1;
        }
        at += 1;
      } else {
        while (at < text.length && text.charCodeAt(at) !== RBRACKET) {
          out += text[at];
          at += 1;
        }
      }
      const closed = text.charCodeAt(at) === RBRACKET;
      if (closed) at += 1;
      // `a[]` addresses the empty name; `a[` addresses nothing and is the end of the string.
      if (out.length > 0 || closed) keys.push(out);
      continue;
    }
    let out = '';
    while (at < text.length) {
      const here = text.charCodeAt(at);
      if (here === DOT || here === LBRACKET || here === RBRACKET) break;
      out += text[at];
      at += 1;
    }
    keys.push(out);
  }
  return keys;
}

/** Whether every character is one a bare property name is made of: the `\w` class, spelled out. */
function isWordy(text) {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    const wordy = (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122) || code === 95;
    if (!wordy) return false;
  }
  return true;
}

/** Whether a string contains anything that makes it a path: a dot, or a bracket that closes. */
function looksDeep(text) {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === DOT) return true;
    if (code !== LBRACKET) continue;
    let end = at + 1;
    const quote = text.charCodeAt(end);
    if (quote === QUOTE || quote === DQUOTE) {
      end += 1;
      while (end < text.length && text.charCodeAt(end) !== quote) {
        end += text.charCodeAt(end) === BACKSLASH ? 2 : 1;
      }
      if (text.charCodeAt(end + 1) === RBRACKET) return true;
      continue;
    }
    while (end < text.length && text.charCodeAt(end) !== RBRACKET && text.charCodeAt(end) !== LBRACKET) {
      end += 1;
    }
    if (text.charCodeAt(end) === RBRACKET) return true;
  }
  return false;
}

/**
 * A path, read with the object in hand -- which is the only way to read one correctly.
 *
 * `get(row, 'x.y')` on an object with a literal `'x.y'` key means that key, not a walk through
 * `x` to `y`: a name that exists wins over any reading of it as a route. lodash asks the same
 * question with two regular expressions and one clause of real judgement; this is the judgement.
 */
function pathIn(object, path) {
  if (Array.isArray(path)) return path.map(toKey);
  if (typeof path === 'symbol') return [path];
  if (typeof path !== 'string') return [toKey(path)];
  if (isWordy(path) || !looksDeep(path)) return [path];
  if (object !== null && object !== undefined && path in Object(object)) return [path];
  return toPath(path);
}

/**
 * The value at a path, or `fallback` if the road runs out. `undefined` found at the end and
 * `undefined` because nothing was there are the same answer, which is lodash's behaviour and
 * the reason `has` exists as a separate question.
 *
 * @param {*} object
 * @param {string|number|symbol|Array<string|number|symbol>} path
 * @param {*} [fallback]
 */
export function get(object, path, fallback) {
  const keys = pathIn(object, path);

  if (keys.length === 0) return fallback;
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined) return fallback;
    current = current[key];
  }
  return current === undefined ? fallback : current;
}

/**
 * Whether every step of the path is an own property. Inherited names answer `false` --
 * `has({}, 'toString')` is the question this function exists to get right.
 */
export function has(object, path) {
  const keys = pathIn(object, path);
  if (keys.length === 0) return false;
  let current = object;
  for (let at = 0; at < keys.length; at += 1) {
    const key = keys[at];
    if (current === null || current === undefined) return false;
    const bag = typeof current === 'object' || typeof current === 'function' ? current : Object(current);
    if (!Object.hasOwn(bag, key)) {
      // One exception, and lodash makes it too: a hole in an array is not an own property, but an
      // index inside the length of an array or an `arguments` is a slot that exists. `[, ,]` has
      // a second element in every sense a caller cares about.
      if (at !== keys.length - 1 || !isIndexKey(key)) return false;
      const length = current.length;
      return Number.isSafeInteger(length) && Number(key) < length
        && (Array.isArray(current) || tagOf(current) === '[object Arguments]');
    }
    current = current[key];
  }
  return true;
}

/** The refusal shared by every deep write. */
function checkKey(key, path) {
  if (typeof key === 'string' && UNSAFE.has(key)) {
    throw new CollectError(`refusing to write ${String(key)} at ${path.map(String).join('.')}: `
      + 'a deep write that follows that key rewrites the prototype instead of the object', 'ERR_UNSAFE_KEY');
  }
}

/**
 * Assign, unless the property will not have it: a frozen object, a sealed one, a getter with no
 * setter. lodash is sloppy-mode code and those writes quietly did nothing there; this file is a
 * module, where the same line is a TypeError. `Reflect.set` is the one spelling of an assignment
 * that reports failure instead of raising it, so declining an *impossible* write keeps a rewritten
 * call site behaving as it did. That is a different thing from refusing a *dangerous* one -- the
 * dangerous case is loud, and it is the reason `checkKey` exists.
 *
 * @returns {boolean} whether the write happened
 */
function put(holder, key, value) {
  return Reflect.set(holder, key, value);
}

/**
 * Write a value at a path, making the missing steps on the way. A numeric step makes an array
 * and anything else makes an object, which is lodash's rule and the one that surprises people
 * least. Mutates and returns `object`.
 *
 * Two divergences, and the second is the more interesting one. An unsafe key anywhere in the path
 * throws: see UNSAFE above. And a step is followed only when the object owns it -- `set(o,
 * 'toString.x', 1)` in lodash walks into the *inherited* `toString`, which is a function every
 * object in the program shares, and writes there. A blocklist of three names cannot catch that;
 * refusing to follow anything the object inherited can, and does.
 */
export function set(object, path, value) {
  if (!isObjectLike(object) && typeof object !== 'function') return object;
  const keys = pathIn(object, path);
  if (keys.length === 0) return object;
  for (const key of keys) checkKey(key, keys);
  let current = object;
  for (let at = 0; at < keys.length - 1; at += 1) {
    const key = keys[at];
    const next = Object.hasOwn(current, key) ? current[key] : undefined;
    if (isObjectLike(next) || typeof next === 'function') {
      current = next;
      continue;
    }
    const made = isIndexKey(keys[at + 1]) ? [] : {};
    // A refusal ends the walk: a read-only or frozen property answers false and the object comes
    // back as it was found. A property that *complains* -- `length`, which coerces whatever it is
    // handed and will not take an object -- throws, and that throw is the object's own and is
    // passed on rather than swallowed, which is lodash's behaviour here as well.
    if (!put(current, key, made)) return object;
    current = made;
  }
  put(current, keys[keys.length - 1], value);
  return object;
}

/** Delete the property at a path. `true` when it is gone, including when it was never there,
 * which is what `delete` itself answers; `false` only when the property refuses to go. Inherited
 * steps are not followed, for the reason `set` gives. */
export function unset(object, path) {
  const keys = pathIn(object, path);
  if (keys.length === 0) return true;
  for (const key of keys) checkKey(key, keys);
  let current = object;
  for (let at = 0; at < keys.length - 1; at += 1) {
    if (!isObjectLike(current) && typeof current !== 'function') return true;
    if (!Object.hasOwn(current, keys[at])) return true;
    current = current[keys[at]];
  }
  if (!isObjectLike(current) && typeof current !== 'function') return true;
  const last = keys[keys.length - 1];
  if (!Object.hasOwn(current, last)) return true;
  // `Reflect.deleteProperty` is `delete` that answers instead of throwing: a non-configurable
  // property and an in-bounds slot of a typed array both come back false, which is the answer.
  return Reflect.deleteProperty(current, last);
}

/** Own enumerable keys, strings and symbols both. A symbol key is how a library marks data as
 * its own, and a clone that drops it is a clone that library will not recognise. */
function ownKeys(value) {
  const symbols = Object.getOwnPropertySymbols(value)
    .filter((one) => Object.getOwnPropertyDescriptor(value, one).enumerable);
  return symbols.length === 0 ? Object.keys(value) : [...Object.keys(value), ...symbols];
}

/** Node's Buffer, if this is Node. Looked up rather than imported so the file runs in a
 * browser, where the answer is simply that there are no Buffers. */
const isBuffer = (value) => typeof globalThis.Buffer?.isBuffer === 'function' && globalThis.Buffer.isBuffer(value);

/** Whether a value has a length that a loop can trust: an array, a typed array, an `arguments`,
 * or the `{0: 'a', length: 1}` shape that predates all three. */
const isArrayLike = (value) => isObjectLike(value) && Number.isSafeInteger(value.length) && value.length >= 0;

/**
 * A deep copy, with cycles, Maps, Sets, typed arrays, prototypes and symbol keys intact.
 *
 * Node has `structuredClone`, and where it fits it is the better answer: it is in the platform
 * and it is not this loop. It fits when the data is data. It throws on a function or a
 * DOM-hostile value, it returns a plain object where a class instance went in, and it turns an
 * accessor into a fixed value -- so a config object with a getter on it comes back subtly
 * wrong rather than loudly broken. This clone keeps the prototype and copies own enumerable
 * properties, which is what a lodash call site is written against.
 */
export function cloneDeep(value) {
  return cloneAny(value, new WeakMap(), false);
}

function cloneAny(value, seen, nested) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  // A function cannot be copied. lodash answers `{}` for one handed in directly and the
  // function itself for one found on a property, and both are kept: a shared function is
  // normal, and a top-level clone of one is a mistake worth showing.
  if (typeof value === 'function') return nested ? value : {};
  if (seen.has(value)) return seen.get(value);
  const flat = cloneFlat(value);
  if (flat !== undefined) return flat;
  const made = emptyLike(value);
  seen.set(value, made);
  fillClone(value, made, seen);
  return made;
}

/**
 * The values that copy in one move and cannot contain a cycle. `undefined` means "not one of
 * these", which is safe because none of them clone *to* undefined.
 *
 * A Promise, a WeakMap or a WeakSet comes back by reference. There is no copy of any of them
 * that is not a lie: a second Promise settles separately, and a copied WeakMap cannot be
 * populated because its keys are unreachable by design.
 */
function cloneFlat(value) {
  if (isBuffer(value)) return globalThis.Buffer.from(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return new value.constructor(value);
  switch (tagOf(value)) {
    case '[object Date]': return new Date(value.getTime());
    case '[object RegExp]': {
      const made = new RegExp(value.source, value.flags);
      made.lastIndex = value.lastIndex;
      return made;
    }
    case '[object Symbol]': return Object(Symbol.prototype.valueOf.call(value));
    case '[object Number]':
    case '[object String]':
    case '[object Boolean]':
    case '[object BigInt]': return Object(value.valueOf());
    case '[object ArrayBuffer]': return value.slice(0);
    case '[object DataView]': return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    case '[object Promise]':
    case '[object WeakMap]':
    case '[object WeakSet]': return value;
    default: return undefined;
  }
}

/** The same shape, empty. The prototype travels, including a `null` one: somebody who made a
 * bag with no prototype did it so that nothing would be inherited, and a clone that quietly
 * hands back `{}` has undone the only thing that object was for. */
function emptyLike(value) {
  if (Array.isArray(value)) return new Array(value.length);
  const tag = tagOf(value);
  if (tag === '[object Map]') return new Map();
  if (tag === '[object Set]') return new Set();
  if (tag === '[object Arguments]') return {};
  return Object.create(Object.getPrototypeOf(value));
}

/** The contents, once the empty shell is registered against cycles. */
function fillClone(value, made, seen) {
  if (Array.isArray(value)) {
    for (let at = 0; at < value.length; at += 1) made[at] = cloneAny(value[at], seen, true);
    return;
  }
  const tag = tagOf(value);
  if (tag === '[object Map]') {
    // The values are cloned and the keys are not, which is lodash's behaviour and the useful
    // one: a key is an identity, and a copy of it would not find its own entry.
    value.forEach((entry, key) => made.set(key, cloneAny(entry, seen, true)));
    return;
  }
  if (tag === '[object Set]') {
    value.forEach((entry) => made.add(cloneAny(entry, seen, true)));
    return;
  }
  if (value instanceof Error) {
    // lodash answers `{}` for an error, which loses the one thing it was carrying. Message and
    // stack are not enumerable, so they are copied by name or not at all.
    for (const key of ['message', 'stack']) {
      if (Object.hasOwn(value, key)) {
        Object.defineProperty(made, key, { value: value[key], writable: true, configurable: true });
      }
    }
    if (Object.hasOwn(value, 'cause')) made.cause = cloneAny(value.cause, seen, true);
  }
  for (const key of ownKeys(value)) {
    if (key === 'cause' && value instanceof Error) continue;
    made[key] = cloneAny(value[key], seen, true);
  }
}

/**
 * Deep-merge each source into `object`, left to right, and return it.
 *
 * The rules are lodash's, because a rewritten call site depends on them: arrays merge by index
 * rather than concatenating, a plain object merges into whatever is already there, an
 * `undefined` in a source does not erase a value in the target, and anything with a class of
 * its own -- a Date, a Map, an instance -- is assigned by reference rather than picked apart.
 * Buffers and typed arrays are copied, since merging into a fixed-width window is not a merge.
 *
 * Three divergences, all deliberate. An unsafe key throws instead of quietly landing. Only own
 * keys are read from a source, where lodash also walks the prototype chain -- a source's
 * inherited property is almost never what the caller meant to copy. And symbol keys are merged,
 * where lodash silently ignores them.
 */
export function merge(object, ...sources) {
  if (!isObjectLike(object) && typeof object !== 'function') return object;
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    mergeInto(object, source, new Map());
  }
  return object;
}

function mergeInto(target, source, seen) {
  for (const key of ownKeys(source)) {
    checkKey(key, [key]);
    const from = source[key];
    if (isObjectLike(from)) mergeDeep(target, key, from, seen);
    else assignInto(target, key, from);
  }
}

/**
 * The one assignment merge makes, and the reason a `-0` already in the target survives a `0`
 * arriving in a source: a value indistinguishable from the one that is there is not written
 * again. `undefined` is the exception -- it fills a key that is missing and never overwrites one
 * that is present, which is what makes `merge` a fill rather than an assign.
 */
function assignInto(target, key, value) {
  if (value === undefined) {
    if (!(key in target)) put(target, key, value);
    return;
  }
  const at = Object.hasOwn(target, key) ? target[key] : undefined;
  if (!same(at, value)) put(target, key, value);
}

function mergeDeep(target, key, from, seen) {
  // A source that refers to itself would otherwise recurse until the stack ends. The already
  // built target for it is the honest answer, and it is what lodash answers too.
  if (seen.has(from)) {
    assignInto(target, key, seen.get(from));
    return;
  }
  // Own only: an inherited object at this key belongs to every object sharing that prototype,
  // and merging into it would edit all of them.
  const into = Object.hasOwn(target, key) ? target[key] : undefined;
  let made = from;
  let recurse = true;
  if (Array.isArray(from) || isBuffer(from) || ArrayBuffer.isView(from)) {
    if (Array.isArray(into)) made = into;
    else if (isBuffer(from) || ArrayBuffer.isView(from)) {
      made = cloneAny(from, new WeakMap(), true);
      recurse = false;
    } else if (isArrayLike(into)) {
      // A Uint8Array or an `{0: …, length: 1}` under an array source: the elements already there
      // come along, in a plain array, because an array source can be longer than a fixed window.
      made = Array.prototype.slice.call(into);
    } else made = [];
  } else if (isPlainObject(from) || tagOf(from) === '[object Arguments]') {
    made = isObjectLike(into) ? into : {};
    // An `arguments` object on the target side becomes a plain object: merging into one would
    // write properties nobody can read back through the argument names.
    if (tagOf(into) === '[object Arguments]') made = { ...into };
  } else {
    // A Date, a Map, a class instance: assigned, not merged. Picking apart something with
    // behaviour produces an object that has its data and none of its methods.
    recurse = false;
  }
  if (recurse) {
    seen.set(from, made);
    mergeInto(made, from, seen);
    seen.delete(from);
  }
  assignInto(target, key, made);
}

/**
 * Deep equality, the lodash way: NaN equals NaN, `0` equals `-0`, a boxed primitive equals the
 * primitive it wraps, Maps and Sets compare by contents rather than by insertion order, and two
 * instances of different classes with identical fields are not equal. Cycles are handled by
 * remembering which pair is already being compared.
 */
export function isEqual(a, b) {
  return equals(a, b, new Map());
}

function equals(a, b, seen) {
  if (a === b) return true;
  const bothLike = isObjectLike(a) || isObjectLike(b);
  // Two NaNs, and nothing else, are equal without being identical.
  if (!bothLike) return a !== a && b !== b;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const tag = tagOf(a) === '[object Arguments]' ? '[object Object]' : tagOf(a);
  const other = tagOf(b) === '[object Arguments]' ? '[object Object]' : tagOf(b);
  if (tag !== other) return false;
  const stacked = seen.get(a);
  if (stacked !== undefined) return stacked === b;
  seen.set(a, b);
  const answer = equalsByTag(a, b, tag, seen);
  seen.delete(a);
  return answer;
}

/** SameValueZero, which is `===` with NaN made reflexive. */
const same = (a, b) => a === b || (a !== a && b !== b);

function equalsByTag(a, b, tag, seen) {
  switch (tag) {
    case '[object Date]': return same(a.getTime(), b.getTime());
    case '[object RegExp]': return `${a}` === `${b}`;
    case '[object Error]': return a.name === b.name && a.message === b.message;
    case '[object Symbol]': return Symbol.prototype.valueOf.call(a) === Symbol.prototype.valueOf.call(b);
    case '[object Number]': return same(a.valueOf(), b.valueOf());
    case '[object String]': return `${a}` === `${b}`;
    case '[object Boolean]':
    case '[object BigInt]': return a.valueOf() === b.valueOf();
    case '[object ArrayBuffer]': return sameBytes(new Uint8Array(a), new Uint8Array(b));
    case '[object DataView]':
      return a.byteLength === b.byteLength && a.byteOffset === b.byteOffset
        && sameBytes(new Uint8Array(a.buffer), new Uint8Array(b.buffer));
    case '[object Map]': return sameEntries([...a], [...b], seen);
    case '[object Set]': return sameEntries([...a], [...b], seen);
    case '[object Array]': return sameSequence(a, b, seen);
    case '[object Object]': return sameObjects(a, b, seen);
    default: {
      if (ArrayBuffer.isView(a)) return sameSequence(a, b, seen);
      // A Promise, a WeakMap, a function: nothing to compare that is not identity, and
      // identity was checked before we got here.
      return false;
    }
  }
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at]);

function sameSequence(a, b, seen) {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at += 1) {
    if (!equals(a[at], b[at], seen)) return false;
  }
  return true;
}

/** Maps and Sets have contents, not an order: an entry counts if it matches any unclaimed one
 * on the other side. Each match is consumed, so two of a thing cannot both match one of it. */
function sameEntries(mine, theirs, seen) {
  if (mine.length !== theirs.length) return false;
  const taken = new Uint8Array(theirs.length);
  for (const entry of mine) {
    let found = false;
    for (let at = 0; at < theirs.length && !found; at += 1) {
      if (taken[at] === 0 && equals(entry, theirs[at], seen)) {
        taken[at] = 1;
        found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}

function sameObjects(a, b, seen) {
  const mine = ownKeys(a);
  const theirs = ownKeys(b);
  if (mine.length !== theirs.length) return false;
  for (const key of mine) {
    if (!Object.hasOwn(b, key)) return false;
  }
  for (const key of mine) {
    if (!equals(a[key], b[key], seen)) return false;
  }
  // Same fields, different classes, different objects. A Point and a Vector with the same x and
  // y are not the same thing, and the code that told them apart by constructor is right to.
  const mineCtor = 'constructor' in a ? a.constructor : undefined;
  const theirCtor = 'constructor' in b ? b.constructor : undefined;
  if (mineCtor === theirCtor) return true;
  const bothClasses = typeof mineCtor === 'function' && mineCtor instanceof mineCtor
    && typeof theirCtor === 'function' && theirCtor instanceof theirCtor;
  return !('constructor' in a && 'constructor' in b) || bothClasses;
}

/**
 * The shorthand lodash accepts wherever it says "iteratee": a function, a path, or an object
 * read as "every one of these properties matches". The object form is written in terms of the
 * two functions above it, which is the argument for having them.
 */
function iterateeOf(value) {
  if (value === null || value === undefined) return (item) => item;
  if (typeof value === 'function') return value;
  // lodash reads a two-element array as a question about one property -- `['role', 'admin']` asks
  // whether `role` is `'admin'`, it does not address `role.admin`. Reading it as a path would be
  // the friendlier guess and the wrong one, and a call site that worked would quietly change.
  if (Array.isArray(value)) return (item) => isEqual(get(item, value[0]), value[1]);
  if (typeof value === 'object') return (item) => matchesPartly(item, value);
  return (item) => get(item, value);
}

/** Whether `item` carries everything `source` asks for. Nested plain objects are matched the same
 * way, one level at a time, so `{user: {id: 2}}` matches a user with an id and a name. */
function matchesPartly(item, source) {
  for (const key of ownKeys(source)) {
    const wanted = source[key];
    const found = get(item, [key]);
    if (wanted === undefined && !hasIn(item, [key])) return false;
    if (isPlainObject(wanted) && isPlainObject(found)) {
      if (!matchesPartly(found, wanted)) return false;
      continue;
    }
    if (!isEqual(found, wanted)) return false;
  }
  return true;
}

/** Whether a path exists, own or inherited. `pick` asks the looser question on purpose: a
 * getter on a class is still a property somebody meant to pick. */
function hasIn(object, keys) {
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined) return false;
    if (!(key in Object(current))) return false;
    current = current[key];
  }
  return true;
}

/**
 * A new object with only the paths asked for, nested shape preserved:
 * `pick(user, 'name', 'address.city')` gives back `{ name, address: { city } }`.
 */
export function pick(object, ...paths) {
  const made = {};
  if (object === null || object === undefined) return made;
  // One level, not all of them: `pick(row, ['a', 'b'])` names two properties, and
  // `pick(row, [['a', 'b']])` names one that is two deep. Flattening everything loses that.
  for (const path of paths.flat(1)) {
    const keys = pathIn(object, path);
    if (keys.length > 0 && hasIn(object, keys)) set(made, keys, get(object, keys));
  }
  return made;
}

/** A one-level copy that keeps the kind of thing it copies. Anything with a fixed shape -- a
 * typed array, a Map, a Date -- comes back as itself: there is no property inside one of those
 * that a caller means to remove. */
function shallowLike(value) {
  if (Array.isArray(value)) return [...value];
  const tag = tagOf(value);
  if (tag !== OBJECT_TAG && tag !== '[object Arguments]') return value;
  const made = Object.create(Object.getPrototypeOf(value));
  for (const key of ownKeys(value)) made[key] = value[key];
  return made;
}

/** Duplicate the containers along a path, so removing something from the copy cannot reach the
 * original -- the reason `omit` can be handed an object somebody else still holds. */
function copyBranch(target, keys) {
  let current = target;
  for (let at = 0; at < keys.length - 1; at += 1) {
    const key = keys[at];
    const next = Object.hasOwn(current, key) ? current[key] : undefined;
    if (!isObjectLike(next)) return;
    const copy = shallowLike(next);
    if (copy !== next && !put(current, key, copy)) return;
    current = copy;
  }
}

/** Everything except the paths named. A flat copy is taken first, and the branches on the way
 * to a nested removal are copied too, so the input is left alone.
 *
 * Own keys only, which is also the fix for a lodash result nobody can print: lodash copies
 * inherited keys as well, so `_.omit(Buffer.from('hi'), '0')` hands back a plain object wearing
 * all 90-odd methods of `Buffer.prototype` -- including `inspect`, which then throws the moment
 * anything tries to log it. */
export function omit(object, ...paths) {
  const made = {};
  if (object === null || object === undefined) return made;
  for (const key of ownKeys(object)) made[key] = object[key];
  const all = paths.flat(1).map((path) => pathIn(object, path)).filter((keys) => keys.length > 0);
  for (const keys of all) if (keys.length > 1) copyBranch(made, keys);
  for (const keys of all) unset(made, keys);
  return made;
}

/** The values a collection function walks. lodash reads own enumerable keys, which quietly makes
 * `groupBy(new Set(...))` an empty object; a Set is iterable and we walk it. Widening what works
 * cannot break a call site that used to get nothing back. */
function valuesOf(collection) {
  if (collection === null || collection === undefined) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection === 'string') return [...collection];
  if (typeof collection.length === 'number') return Array.prototype.slice.call(collection);
  if (typeof collection[Symbol.iterator] === 'function') return [...collection];
  return Object.values(collection);
}

/** A group name. Symbols stay symbols; everything else is the string a property key would be. */
const keyOf = (value) => (typeof value === 'symbol' ? value : `${value}`);

/**
 * Values split into buckets by what the iteratee returns. `Object.groupBy` does the work and
 * hands back a null-prototype object; callers written against lodash still reach for
 * `result.hasOwnProperty`, so the prototype goes back on.
 */
export function groupBy(collection, by) {
  const of = iterateeOf(by);
  const grouped = Object.groupBy(valuesOf(collection), (item) => keyOf(of(item)));
  return Object.assign({}, grouped);
}

/** Like `groupBy`, except each key holds one value and the last one wins. */
export function keyBy(collection, by) {
  const of = iterateeOf(by);
  const made = {};
  for (const item of valuesOf(collection)) made[keyOf(of(item))] = item;
  return made;
}

/** First occurrence of each computed value, compared the way a Set compares: NaN equals NaN. */
export function uniqBy(array, by) {
  const of = iterateeOf(by);
  const seen = new Set();
  const out = [];
  for (const item of valuesOf(array)) {
    const mark = of(item);
    if (seen.has(mark)) continue;
    seen.add(mark);
    out.push(item);
  }
  return out;
}

/** Fixed-size slices. A size below one has no answer, so it gets an empty list rather than a
 * loop that never advances. */
export function chunk(array, size = 1) {
  const step = Math.max(Math.trunc(Number(size)) || 0, 0);
  const length = array === null || array === undefined ? 0 : array.length;
  if (length === 0 || step < 1) return [];
  const out = [];
  for (let at = 0; at < length; at += step) out.push(Array.prototype.slice.call(array, at, at + step));
  return out;
}

/** Where a value sits when values of different kinds are lined up. lodash spells this out as a
 * ladder of nine conditions; it is five ranks, and the ranks are worth naming: real values first,
 * then symbols, then null, then undefined, then NaN, which cannot be less than anything. */
function rankOf(value) {
  if (value === null) return 2;
  if (value === undefined) return 3;
  if (typeof value === 'symbol') return 1;
  if (value !== value) return 4;
  return 0;
}

/** Ascending order, with no comparison a symbol would throw on. Two values of a rank that has no
 * internal order -- two symbols, two nulls, two NaNs -- tie, and the caller's order survives. */
function compareValues(a, b) {
  const left = rankOf(a);
  const right = rankOf(b);
  if (left !== right) return left < right ? -1 : 1;
  if (left !== 0 || a === b) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Sorted by one criterion or several, tried in order: `sortBy(rows, ['team', 'score'])`. Stable,
 * because the original index breaks every remaining tie -- Node's sort promises that too, and
 * saying it in the comparator is cheaper than depending on the promise.
 *
 * One divergence, and it is a repaired bug rather than a choice. lodash's comparator answers
 * "greater" for two `NaN` criteria -- in both directions, since `NaN !== NaN` is where it starts.
 * A comparator that says `a > b` and `b > a` leaves the order up to the sort algorithm, and it
 * also stops the walk, so the second criterion is never consulted. Two `NaN`s tie here, and the
 * next criterion decides.
 */
export function sortBy(collection, ...by) {
  const named = by.flat(1);
  const each = named.length === 0 ? [iterateeOf(null)] : named.map(iterateeOf);
  const ranked = valuesOf(collection).map((item, index) => ({ item, index, marks: each.map((of) => of(item)) }));
  ranked.sort((a, b) => {
    for (let at = 0; at < each.length; at += 1) {
      const order = compareValues(a.marks[at], b.marks[at]);
      if (order !== 0) return order;
    }
    return a.index - b.index;
  });
  return ranked.map((entry) => entry.item);
}

/**
 * A wrapper that puts off calling `fn` until `wait` milliseconds have passed with no further
 * calls. `leading` also calls on the first one, `trailing` (on by default) calls on the last, and
 * `maxWait` promises a call that often no matter how the calls keep coming.
 *
 * Timers are read off `globalThis` and the clock off `Date` at the moment they are needed, never
 * captured at import. That is what lets a test drive this thing with a fake clock instead of
 * sleeping, and it costs nothing at runtime.
 */
export function debounce(fn, wait = 0, options = {}) {
  if (typeof fn !== 'function') {
    throw new CollectError('debounce needs a function to defer', 'ERR_NOT_A_FUNCTION');
  }
  const delay = Math.max(Number(wait) || 0, 0);
  const leading = options.leading === true;
  const trailing = options.trailing !== false;
  const capped = 'maxWait' in options;
  const maxWait = capped ? Math.max(Number(options.maxWait) || 0, delay) : 0;

  let timer = null;
  let args = null;
  let self = null;
  let calledAt;
  let invokedAt = 0;
  let result;

  function invoke(time) {
    invokedAt = time;
    const theseArgs = args;
    const thisSelf = self;
    args = null;
    self = null;
    result = fn.apply(thisSelf, theseArgs);
    return result;
  }

  /** The wait is over, the clock went backwards, or the cap came due. */
  function due(time) {
    if (calledAt === undefined) return true;
    const since = time - calledAt;
    return since >= delay || since < 0 || (capped && time - invokedAt >= maxWait);
  }

  function left(time) {
    const waiting = delay - (time - calledAt);
    return capped ? Math.min(waiting, maxWait - (time - invokedAt)) : waiting;
  }

  function onTimer() {
    const time = Date.now();
    if (due(time)) return onLast(time);
    timer = globalThis.setTimeout(onTimer, left(time));
    return undefined;
  }

  function onLast(time) {
    timer = null;
    if (trailing && args !== null) return invoke(time);
    args = null;
    self = null;
    return result;
  }

  function debounced(...theseArgs) {
    const time = Date.now();
    const now = due(time);
    args = theseArgs;
    self = this;
    calledAt = time;
    if (now) {
      if (timer === null) {
        invokedAt = time;
        timer = globalThis.setTimeout(onTimer, delay);
        return leading ? invoke(time) : result;
      }
      if (capped) {
        timer = globalThis.setTimeout(onTimer, delay);
        return invoke(time);
      }
    }
    if (timer === null) timer = globalThis.setTimeout(onTimer, delay);
    return result;
  }

  /** Forget the pending call entirely. */
  debounced.cancel = () => {
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
    args = null;
    self = null;
    calledAt = undefined;
    invokedAt = 0;
  };

  /** Call it now if one is owed, and report whether one is. */
  debounced.flush = () => (timer === null ? result : onLast(Date.now()));
  debounced.pending = () => timer !== null;

  return debounced;
}

/**
 * A wrapper that calls `fn` at most once per `wait` milliseconds. This is `debounce` with the cap
 * set to the wait and the leading edge on by default -- lodash implements it the same way, and the
 * two do not deserve two pieces of timer bookkeeping between them.
 */
export function throttle(fn, wait = 0, options = {}) {
  if (typeof fn !== 'function') {
    throw new CollectError('throttle needs a function to rate-limit', 'ERR_NOT_A_FUNCTION');
  }
  return debounce(fn, wait, {
    leading: options.leading !== false,
    trailing: options.trailing !== false,
    maxWait: wait,
  });
}

/** The default export is the shape a default binding of lodash expects, and the list the codemod
 * checks a call site against: a file reaching for a function that is not on it is refused rather
 * than rewritten into something that would throw at run time. */
export default Object.freeze({
  get, set, has, unset, toPath,
  pick, omit, cloneDeep, merge, isEqual,
  groupBy, keyBy, uniqBy, chunk, sortBy,
  debounce, throttle,
  CollectError,
});
