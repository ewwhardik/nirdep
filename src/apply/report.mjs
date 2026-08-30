// Turning a plan into something a person reads in a terminal.
//
// Separate from the planning because the two have different failure modes: a wrong
// number here is a cosmetic bug, a wrong number there is a corrupted repository. Keeping
// them apart also means the tests for the interesting half never have to assert on
// padding.
//
// The report has an opinion about ordering. The declines come after the diff and are not
// tucked behind a flag, because the diff is the part a reviewer skims and the declines are
// the part that tells them what is left to do by hand. A tool that prints twelve rewrites
// and silently omits the four it could not do has told the more comfortable half of the
// truth.

import { unified } from '../patch/diff.mjs';
import { plural, styleOf, wrap } from '../text/format.mjs';
import { OUTCOME } from './project.mjs';

/** What a decline code is called out loud. Short, because it is printed in a column. */
const HEADING = Object.freeze({
  advice: 'by hand',
  form: 'wrong form',
  member: 'not implemented',
  shape: 'different shape',
  unsafe: 'not safe to read',
  unreadable: 'could not read',
});

/**
 * The `plan` command's output: one diff per file that would change, then every dependency
 * left alone with the reason. Returns text and an exit code, and writes nothing.
 *
 * @param {object} plan the result of planProject
 * @param {{ style?: object, context?: number, diff?: boolean }} [options]
 */
export function planReport(plan, options = {}) {
  const s = styleOf(options.style);
  const context = options.context ?? 3;
  const lines = [];

  if (options.diff !== false) {
    for (const entry of plan.files) {
      if (entry.edits === 0 || entry.plan?.patch === null) continue;
      const after = entry.plan.patch.apply().after;
      const text = unified(entry.source, after, {
        context,
        fromFile: `a/${entry.path}`,
        toFile: `b/${entry.path}`,
      });
      if (text === '') continue;
      lines.push(paint(text, s));
    }
  }

  for (const change of plan.changes) {
    lines.push(`${s.green('rewrite')} ${s.bold(change.specifier)} ${s.dim('->')} ${change.target}`
      + `  ${s.dim(`${change.path}:${change.line}`)}`);
  }
  if (plan.declined.length > 0) {
    if (plan.changes.length > 0) lines.push('');
    lines.push(s.bold('left alone'));
    for (const one of plan.declined) {
      const where = one.specifier ? `${s.bold(one.specifier)} ` : '';
      lines.push(`  ${s.yellow(HEADING[one.code] ?? one.code)}  ${where}${s.dim(`${one.path}:${one.line}`)}`);
      lines.push(`    ${wrap(one.detail, 76, '    ')}`);
    }
  }

  const { counts } = plan;
  lines.push('');
  lines.push([
    `${plural(counts.scanned, 'file')} seen`,
    `${counts.opened} worth reading`,
    `${plural(counts.changes, 'rewrite')} in ${plural(counts.touched, 'file')}`,
    `${plural(counts.declined, 'dependency', 'dependencies')} left alone`,
  ].join(s.dim(' | ')));
  return `${lines.join('\n')}\n`;
}

/**
 * The `apply` command's output. One line per file and a closing count, because after a
 * write the diff is history and what matters is which files moved.
 *
 * @param {object} run the result of applyProject
 * @param {{ style?: object }} [options]
 */
export function applyReport(run, options = {}) {
  const s = styleOf(options.style);
  const mark = {
    [OUTCOME.WRITTEN]: s.green('written    '),
    [OUTCOME.WOULD_WRITE]: s.cyan('would write'),
    [OUTCOME.UNCHANGED]: s.dim('unchanged  '),
    [OUTCOME.REJECTED]: s.red('rejected   '),
    [OUTCOME.WAS_BROKEN]: s.yellow('was broken '),
    [OUTCOME.UNREADABLE]: s.red('unreadable '),
  };
  const lines = [];
  for (const file of run.files) {
    if (file.outcome === OUTCOME.UNCHANGED) continue;
    lines.push(`${mark[file.outcome] ?? file.outcome}  ${file.path}`);
    if (file.detail) lines.push(`    ${wrap(file.detail, 76, '    ')}`);
    if (file.gate?.after?.error?.line) {
      lines.push(`    ${s.dim(`${file.path}:${file.gate.after.error.line} (checked by ${file.gate.after.method})`)}`);
    }
  }
  if (run.halted) {
    lines.push('');
    lines.push(s.red('nothing was written.') + ' A rewrite failed its syntax check, and a tree where '
      + 'some files moved and some did not is worse than the tree you started with.');
  }
  const { counts } = run;
  lines.push('');
  lines.push([
    `${counts.written} written`,
    `${counts.wouldWrite} pending`,
    `${counts.unchanged} unchanged`,
    `${counts.rejected} rejected`,
    `${counts.wasBroken} already broken`,
  ].join(s.dim(' | ')));
  return `${lines.join('\n')}\n`;
}

/**
 * The exit code. 0 for a clean run, 1 when a rewrite failed its own syntax check, and 0
 * for a run that had nothing to do -- there is no dependency here is a success, not a
 * usage error. `guard` is the command that turns a finding into a failure; this one only
 * reports what it did.
 */
export function exitCodeFor(run) {
  if (run.halted || run.counts.rejected > 0) return 1;
  if (run.counts.unreadable > 0) return 1;
  return 0;
}

/** Colour a unified diff the way every other diff tool does, so nobody has to learn ours. */
function paint(text, s) {
  return text.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return s.bold(line);
    if (line.startsWith('@@')) return s.cyan(line);
    if (line.startsWith('+')) return s.green(line);
    if (line.startsWith('-')) return s.red(line);
    if (line.startsWith('\\')) return s.dim(line);
    return line;
  }).join('\n');
}
