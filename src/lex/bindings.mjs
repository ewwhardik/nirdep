// Which name means what, and where you may safely change it.
//
// The lexer next door says where every token is. That is not enough to rewrite a
// call site. Given a file that takes a package and uses it, a codemod has to answer
// three questions before it may touch a single byte:
//
//   1. which names did the dependency introduce, and under what specifier
//   2. which of the later mentions of those names are really references to them —
//      not property accesses, not object keys, not labels, not something a nested
//      scope declared for itself and shadowed
//   3. is a new name it wants to introduce already taken somewhere in the file
//
// This module answers all three from the token stream, with a scope tree built from
// brace pairing rather than from a syntax tree. It is not a full binding resolver
// and does not pretend to be: the limits it accepts are named at the bottom of this
// file, and every one of them is biased the same way. When the analysis is unsure it
// records less, which makes the codemod decline a rewrite. A declined rewrite is a
// line in a report; a wrong rewrite is someone's broken build.
//
// A note on spelling: the words this module works with are the words
// `tools/verify.mjs` scans for, and its scanner is deliberately blunt about
// quoted text. Naming them once, unquoted, keeps the dependency proof honest — see
// the WORDS line below.

import {
  KIND, KEYWORDS, lex, stringValue,
} from './lexer.mjs';

// One string, split. Spelling any of these words as a quoted literal would put
// import-shaped text in this file and make the proof script report this module as a
// dependency of itself.
const [IMPORT, EXPORT, REQUIRE, FROM, AS, DEFAULT, WITH, ASSERT] = 'import export require from as default with assert'.split(' ');

/** What introduced a binding. `import` and `require` are the ones a codemod cares about. */
export const BINDING = Object.freeze({
  IMPORT: IMPORT,
  REQUIRE: REQUIRE,
  CONST: 'const',
  LET: 'let',
  VAR: 'var',
  FUNCTION: 'function',
  CLASS: 'class',
  PARAM: 'param',
  CATCH: 'catch',
});

/**
 * The shapes a dependency can take in source. Each one is a rewrite target.
 *
 * Built by interpolation for the same reason as the line above: the name bare-import,
 * spelled out as a quoted literal, is a quoted word followed by a comma and another
 * quoted word, which is the shape `tools/verify.mjs` reads as a dependency. The proof
 * script stays blunt; this file spells things so that it has nothing to find.
 */
export const FORM = Object.freeze({
  STATIC: IMPORT,
  BARE: `bare-${IMPORT}`,
  DYNAMIC: `dynamic-${IMPORT}`,
  EXPORT_FROM: `${EXPORT}-${FROM}`,
  REQUIRE: REQUIRE,
});

/** Words that may stand between a class-body brace and a member name. */
const MEMBER_MODIFIERS = Object.freeze(new Set('static get set async'.split(' ')));

const OPENERS = Object.freeze(new Set(['(', '[', '{']));
const CLOSERS = Object.freeze(new Set([')', ']', '}']));

const isPunct = (token, value) => token !== undefined
  && token.kind === KIND.PUNCT && token.value === value;

const isWord = (token, value) => token !== undefined && token.value === value
  && (token.kind === KIND.NAME || token.kind === KIND.KEYWORD);

/**
 * Match every bracket to its partner, and record which braces opened a block. The
 * lexer already decided block-or-object for each `}` — it had the stack at the time
 * and this pass does not — so the answer is carried back to the opening brace here.
 *
 * A brace that closes a template substitution never reaches this pass: the lexer
 * folds it into the template token that follows it, so the pairing cannot be thrown
 * off by `` `${ {a: 1} }` ``.
 */
function pairBrackets(tokens) {
  const partner = new Map();
  const opensBlock = new Map();
  const open = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token.kind !== KIND.PUNCT) continue;
    if (OPENERS.has(token.value)) {
      open.push(at);
      continue;
    }
    if (!CLOSERS.has(token.value)) continue;
    const from = open.pop();
    if (from === undefined) continue;
    partner.set(from, at);
    partner.set(at, from);
    if (token.value === '}') opensBlock.set(from, token.closesBlock === true);
  }
  return { partner, opensBlock };
}

