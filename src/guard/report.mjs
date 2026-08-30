// The guard, as the four lines a build log should contain.
//
// A CI report is read in two states: green, when nobody reads it, and red, when somebody
// reads it in a hurry and needs to know what to change. So a breach gets the package, the
// three places it was found, one file and line to open, and the command that fixes it --
// and the footer says which policy file made this a failure, because the second question
// after "what broke" is always "who decided that".
//
// Nothing here decides anything; guardExitCode does that, from the same result.

import { pad, plural, styleOf, wrap, WIDTH } from '../text/format.mjs';
import { ACTION } from '../rules/registry.mjs';
import { SIGNAL, SOURCE } from './policy.mjs';

/** Two nouns spelled by splitting a string, for the reason src/scan/report.mjs gives:
 * the word `import` followed by a quote is what tools/verify.mjs counts as a dependency. */
const [IMPORTED, FILE] = 'imported file'.split(' ');

const folded = (text, indent = '  ') => `${indent}${wrap(text, WIDTH - (indent.length - 4), indent)}`;

/** The terminal this report is written for. WIDTH is the folding width inside a four-space
 * indent, so the whole line is four wider. */
const COLUMNS = WIDTH + 4;

/** What a package's presence looks like, one phrase per signal the policy watches. Kept as
 * plain-and-styled pairs because the styled text has bytes in it that are not columns, and
 * the packer below has to measure. */
function presence(row, s) {
  const parts = [];
  const part = (plain, text) => parts.push({ plain, text });
  if (row.signals.includes(SIGNAL.DECLARED)) {
    const dev = row.dev ? ' (dev)' : '';
    part(`declared ${row.range ?? '?'}${dev}`,
      `${s.yellow('declared')} ${row.range ?? '?'}${row.dev ? s.dim(dev) : ''}`);
  }
  if (row.signals.includes(SIGNAL.INSTALLED)) {
    const versions = row.versions.length > 0 ? row.versions.join(', ') : '?';
    part(`installed ${versions}`, `${s.yellow('installed')} ${versions}`);
  }
  if (row.signals.includes(SIGNAL.IMPORTED)) {
    const where = `${plural(row.sites, 'site')} in ${plural(row.files, FILE)}`;
    part(`${IMPORTED} ${where}`, `${s.red(IMPORTED)} ${where}`);
  }
  return parts;
}

/**
 * The phrases, packed into as few lines as fit beside the name column.
 *
 * Two installed versions and a long package name is enough to push a row past 80 columns,
 * and a table left to wrap at the terminal's mercy is harder to read than one that wraps
 * where it chose to.
 */
function packed(parts, room, s) {
  const lines = [];
  let line = null;
  for (const part of parts) {
    if (line === null) line = part;
    else if (line.plain.length + 2 + part.plain.length <= room) {
      line = { plain: `${line.plain}  ${part.plain}`, text: `${line.text}${s.dim('  ')}${part.text}` };
    } else {
      lines.push(line);
      line = part;
    }
  }
  if (line !== null) lines.push(line);
  return lines;
}

/** A package's name and its presence: one line if it fits, and the gutter if it does not. */
function rowOf(row, s, width) {
  const gutter = `  ${' '.repeat(width)}  `;
  const packs = packed(presence(row, s), COLUMNS - gutter.length, s);
  // A name too long for the column takes a line of its own. Padding to fit it would move
  // every other row's column; letting it overhang would push its own presence off the edge.
  if (row.name.length > width) return [`  ${s.bold(row.name)}`, ...packs.map((one) => `${gutter}${one.text}`)];
  if (packs.length === 0) return [`  ${s.bold(pad(row.name, width))}`];
  return packs.map((one, index) => (index === 0
    ? `  ${s.bold(pad(row.name, width))}  ${one.text}`
    : `${gutter}${one.text}`));
}

/** A note under a row, folded to the terminal and painted after it has been measured: the
 * style hooks add bytes that are not columns, so measuring styled text folds it early. */
function note(plain, gutter, paint) {
  return wrap(plain, COLUMNS - gutter.length, '').split('\n').map((line) => `${gutter}${paint(line)}`);
}

/** The signals a policy is not watching, said out loud rather than quietly dropped. */
function alsoSeen(row) {
  const ignored = row.seen.filter((one) => !row.signals.includes(one));
  if (ignored.length === 0) return null;
  return `also ${ignored.join(' and ')}, which this policy does not watch`;
}

/** What to do about it: the rule decides whether a machine may, and which command it is.
 * Two segments rather than one sentence, so a wide name column packs them onto two lines
 * instead of running off the side of the terminal. */
function remedyLines(row, s, gutter) {
  if (!row.replaceable) {
    return note('denied by this policy, and not a package nirdep replaces', gutter, s.dim);
  }
  const how = row.action === ACTION.REWRITE
    ? { label: 'rewrite it: ', command: 'nirdep plan .' }
    : { label: 'by hand: ', command: `nirdep explain ${row.name}` };
  return packed([
    { plain: `-> ${row.target}`, text: `${s.dim('->')} ${row.target}` },
    { plain: `${how.label}${how.command}`, text: `${s.dim(how.label)}${s.cyan(how.command)}` },
  ], COLUMNS - gutter.length, s).map((one) => `${gutter}${one.text}`);
}

/** Where the policy came from, including the part flags overrode. Folded rather than allowed
 * to run off the terminal: this is the line somebody reads when they want to argue with the
 * result, and a line that has scrolled sideways cannot be argued with. */
