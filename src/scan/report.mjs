// The scan, as a page a person reads once and acts on.
//
// Four blocks, in the order somebody actually decides things. What this project depends
// on and how much of it there is. What could be removed and what would leave with it --
// the only block with a number worth quoting. What is wrong, worst first. Then the
// footer, which is the part most tools omit: which file each number came from, and what
// that file does not record.
//
// The last block is not modesty. A count derived from a yarn lockfile cannot distinguish
// a dev dependency from a real one, and a reader who does not know that will act on the
// number anyway. Printing the limit next to the figure costs four lines and is the
// difference between a report and an advertisement.

import { pad, plural, styleOf, wrap, WIDTH } from '../text/format.mjs';
import { ACTION } from '../rules/registry.mjs';
import { SOURCE } from './advisories.mjs';
import { SEVERITY } from './risk.mjs';

// Two nouns, spelled by splitting one string. Written as its own quoted literal the
// first would be the word `import` followed immediately by a quote, which is the exact
// shape tools/verify.mjs reads as a dependency of this project -- src/lex/bindings.mjs
// spells the same word the same way and for the same reason. The second is along for the
// ride so that the first is not the last word in the string.
const [IMPORT, FILE] = 'import file'.split(' ');

/** How a severity is spelled in the margin, padded to one column width. */
const MARK = Object.freeze({
  [SEVERITY.HIGH]: 'high  ',
  [SEVERITY.MEDIUM]: 'medium',
  [SEVERITY.LOW]: 'low   ',
  [SEVERITY.NOTE]: 'note  ',
});

const paintSeverity = (severity, s) => {
  const text = MARK[severity] ?? pad(severity, 6);
  // The one level that gets two effects, because a release published to steal from
  // you and a ReDoS in a whitespace trim should not arrive in the same colour.
  if (severity === SEVERITY.CRITICAL) return s.bold(s.red(text));
  if (severity === SEVERITY.HIGH) return s.red(text);
  if (severity === SEVERITY.MEDIUM) return s.yellow(text);
  if (severity === SEVERITY.LOW) return s.cyan(text);
  return s.dim(text);
};

/** The lockfile, named the way a person would name it. */
function whichLock(scan) {
  if (scan.lock.kind === 'none') return 'no lockfile';
  return `${scan.lock.file}${scan.lock.version === null ? '' : ` (v${scan.lock.version})`}`;
}

/**
 * What is installed and where the tool looked.
 */
function overview(scan, s) {
  const { counts } = scan;
  const lines = [s.bold('dependencies')];
  lines.push(`  ${plural(counts.declared, 'package')} declared`
    + `${counts.dev > 0 ? s.dim(`, ${counts.dev} of them for development`) : ''}`);
  if (scan.lock.understood) {
    lines.push(`  ${plural(counts.installed, 'package')} installed, ${counts.names} distinct names`
      + `, from ${whichLock(scan)}`);
  } else {
    lines.push(`  ${s.yellow('the transitive tree is not visible')}: ${whichLock(scan)}`);
  }
  lines.push(`  ${plural(counts.imported, 'package')} imported by this project's own source`
    + s.dim(`, out of ${plural(scan.source.counts.scanned, 'file')} read`));
  return lines;
}

/** A list of names, cut short before it stops being readable. */
const some = (names, limit = 12) => (names.length > limit
  ? `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`
  : names.join(', '));

/** One folded, uniformly styled paragraph at a given indent. */
function folded(text, indent, paint) {
  return wrap(text, WIDTH - (indent.length - 4), indent)
    .split('\n')
    .map((line) => `${indent}${paint(line.trimStart())}`)
    .join('\n');
}

/**
 * The blast radius table, which is the reason this command exists.
 *
 * Only the replaceable rows are printed in full. A project's other direct dependencies
 * are counted in one line, because `nirdep` has nothing to offer about them and a table
 * padded out with rows the tool cannot act on is a table nobody finishes reading.
 */
function radius(scan, s) {
  const rows = scan.radius.filter((one) => one.replaceable);
  if (rows.length === 0) {
    return [s.bold('what nirdep can replace'), folded('nothing here: no direct dependency is one of the '
      + 'packages this tool knows how to stand in for.', '  ', s.dim)];
  }
  const width = Math.max(...rows.map((one) => one.name.length));
  const lines = [s.bold('what nirdep can replace')];
  for (const one of rows) {
    const verb = one.action === ACTION.REWRITE ? s.green('rewrite') : s.yellow('by hand');
    // The count includes the package itself, because "5 packages would leave with it" and
    // "6 packages leave the tree" are both true and only one of them can be checked
    // against the list printed beside it.
    const weight = one.installed
      ? `removing it takes ${plural(one.own.length, 'package')} out of the tree`
      : 'not installed here, so nothing would leave with it';
    lines.push(`  ${verb}  ${s.bold(pad(one.name, width))}  ${s.dim(one.range ?? '')}`);
    lines.push(`    ${one.sites === 0
      ? 'imported by no file here'
      : `${plural(one.sites, IMPORT)} in ${plural(one.files, FILE)}`}, ${one.installed ? weight : s.dim(weight)}`);
    // The names go on their own folded, dimmed lines. Styling a whole line at a time is
    // the only way to fold and colour the same text: `wrap` counts characters, and an
    // escape sequence is characters that occupy no columns.
    if (one.installed && one.own.length > 0) lines.push(folded(some(one.own), '      ', s.dim));
  }
  const { removable } = scan;
  if (removable.count > 0) {
    const n = removable.count;
    const direct = removable.direct.length;
    // The arithmetic is spelled out -- 10 = 3 + 7 -- because a reader who can check a
    // number against the row above believes the next one for free.
    const others = removable.stranded.filter((name) => !removable.direct.includes(name)).length;
    const head = `${n} of ${removable.of}`;
    const sentence = `${head} installed ${removable.of === 1 ? 'name' : 'names'} `
      + `${n === 1 ? 'is' : 'are'} reachable `
      + `only through ${plural(direct, 'package')} this tool replaces`
      + (others === 0
        ? '.'
        : `: remove ${direct === 1 ? 'it' : `those ${direct}`} and `
          + `${plural(others, 'package')} ${others === 1 ? 'goes' : 'go'} with ${direct === 1 ? 'it' : 'them'}.`);
    lines.push('');
    // Folded first and styled after, which is the only order that works: the head is the
    // start of the first line, so bolding it cannot move the column the fold measured.
    lines.push(folded(sentence, '  ', (line) => (line.startsWith(head)
      ? `${s.bold(head)}${line.slice(head.length)}`
      : line)));
  }
  return lines;
}

