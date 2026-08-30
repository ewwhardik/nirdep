// What stdlibmd says when it wrote a file rather than printed one.
//
// Piped, the command is the document and this page never appears. Told to write, the useful
// answer is three facts: where the file is, what got logged in it, and that the document is
// not finished -- a generator that said "done" about a write-up with five TODOs in it would
// be the last thing anybody read before publishing five TODOs.

import { pad, plural, styleOf, wrap, WIDTH } from '../text/format.mjs';
import { RESULT } from './project.mjs';

/** The verb in the margin, and the colour it is printed in. */
const MARGIN = Object.freeze({
  [RESULT.WRITTEN]: ['written', 'green'],
  [RESULT.WOULD_WRITE]: ['would write', 'cyan'],
  [RESULT.SAME]: ['up to date', 'dim'],
  [RESULT.REFUSED]: ['refused', 'red'],
  [RESULT.FAILED]: ['failed', 'red'],
});

const folded = (text, indent, paint) => wrap(text, WIDTH - (indent.length - 4), indent)
  .split('\n').map((line) => `${indent}${paint(line.trimStart())}`).join('\n');

/**
 * @param {object} run the result of stdlibApply
 * @param {{ style?: object }} [options]
 */
export function stdlibReport(run, options = {}) {
  const s = styleOf(options.style);
  const [verb, colour] = MARGIN[run.result] ?? ['?', 'dim'];
  const { counts } = run.document;
  const lines = [
    `  ${s[colour](pad(verb, 11))}  ${s.bold(run.display)}`
      + `${run.result === RESULT.SAME ? '' : `  ${s.dim(`${counts.lines} lines, ${counts.bytes} bytes`)}`}`,
  ];
  if (run.reason !== null) lines.push(`  ${' '.repeat(11)}  ${s.yellow(run.reason)}`);

  if (run.result === RESULT.WRITTEN || run.result === RESULT.WOULD_WRITE || run.result === RESULT.SAME) {
    lines.push('');
    lines.push(folded(run.document.empty
      ? 'It logs no replacement, because this project depends on none of the packages '
        + 'nirdep replaces. That is a result worth committing, and it is a short document.'
      : `${plural(run.document.counts.replaced, 'package')} logged as replaced across `
        + `${plural(run.document.counts.modules, 'runtime module')}, and `
        + `${plural(run.document.counts.remaining, 'dependency', 'dependencies')} left in place `
        + 'with a table and no explanation.', '  ', s.dim));
    lines.push('');
    // The point of the command, and the reason it does not claim to be finished.
    lines.push(folded('The tables are derived and will be right. The prose is not written: '
      + 'every heading that needs a sentence from you is marked TODO, and the last TODO is to '
      + 'delete the list.', '  ', s.dim));
  }
  if (run.result === RESULT.WOULD_WRITE) {
    lines.push('');
    lines.push(s.dim('nothing was written: this was a dry run.'));
  }
  return `${lines.join('\n')}\n`;
}

/** 0 written or already right, 1 a write that failed, 2 a file we declined to clobber. As
 * with eject, a refusal is the user's to resolve, so it is a 2 rather than a 1. */
export function stdlibExitCode(run) {
  if (run.result === RESULT.FAILED) return 1;
  if (run.result === RESULT.REFUSED) return 2;
  return 0;
}
