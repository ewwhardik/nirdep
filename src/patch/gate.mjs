// The syntax gate: does the file still parse after we touched it?
//
// A codemod that writes broken JavaScript is worse than one that does nothing, because
// nothing is easy to undo and a half-parsed file is a bisect. So every patch goes
// through a real parser before it reaches the disk -- not our lexer, which is
// token-level and forgiving by design, but Node's own, which is the parser that will
// run the code.
//
// Getting at that parser without a dependency takes some care. `vm.Script` only knows
// script grammar and rejects the word export outright. `vm.SourceTextModule` is the
// module-aware door and it is locked unless the process was started with
// --experimental-vm-modules, so we try the handle and fall through when it does not
// turn. What is left is `node --check --input-type=module` over stdin: that is the
// runtime itself, already on this machine, which is a different thing from shelling out
// to a tool somebody had to install. It costs about 20ms, so the lexer runs first as a
// free filter -- a file it cannot tokenise is broken and needs no second opinion.

import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { lex, LexError } from '../lex/lexer.mjs';

/** Which grammar to check against. Modules are the default; scripts are for .cjs. */
export const KIND = Object.freeze({ MODULE: 'module', SCRIPT: 'script' });

/** Who did the checking, reported so a failure can be believed or discounted. */
export const METHOD = Object.freeze({
  LEX: 'lex',
  VM_SCRIPT: 'vm-script',
  VM_MODULE: 'vm-module',
  NODE_CHECK: 'node-check',
});

/** Available only with --experimental-vm-modules, so ask rather than assume. */
const hasModuleVm = typeof vm.SourceTextModule === 'function';

const verdict = (ok, method, error = null) => Object.freeze({ ok, method, error });

const problem = (message, line = 0, column = 0) => Object.freeze({
  message: String(message).replace(/^SyntaxError:\s*/, ''),
  line,
  column,
});

/**
 * Pull a line and column out of a thrown SyntaxError. V8 does not put them on the error;
 * it prints them above the stack as `<filename>:<line>`, the offending line, and a caret
 * whose indentation is the column. The filename we passed in is the anchor -- without it
 * the first internal frame that happens to end in a number gets mistaken for a position,
 * which is how a parse error on line 1 gets reported on line 28.
 */
function whereFrom(error, filename) {
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const lines = stack.split('\n');
  const marker = `${filename}:`;
  const head = lines.findIndex((one) => one.startsWith(marker) && /^\d+$/.test(one.slice(marker.length).trim()));
  if (head === -1) return problem(error.message);
  const line = Number(lines[head].slice(marker.length).trim());
  const caret = lines.slice(head + 1, head + 4).find((one) => one.includes('^'));
  return problem(error.message, line, caret ? caret.indexOf('^') + 1 : 0);
}


/**
 * Same job for `node --check`, which reports on stderr rather than by throwing across a
 * process boundary. The shape is `[stdin]:<line>`, the offending line, a caret line,
 * then the message.
 */
function fromCheckOutput(text) {
  const lines = String(text ?? '').split('\n');
  const message = lines.map((one) => one.trim()).find((one) => /^\w*Error:/.test(one));
  const head = lines.findIndex((one) => /^\[stdin\]:\d+$/.test(one.trim()));
  if (head === -1) return problem(message ?? 'the file did not parse');
  const line = Number(lines[head].trim().split(':')[1]);
  const caret = lines.slice(head + 1, head + 4).find((one) => one.includes('^'));
  return problem(message ?? 'the file did not parse', line, caret ? caret.indexOf('^') + 1 : 0);
}

/**
 * The free filter on its own, for a host with no parser to reach.
 *
 * The browser playground runs `applyProject` for real, and a browser has no way to compile
 * JavaScript without also running it -- `new Function` would be exactly the hole this project
 * criticises `lodash.template` for. So it passes this as the check and the verdict says `lex`,
 * which is a weaker claim than `node --check` and an accurate one. It catches an unterminated
 * string, comment, template or bracket run; it does not catch `let let = 1`.
 */
