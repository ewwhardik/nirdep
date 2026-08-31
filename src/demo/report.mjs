// The frame around the demo: numbered headings, the command each stage stands for, and a
// closing count.
//
// The stage bodies are the real commands' own output and are printed flush left, unindented
// and unwrapped, because a diff that has been re-indented for presentation is no longer a
// diff you could paste anywhere. Everything this file adds sits outside them.

import {
  COLUMNS, pad, plural, sizeOf, styleOf, wrap, WIDTH,
} from '../text/format.mjs';
import { packageName } from '../scan/project.mjs';
import { GLOSSARY, guideFor, NEXT_STEPS } from './guide.mjs';
import { DEMO } from './script.mjs';

/** A heading that fills the line, so stages are findable when scrolling back. */
function rule(label, s) {
  const dashes = Math.max(2, COLUMNS - label.length - 4);
  return `${s.dim('--')} ${label} ${s.dim('-'.repeat(dashes))}`;
}

/** A labelled paragraph: the label in a dim gutter, the prose folded under itself. */
function field(label, text, s, gutter = 9) {
  // The gutter is a minimum, not a promise: a long label widens it rather than running
  // into the first word, which is what a fixed pad would have done to "blast radius".
  const width = Math.max(gutter, label.length + 3);
  const indent = ' '.repeat(width);
  return wrap(text, COLUMNS - width, '').split('\n')
    .map((line, index) => (index === 0
      ? `  ${s.dim(pad(label, width - 2))}${line}`
      : `${indent}${line}`));
}

/**
 * What the demo is about to do, before it does any of it.
 *
 * The terminal gets the steps and one line about where they happen. The teaching -- what a
 * codemod is, what a specifier is, what to do next in a project of your own -- is the
 * playground's job, where a reader can click a stage twice and read the popup at their own
 * pace instead of scrolling back through a transcript. `--guide` folds it in anyway, for
 * anyone who would rather have the whole thing in one buffer.
 *
 * @param {{ style?: object, root: string, total: number, guide?: boolean }} options
 */
