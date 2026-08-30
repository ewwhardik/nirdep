// Why a rewrite is safe, or why it was refused.
//
// `plan` and `apply` print decisions. This prints the reasoning behind one, for a package
// name rather than for a file, and it is the command to reach for when a reviewer asks the
// only question that matters about a codemod: how do you know that was safe?
//
// Everything here is read off the rule catalogue and the runtime modules themselves -- the
// accepted import forms, the declines and their reasons, the member list the rewriter
// checks each call site against. A hand-written explanation would be a second source of
// truth, and the first time the two disagreed the tool would be lying with confidence.
//
// The one thing not derived from code is the table of Node APIs in ./facts.mjs, and that
// is what the two `what the standard library` blocks below are quoting.

import { isBuiltinSpecifier, packageOf } from '../audit/imports.mjs';
import { DEFAULT_RUNTIME_DIR } from '../apply/project.mjs';
import { suggest } from '../runtime/args.mjs';
import { ACTION, RULES, REPLACEABLE, ruleFor } from '../rules/registry.mjs';
import { pad, plural, styleOf, wrap, WIDTH } from '../text/format.mjs';
import { nodeApiFor } from './facts.mjs';

/** One folded, uniformly styled paragraph at a given indent. Same trick as scan's report:
 * `wrap` counts characters, so a styled line has to be styled whole. `lead` is the first
 * line's prefix, which is how a bullet gets a hanging indent instead of continuations that
 * read as items of their own. */
function folded(text, indent, paint = (line) => line, lead = indent) {
  return wrap(text, WIDTH - (indent.length - 4), indent)
    .split('\n')
    .map((line, index) => `${index === 0 ? lead : indent}${paint(line.trimStart())}`)
    .join('\n');
}

/**
 * What we have to say about a name. `kind` is the shape of the answer, not its severity:
 * a builtin is a perfectly good answer, it just is not a rule.
 *
 * @param {string} name a package name as it would appear in a manifest or an import
 */
export function explainPackage(name) {
  const asked = String(name ?? '').trim();
  // A deep specifier is a fair thing to type, and the answer is about its package. Saying
  // "no such package: chalk/source" to somebody who pasted an import would be pedantry.
  const root = packageOf(asked);
  const rule = ruleFor(root);
  if (rule !== null) {
    return Object.freeze({
      asked, name: root, kind: 'rule', rule, api: nodeApiFor(rule.subpath), near: Object.freeze([]),
    });
  }
  if (isBuiltinSpecifier(asked)) {
    return Object.freeze({ asked, name: asked, kind: 'builtin', rule: null, api: null, near: Object.freeze([]) });
  }
  return Object.freeze({
    asked,
    name: root,
    kind: 'unknown',
    rule: null,
    api: null,
    near: Object.freeze(suggest(root, REPLACEABLE, 2)),
  });
}

/** The module a rule points at, as `eject` names it. */
const moduleOf = (rule) => rule.subpath.slice(rule.subpath.lastIndexOf('/') + 1);

/**
 * @param {object} answer the result of explainPackage
 * @param {{ style?: object }} [options]
 */
