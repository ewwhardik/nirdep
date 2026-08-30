// What `explain` is allowed to say.
//
// The risk in a command whose whole job is to be persuasive is that it becomes prose: a
// paragraph that was true when it was typed and stays on screen long after the rule under
// it changed. So these tests assert the relationship rather than the wording -- the member
// count is the module's member count, a refused import form is a form the rule really
// refuses, and every rule in the registry renders a complete page with nothing missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainPackage, explainReport, explainList, explainExitCode } from '../../src/explain/report.mjs';
import { ACTION, RULES, REPLACEABLE } from '../../src/rules/registry.mjs';
import { DEFAULT_RUNTIME_DIR } from '../../src/apply/project.mjs';

const answerFor = (name) => explainPackage(name);
const textFor = (name) => explainReport(answerFor(name));
const ruleFor = (name) => RULES.find((one) => one.package === name);

/** Prose is folded at 80 columns, so a sentence assertion has to read the sentence and not
 * the layout. The layout has its own tests, which match on `^` and `$`. */
const flat = (text) => text.replace(/\s+/g, ' ');

test('a name we replace comes back as a rule, with the Node facts attached', () => {
  const answer = answerFor('chalk');
  assert.equal(answer.kind, 'rule');
  assert.equal(answer.rule.package, 'chalk');
  assert.equal(answer.api.has.length > 0, true, 'colour builds on something');
  assert.equal(explainExitCode(answer), 0);
});

test('a deep specifier is answered for its package, not refused as a name', () => {
  // Somebody pasting a line out of their own source is the common case, and
  // "no such package: chalk/source" would be pedantry with a non-zero exit code.
  const answer = answerFor('chalk/source/index.js');
  assert.equal(answer.kind, 'rule');
  assert.equal(answer.name, 'chalk');
  assert.equal(answer.asked, 'chalk/source/index.js');
  assert.equal(answerFor('@scope/thing/deep').name, '@scope/thing', 'a scope is not a package');
});

test('a builtin is an answer rather than an error', () => {
  for (const name of ['fs', 'node:util', 'assert/strict']) {
    const answer = answerFor(name);
    assert.equal(answer.kind, 'builtin', `${name} is Node`);
    assert.equal(explainExitCode(answer), 0, 'nothing went wrong: the question just has a short answer');
    assert.match(explainReport(answer), /is part of Node/);
    assert.match(explainReport(answer), /nothing to replace and nothing to remove/);
  }
});

test('a name we do not replace is the user\'s to fix, with a suggestion where there is one', () => {
  const near = answerFor('chalkk');
  assert.equal(near.kind, 'unknown');
  assert.deepEqual([...near.near], ['chalk']);
  assert.equal(explainExitCode(near), 2);
  assert.match(explainReport(near), /did you mean chalk\?/);
  const far = answerFor('left-pad');
  assert.deepEqual([...far.near], [], 'no near miss, so no guess');
  assert.equal(explainReport(far).includes('did you mean'), false);
  assert.match(explainReport(far), new RegExp(`${REPLACEABLE.length} packages`));
});

test('an empty name is the list, not a failed lookup', () => {
  // The CLI routes a missing positional to explainList, so this is only about the resolver
  // not throwing on the way there.
  for (const name of ['', '   ', undefined, null]) {
    assert.equal(answerFor(name).kind, 'unknown', `${JSON.stringify(name)} resolves to nothing`);
  }
});

test('a rewrite page prints the accepted forms, and a reason for each refusal', () => {
  const text = textFor('chalk');
  const rule = ruleFor('chalk');
  assert.match(text, /^chalk {2}319\.8M downloads a week$/m);
  assert.match(text, /nirdep rewrites this one\. -> nirdep\/runtime\/colour/);
  assert.match(text, /^ {4}rewritten {2}a default import$/m);
  assert.match(text, /^ {4}refused {4}a namespace import$/m);
  assert.match(text, /^ {4}refused {4}a named import$/m);
  // Both reasons, quoted from the rule rather than retyped here.
  for (const reason of Object.values(rule.declines)) {
    assert.equal(flat(text).includes(flat(reason)), true, `the reason for refusing is printed: ${reason}`);
  }
  assert.match(flat(text), new RegExp(`${rule.members.size} members are known`), 'the count is the module\'s count');
  assert.match(flat(text), /a chain is checked link by link/, 'chalk is the chained one');
});