/** Every finding, in the order `assess` put them. */
function risks(scan, s) {
  if (scan.findings.length === 0) return [s.bold('findings'), `  ${s.green('nothing to report')}`];
  const lines = [s.bold('findings')];
  for (const one of scan.findings) {
    // The advisory identifier rides in the margin where there is one, because a claim
    // about somebody else's package should be checkable somewhere that is not here.
    const cite = one.id === null || one.id === undefined ? '' : `  ${one.id}`;
    lines.push(`  ${paintSeverity(one.severity, s)}  ${s.dim(`${one.code}${cite}`)}`);
    lines.push(`    ${wrap(one.detail)}`);
  }
  return lines;
}

/**
 * What was read, and what the things it read do not say. Always printed, including on a
 * clean project: "nothing found" means very little without "and here is what I could not
 * have found".
 */
function limits(scan, s) {
  const lines = [s.bold('what this scan did not check')];
  const { advisories } = scan;
  // The first line is the one people misread, so it states the scope twice: how many
  // packages the table covers, and the day somebody last read it against its sources.
  lines.push(`    ${wrap('Known vulnerabilities beyond a curated table. '
    + `${plural(advisories.coverage.packages, 'package')} `
    + `${advisories.coverage.packages === 1 ? 'is' : 'are'} in it, reviewed ${advisories.reviewed}, and `
    + `${advisories.matched} of ${advisories.source === SOURCE.LOCK ? 'the installed names' : 'the declared names'} `
    + 'matched. That is the neighbourhood nirdep offers to replace and the incidents that happened beside it. '
    + 'npm audit mirrors the whole advisory database over the network; this makes no request, so a clean '
    + 'report here is not a clean report from npm audit.')}`);
  lines.push(`    ${wrap(scan.lock.kind === 'none'
    ? 'Everything above comes from package.json alone: no lockfile is committed, so the transitive tree is '
      + 'invisible from here and every count above stops at the direct dependencies.'
    : `Everything above comes from ${whichLock(scan)} and package.json as committed, not from `
      + `node_modules as installed: ${scan.lock.note}.`)}`);
  if (scan.graph.understood) {
    lines.push(`    ${wrap('Blast radius follows the lockfile\'s edges by package name rather than by name and '
      + 'version, so a package installed at two versions is one node here. That makes every "would leave '
      + 'with it" count an upper bound.')}`);
  }
  if (scan.source.unparsed.length > 0) {
    const n = scan.source.unparsed.length;
    lines.push(`    ${wrap(`${plural(n, 'file')} would not parse, so ${n === 1 ? 'its' : 'their'} imports `
      + `were read with a blunt text scan instead: ${scan.source.unparsed.map((one) => one.path).join(', ')}.`)}`);
  }
  if (scan.source.unanalysable.length > 0) {
    const n = scan.source.unanalysable.length;
    lines.push(`    ${wrap(`${plural(n, IMPORT)} ${n === 1 ? 'names' : 'name'} a specifier that is not a `
      + `literal string, so no tool can say what ${n === 1 ? 'it loads' : 'they load'} without running the `
      + 'program.')}`);
  }
  for (const one of scan.source.unreadable) {
    lines.push(`    ${s.red('could not read')} ${one.path}: ${one.detail}`);
  }
  return lines;
}

/**
 * The `scan` command's output.
 *
 * @param {object} scan the result of scanProject
 * @param {{ style?: object }} [options]
 * @returns {string}
 */
export function scanReport(scan, options = {}) {
  const s = styleOf(options.style);
  const blocks = [overview(scan, s), radius(scan, s), risks(scan, s), limits(scan, s)];
  const { summary } = scan;
  // `critical` is omitted when it is zero rather than printed as a reassuring nought:
  // the level exists for malware in a lockfile, and a column that is almost always
  // empty teaches people to stop reading the row it lives in.
  const tally = [
    ...(summary.critical > 0 ? [`${summary.critical} critical`] : []),
    `${summary.high} high`,
    `${summary.medium} medium`,
    `${summary.low} low`,
    `${summary.note} note`,
  ].join(s.dim(' | '));
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n\n${tally}\n`;
}

/**
 * The exit code. A scan reports; it does not judge. Findings do not fail, because a
 * command that exits 1 on a deprecation notice gets wrapped in `|| true` within a week
 * and then it never fails again. `guard` is the one that fails, on rules a person chose.
 *
 * The one non-zero case is a file we were asked to read and could not, which is a
 * question about the report's own completeness rather than about the project.
 */
export function scanExitCode(scan) {
  return scan.source.unreadable.length > 0 ? 1 : 0;
}