export function explainReport(answer, options = {}) {
  const s = styleOf(options.style);
  if (answer.kind === 'builtin') {
    return `${[
      `${s.bold(answer.asked)} ${s.dim('is part of Node')}`,
      folded('There is nothing to replace and nothing to remove: it resolves without a '
        + 'package, on every machine, at the version of Node you already have.', '  ', s.dim),
    ].join('\n')}\n`;
  }
  if (answer.kind === 'unknown') {
    const lines = [`${s.red('nothing to explain:')} ${s.bold(answer.name)} `
      + s.dim('is not a package this project replaces')];
    if (answer.near.length > 0) {
      lines.push(`  ${s.dim(`did you mean ${answer.near.join(' or ')}?`)}`);
    }
    lines.push(folded(`The list is short on purpose: ${plural(REPLACEABLE.length, 'package')}, each one `
      + 'taken to conformance rather than to a demo. Run "nirdep explain" with no argument to see it.',
    '  ', s.dim));
    return `${lines.join('\n')}\n`;
  }

  const rule = answer.rule;
  const rewrite = rule.action === ACTION.REWRITE;
  const module = moduleOf(rule);
  const lines = [
    `${s.bold(rule.package)}  ${s.dim(`${rule.weekly} downloads a week`)}`,
    rewrite
      ? `  ${s.green('nirdep rewrites this one.')} ${s.dim('->')} ${s.bold(rule.target)}`
      : `  ${s.yellow('nirdep replaces this one by hand.')} ${s.dim('->')} ${s.bold(rule.target)}`,
  ];

  lines.push('');
  lines.push(`  ${s.bold('what the standard library already gives you')}`);
  if (answer.api.has.length === 0) {
    lines.push(folded('Nothing. This is the row with no partial answer in it: Node ships no '
      + 'comparator, no range grammar and no precedence rule, so every line of the replacement '
      + 'had to be written.', '    ', s.dim));
  } else {
    const width = Math.max(...answer.api.has.map((one) => `${one.module.slice('node:'.length)}.${one.path}`.length));
    for (const one of answer.api.has) {
      const api = `${one.module.slice('node:'.length)}.${one.path}`;
      lines.push(`    ${s.cyan(pad(api, width))}  ${s.dim(`Node ${one.version}`)}`);
      lines.push(folded(one.gives, `    ${' '.repeat(width)}  `, s.dim));
    }
  }
  lines.push(`  ${s.bold('and what it does not')}`);
  for (const gap of answer.api.lacks) lines.push(folded(gap, '      ', s.dim, '    - '));

  lines.push('');
  if (rewrite) {
    lines.push(`  ${s.bold('what the codemod will do')}`);
    lines.push(folded(rule.note, '    '));
    // Keyed rather than labelled: `declines` uses these three words and so does the prose,
    // so there is one place to change and no chance of a reason silently not printing. The
    // label is a template literal on purpose -- tools/verify.mjs reads this repository
    // looking for import-shaped text, and the word followed by a quote is exactly what it
    // counts as a dependency.
    for (const [key, accepted] of [
      ['default', rule.fromDefault],
      ['namespace', rule.fromNamespace],
      ['named', rule.fromNamed],
    ]) {
      const form = `a ${key} import`;
      const declined = rule.declines?.[key];
      if (accepted !== null && accepted !== undefined) {
        lines.push(`    ${s.green('rewritten')}  ${form}${accepted.as === 'named' && accepted.name
          ? s.dim(` -> the named export ${accepted.name}`) : ''}`);
      } else {
        lines.push(`    ${s.yellow('refused')}    ${form}`);
        if (declined !== undefined) lines.push(folded(declined, '               ', s.dim));
      }
    }
    // strip-ansi is one function with nothing to reach for, so the member sentence would
    // read "0 members are known" -- true, and no help to anybody.
    if (rule.members.size > 0) {
      lines.push(folded(`${plural(rule.members.size, 'member')} are known, read off the module rather than `
        + `typed out here${rule.chained ? ', and a chain is checked link by link' : ''}. A call site that `
        + 'reaches for anything else is left alone and reported.', '    ', s.dim));
    }
  } else {
    lines.push(`  ${s.bold('why this one is not rewritten')}`);
    lines.push(folded(rule.advice, '    '));
  }

  lines.push('');
  lines.push(`  ${s.bold('how to take it')}`);
  lines.push(`    ${s.cyan(`nirdep eject ${module}`)}`);
  // The same default `eject` writes to and `apply` reads from, quoted from the one
  // constant rather than typed, so a printed instruction cannot go stale.
  if (rewrite) lines.push(`    ${s.cyan(`nirdep apply --runtime ${DEFAULT_RUNTIME_DIR} .`)}`);

  const together = RULES.filter((one) => one.subpath === rule.subpath && one.package !== rule.package);
  if (together.length > 0) {
    // A paragraph rather than a fourth line under the commands: it is a fact about the
    // commit, not another thing to type.
    lines.push('');
    lines.push(folded(`The same file replaces ${together.map((one) => one.package).join(', ')}, so `
      + `${together.length === 1 ? 'that package goes' : 'those packages go'} in the same commit.`, '    ', s.dim));
  }
  return `${lines.join('\n')}\n`;
}

/** `explain` with nothing to explain: the whole claim, in one table. */
export function explainList(options = {}) {
  const s = styleOf(options.style);
  const width = Math.max(...REPLACEABLE.map((name) => name.length));
  const lines = [s.bold('what nirdep replaces'), ''];
  for (const rule of RULES) {
    const verb = rule.action === ACTION.REWRITE ? s.green(pad('rewrite', 8)) : s.yellow(pad('by hand', 8));
    lines.push(`  ${verb}  ${s.bold(pad(rule.package, width))}  ${s.dim(pad(`${rule.weekly}/week`, 10))}  ${rule.target}`);
  }
  lines.push('');
  lines.push(folded('Name any one of them for the reasoning: what Node already does, what it does '
    + 'not, and whether a machine is allowed to move your call sites.', '  ', s.dim));
  return `${lines.join('\n')}\n`;
}

/** 0 when we could answer, 2 when the name means nothing here. */
export function explainExitCode(answer) {
  return answer.kind === 'unknown' ? 2 : 0;
}