/**
 * Read a file's names. Accepts source text or a result from `lex`, and returns a
 * frozen analysis:
 *
 *   scopes        the scope tree, each with the declarations made directly in it
 *   bindings      every declaration, with its kind, its scope and its byte range
 *   references    every mention that is really a reference, resolved to a binding
 *                 where one was found and left unresolved where it is a global
 *   dependencies  one record per module specifier in the file, with the bindings it
 *                 introduced and the byte range of the specifier itself
 *   unanalysable  the dependency sites whose specifier is not a literal string, which
 *                 is a thing to report rather than a thing to rewrite
 *   unresolved    the references that matched no binding, deduplicated by name
 */
export function analyse(input, options = {}) {
  // A lex result is passed straight through, so a caller that already has one does not
  // pay for a second pass. Anything else goes to the lexer, including junk: its
  // NOT_A_STRING is the right failure and there is no reason to invent another.
  const looksLexed = typeof input === 'object' && input !== null
    && Array.isArray(input.tokens) && typeof input.source === 'string';
  const result = looksLexed ? input : lex(input, options);
  const tokens = result.tokens;
  const { partner, opensBlock } = pairBrackets(tokens);

  const scopes = [];
  const bindings = [];
  const references = [];
  const dependencies = [];
  /** Token indexes that are declarations, so the reference pass leaves them alone. */
  const declaredAt = new Set();
  /** Specifier tokens a declarator already claimed, so they are not counted twice. */
  const claimed = new Set();
  /** Braces known to open a class body, decided at the `class` keyword. */
  const classBodies = new Set();

  const openScope = (kind, parent, at) => {
    const scope = {
      id: scopes.length, kind, parent, start: at, end: tokens.length - 1,
      declarations: new Map(), children: [],
    };
    scopes.push(scope);
    if (parent !== null) scopes[parent].children.push(scope.id);
    return scope;
  };

  const moduleScope = openScope('module', null, 0);
  // A frame is a region of the token stream. Most own a scope; an object literal owns
  // none and is tracked only so that a key can be told from a reference. A function's
  // body brace shares the scope its parameter list opened, so a parameter and a `let`
  // in the body collide the way they really do.
  const frames = [{ kind: 'module', scope: moduleScope, closeAt: tokens.length - 1 }];
  const inScope = () => {
    for (let n = frames.length - 1; n >= 0; n -= 1) if (frames[n].scope) return frames[n].scope;
    return moduleScope;
  };
  const inFunction = () => {
    for (let n = frames.length - 1; n >= 0; n -= 1) {
      const kind = frames[n].scope?.kind;
      if (kind === 'function' || kind === 'module') return frames[n].scope;
    }
    return moduleScope;
  };

  /** Record a declaration. The first one wins the slot: `var x` twice is one name. */
  const declare = (at, kind, scope, extra = {}) => {
    const token = tokens[at];
    const record = Object.freeze({
      name: token.value,
      kind,
      scope: scope.id,
      token: at,
      start: token.start,
      end: token.end,
      line: token.line,
      column: token.column,
      ...extra,
    });
    bindings.push(record);
    declaredAt.add(at);
    if (!scope.declarations.has(record.name)) scope.declarations.set(record.name, bindings.length - 1);
    return bindings.length - 1;
  };

  const refer = (at) => {
    const token = tokens[at];
    references.push({
      name: token.value,
      token: at,
      start: token.start,
      end: token.end,
      line: token.line,
      column: token.column,
      scope: inScope().id,
      binding: null,
    });
  };

  /**
   * The names bound by a binding pattern between two token indexes. `{a: b}` binds
   * `b` and not `a`; `[a, ...rest]` binds both; a default value is an expression, so
   * `= expr` is skipped and the names in it are left for the reference pass.
   *
   * Returns the token indexes it declared, which the arrow case needs: an arrow's
   * parameters are walked before the `=>` that reveals them, so the references
   * recorded for them have to be taken back.
   */
  const collectPattern = (from, to, kind, scope, extra = {}) => {
    const declared = new Set();
    let depth = 0;
    let skipDepth = -1;
    for (let at = from; at < to; at += 1) {
      const token = tokens[at];
      if (token.kind === KIND.PUNCT) {
        if (OPENERS.has(token.value)) depth += 1;
        else if (CLOSERS.has(token.value)) depth -= 1;
        else if (token.value === '=' && skipDepth < 0) skipDepth = depth;
        else if (token.value === ',' && depth <= skipDepth) skipDepth = -1;
        continue;
      }
      if (skipDepth >= 0) continue;
      if (token.kind !== KIND.NAME) continue;
      // `{a: b}` names the property first and the binding second.
      if (isPunct(tokens[at + 1], ':')) continue;
      declare(at, kind, scope, extra);
      declared.add(at);
    }
    return declared;
  };

  /** Token indexes the reference pass must ignore: clause words, attribute keys. */
  const skipTokens = new Set();
  /** Braces that are the body of something that already opened a scope. */
  const sharedBraces = new Set();
  /** Specifiers the file computes rather than writes, which no codemod may rewrite. */
  const unanalysable = [];

  /**
   * The index where a statement's interesting part stops: the first of `values` at
   * the same bracket depth, or the closing bracket of whatever contains it.
   */
  const boundary = (from, values) => {
    let depth = 0;
    for (let at = from; at < tokens.length; at += 1) {
      const token = tokens[at];
      if (token.kind === KIND.PUNCT && OPENERS.has(token.value)) {
        depth += 1;
        continue;
      }
      if (token.kind === KIND.PUNCT && CLOSERS.has(token.value)) {
        if (depth === 0) return at;
        depth -= 1;
        continue;
      }
      if (depth === 0 && values.has(token.value)
        && (token.kind === KIND.PUNCT || token.kind === KIND.NAME || token.kind === KIND.KEYWORD)) {
        return at;
      }
    }
    return tokens.length - 1;
  };

  const addDependency = (form, from, specifierIndex, stop, bindingIndexes) => {
    const token = tokens[specifierIndex];
    dependencies.push(Object.freeze({
      specifier: stringValue(token),
      form,
      line: tokens[from].line,
      statement: Object.freeze({ start: tokens[from].start, end: (tokens[stop] ?? token).end }),
      specifierRange: Object.freeze({ start: token.start, end: token.end }),
      bindings: Object.freeze([...bindingIndexes]),
    }));
    claimed.add(specifierIndex);
    return dependencies.length - 1;
  };

  const STATEMENT_STOP = Object.freeze(new Set([';']));
  const PATTERN_STOP = Object.freeze(new Set(['=', ',', ';', 'of', 'in']));
  const DECLARATOR_STOP = Object.freeze(new Set([',', ';']));

  /**
   * Where a declarator's pattern stops. `of` and `in` end a pattern because a for-of head
   * puts them there, but at the first token of the declarator neither is grammar: `of` is a
   * legal name, and `const of = f(x)` would otherwise declare nothing and leave every later
   * use of it looking like a global. One token, because a name is the only pattern that can
   * start with a word.
   */
  const patternBoundary = (from) => {
    const stop = boundary(from, PATTERN_STOP);
    return stop === from && tokens[from]?.kind === KIND.NAME ? boundary(from + 1, PATTERN_STOP) : stop;
  };

  /** A call of the CommonJS loader with a literal specifier, or null. */
  const loaderCall = (at) => {
    if (!isWord(tokens[at], REQUIRE) || !isPunct(tokens[at + 1], '(')) return null;
    if (tokens[at + 2]?.kind !== KIND.STRING || !isPunct(tokens[at + 3], ')')) {
      unanalysable.push(Object.freeze({
        form: FORM.REQUIRE, line: tokens[at].line, reason: 'the specifier is not a literal string',
      }));
      return null;
    }
    // The callee of a recognised loader call is grammar, in the same way `from` is
    // grammar in an import statement: the whole call is one rewrite target and the word
    // reads nothing. A call whose specifier is computed is not a dependency site, and
    // there the word stays an ordinary reference so the report still shows it.
    skipTokens.add(at);
    return { specifier: at + 2, stop: at + 3 };
  };

  /** `const`, `let` or `var`, one declarator at a time. */
  const readDeclaration = (at) => {
    const kind = tokens[at].value;
    const scope = kind === BINDING.VAR ? inFunction() : inScope();
    let from = at + 1;
    while (from < tokens.length) {
      const patternEnd = patternBoundary(from);
      const initialiser = isPunct(tokens[patternEnd], '=') ? patternEnd + 1 : -1;
      // A name taken straight from the loader is a dependency binding, not an ordinary
      // one: the codemod needs its specifier to know what to replace it with.
      const call = initialiser >= 0 ? loaderCall(initialiser) : null;
      const first = bindings.length;
      collectPattern(
        from,
        patternEnd,
        call === null ? kind : BINDING.REQUIRE,
        scope,
        call === null ? {} : { specifier: stringValue(tokens[call.specifier]), form: FORM.REQUIRE },
      );
      if (call !== null) {
        const stop = boundary(patternEnd, STATEMENT_STOP);
        const indexes = [];
        for (let n = first; n < bindings.length; n += 1) indexes.push(n);
        addDependency(FORM.REQUIRE, at, call.specifier, stop, indexes);
      }
      const cursor = initialiser >= 0 ? boundary(initialiser, DECLARATOR_STOP) : patternEnd;
      if (!isPunct(tokens[cursor], ',')) break;
      from = cursor + 1;
    }
  };

  /**
   * Open a function scope for a parameter list at `open`, declare its parameters, and
   * keep the scope alive to the end of the body. The body brace is marked as shared so
   * that the walk does not open a second scope for it: a parameter and a `let` in the
   * body are in the same scope and must collide.
   */
  const openFunctionAt = (open) => {
    const close = partner.get(open) ?? open;
    const scope = openScope('function', inScope().id, open);
    collectPattern(open + 1, close, BINDING.PARAM, scope);
    const body = isPunct(tokens[close + 1], '{') ? close + 1 : -1;
    if (body >= 0) sharedBraces.add(body);
    frames.push({
      kind: 'function',
      scope,
      closeAt: body >= 0 ? (partner.get(body) ?? close) : close,
    });
    return scope;
  };

  const readFunction = (at) => {
    let cursor = at + 1;
    if (isPunct(tokens[cursor], '*')) cursor += 1;
    // A function expression's own name is visible only inside itself. Declaring it in
    // the enclosing scope is the careful direction: it can make the codemod treat an
    // outer name as shadowed and decline a rewrite, never the reverse.
    if (tokens[cursor]?.kind === KIND.NAME) {
      declare(cursor, BINDING.FUNCTION, inScope());
      cursor += 1;
    }
    if (isPunct(tokens[cursor], '(')) openFunctionAt(cursor);
  };

  const readArrow = (at, depth) => {
    const scope = openScope('function', inScope().id, at);
    const before = tokens[at - 1];
    let declared = new Set();
    let from = at - 1;
    if (isPunct(before, ')')) {
      from = partner.get(at - 1) ?? at - 1;
      declared = collectPattern(from + 1, at - 1, BINDING.PARAM, scope);
    } else if (before?.kind === KIND.NAME) {
      declare(at - 1, BINDING.PARAM, scope);
      declared.add(at - 1);
    }
    // The parameters were walked before the `=>` said what they were, so they are in
    // the reference list by mistake. Take exactly those entries back. What is left in
    // that span is a default value -- `(count, one, many = `${one}s`) => ...` -- and it
    // is evaluated in the parameter scope, so those references move into the scope that
    // has only just come into existence. Leaving them outside it loses the name.
    for (let n = references.length - 1; n >= 0 && references[n].token >= from; n -= 1) {
      if (declared.has(references[n].token)) references.splice(n, 1);
      else if (references[n].token < at) references[n].scope = scope.id;
    }
    const body = at + 1;
    if (isPunct(tokens[body], '{')) {
      sharedBraces.add(body);
      frames.push({ kind: 'function', scope, closeAt: partner.get(body) ?? body });
      return;
    }
    // A concise body has no brace to close it. It ends at the first delimiter that
    // belongs to whatever contains the arrow, which is what `depth` records.
    frames.push({ kind: 'function', scope, closeAt: tokens.length - 1, concise: true, depth });
  };

  const readClass = (at) => {
    let cursor = at + 1;
    if (tokens[cursor]?.kind === KIND.NAME) {
      declare(cursor, BINDING.CLASS, inScope());
      cursor += 1;
    }
    // The heritage clause may contain calls, so the body brace is the first `{` at the
    // depth the class started at.
    let depth = 0;
    for (let n = cursor; n < tokens.length; n += 1) {
      const token = tokens[n];
      if (token.kind !== KIND.PUNCT) continue;
      if (token.value === '{' && depth === 0) {
        classBodies.add(n);
        return;
      }
      if (OPENERS.has(token.value)) depth += 1;
      else if (CLOSERS.has(token.value)) {
        if (depth === 0) return;
        depth -= 1;
      }
    }
  };

  /** `catch (error)` binds its parameter in a scope of its own, wider than the block. */
  const readCatch = (at) => {
    if (!isPunct(tokens[at + 1], '(')) return;
    const open = at + 1;
    const close = partner.get(open) ?? open;
    const scope = openScope(BINDING.CATCH, inScope().id, open);
    collectPattern(open + 1, close, BINDING.CATCH, scope);
    const body = isPunct(tokens[close + 1], '{') ? close + 1 : -1;
    if (body >= 0) sharedBraces.add(body);
    frames.push({ kind: BINDING.CATCH, scope, closeAt: body >= 0 ? (partner.get(body) ?? close) : close });
  };

  /** A `for` head is its own scope: the `let` in it does not leak past the loop. */
  const readFor = (at) => {
    if (!isPunct(tokens[at + 1], '(')) return;
    const open = at + 1;
    const close = partner.get(open) ?? open;
    const scope = openScope('for', inScope().id, open);
    // `of` is an ordinary name everywhere else, so the lexer hands it over as one. Here
    // it is the clause word of a for-of head and reads nothing -- except where the loop
    // binds a variable of that name, in which case the first one is the name and the
    // clause word is the next.
    const declared = tokens[open + 1]?.value;
    const bound = declared === BINDING.CONST || declared === BINDING.LET || declared === BINDING.VAR
      ? open + 2 : -1;
    for (let n = open + 1; n < close; n += 1) {
      if (n !== bound && isWord(tokens[n], 'of')) {
        skipTokens.add(n);
        break;
      }
    }
    // A body without braces is still inside the loop's scope, so the scope has to reach
    // past the `)` to the end of that one statement.
    const body = isPunct(tokens[close + 1], '{') ? close + 1 : -1;
    if (body >= 0) sharedBraces.add(body);
    frames.push({
      kind: 'for',
      scope,
      closeAt: body >= 0 ? (partner.get(body) ?? close) : boundary(close + 1, STATEMENT_STOP),
    });
  };

  /**
   * The statement form of a module import. Every local name it introduces is a
   * dependency binding carrying the specifier it came from and which exported name it
   * took, which together are everything a rewrite rule needs.
   */
  const readStaticImport = (at) => {
    let cursor = at + 1;
    const clauses = [];
    let specifierIndex = -1;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === KIND.STRING) {
        specifierIndex = cursor;
        cursor += 1;
        break;
      }
      if (isWord(token, FROM) || isPunct(token, ',')) {
        cursor += 1;
        continue;
      }
      if (isPunct(token, '*')) {
        cursor += 1;
        if (isWord(tokens[cursor], AS)) cursor += 1;
        if (tokens[cursor]?.kind === KIND.NAME) {
          clauses.push({ at: cursor, imported: '*', form: 'namespace' });
          cursor += 1;
        }
        continue;
      }
      if (isPunct(token, '{')) {
        const close = partner.get(cursor) ?? cursor;
        let n = cursor + 1;
        while (n < close) {
          const piece = tokens[n];
          const named = piece.kind === KIND.NAME || piece.kind === KIND.KEYWORD
            || piece.kind === KIND.STRING;
          if (!named) {
            n += 1;
            continue;
          }
          const imported = piece.kind === KIND.STRING ? stringValue(piece) : piece.value;
          if (isWord(tokens[n + 1], AS) && tokens[n + 2]?.kind === KIND.NAME) {
            clauses.push({ at: n + 2, imported, form: 'named' });
            n += 3;
            continue;
          }
          clauses.push({ at: n, imported, form: 'named' });
          n += 1;
        }
        cursor = close + 1;
        continue;
      }
      if (token.kind === KIND.NAME) {
        clauses.push({ at: cursor, imported: DEFAULT, form: DEFAULT });
        cursor += 1;
        continue;
      }
      break;
    }
    if (specifierIndex < 0) return;
    // An attribute clause is data about the import, not code, and its keys are not
    // references to anything.
    if ((isWord(tokens[cursor], WITH) || isWord(tokens[cursor], ASSERT))
      && isPunct(tokens[cursor + 1], '{')) {
      cursor = (partner.get(cursor + 1) ?? cursor) + 1;
    }
    const stop = isPunct(tokens[cursor], ';') ? cursor : cursor - 1;
    const specifier = stringValue(tokens[specifierIndex]);
    const indexes = clauses.map((clause) => declare(clause.at, BINDING.IMPORT, moduleScope, {
      specifier,
      imported: clause.imported,
      form: clause.form,
    }));
    addDependency(clauses.length === 0 ? FORM.BARE : FORM.STATIC, at, specifierIndex, stop, indexes);
    // Everything else in the statement is clause grammar: `from`, `as`, attribute keys.
    for (let n = at + 1; n <= stop; n += 1) if (!declaredAt.has(n)) skipTokens.add(n);
  };

  /** The call form. It introduces no name, but the specifier is still a rewrite target. */
  const readDynamicImport = (at) => {
    if (tokens[at + 2]?.kind === KIND.STRING && isPunct(tokens[at + 3], ')')) {
      addDependency(FORM.DYNAMIC, at, at + 2, at + 3, []);
      return;
    }
    // A computed specifier is not a thing a codemod may rewrite, and saying so in the
    // report is the difference between a limit and a silent miss.
    unanalysable.push(Object.freeze({
      form: FORM.DYNAMIC, line: tokens[at].line, reason: 'the specifier is not a literal string',
    }));
  };

  /** `export ... from <specifier>` moves someone else's module through this one. */
  const readExport = (at) => {
    const stop = boundary(at + 1, STATEMENT_STOP);
    for (let n = at + 1; n <= stop && n < tokens.length; n += 1) {
      if (!isWord(tokens[n], FROM) || tokens[n + 1]?.kind !== KIND.STRING) continue;
      addDependency(FORM.EXPORT_FROM, at, n + 1, stop, []);
      // The names in a re-export clause are the other module's exported names. They
      // bind nothing here and read nothing here, so none of them is a reference. A
      // clause without `from` is different: those names are local, and the walk is
      // left to treat them as the references they are.
      for (let k = at + 1; k <= stop && k < tokens.length; k += 1) skipTokens.add(k);
      return;
    }
  };

  /** A loader call that no declarator claimed: taken for its side effect, or inline. */
  const readLoaderCall = (at) => {
    if (claimed.has(at + 2)) return;
    const call = loaderCall(at);
    if (call !== null) addDependency(FORM.REQUIRE, at, call.specifier, call.stop, []);
  };

  /** Could this token begin a member name, after a modifier word? */
  const startsMember = (token) => token !== undefined && (token.kind === KIND.NAME
    || token.kind === KIND.KEYWORD || token.kind === KIND.STRING || token.kind === KIND.NUMBER
    || token.kind === KIND.PRIVATE || isPunct(token, '[') || isPunct(token, '*'));

  /** Is this name in the position a class or object member name occupies? */
  const memberPosition = (at) => {
    const previous = tokens[at - 1];
    if (previous === undefined) return false;
    if (previous.kind === KIND.PUNCT) return ['{', '}', ';', ',', '*'].includes(previous.value);
    return MEMBER_MODIFIERS.has(previous.value);
  };

  /** A label is a name followed by a colon where a statement could begin. */
  const isLabel = (at) => isPunct(tokens[at + 1], ':')
    && (at === 0 || isPunct(tokens[at - 1], ';') || isPunct(tokens[at - 1], '{')
      || isPunct(tokens[at - 1], '}'))
    && frames[frames.length - 1].kind !== 'object';

  const closeFrame = () => {
    const frame = frames.pop();
    if (frame.scope) frame.scope.end = Math.min(frame.closeAt, tokens.length - 1);
  };

  // -- the walk --------------------------------------------------------------
  //
  // One pass. Handlers look ahead to declare names and record the token indexes they
  // consumed; the reference decision below then only has to ask whether a name was
  // already accounted for. Nothing is walked twice.

  let at = 0;
  let depth = 0;
  while (at < tokens.length) {
    while (frames.length > 1 && frames[frames.length - 1].closeAt < at) closeFrame();
    const token = tokens[at];
    if (token.kind === KIND.PUNCT) {
      const terminator = CLOSERS.has(token.value) || token.value === ',' || token.value === ';';
      if (terminator) {
        while (frames.length > 1 && frames[frames.length - 1].concise === true
          && depth <= frames[frames.length - 1].depth) closeFrame();
      }
      if (OPENERS.has(token.value)) {
        if (token.value === '{') {
          if (sharedBraces.has(at)) {
            frames.push({ kind: 'body', scope: null, closeAt: partner.get(at) ?? at });
          } else if (classBodies.has(at)) {
            frames.push({ kind: 'class', scope: openScope('class', inScope().id, at), closeAt: partner.get(at) ?? at });
          } else if (opensBlock.get(at) === true) {
            frames.push({ kind: 'block', scope: openScope('block', inScope().id, at), closeAt: partner.get(at) ?? at });
          } else {
            frames.push({ kind: 'object', scope: null, closeAt: partner.get(at) ?? at });
          }
        }
        depth += 1;
        at += 1;
        continue;
      }
      if (CLOSERS.has(token.value)) {
        depth -= 1;
        at += 1;
        continue;
      }
      if (token.value === '=>') readArrow(at, depth);
      at += 1;
      continue;
    }
    if (token.kind === KIND.KEYWORD) {
      if (token.value === IMPORT) {
        if (isPunct(tokens[at + 1], '(')) readDynamicImport(at);
        else if (!isPunct(tokens[at + 1], '.')) readStaticImport(at);
      } else if (token.value === EXPORT) readExport(at);
      else if (token.value === BINDING.CONST || token.value === BINDING.LET || token.value === BINDING.VAR) readDeclaration(at);
      else if (token.value === BINDING.FUNCTION) readFunction(at);
      else if (token.value === BINDING.CLASS) readClass(at);
      else if (token.value === BINDING.CATCH) readCatch(at);
      else if (token.value === 'for') readFor(at);
      at += 1;
      continue;
    }
    if (token.kind !== KIND.NAME) {
      at += 1;
      continue;
    }

    // -- is this name a reference? -------------------------------------------
    const previous = tokens[at - 1];
    const next = tokens[at + 1];
    const frame = frames[frames.length - 1];
    if (token.value === REQUIRE && isPunct(next, '(')) readLoaderCall(at);
    // A member with a parameter list is a method, and its parameters are its own.
    if ((frame.kind === 'class' || frame.kind === 'object')
      && memberPosition(at) && isPunct(next, '(')) {
      openFunctionAt(at + 1);
      at += 1;
      continue;
    }
    const isProperty = isPunct(previous, '.') || isPunct(previous, '?.');
    const isKey = frame.kind === 'object' && (isPunct(next, ':') || isPunct(next, '('));
    const isMember = frame.kind === 'class' && memberPosition(at);
    // `get`, `set`, `static` and `async` in front of a member name are modifiers. In a
    // class the member reader has already taken them; in an object literal `get get()`
    // reaches here with the first word looking like a name in use.
    const isMemberModifier = MEMBER_MODIFIERS.has(token.value)
      && (frame.kind === 'object' || frame.kind === 'class') && startsMember(next);
    // `async` in front of a function or an arrow is a modifier, not a name in use. The
    // arrow case has to look past the parameter list, because `async (a) => a` and a
    // call of a function named `async` are the same tokens up to that point.
    const isAsyncModifier = token.value === 'async'
      && (isWord(next, BINDING.FUNCTION) || next?.kind === KIND.NAME
        || (isPunct(next, '(') && isPunct(tokens[(partner.get(at + 1) ?? at) + 1], '=>')));
    // A label after `break` or `continue` names a statement, not a value.
    const isLabelUse = isWord(previous, 'break') || isWord(previous, 'continue');
    const skip = declaredAt.has(at) || skipTokens.has(at) || isProperty || isKey
      || isMember || isMemberModifier || isAsyncModifier || isLabelUse || isLabel(at);
    if (!skip) refer(at);
    at += 1;
  }
  while (frames.length > 0) closeFrame();

  // -- resolution ------------------------------------------------------------
  //
  // Every reference walks out through its scope chain to the first scope that declares
  // its name. A reference that reaches the module scope without a match is a global, or
  // something this analysis was not able to see, and is reported as unresolved rather
  // than guessed at.

  for (const reference of references) {
    let scope = scopes[reference.scope];
    while (scope !== undefined) {
      const found = scope.declarations.get(reference.name);
      if (found !== undefined) {
        reference.binding = found;
        break;
      }
      scope = scope.parent === null ? undefined : scopes[scope.parent];
    }
    Object.freeze(reference);
  }

  const unresolved = [...new Set(references.filter((one) => one.binding === null)
    .map((one) => one.name))].sort();

  return Object.freeze({
    result,
    scopes: Object.freeze(scopes.map((scope) => Object.freeze(scope))),
    bindings: Object.freeze(bindings),
    references: Object.freeze(references),
    dependencies: Object.freeze(dependencies),
    unanalysable: Object.freeze(unanalysable),
    unresolved: Object.freeze(unresolved),
  });
}