export function demoHeader(options) {
  const s = styleOf(options.style);
  const lines = [
    `${s.bold('nirdep demo')} ${s.dim('--')} a project that cannot run, then the same project running,`,
    `${s.dim('with nothing installed in between.')}`,
    '',
    `  ${s.dim('project')}  ${DEMO.name}`,
    `  ${s.dim('written')}  ${options.root}`,
    `  ${s.dim('stages')}   ${options.total}`,
    '',
    `  ${s.dim('nothing is installed, and nothing outside that directory is read or written.')}`,
    '',
  ];
  if (options.guide === true) {
    lines.push(
      ...field('reading', 'Each stage below shows the command it stands for, what it does '
        + 'and why it is there, then the real output of the real command. Nothing is '
        + 'transcribed: this is the same code the CLI runs.', s, 10),
      ...field('safety', 'The directory above is removed at the end unless you pass --keep, '
        + 'and --dir puts it somewhere you choose.', s, 10),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * One stage: the heading, the command, the guide, then the command's own output.
 *
 * The output is printed flush left because it is somebody else's format -- a diff that has
 * been re-indented to look tidy inside a walkthrough is no longer a diff you could apply.
 *
 * @param {object} one a stage from runDemo
 * @param {{ style?: object, index: number, total: number, guide?: boolean }} options
 */
export function demoStage(one, options) {
  const s = styleOf(options.style);
  const mark = one.ok ? s.bold : s.red;
  const guide = options.guide === true ? guideFor(one.name) : null;
  const lines = [
    rule(`${s.dim(`${options.index}/${options.total}`)} ${mark(one.title)}`, s),
    `${s.dim('$')} ${s.cyan(one.command)}`,
    '',
  ];
  if (guide !== null) {
    lines.push(...field('what', guide.what, s), ...field('why', guide.why, s));
    for (const term of guide.terms) {
      if (GLOSSARY[term]) lines.push(...field(term, GLOSSARY[term], s, 12));
    }
    lines.push('');
  }
  if (one.text !== '') lines.push(one.text, '');
  return lines.join('\n');
}

/** The two packages a machine declined, named, because the honesty is the point. */
const leftAlone = (plan) => [...new Set(plan.declined
  .map((one) => one.specifier).filter((name) => name !== null && name !== undefined))].sort();

/** The packages that are actually gone, by package rather than by specifier. */
const removed = (plan) => [...new Set(plan.changes.map((one) => packageName(one.specifier)))].sort();

/**
 * The closing count: what happened, and what is still the reader's job.
 *
 * @param {object} result the result of runDemo
 * @param {{ style?: object, tree?: string | null, kept?: boolean, guide?: boolean }} options
 */
export function demoSummary(result, options = {}) {
  const s = styleOf(options.style);
  const bytes = result.ejected.files.reduce((sum, file) => sum + file.bytes, 0);
  const lines = result.ejected.files.reduce((sum, file) => sum + file.lines, 0);
  const declined = leftAlone(result.plan);
  const gone = removed(result.plan);
  const out = [
    rule(s.bold(result.ok ? 'What just happened' : 'What went wrong'), s),
    [
      `${plural(result.applied.counts.written, 'file')} rewritten`,
      // Spelt as one phrase because tools/verify.mjs reads the word `import` followed by a
      // quote as a dependency, on purpose: over-accepting is the right bias for a proof of
      // absence, and the cost of it is a comment like this one.
      plural(result.plan.counts.changes, 'import moved', 'imports moved'),
      `${plural(result.modules.length, 'module')} vendored`,
      `${plural(declined.length, 'package')} declined`,
    ].join(s.dim(' | ')),
    '',
    `  ${s.green('gone')}      ${gone.length === 0 ? '--' : gone.join(', ')}`,
    `  ${s.yellow('by hand')}   ${declined.length === 0 ? '--' : declined.join(', ')}`,
    `  ${s.cyan('vendored')}  ${result.modules.join(', ')} ${s.dim(`(${sizeOf({ lines, bytes })})`)}`,
    '',
  ];

  // Attributed advisory by advisory, because "four CVEs fixed" would be the easy lie
  // here: one of them is against a package this tool declined to touch, and it is
  // still in that lockfile.
  const { hits } = result.scanned.advisories;
  const cleared = hits.filter((one) => gone.includes(one.package));
  const staying = hits.filter((one) => !gone.includes(one.package));
  if (cleared.length > 0) {
    out.push(`  ${wrap(`${plural(cleared.length, 'advisory', 'advisories')} in that lockfile `
      + `${cleared.length === 1 ? 'was' : 'were'} against a package the rewrite removed: not `
      + 'patched, not waived, nothing left for them to be about.', WIDTH, '  ')}`, '');
  }
  if (staying.length > 0) {
    out.push(`  ${wrap(`${plural(staying.length, 'advisory', 'advisories')} `
      + `${staying.length === 1 ? 'stays' : 'stay'}, against `
      + `${[...new Set(staying.map((one) => one.package))].sort().join(' and ')}, `
      + 'which nirdep will not rewrite for you and does not pretend to have handled.',
    WIDTH, '  ')}`, '');
  }
  out.push(`  ${wrap('Still yours: drop the dead names from package.json, re-lock, and deal with '
    + `${declined.length === 0 ? 'anything' : declined.join(' and ')} by hand. `
    + 'A tool that edited your manifest on your behalf would be a tool you could not trust '
    + 'with your imports.', WIDTH, '  ')}`);
  // The commands themselves are steps, not commentary, so they print either way: a reader
  // who has watched this run wants to know what to type next, and only the reasoning behind
  // them is worth a paragraph.
  out.push('', rule(s.bold('Your turn'), s), '');
  const width = Math.max(...NEXT_STEPS.map((one) => one.command.length));
  for (const one of NEXT_STEPS) {
    out.push(`  ${s.cyan(pad(one.command, width))}  ${s.dim(one.why)}`);
  }
  if (options.guide === true) {
    out.push('', `  ${wrap('Run them in that order in a project of your own. `scan` and `plan` '
      + 'change nothing, so the first two are free; `apply` is the only command that writes to '
      + 'your source, and it will not write a file it could not parse.', WIDTH, '  ')}`);
  }
  if (options.tree) {
    out.push('', ...field(options.kept === true ? 'kept' : 'gone',
      options.kept === true
        ? `the demo project is at ${options.tree}, and it is a normal project: cd into it and `
          + 'run whatever you like.'
        : `the demo project was at ${options.tree} and has been removed. --keep leaves it `
          + 'there, or --dir puts it somewhere you choose.', s));
  }
  return `${out.join('\n')}\n`;
}

/** Non-zero if any stage failed, because a demo that lies is worse than no demo. */
export const demoExitCode = (result) => (result.ok ? 0 : 1);