test('a default import that becomes a named one says which name', () => {
  const text = textFor('strip-ansi');
  assert.match(text, /rewritten {2}a default import -> the named export strip/);
  // One function, no surface: "0 members are known" is true and useless, so it is not said.
  assert.equal(text.includes('members are known'), false);
});

test('the row with no standard-library answer at all says nothing, in a sentence', () => {
  const text = textFor('semver');
  assert.match(text, /Nothing\. This is the row with no partial answer in it/);
  assert.match(text, /any version comparison at all/);
  assert.equal(text.includes('Node 2'), false, 'no version to quote, so no version is printed');
  assert.match(text, /rewritten {2}a namespace import/, 'the shapes match, so all three forms go');
});

test('an advise page gives the advice and does not offer a codemod', () => {
  const text = textFor('minimist');
  assert.match(text, /nirdep replaces this one by hand\. -> nirdep\/runtime\/args/);
  assert.match(text, /why this one is not rewritten/);
  assert.match(flat(text), /parse\(argv, spec\) covers it/);
  // The word appears in the heading "why this one is not rewritten"; the margin is what
  // matters, and there is no margin row on an advise page.
  assert.equal(/^ {4}rewritten/m.test(text), false, 'nothing here is rewritten');
  assert.match(text, /nirdep eject args/);
  assert.equal(text.includes('nirdep apply'), false, 'apply would find nothing to do, so it is not suggested');
});

test('the commands printed are the ones that exist, at the default directory', () => {
  const text = textFor('semver');
  assert.match(text, /^ {4}nirdep eject semver$/m, 'the module name, not the package name');
  assert.match(text, new RegExp(`^ {4}nirdep apply --runtime ${DEFAULT_RUNTIME_DIR} \\.$`, 'm'));
});

test('packages that share a file are named, and a lone one is not', () => {
  assert.match(flat(textFor('chalk')), /The same file replaces strip-ansi, supports-color, ansi-styles/);
  assert.match(flat(textFor('minimist')), /so those packages go in the same commit/);
  assert.equal(textFor('semver').includes('The same file replaces'), false, 'semver has the file to itself');
});

test('every rule renders a complete page inside 80 columns', () => {
  for (const rule of RULES) {
    const text = textFor(rule.package);
    assert.equal(text.includes('undefined'), false, `${rule.package} has no hole in it`);
    assert.equal(text.includes('[object Object]'), false, `${rule.package} prints no objects`);
    assert.equal(text.endsWith('\n'), true);
    assert.match(text, new RegExp(`^${rule.package} `), 'the answer starts with the question');
    assert.match(text, new RegExp(rule.target.replace('/', '\\/')), 'and names the replacement');
    assert.match(text, rule.action === ACTION.REWRITE ? /what the codemod will do/ : /why this one is not rewritten/);
    for (const line of text.split('\n')) {
      assert.ok(line.length <= 80, `${rule.package}: ${line.length} columns: ${line}`);
    }
  }
});

test('the list is the whole claim, one line each, and folds', () => {
  const text = explainList();
  assert.match(text, /^what nirdep replaces\n/);
  for (const rule of RULES) {
    const verb = rule.action === ACTION.REWRITE ? 'rewrite' : 'by hand';
    assert.match(text, new RegExp(`^ {2}${verb} +${rule.package} +${rule.weekly}/week +${rule.target.replace(/\//g, '\\/')}$`, 'm'));
  }
  for (const line of text.split('\n')) assert.ok(line.length <= 80, `${line.length} columns: ${line}`);
});

test('the styling is a hook, so the plain text is the same text', () => {
  // Not a cosmetic check: the report folds paragraphs by counting characters, and a style
  // that added bytes before the fold would push lines past 80 columns on a real terminal.
  const loud = { bold: (t) => `<${t}>`, dim: (t) => `(${t})`, cyan: (t) => t, green: (t) => t, yellow: (t) => t, red: (t) => t };
  const styled = explainReport(answerFor('chalk'), { style: loud });
  assert.match(styled, /^<chalk> {2}\(319\.8M downloads a week\)$/m);
  assert.equal(styled.split('\n').length, textFor('chalk').split('\n').length, 'same lines, different paint');
});
