// The frame around the demo: what it prints, and more importantly what it refuses to claim.
//
// The stages themselves are somebody else's output, so there is little to assert about them
// beyond "it was passed through unchanged". The interesting part of this file is the closing
// count, which is the one place in the project where a tempting lie is available: four
// advisories in that lockfile, four advisories "fixed". One of them is against a package
// nirdep declined to touch, and it is still in there. These tests hold the wording apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  demoExitCode, demoHeader, demoStage, demoSummary,
} from '../../src/demo/report.mjs';
import { DEMO, DEMO_STAGES, runDemo } from '../../src/demo/script.mjs';
import { GLOSSARY, guideFor, NEXT_STEPS } from '../../src/demo/guide.mjs';

// One real run, shared: the reports are pure functions of it, and planting the fixture five
// times to assert five things about the same numbers would only make the suite slower.
const ROOT = mkdtempSync(join(tmpdir(), 'nirdep-report-'));
const RESULT = await runDemo({ root: ROOT, diff: false });
rmSync(ROOT, { recursive: true, force: true });

/** The same result with a different advisory list, to reach each branch of the attribution. */
const withAdvisories = (names) => ({
  ...RESULT,
  scanned: { ...RESULT.scanned, advisories: { ...RESULT.scanned.advisories, hits: names.map((one) => ({ package: one })) } },
});

// Every paragraph in these reports is folded to 76 columns, so a sentence a test looks for is
// usually broken across two lines by the time it is printed. Matching against the folded form
// would only be asserting where the wrap landed, which is not the claim.
const flat = (text) => text.split(/\s+/).join(' ');

/** The summary as one line, which is the form worth making claims about. */
const summary = (result, options = {}) => flat(demoSummary(result, options));

test('the header says where it wrote, how many stages, and that it stays there', () => {
  const text = demoHeader({ root: '/tmp/somewhere', total: DEMO_STAGES.length });
  assert.match(text, /nirdep demo/);
  assert.ok(text.includes(DEMO.name), 'the project has a name');
  assert.ok(text.includes('/tmp/somewhere'), 'and the reader is told where it landed');
  assert.match(text, /stages\s+7/);
  assert.match(text, /nothing outside that directory is read or written/);
});

test('the header teaches nothing until asked: --guide is opt-in, the page is the guide', () => {
  const plain = demoHeader({ root: '/tmp/x', total: 7 });
  assert.equal(/reading/.test(plain), false, 'no commentary by default');
  assert.equal(/--keep/.test(plain), false);
  const guided = demoHeader({ root: '/tmp/x', total: 7, guide: true });
  assert.match(guided, /reading/);
  assert.match(guided, /--keep/, 'and the guide is where the flags are explained');
  assert.ok(guided.length > plain.length);
});

test('a stage prints its heading, its command, and the output flush left and unedited', () => {
  const one = RESULT.stages.find((stage) => stage.name === 'scan');
  const text = demoStage(one, { index: 3, total: 7 });
  assert.match(text, /3\/7/);
  assert.ok(text.includes(one.title));
  assert.ok(text.includes(`$ ${one.command}`), 'the command reads as something you typed');
  assert.ok(text.includes(one.text), 'the body is passed through, not re-indented');
});

test('a stage with --guide adds what, why and every term it names, and nothing without it', () => {
  const one = RESULT.stages.find((stage) => stage.name === 'plan');
  const guide = guideFor('plan');
  const plain = flat(demoStage(one, { index: 4, total: 7 }));
  const guided = flat(demoStage(one, { index: 4, total: 7, guide: true }));
  const head = guide.what.split(' ').slice(0, 4).join(' ');
  assert.equal(plain.includes(head), false, 'the terminal gets steps');
  assert.ok(guided.includes(head), 'and --guide gets the mechanics');
  assert.match(guided, /what/);
  assert.match(guided, /why/);
  for (const term of guide.terms) {
    assert.ok(guided.includes(term), `${term} is labelled`);
    assert.ok(guided.includes(GLOSSARY[term].split(' ').slice(0, 5).join(' ')), `${term} is defined`);
  }
});