export function checkByLexer(source, options = {}) {
  if (typeof source !== 'string') return verdict(false, METHOD.LEX, problem('a syntax check needs source text'));
  void options;
  return preGate(source) ?? verdict(true, METHOD.LEX);
}

/** The free filter. Returns a verdict only when the lexer already knows it is broken. */
function preGate(source) {
  let result;
  try {
    result = lex(source);
  } catch (error) {
    if (error instanceof LexError) {
      return verdict(false, METHOD.LEX, problem(error.message, error.line, error.column));
    }
    throw error;
  }
  const open = result.unclosed;
  if (open.length > 0) {
    return verdict(false, METHOD.LEX, problem(`unclosed ${open[open.length - 1]}`));
  }
  return null;
}

/**
 * Does this source parse?
 *
 * @param {string} source
 * @param {{ kind?: string, filename?: string }} [options]
 * @returns {{ ok: boolean, method: string, error: null | { message: string, line: number, column: number } }}
 */
export function checkSyntax(source, options = {}) {
  if (typeof source !== 'string') {
    return verdict(false, METHOD.LEX, problem('a syntax check needs source text'));
  }
  const kind = options.kind === KIND.SCRIPT ? KIND.SCRIPT : KIND.MODULE;
  const filename = options.filename ?? 'nirdep-check.js';
  const cheap = preGate(source);
  if (cheap) return cheap;
  if (kind === KIND.SCRIPT) {
    try {
      new vm.Script(source, { filename });
      return verdict(true, METHOD.VM_SCRIPT);
    } catch (error) {
      return verdict(false, METHOD.VM_SCRIPT, whereFrom(error, filename));
    }
  }
  // The fast path, when the process was started with the flag: about 40x cheaper than a
  // spawn. Its SyntaxError arrives with no position attached at all, so a failure here is
  // handed to `node --check` purely to find out where. Failures are the rare case and the
  // one where a line number is worth 20ms.
  if (hasModuleVm) {
    try {
      new vm.SourceTextModule(source, { identifier: filename });
      return verdict(true, METHOD.VM_MODULE);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  try {
    execFileSync(process.execPath, ['--check', `--input-type=${kind}`], {
      input: source, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8',
    });
    return verdict(true, METHOD.NODE_CHECK);
  } catch (error) {
    return verdict(false, METHOD.NODE_CHECK, fromCheckOutput(error.stderr ?? error.message));
  }
}

/**
 * Check both sides of a patch and say whose fault it is.
 *
 * `blame` is the whole point. A file that did not parse before we touched it is not
 * evidence against the rewrite, and reporting it as such sends the user looking for a
 * bug in the wrong place. Both sides are checked even when the first one fails, because
 * a second 20ms is cheaper than a wrong accusation.
 *
 * `check` is a seam, not a switch: it defaults to the real thing, and the one caller that
 * overrides it is a host where the real thing does not exist. Whoever passes it owns the
 * claim, which is why the verdict carries the method that made it.
 *
 * @param {string} before
 * @param {string} after
 * @param {{ kind?: string, filename?: string, check?: typeof checkSyntax }} [options]
 */
export function gate(before, after, options = {}) {
  const check = options.check ?? checkSyntax;
  const first = check(before, options);
  const second = check(after, options);
  let blame = null;
  if (!second.ok) blame = first.ok ? 'patch' : 'source';
  return Object.freeze({
    ok: second.ok && first.ok,
    parsed: second.ok,
    wasBroken: !first.ok,
    blame,
    before: first,
    after: second,
  });
}

/**
 * Which grammar a path is written in. The extension decides when it can: `.mjs` is
 * always a module and `.cjs` always a script. A bare `.js` is whatever the nearest
 * package.json says, which the caller has to look up -- guessing here would mean
 * checking half the CommonJS in the world against the wrong grammar.
 */
export function kindFor(path, packageType = 'commonjs') {
  const name = String(path);
  if (/\.mjs$/i.test(name)) return KIND.MODULE;
  if (/\.cjs$/i.test(name)) return KIND.SCRIPT;
  return packageType === 'module' ? KIND.MODULE : KIND.SCRIPT;
}