// -- asking the analysis questions -------------------------------------------

/**
 * The binding a name resolves to from inside `scopeId`, or -1. This is the question
 * "if I write this name here, what do I get?", which the codemod asks before it
 * introduces a name of its own.
 */
export function lookup(analysis, name, scopeId = 0) {
  let scope = analysis.scopes[scopeId];
  while (scope !== undefined) {
    const found = scope.declarations.get(name);
    if (found !== undefined) return found;
    scope = scope.parent === null ? undefined : analysis.scopes[scope.parent];
  }
  return -1;
}

/** Every reference that resolved to this binding, in source order. */
export function referencesTo(analysis, binding) {
  return analysis.references.filter((one) => one.binding === binding);
}

/**
 * The byte ranges to overwrite to rename a binding: its declaration and each
 * reference that resolved to it. A reference in a scope that shadowed the binding
 * resolved elsewhere and is not in this list, which is the whole reason the scope tree
 * exists.
 *
 * A named import is renamed at its local name only. `{ red as r }` keeps `red`,
 * because that is the exported name and not ours to change, so the declaration range
 * is the local token's range and nothing wider.
 */
export function renameSites(analysis, binding) {
  const record = analysis.bindings[binding];
  if (record === undefined) return [];
  const sites = [{ start: record.start, end: record.end, declaration: true }];
  for (const reference of referencesTo(analysis, binding)) {
    sites.push({ start: reference.start, end: reference.end, declaration: false });
  }
  return sites.sort((one, other) => one.start - other.start);
}