test('a failed stage is marked as failed, not merely coloured differently', () => {
  // Both marks are style hooks, so the difference is only visible through the style seam --
  // which is exactly how a reader with NO_COLOR set sees it, and why it is worth asserting.
  const one = { name: 'after', title: 'The same files, running', command: 'node', text: 'x', ok: false };
  const style = { red: (text) => `RED(${text})`, bold: (text) => `BOLD(${text})` };
  assert.match(demoStage(one, { index: 7, total: 7, style }), /RED\(The same files, running\)/);
  assert.match(demoStage({ ...one, ok: true }, { index: 7, total: 7, style }), /BOLD\(The same files/);
});

test('the summary counts what moved and names what it would not touch', () => {
  const text = summary(RESULT);
  assert.match(text, /files? rewritten/);
  assert.match(text, /imports? moved/);
  assert.match(text, /modules? vendored/);
  assert.match(text, /packages? declined/);
  for (const name of RESULT.modules) assert.ok(text.includes(name), `${name} is listed as vendored`);
  for (const one of RESULT.plan.declined) {
    if (one.specifier) assert.ok(text.includes(one.specifier), `${one.specifier} is named as by-hand work`);
  }
  assert.match(text, /Still yours/, 'and the manifest is still the reader s job');
});

test('the six next commands print whether or not the guide was asked for', () => {
  for (const guide of [false, true]) {
    const text = summary(RESULT, { guide });
    for (const one of NEXT_STEPS) assert.ok(text.includes(one.command), `${one.command} is printed`);
  }
  // Only the paragraph reasoning about them is commentary.
  assert.equal(/the first two are free/.test(summary(RESULT)), false);
  assert.match(summary(RESULT, { guide: true }), /the first two are free/);
});

test('an advisory against a rewritten package is cleared, and says why that is not a patch', () => {
  const text = summary(withAdvisories(['chalk']));
  assert.match(text, /against a package the rewrite removed/);
  assert.match(text, /not patched, not waived/);
  assert.equal(/stays, against/.test(text), false, 'there is nothing left to stay');
});

test('an advisory against a declined package stays, and is named', () => {
  const text = summary(withAdvisories(['minimist']));
  assert.match(text, /1 advisory stays, against minimist/);
  assert.match(text, /does not pretend to have handled/);
  assert.equal(/the rewrite removed/.test(text), false, 'and nothing is claimed to be cleared');
});

test('a mixed lockfile is reported as a mix, which is the whole point of the wording', () => {
  const text = summary(withAdvisories(['chalk', 'chalk', 'minimist']));
  assert.match(text, /2 advisories in that lockfile were against a package the rewrite removed/);
  assert.match(text, /1 advisory stays, against minimist/);
});

test('a clean lockfile gets no advisory paragraph at all', () => {
  const text = summary(withAdvisories([]));
  assert.equal(/advisor/.test(text), false, 'silence beats a sentence saying zero');
  assert.match(text, /Still yours/, 'the rest of the summary is unaffected');
});

test('the last line tells the truth about the directory either way', () => {
  const kept = summary(RESULT, { tree: '/tmp/here', kept: true });
  assert.match(kept, /the demo project is at \/tmp\/here/);
  assert.match(kept, /cd into it/);
  const gone = summary(RESULT, { tree: '/tmp/here', kept: false });
  assert.match(gone, /has been removed/);
  assert.match(gone, /--keep leaves it/);
  assert.equal(/\/tmp\/here/.test(summary(RESULT)), false, 'and says nothing if not told');
});

test('the exit code follows the run, because a demo that lies is worse than no demo', () => {
  assert.equal(demoExitCode(RESULT), 0);
  assert.equal(demoExitCode({ ...RESULT, ok: false }), 1);
});
