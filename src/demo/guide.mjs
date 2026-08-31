// The commentary that turns the demo into an onboarding guide: what each stage is, why it
// is there, and what the reader would type next in a project of their own.
//
// The browser playground is the main reader of this file -- its popups and glossary are
// built from these strings at build time by tools/playground.mjs. The terminal walkthrough
// takes the same words behind `--guide`, because a transcript you cannot scroll back into
// is a bad place to learn what a codemod is, and because prose kept in two places drifts
// within a week.
//
// Every sentence here has to survive a reader who has never seen a codemod. Nothing is
// promised that the stage below it does not do.

/** Terms a reader may not have met, each in one sentence, no cross-references. */
export const GLOSSARY = Object.freeze({
  codemod: 'A program that edits source code instead of text: it reads the syntax, so it '
    + 'knows an import from a word in a comment that happens to say import.',
  specifier: 'The quoted name at the end of a dependency line -- chalk, ./util.mjs, node:fs. '
    + 'A bare one names a package; one starting with . or / names a file in your own tree.',
  'blast radius': 'How much of node_modules leaves with a package: itself, plus everything '
    + 'installed only because of it.',
  advisory: 'A published report that a specific range of versions of a package is unsafe. '
    + 'A CVE identifier is the usual name for one.',
  'syntax gate': 'The check that runs between a rewrite and a write: the new text is parsed '
    + 'before it is saved, so a file that would not load is never written.',
  eject: 'Copying a runtime module into your own tree as a plain file, so the replacement '
    + 'is code you own rather than another dependency.',
  vendored: 'A dependency kept as a file in your repository instead of installed from a '
    + 'registry. It cannot change under you, and it cannot be unpublished.',
  conformance: "A differential test: the replacement and the package it replaces are asked "
    + 'the same question, and every answer is compared.',
});

/**
 * The stages, annotated. `what` is the mechanics, `why` is the argument, `next` is the
 * command a reader would run at this point in their own project.
 */
export const GUIDE = Object.freeze([
  Object.freeze({
    stage: 'plant',
    what: 'A small project is written to a temporary directory: six dependencies declared '
      + 'in package.json, a lockfile that says which versions were installed, and four '
      + 'source files that import them.',
    why: 'Every other command reports on a tree you already have. This one brings its own, '
      + 'so nothing below is a claim you have to take on trust.',
    next: 'nothing -- your project is the fixture',
    terms: Object.freeze(['vendored']),
  }),
  Object.freeze({
    stage: 'before',
    what: 'The entry file is imported, and Node refuses: the packages are declared but not '
      + 'installed, and there is no node_modules here.',
    why: 'This is the "before" the demo is measured against. The same file runs at the end, '
      + 'and nothing is installed in between.',
    next: 'rm -rf node_modules && node your-entry.mjs, if you want to see it yourself',
    terms: Object.freeze([]),
  }),
  Object.freeze({
    stage: 'scan',
    what: 'The manifest, the lockfile and the source are read separately, then crossed: '
      + 'which packages are declared, which are installed, which the code actually imports, '
      + 'which nirdep can replace, and which are named in a published advisory.',
    why: 'A migration you cannot cost is a migration nobody signs off. This is the estimate, '
      + 'and it ends with the things it did not check.',
    next: 'nirdep scan .',
    terms: Object.freeze(['blast radius', 'advisory']),
  }),
  Object.freeze({
    stage: 'plan',
    what: 'The rewrite as a unified diff, plus a list of what it will not touch. Each '
      + 'refusal names the file, the line and the reason.',
    why: 'A codemod that cannot say no is a codemod you have to review by hand anyway. Two '
      + 'of the six packages here are declined on purpose, with the difference spelt out.',
    next: 'nirdep plan --runtime vendor/nirdep .',
    terms: Object.freeze(['codemod', 'specifier']),
  }),
  Object.freeze({
    stage: 'eject',
    what: 'The replacement modules are copied into the project as ordinary files, each with '
      + 'a banner saying where it came from and what it replaces.',
    why: 'Replacing a dependency with a dependency is a trade, not a fix. After this the '
      + 'project has no runtime dependencies at all, including on nirdep.',
    next: 'nirdep eject --into vendor/nirdep',
    terms: Object.freeze(['eject', 'vendored']),
  }),
  Object.freeze({
    stage: 'apply',
    what: 'The imports are rewritten to point at those files. Each new version is parsed '
      + 'before it is written, and if any file fails, nothing is written at all.',
    why: 'A half-migrated tree is worse than the one you started with, so the run is all or '
      + 'nothing.',
    next: 'nirdep apply --runtime vendor/nirdep .',
    terms: Object.freeze(['syntax gate']),
  }),
  Object.freeze({
    stage: 'after',
    what: 'The rewritten modules are imported for real and their exports are called. The '
      + 'answers are compared with what the fixture said they should be.',
    why: 'A green report is not a working project. This is the same file that could not load '
      + 'four stages ago, running, on the standard library.',
    next: 'your own test suite, which is the only conformance that matters to you',
    terms: Object.freeze(['conformance']),
  }),
]);

/** The guide entry for a stage, or null for a stage nobody wrote one for. */
export const guideFor = (stage) => GUIDE.find((one) => one.stage === stage) ?? null;

/** What to do after the demo, in a project that is not the demo's. The reasons are kept
 * short because the longest command here is 38 columns wide, and a table that wraps is a
 * table nobody reads twice. */
export const NEXT_STEPS = Object.freeze([
  Object.freeze({ command: 'nirdep scan .', why: 'what is replaceable, and the cost' }),
  Object.freeze({ command: 'nirdep explain chalk', why: 'why a machine may touch it' }),
  Object.freeze({ command: 'nirdep eject --into vendor/nirdep', why: 'the replacements, as your files' }),
  Object.freeze({ command: 'nirdep plan --runtime vendor/nirdep .', why: 'the diff, before anything moves' }),
  Object.freeze({ command: 'nirdep apply --runtime vendor/nirdep .', why: 'and now it moves' }),
  Object.freeze({ command: 'nirdep guard .', why: 'fail CI if any of them comes back' }),
]);