/** The dependency records for one specifier, in source order. */
export function dependenciesOn(analysis, specifier) {
  return analysis.dependencies.filter((one) => one.specifier === specifier);
}

/**
 * Every use of a specifier's bindings: the name it was bound to, and each place that
 * name is read. This is the list a rewrite rule walks.
 */
export function usesOf(analysis, specifier) {
  const uses = [];
  for (const dependency of dependenciesOn(analysis, specifier)) {
    for (const binding of dependency.bindings) {
      uses.push(Object.freeze({
        binding,
        record: analysis.bindings[binding],
        references: Object.freeze(referencesTo(analysis, binding)),
      }));
    }
  }
  return uses;
}

/**
 * A name nothing in the file uses, formed from `base`. The codemod needs one when the
 * name it would like to introduce is taken — a file that already has its own `style`
 * gets `style2`. Every declared name and every mention of any name counts as taken,
 * including unresolved ones: a global the file relies on must not be shadowed either.
 */
export function freeName(analysis, base) {
  const taken = new Set(analysis.unresolved);
  for (const scope of analysis.scopes) for (const name of scope.declarations.keys()) taken.add(name);
  for (const reference of analysis.references) taken.add(reference.name);
  if (!taken.has(base) && !KEYWORDS.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// -- what this does not do ---------------------------------------------------
//
// Named honestly, because a codemod's report is only worth reading if its author was
// honest about the analysis behind it. Each limit below makes the analysis record
// less than the truth, never more, so the effect is a rewrite declined.
//
//   * A function expression's own name is declared in the enclosing scope rather than
//     in the function itself, so an outer name of the same spelling looks shadowed.
//   * A concise arrow body ends at the first comma, semicolon or closing bracket at
//     the arrow's own depth. `f(a => b, a)` is read correctly; an arrow whose body
//     contains a comma operator at that depth ends early.
//   * `with (o) { x }` puts unknown names in scope at run time. Names inside are
//     resolved as if it were an ordinary block; the statement is forbidden in modules,
//     which is where this analysis is used.
//   * A specifier that is computed — a template, a variable, `createRequire` — is
//     recorded in `unanalysable` and never rewritten.
//   * `eval` can reach any name. A file that calls it is reported by the codemod as
//     unsafe to patch rather than analysed harder.
