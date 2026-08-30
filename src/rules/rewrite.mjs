// The codemod itself: read one file, decide what may be rewritten, produce the edits.
//
// Everything here is a refusal engine with a rewrite attached. The interesting output is
// not the diff but the list of things it would not touch and why, because that list is
// what a reviewer checks before running `apply`. A codemod that reports nothing declined
// is a codemod that has not looked.
//
// The order of the checks is deliberate: the cheapest and most sweeping first. A file
// whose tokens do not add up to its own bytes is refused before any rule runs, and a
// file that calls eval is refused too -- eval can reach any name, so no static claim
// about a binding survives it.

import { KIND, accountsForEverySource } from '../lex/lexer.mjs';
import { FORM, analyse, referencesTo } from '../lex/bindings.mjs';
import { createPatch } from '../patch/edits.mjs';
import { ACTION, AS, ruleFor } from './registry.mjs';

/** Why a rewrite did not happen. One of these is worth more than a silent skip. */
export const DECLINE = Object.freeze({
  UNREADABLE: 'unreadable',
  UNSAFE: 'unsafe',
  SHAPE: 'shape',
  MEMBER: 'member',
  FORM: 'form',
  ADVICE: 'advice',
});

/** The quote the file already used, so a rewrite does not start a style argument. */
const quoteOf = (source, range) => {
  const first = source[range.start];
  return first === '"' || first === "'" || first === '`' ? first : "'";
};

/** `?.` is one token in this lexer, and it reaches a member just like `.` does. */
const isAccess = (token) => token?.kind === KIND.PUNCT && (token.value === '.' || token.value === '?.');

/**
 * The members a binding reaches for. Returns the list, or null when the binding is used
 * as a value somewhere -- passed to a function, assigned, spread -- because then no list
 * of member names describes what the call site needs.
 */
function membersReached(analysis, index, chained) {
  const tokens = analysis.result.tokens;
  const found = [];
  for (const reference of referencesTo(analysis, index)) {
    let at = reference.token;
    if (!isAccess(tokens[at + 1]) || tokens[at + 2]?.kind !== KIND.NAME) return null;
    found.push({ name: tokens[at + 2].value, line: tokens[at + 2].line });
    if (!chained) continue;
    at += 2;
    while (isAccess(tokens[at + 1]) && tokens[at + 2]?.kind === KIND.NAME) {
      found.push({ name: tokens[at + 2].value, line: tokens[at + 2].line });
      at += 2;
    }
  }
  return found;
}

/**
 * Decide one statement. Returns either a list of edits to make or a reason not to, never
 * both, and never a partial rewrite: a statement whose default binding is fine and whose
 * named binding is not would end up pointing half its names at a module that does not
 * have them.
 */
function judge(analysis, dependency, rule, target) {
  const source = analysis.result.source;
  const at = (line, code, detail) => ({ line, code, detail });

  if (dependency.form === FORM.REQUIRE) {
    return at(dependency.line, DECLINE.FORM, 'the replacement is an ES module and this is a loader '
      + 'call, so the value on the other side would be read differently. Convert the file first.');
  }
  if (dependency.form === FORM.EXPORT_FROM) {
    return at(dependency.line, DECLINE.FORM, 'a re-export passes names through without naming '
      + 'them here, so there is nothing to check them against.');
  }
  if (dependency.form === FORM.BARE) {
    return at(dependency.line, DECLINE.FORM, 'nothing is bound, so this line is here for a side '
      + 'effect. The replacement has none: delete the line rather than repoint it.');
  }
  if (dependency.form === FORM.DYNAMIC) {
    if (rule.fromDefault?.as !== AS.DEFAULT) {
      return at(dependency.line, DECLINE.SHAPE, 'the awaited namespace would not carry the same '
        + 'default export, and what happens to it here is not visible from the statement.');
    }
    return { edits: [specifierEdit(source, dependency, target, rule)] };
  }

  const edits = [specifierEdit(source, dependency, target, rule)];
  for (const index of dependency.bindings) {
    const binding = analysis.bindings[index];
    const shape = binding.form === 'namespace' ? rule.fromNamespace
      : binding.form === 'named' ? rule.fromNamed : rule.fromDefault;
    if (!shape) {
      const reason = rule.declines?.[binding.form] ?? `a ${binding.form} binding has no equivalent here`;
      return at(binding.line, DECLINE.SHAPE, reason);
    }
    if (binding.form === 'named') {
      if (!rule.members.has(binding.imported)) {
        return at(binding.line, DECLINE.MEMBER, `${rule.package}.${binding.imported} is not implemented `
          + 'by the replacement, so moving this line would break the build.');
      }
      continue;
    }
    if (shape.as === AS.NAMED) {
      const local = binding.name;
      const clause = local === shape.name ? `{ ${shape.name} }` : `{ ${shape.name} as ${local} }`;
      edits.push({
        start: binding.start,
        end: binding.end,
        text: clause,
        why: `${rule.package} is one function; the replacement exports it under the name ${shape.name}`,
      });
      continue;
    }
    const reached = membersReached(analysis, index, rule.chained);
    if (reached === null) {
      return at(binding.line, DECLINE.SHAPE, `${binding.name} is used as a value somewhere, not only `
        + 'as a member access, so which parts of the surface it needs cannot be read off the file.');
    }
    const missing = reached.filter((one) => !rule.members.has(one.name));
    if (missing.length > 0) {
      const names = [...new Set(missing.map((one) => one.name))].join(', ');
      return at(missing[0].line, DECLINE.MEMBER, `the replacement has no ${names}, which this file `
        + `reaches for on line ${missing[0].line}.`);
    }
  }
  return { edits };
}

