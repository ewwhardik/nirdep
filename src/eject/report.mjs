// What eject says it did, and the one line to run next.
//
// The report is four lines in the ordinary case, because the ordinary case is somebody who
// typed one command and wants to know whether they can carry on. What earns the space is
// the last line: the ejected files are useless until the imports point at them, so the
// report ends with the exact `apply --runtime` invocation, spelled with the directory the
// user actually chose rather than the default in the documentation.

import { suggest } from '../runtime/args.mjs';
import {
  agree, columnWidth, didYouMean, DRY_RUN, pad, plural, sizeOf, styleOf, wrap, WIDTH,
} from '../text/format.mjs';
import { RESULT } from './project.mjs';

/** The verb in the margin, and the colour it is printed in. */
const MARGIN = Object.freeze({
  [RESULT.WRITTEN]: ['written', 'green'],
  [RESULT.WOULD_WRITE]: ['would add', 'cyan'],
  [RESULT.SKIPPED]: ['up to date', 'dim'],
  [RESULT.REFUSED]: ['refused', 'red'],
  [RESULT.FAILED]: ['failed', 'red'],
});

/**
 * @param {object} run the result of ejectApply
 * @param {{ style?: object }} [options]
 */
export function ejectReport(run, options = {}) {
  const s = styleOf(options.style);
  const lines = [];

  if (run.unknown.length > 0) {
    for (const name of run.unknown) {
      // The did-you-mean comes from our own replacement for commander, which already had
      // to solve this for command names. One typo, one answer, no second guess.
      const near = suggest(name, run.available, 1);
      const tail = didYouMean(near, { lead: '' });
      lines.push(`${s.red('no such runtime module:')} ${s.bold(name)}${tail === '' ? '' : `  ${s.dim(tail)}`}`);
    }
    lines.push(`  ${s.dim(`there ${agree(run.available.length, 'is', 'are')} `
      + `${run.available.length}: ${run.available.join(', ')}`)}`);
    if (run.files.length > 0) lines.push('');
  }

  const width = columnWidth(run.files.map((entry) => entry.module));
  for (const entry of run.files) {
    const [verb, colour] = MARGIN[entry.result] ?? ['?', 'dim'];
    const size = entry.result === RESULT.SKIPPED ? '' : `  ${s.dim(sizeOf(entry))}`;
    lines.push(`  ${s[colour](pad(verb, 10))}  ${s.bold(pad(entry.module, width))}  ${entry.path}${size}`);
    if (entry.replaces.length > 0) {
      lines.push(`  ${' '.repeat(10)}  ${s.dim(`replaces ${entry.replaces.join(', ')}`)}`);
    }
    if (entry.reason !== null && entry.result !== RESULT.SKIPPED) {
      lines.push(`  ${' '.repeat(10)}  ${s.yellow(entry.reason)}`);
    }
  }

  if (run.counts.refused > 0) {
    lines.push('');
    lines.push(`  ${wrap(`${plural(run.counts.refused, 'file')} already there and not what this version of `
      + 'nirdep writes. Diff it, keep whichever you prefer, and pass --force to take ours.', WIDTH, '  ')}`);
  }

  const done = run.counts.written + run.counts.skipped;
  if (done > 0 && run.counts.refused === 0 && run.counts.failed === 0) {
    lines.push('');
    // The point of the whole command. Printed even when everything was already up to date,
    // because "nothing to do" is exactly when somebody has forgotten the second step.
    lines.push(`${s.dim('next:')} ${s.bold(`nirdep apply --runtime ${run.into} .`)}`);
  }
  if (!run.wrote && run.counts.wouldWrite > 0) {
    lines.push('');
    lines.push(s.dim(DRY_RUN));
  }

  if (lines.length === 0) lines.push(s.dim('no runtime modules selected, so nothing to write.'));
  return `${lines.join('\n')}\n`;
}

/**
 * 0 written or already right, 1 a write that failed, 2 a name that does not exist or a
 * file we declined to clobber. The refusal is the user's to resolve -- with --force, or by
 * moving their file -- so it is a 2 and not a 1.
 */
export function ejectExitCode(run) {
  if (run.counts.failed > 0) return 1;
  if (run.unknown.length > 0 || run.counts.refused > 0) return 2;
  return 0;
}

/** `eject --list`: the modules, what each replaces, and how big the file is. */
export function ejectList(modules, options = {}) {
  const s = styleOf(options.style);
  const width = columnWidth(modules.map((module) => module.name));
  const lines = [s.bold('runtime modules')];
  for (const module of modules) {
    lines.push(`  ${s.bold(pad(module.name, width))}  ${s.dim(module.target)}`);
    lines.push(`  ${' '.repeat(width)}  ${module.replaces.length > 0
      ? `replaces ${module.replaces.join(', ')}`
      : s.dim('no package to replace')}`);
  }
  lines.push('');
  lines.push(s.dim('each is one file with no imports of its own beyond node: builtins.'));
  return `${lines.join('\n')}\n`;
}