function policyLines(found, s) {
  const { policy } = found;
  const where = found.source === SOURCE.FILE || found.source === SOURCE.MANIFEST
    ? found.path
    : 'the default policy';
  const bits = [
    `${plural(policy.deny.length, 'package')} denied`,
    policy.signals.length === 3 ? 'all three signals' : `${policy.signals.join(' and ')} only`,
    policy.dev ? 'development included' : 'runtime only',
  ];
  if (policy.max !== null) bits.push(`at most ${plural(policy.max, 'direct dependency', 'direct dependencies')}`);
  if (policy.allow.size > 0) bits.push(`${policy.allow.size} allowed`);
  if (found.overridden.length > 0) bits.push(`${found.overridden.join(' and ')} from the command line`);
  const head = found.source === SOURCE.FILE && !found.written
    ? `${where} has no guard section, so the default applies:`
    : `${where}:`;

  const indent = ' '.repeat(10);
  return wrap(`${head} ${bits.join(', ')}`, COLUMNS - indent.length, '').split('\n')
    .map((line, index) => (index === 0
      ? `${s.dim('policy')}    ${where}${s.dim(line.slice(where.length))}`
      : `${indent}${s.dim(line)}`));
}

/**
 * @param {object} result the result of guardProject
 * @param {{ style?: object }} [options]
 */
export function guardReport(result, options = {}) {
  const s = styleOf(options.style);
  const found = result.policy;

  if (!result.ran) {
    const lines = [`${s.red('guard cannot run:')} ${plural(found.problems.length, 'problem')} in the policy`];
    for (const problem of found.problems) lines.push(`  ${s.yellow('-')} ${problem}`);
    lines.push('');
    lines.push(folded('A policy that cannot be read is worse than none: it would pass a build for '
      + 'the wrong reason. Fix it, or remove it -- with no policy at all the default denies '
      + 'every package this tool can replace.'));
    return `${lines.join('\n')}\n`;
  }

  const rows = [...result.breaches, ...result.exempt];
  // Capped, because a column as wide as the longest name somebody ever denied would indent
  // every other row past the point of being readable.
  const width = Math.min(24, Math.max(12, ...rows.map((one) => one.name.length)));
  const lines = [];

  if (result.breaches.length > 0) {
    lines.push(s.bold(`${plural(result.breaches.length, 'package')} came back`));
    for (const row of result.breaches) {
      lines.push(...rowOf(row, s, width));
      const gutter = `  ${' '.repeat(width)}  `;
      if (row.first !== null) lines.push(`${gutter}${s.dim('first at')} ${row.first.path}:${row.first.line}`);
      const also = alsoSeen(row);
      if (also !== null) lines.push(...note(also, gutter, s.dim));
      lines.push(...remedyLines(row, s, gutter));
    }
  } else {
    lines.push(s.bold('nothing came back'));
    // The count has to exclude the allowed rows or the line contradicts the block printed
    // directly under it, which lists a package that is very much still there.
    const clear = result.counts.guarded - result.counts.exempt;
    lines.push(`  ${s.dim(`none of the ${result.counts.exempt > 0 ? 'other ' : ''}`
      + `${plural(clear, 'watched package')} is declared, installed or imported`)}`);
  }

  // A narrowed policy sees a package and says nothing about it, which is the right
  // behaviour and the wrong thing to leave silent: the next person to read a green build
  // should know the packages were there and that this policy chose not to mind.
  const unwatched = result.quiet.filter((one) => one.seen.length > 0);
  if (unwatched.length > 0) {
    // Under a breach list the rows are already indented two spaces, so without this the
    // line reads as another note about the last package rather than about the project.
    if (result.breaches.length > 0) lines.push('');
    lines.push(...note(`${plural(unwatched.length, 'other')} present but not watched here: `
      + `${unwatched.map((one) => one.name).join(', ')}`, '  ', s.dim));
  }

  if (result.exempt.length > 0) {
    lines.push('');
    lines.push(s.bold('allowed by policy'));
    for (const row of result.exempt) {
      lines.push(...rowOf(row, s, width));
      // A reason is a sentence somebody wrote, so it is the one field here with no length a
      // reader can predict. Folded, it stays in its column instead of moving the table.
      lines.push(...note(row.reason ?? 'no reason recorded', `  ${' '.repeat(width)}  `, s.dim));
    }
  }

  if (result.max.limit !== null) {
    lines.push('');
    const over = result.max.over;
    lines.push(`${over ? s.red('over the cap:') : s.dim('under the cap:')} `
      + `${plural(result.max.direct, 'direct dependency', 'direct dependencies')}`
      + s.dim(`, and the policy allows ${result.max.limit}`));
  }

  lines.push('');
  lines.push(...policyLines(found, s));
  lines.push(`${s.dim('read')}      ${result.lock.understood
    ? `${result.lock.kind} lockfile, ${plural(result.source.counts.scanned, 'source file')} scanned`
    : `${s.yellow('no usable lockfile')}, so only package.json and `
      + `${plural(result.source.counts.scanned, 'source file')}`}`);
  if (!result.lock.understood && result.lock.note !== null) {
    lines.push(folded(`Installed-but-undeclared packages cannot be seen from here: ${result.lock.note}.`, '          '));
  }

  lines.push('');
  const failed = result.counts.breached > 0 || result.max.over;
  lines.push(failed
    ? `${s.red('FAIL')}: ${result.counts.breached > 0
      ? `${result.counts.breached} of ${plural(result.counts.guarded, 'watched package')} present`
      : `${result.max.direct} direct dependencies, over the cap of ${result.max.limit}`}.`
    : `${s.green('PASS')}: ${plural(result.counts.guarded, 'package')} watched, `
      + `${result.counts.exempt > 0 ? `${result.counts.exempt} allowed by name, ` : ''}nothing to report.`);
  return `${lines.join('\n')}\n`;
}
