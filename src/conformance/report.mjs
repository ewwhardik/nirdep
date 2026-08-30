// The conformance table, as the one page that answers "does the replacement behave".
//
// Three columns, and the middle one is the point: how many cases, and out of what. A table
// that said only "colour: passed" would be true of a module with one case in it, which is
// how a green conformance report gets to mean nothing. So the case count and the file count
// travel with the verdict, and the footer sends the reader to the document that says where
// the expectations came from -- a number checked against a hand-written table and a number
// checked against a published package's own output are both worth having, and they are not
// the same claim.

import { columnWidth, COLUMNS, labelled, note, pad, plural, styleOf, verdictOf, wrap }
  from '../text/format.mjs';
import { DRIVERS, VECTORS } from './plan.mjs';

/** How many failing names to print before the list itself becomes the noise. */
const NAMED = 5;

/** A bullet with a hanging indent, so a folded problem stays visibly one problem. */
function bullet(plain, s) {
  return wrap(plain, COLUMNS - 4, '').split('\n')
    .map((line, index) => (index === 0 ? `  ${s.yellow('-')} ${s.dim(line)}` : `    ${s.dim(line)}`));
}

/** What the suite said, in the order a reader cares about it. */
function verdict(counts, s) {
  if (counts === null) return s.red('did not run');
  const parts = [];
  if (counts.fail > 0) parts.push(s.red(plural(counts.fail, 'failed', 'failed')));
  if (counts.cancelled > 0) parts.push(s.red(`${counts.cancelled} cancelled`));
  if (counts.skipped > 0) parts.push(s.yellow(`${counts.skipped} skipped`));
  if (counts.todo > 0) parts.push(s.yellow(`${counts.todo} todo`));
  if (parts.length === 0) return `${plural(counts.tests, 'test')}, ${s.green('all passed')}`;
  // With something to report, the pass count stops being implied and has to be said.
  return `${plural(counts.tests, 'test')}, ${counts.pass} passed, ${parts.join(', ')}`;
}

/**
 * @param {object} result the result of runConformance
 * @param {{ style?: object, verbose?: boolean }} [options]
 */
export function conformanceReport(result, options = {}) {
  const s = styleOf(options.style);
  const lines = [];

  // `ran: false` is two different sentences: we refused to start, and a suite that started
  // and fell over. Only the first one has no table to print -- the second one has numbers
  // from the modules that did run, and printing them is the whole point of running the
  // modules separately.
  if (result.blocked.length > 0) {
    lines.push(`${s.red('conformance cannot run:')} ${plural(result.blocked.length, 'problem')}`);
    for (const problem of result.blocked) lines.push(...bullet(problem, s));
    lines.push('');
    lines.push(...note('The vectors are data, not code: package.json "files" ships bin, src and the '
      + 'documents, so a published artifact has no tests directory in it. Clone the repository '
      + 'and run "make conformance" there.', '  ', s.dim));
    return `${lines.join('\n')}\n`;
  }

  const width = columnWidth(result.modules.map((one) => `${one.name}  `), { min: 8 });
  const gutter = `  ${' '.repeat(width)}`;
  const cases = columnWidth(result.modules.map((one) => one.cases), { min: 5 });
  const corpusOf = (one) => `${String(one.cases).padStart(cases)} cases in ${plural(one.vectors.length, 'file')}`;
  // Padded, because "1 file" is shorter than "2 files" and a verdict column that moves by
  // one character per row is a column a reader has to find again on every line.
  const corpusWidth = columnWidth(result.modules.map((one) => corpusOf(one)));

  lines.push(s.bold(`${plural(result.totals.modules, 'runtime module')}, `
    + `${plural(result.totals.cases, 'vector case')}, ${plural(result.totals.tests, 'test')}`));
  for (const one of result.modules) {
    const corpus = pad(corpusOf(one), corpusWidth);
    lines.push(`  ${s.bold(pad(one.name, width - 2))}  ${s.dim(corpus)}  ${verdict(one.counts, s)}`);
    lines.push(...note(`${plural(one.packages.length, 'package')}: `
      + `${one.packages.map((pkg) => pkg.name).join(', ')}`, gutter, s.dim));
    if (one.note !== null) lines.push(...note(one.note, gutter, s.yellow));
    for (const name of one.failures.slice(0, NAMED)) lines.push(...note(`failed: ${name}`, gutter, s.red));
    if (one.failures.length > NAMED) {
      lines.push(...note(`and ${one.failures.length - NAMED} more, in the suite's own output`, gutter, s.red));
    }
    if (options.verbose === true) {
      for (const vector of one.vectors) lines.push(...note(`${vector.file}  ${vector.cases}`, gutter, s.dim));
      for (const driver of one.drivers) lines.push(...note(driver, gutter, s.dim));
    }
  }

  if (result.plan.strays.length > 0) {
    lines.push('');
    lines.push(...note(`${plural(result.plan.strays.length, 'file')} under ${DRIVERS} reads no runtime `
      + `module and was not run here: ${result.plan.strays.join(', ')}`, '  ', s.yellow));
  }

  lines.push('');
  lines.push(...labelled('read', `${VECTORS} and ${DRIVERS}, on node ${result.node}`, s.dim));
  lines.push(...labelled('source', 'expectations are hand-written or taken from a published package\'s own '
    + 'test data; STDLIB.md, under Borrowed test data, says which, per module.', s.dim));

  lines.push('');
  const wrong = result.totals.fail + result.totals.cancelled;
  const missing = result.modules.filter((one) => !one.ran);
  if (missing.length > 0) {
    // Exit 2 has to be readable as well as returnable. A module that never reported is not
    // a module with nothing wrong in it, and the other modules' pass counts cannot stand in
    // for the cases nobody ran.
    const unchecked = missing.reduce((sum, one) => sum + one.cases, 0);
    lines.push(...verdictOf('NO VERDICT', `: ${missing.length} of `
      + `${plural(result.totals.modules, 'module')} did not run; `
      + `${plural(unchecked, 'case')} went unchecked`
      + `${wrong > 0 ? `, and ${wrong} of the rest came back wrong` : ''}.`, s.red));
  } else if (wrong > 0) {
    lines.push(...verdictOf('FAIL', `: ${wrong} of ${plural(result.totals.tests, 'test')} `
      + `came back wrong across ${plural(result.totals.modules, 'module')}.`, s.red));
  } else {
    lines.push(...verdictOf('PASS', `: ${plural(result.totals.packages, 'package')} replaced, `
      + `${plural(result.totals.cases, 'case')} checked`
      + `${result.totals.skipped > 0 ? `, ${result.totals.skipped} skipped` : ''}`
      + ', nothing came back wrong.', s.green));
  }
  return `${lines.join('\n')}\n`;
}