/** The one edit every rewrite has: point the specifier somewhere else, same quotes. */
function specifierEdit(source, dependency, target, rule) {
  const quote = quoteOf(source, dependency.specifierRange);
  return {
    start: dependency.specifierRange.start,
    end: dependency.specifierRange.end,
    text: `${quote}${target}${quote}`,
    why: `${rule.package} becomes ${target}`,
  };
}

/**
 * Plan one file.
 *
 * Nothing is written and nothing is thrown. The return is the whole answer: a patch when
 * there is something to do, the changes it makes, and every dependency it left alone
 * with a reason attached.
 *
 * @param {string} source
 * @param {{ file?: string, resolve?: (rule: object, file: string) => string }} [options]
 */
export function planFile(source, options = {}) {
  const file = options.file ?? '<memory>';
  const resolve = options.resolve ?? ((rule) => rule.target);
  const declined = [];
  const changes = [];
  const report = (patch, extra = {}) => Object.freeze({
    file,
    patch,
    changes: Object.freeze(changes),
    declined: Object.freeze(declined),
    ...extra,
  });

  let analysis;
  try {
    analysis = analyse(source, { file });
  } catch (error) {
    declined.push(Object.freeze({
      line: error.line ?? 0, code: DECLINE.UNREADABLE, detail: error.message, specifier: null,
    }));
    return report(null, { readable: false });
  }
  if (!accountsForEverySource(analysis.result)) {
    declined.push(Object.freeze({
      line: 0,
      code: DECLINE.UNREADABLE,
      detail: 'the tokens do not add up to the bytes of the file, so an offset in it cannot be trusted',
      specifier: null,
    }));
    return report(null, { readable: false });
  }
  if (analysis.references.some((one) => one.name === 'eval' && one.binding === null)) {
    declined.push(Object.freeze({
      line: analysis.references.find((one) => one.name === 'eval').line,
      code: DECLINE.UNSAFE,
      detail: 'this file calls eval, which can reach any name, so nothing static about a binding holds',
      specifier: null,
    }));
    return report(null, { readable: true });
  }

  const patch = createPatch(source, { file });
  for (const dependency of analysis.dependencies) {
    const rule = ruleFor(dependency.specifier);
    if (rule === null) continue;
    if (rule.action === ACTION.ADVISE) {
      declined.push(Object.freeze({
        line: dependency.line, code: DECLINE.ADVICE, detail: rule.advice, specifier: rule.package,
      }));
      continue;
    }
    const target = resolve(rule, file);
    const verdict = judge(analysis, dependency, rule, target);
    if (!verdict.edits) {
      declined.push(Object.freeze({ ...verdict, specifier: rule.package }));
      continue;
    }
    for (const edit of verdict.edits) patch.replace(edit.start, edit.end, edit.text, edit.why);
    changes.push(Object.freeze({
      specifier: rule.package,
      target,
      form: dependency.form,
      line: dependency.line,
      why: `${rule.package} becomes ${target}: ${rule.note}`,
    }));
  }
  return report(patch, { readable: true, unanalysable: analysis.unanalysable });
}

/** The patched text, for a caller that only wants the string. */
export function rewriteSource(source, options = {}) {
  const plan = planFile(source, options);
  if (plan.patch === null) return source;
  return plan.patch.apply().after;
}
