// The same result, said in the one dialect GitHub reads.
//
// A build log is where a failure goes to be ignored. An annotation is the same sentence
// attached to the line of code it is about, in the diff, next to the person who wrote it --
// which is the difference between a check somebody silences and a check somebody fixes.
//
// This is a translation and nothing more: every line here comes from a field guardProject
// already filled in, so there is no second opinion to keep in step with the first. Anything
// GitHub cannot show gets left to the report on stdout rather than approximated here.

import { plural } from '../text/format.mjs';
import { ADVISORY } from './policy.mjs';

/** GitHub's own limit is ten annotations per level per step; the eleventh is dropped without
 * saying so, which is worse than a line admitting there were more. */
const LIMIT = 10;

/**
 * Message escaping, per GitHub's workflow-command grammar. A message with a newline in it
 * ends the command early and prints the rest as build output, so this is not cosmetic.
 */
const message = (text) => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** Property values need two more, because `,` ends a property and `:` ends the property list. */
const property = (text) => message(text).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** `::error file=src/a.mjs,line=3,title=nirdep::text`, with the location left off when there
 * is nothing honest to put in it: a wrong line number sends a reader to the wrong line. */
function command(level, title, text, place) {
  const bits = [];
  if (place !== null && place !== undefined) {
    bits.push(`file=${property(place.path)}`);
    if (place.line !== null && place.line !== undefined) bits.push(`line=${place.line}`);
  }
  bits.push(`title=${property(title)}`);
  return `::${level} ${bits.join(',')}::${message(text)}`;
}

/** What to do about a package, in one clause, or nothing if there is nothing to offer. */
function remedy(row) {
  if (!row.replaceable) return null;
  return `nirdep replaces it with ${row.target}`;
}

/** One annotation per alarming version. These are errors: a release published to do harm is
 * not a style preference, and the policy had to opt out of the check to see it as one. */
function alarms(result) {
  // A version comes from the lockfile, so that is the file to attach it to. The path inside
  // node_modules the scan recorded is not a file in the repository and pointing at it would
  // put the annotation nowhere.
  const place = result.lock.file === null ? null : { path: result.lock.file, line: null };
  return result.advisories.alarms.map((row) => {
    const subject = row.version === null ? row.package : `${row.package}@${row.version}`;
    const parts = [`${subject}: ${row.what}`];
    if (row.fixed !== null) parts.push(`Fixed in ${row.fixed}.`);
    else parts.push('No release fixes this one.');
    const way = remedy(row);
    if (way !== null) parts.push(`${way}.`);
    if (row.allowed) parts.push('Your allow list covers the package, not a release published to do harm.');
    return {
      level: 'error',
      title: `nirdep: ${row.id ?? subject}`,
      text: parts.join(' '),
      place,
    };
  });
}

/** One per breached package, at the first import site if there is one: a warning with a line
 * number is a warning somebody can act on from the diff. */
function breaches(result) {
  return result.breaches.map((row) => {
    const parts = [`${row.name} is denied by this policy and it is ${row.signals.join(', ')}.`];
    const way = remedy(row);
    if (way !== null) parts.push(`${way} -- run nirdep plan . to see the change.`);
    return { level: 'error', title: `nirdep: ${row.name}`, text: parts.join(' '), place: row.first };
  });
}

/** The cap, which is about the project rather than any one file, so it has no location. */
function cap(result) {
  if (!result.max.over) return [];
  return [{
    level: 'error',
    title: 'nirdep: dependency cap',
    text: `${plural(result.max.direct, 'direct dependency', 'direct dependencies')}, `
      + `and the policy allows ${result.max.limit}.`,
    place: null,
  }];
}

/** A policy that could not be read is not a passing build and not a failing one: it is a check
 * that did not happen, and the annotation says which line of the file to look at as far as the
 * parser got. */
function unreadable(result) {
  return result.policy.problems.map((problem) => ({
    level: 'error',
    title: 'nirdep: policy',
    text: problem,
    place: result.policy.path === null ? null : { path: result.policy.path, line: null },
  }));
}

/**
 * The notices worth printing on a green build: what was watched, and what the advisory pass
 * did not cover. A PASS that says nothing is read as an audit, and this tool has never
 * claimed to be one.
 */
function notices(result) {
  const out = [];
  if (result.advisories.waived.length > 0) {
    out.push({
      level: 'notice',
      title: 'nirdep: allowed by name',
      text: `${plural(result.advisories.waived.length, 'advisory', 'advisories')} matched a package your `
        + 'allow list names, so they did not fail this build.',
      place: null,
    });
  }
  if (result.advisories.level === ADVISORY.OFF || result.advisories.coverage === null) {
    out.push({
      level: 'notice',
      title: 'nirdep: advisories',
      text: result.advisories.coverage === null
        ? 'No advisory pass ran, so no version in this lockfile was checked against the table.'
        : 'This policy says advisories: off, so no version in this lockfile was checked.',
      place: null,
    });
  }
  return out;
}

/**
 * Every annotation this result earns, in the order a reader wants them.
 *
 * @param {object} result the result of guardProject
 * @returns {Array<{level: string, title: string, text: string, place: object|null}>}
 */
export function annotations(result) {
  if (!result.ran) return unreadable(result);
  return [...alarms(result), ...breaches(result), ...cap(result), ...notices(result)];
}

/**
 * The annotations as workflow commands, capped per level the way GitHub caps them.
 *
 * The cap is applied here rather than left to GitHub because GitHub applies it silently. Ten
 * errors and no eleventh reads as ten problems; nine errors and a line saying twelve were
 * found reads as what happened.
 *
 * @param {object} result
 * @param {{ limit?: number }} [options]
 * @returns {string} the commands, newline-terminated, or '' when there are none
 */
export function annotate(result, options = {}) {
  const limit = options.limit ?? LIMIT;
  const lines = [];
  const levels = new Map();
  for (const one of annotations(result)) {
    const seen = levels.get(one.level) ?? [];
    seen.push(one);
    levels.set(one.level, seen);
  }
  for (const [level, all] of levels) {
    const room = all.length > limit ? limit - 1 : limit;
    for (const one of all.slice(0, room)) lines.push(command(level, one.title, one.text, one.place));
    if (all.length > room) {
      lines.push(command(level, 'nirdep', `${all.length - room} more ${level}${all.length - room === 1 ? '' : 's'} `
        + 'are in the run log: GitHub shows ten per level and this step had more.', null));
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
