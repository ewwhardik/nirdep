# STDLIB.md — where the standard library was enough, and where it stopped

Published by Nastik AI. Developed by Hardik.

This is the log the Zero Dependency Hackathon asks for: a running note of what
we reached for in `node:*`, what it gave us, and what it would not give us.
It is written to be read by someone deciding whether to delete a dependency of
their own, so the interesting entries are the ones where the answer was *no*.

`nirdep stdlibmd` will regenerate the machine-checkable half of this file from the
source tree so the two cannot drift. Until that command lands, this file is
maintained by hand and dated.

Last updated by hand: 29 August 2026, against Node v22.23.2. 136 tests passing.

## The rules I held myself to

No third-party source was copied into `src/`. Where a reference package's
**published test corpus** is used as conformance data, the file says so at the
top and the borrowing is listed under *Borrowed test data* below. Test vectors
are facts about a format; implementation is the work being judged.

No separately installed tool is invoked at runtime. nirdep never shells out to
`npm`, `git`, `pnpm` or `yarn` — spawning an installed binary is a dependency
with extra steps. Reading a file those tools left behind (`package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`) is a different act, and nirdep does that, treats a
missing lockfile as an ordinary case, and never assumes one exists.

## Where the standard library did the whole job

**`node:zlib` — gzip.** `gzipSync` with `level: Z_BEST_COMPRESSION` and a fixed
input produces fixed bytes. Node writes zero into the gzip header's MTIME field
by default, which is the one thing that would otherwise have broken
reproducibility for us for free. Verified by hashing two runs. No dependency
needed; nothing missing.

**`node:crypto` — hashing.** `createHash('sha256')` for artifact digests. The
`sha256` string is the whole API surface we wanted.

**`node:module` — `builtinModules`, and why we stopped using it.** This is the
load-bearing primitive of the zero-dependency proof: rather than keeping a
hand-written list of Node's builtins, which rots between releases and would let a
typo pass as a builtin, we ask the running Node which modules it ships.

The first version built a `Set` from `builtinModules.flatMap(n => [n, 'node:' + n])`
and it was wrong in three ways at once, which is worth writing down because the
mistake is easy and the failure is silent in the dangerous direction.

`builtinModules` deliberately **omits prefix-only modules**. `node:test` is not
in it. Neither is `node:sqlite`. So the proof failed on its own test files, which
was the loud version of the bug and the reason we found it. It also omits
**subpaths**: `node:assert/strict` and `node:fs/promises` are not members, so
they were only accepted by accident of the `node:` expansion. And the expansion
itself was wrong in the *permissive* direction: pairing every name with a bare
form accepts `import x from 'test'`, which does not resolve to `node:test` at all
— it resolves to a package called `test` on npm. A proof of absence that accepts
a real package name is not a proof.

`module.isBuiltin(specifier)` answers all three correctly, because it is the same
question the resolver itself asks: it returns true for `node:test`,
`node:test/reporters`, `node:sqlite` and `node:assert/strict`, and false for bare
`test` and `sqlite`. `src/audit/imports.mjs` now delegates to it, with a test
pinning each of those cases so the array-based version cannot come back.

**`node:test` and `node:assert/strict`.** The hackathon allows a dev-only test
dependency for languages with no built-in test framework. Node has one, so we
took no exception: 136 tests as of this writing, run by `node --test`. One of
them, `tests/repo/hygiene.test.mjs`, tests the repository rather than the code —
no raw control bytes, newline endings, no trailing whitespace, valid JSON, the
attribution present where it is claimed to be, no import outside `node:`, and no
import between the two runtime modules. Several comments in `src/` promise a
property of the source itself, and a promise in a comment is worth nothing
without a test underneath it.

**`node:fs` — traversal.** `readdirSync(dir, { withFileTypes: true })` plus an
explicit `.sort()` at every level. The sort is not cosmetic; without it, archive
member order follows filesystem iteration order and the reproducible build claim
quietly becomes false on a different machine.

## Where the standard library stopped, and what I wrote instead

**tar. Nothing in Node writes archives.** `node:zlib` compresses a byte stream
and has no concept of members, names or modes, so `tools/build.mjs` contains a
ustar writer: 512-byte headers, octal fields, the checksum computed with the
checksum field itself filled with spaces and then written back as six octal
digits followed by NUL and a space. Every varying field is pinned — `mtime`,
`uid` and `gid` to zero, `uname` and `gname` to empty, mode to 0644 or 0755.
Roughly 90 lines. GNU tar reads it and reports `0/0` ownership with
`1970-01-01` timestamps, which is the evidence that this is a real archive and
not a format only we can open. This is the honest version of the Reproducible
Build bonus: not "we set a flag", but "we own every byte that could have varied".

**TOML. Node ships no TOML parser.** `.zero-dep.toml` is the hackathon's own
submission metadata format, and reading it with a regular expression would have
been the sort of shortcut this event exists to argue against. `src/meta/toml.mjs`
is a hand-written reader of roughly 290 lines: basic and literal strings,
multi-line forms including the three-to-five closing quote rule, escape
sequences with `\uXXXX` and `\UXXXXXXXX`, line-continuation backslashes,
integers with underscores and 0x/0o/0b bases, floats with `inf` and `nan`,
booleans, bare and quoted and dotted keys, arrays, inline tables, tables and
arrays of tables, comments, and a tolerated byte-order mark.

It is a **subset** reader and says so in its own header comment. It is not
toml-test complete. The specific gap: **dates and times are refused, not
guessed.** A value that looks like `1979-05-27T07:32:00Z` throws a `TomlError`
carrying the exact line and column instead of being parsed as something
plausible. That was a deliberate call — a parser that silently mangles a
timestamp is worse than one that admits it does not handle timestamps, and no
part of the metadata format we actually read needs them. There is a test that
asserts the refusal, so if the gap ever closes the test will be the thing that
tells us.

**Argument parsing beyond flags.** `util.parseArgs` is intentionally minimal:
strings and booleans, one flat result object, no subcommands, no coercion, no
counts, no arrays, no numbers, no choices, no environment fallback, no positional
declarations, no generated help, no "did you mean". Node core has declined all of
that on purpose and says so in its own documentation. That declined surface is
exactly the space `minimist`, `commander`, `yargs` and `yargs-parser` occupy —
roughly 190 million downloads a week between them — and it is why
`src/runtime/args.mjs` exists: about 980 lines, zero imports, split into a parser
layer (`parse`) and a framework layer (`createCli`) because the packages split the
same way.

Four decisions in it are arguable, so they are argued here rather than left in the
code for someone to discover.

*No automatic number coercion.* minimist inspects every value and converts
anything numeric-looking, so `--id 0123` arrives as `123` and `--version 1.10` as
`1.1`. Zero-padded identifiers, version strings and hashes all travel through
argument parsers, and a parser that reinterprets them is a bug factory. Here a
type must be declared, and the number grammar is a plain decimal literal only:
`0x10`, `1_000`, `NaN` and `Infinity` are refused rather than guessed at.

*Prototype pollution is closed by absence, not by a patch.* Both of minimist's
advisories — CVE-2020-7598 and CVE-2021-44906 — come from one feature, dot
notation: `--a.b=1` becoming `{ a: { b: 1 } }`, and therefore
`--__proto__.polluted=yes` becoming an assignment onto `Object.prototype`.
Nesting a command line is a job for a config file, so the feature is not
implemented, which means the attack has nowhere to arrive. Belt and braces on top
of that: `__proto__`, `prototype` and `constructor` are refused as spec keys with
a `SpecError`, and refused again at the assignment site, so a future refactor that
lets a raw name through throws instead of assigning. Five attack strings are in
the suite and each one asserts against `Object.prototype` itself.

*A repeat is last-wins unless the option asks for a list.* minimist turns the
second `--tag` into an array, so the *type* of a field depends on how many times
the user pressed the up arrow, and every consumer needs `Array.isArray`. Here
`multiple: true` says the field is a list from the first occurrence, and without
it the last value wins.

*A value-taking option refuses to swallow the next flag.* `--output --verbose`
sets the output to the string `"--verbose"` in both minimist and
`util.parseArgs`. That is never what was meant, so it is a `MISSING_VALUE` error.
A negative number is still a value, because `-5` is not option-shaped:
the test is `/^-(?!\d|\.\d|$)/`, which also leaves a bare `-` as a positional.

Everything else is the surface those four packages are actually installed for:
short clustering with getopt's rules (`-fo out.txt`, `-foout.txt`, `-o=value`),
counts (`-vvv`), `--no-` negation that a literally-named `--no-cache` option
beats, `--` termination, choices, conflicts, implications, required options,
declared and variadic positionals, environment-variable fallback that an explicit
flag always overrides, generated help measured in visible columns rather than
bytes, and did-you-mean on both options and commands. Exit codes are fixed and
documented: 0 success, 1 our fault, 2 the user's, 3 not implemented yet.

Two details worth stating. Suggestions use optimal string alignment rather than
plain Levenshtein, because the commonest typo of all is a transposition: `sacn`
for `scan` is one keystroke wrong, and plain Levenshtein scores it 2 — the same as
`plan`, which is a different command. Counting a swap as one edit is what makes
the suggestion land on the right word. And help rendering takes a plain `style`
object of functions that all default to the identity, so this module has no
opinion about colour and does not import the module that does: `runtime/args` and
`runtime/colour` can be ejected independently, and a test asserts that neither
imports the other.

The error type carries a stable `code` (`UNKNOWN_OPTION`, `MISSING_VALUE`,
`INVALID_VALUE`, `INVALID_CHOICE`, `MISSING_REQUIRED`, `CONFLICT`,
`MISSING_POSITIONAL`, `UNEXPECTED_POSITIONAL`, `UNEXPECTED_VALUE`) and a
deliberately unstable message; a bad *spec* throws `SpecError` instead, because
that is our mistake and must never be reported to the user as if they had
mistyped something. 94 parser cases live as data in
`tests/vectors/args/parse.json`, with 27 of them naming the code they must throw.

**Colour beyond one call.** `util.styleText(['red', 'bold'], s)` covers a single
styled write at 16 colours. There is no chainable builder, no 256-colour or
24-bit support, no hex or RGB conversion, and no capability detection — nothing
that reads `NO_COLOR`, `FORCE_COLOR`, `TERM`, `CI` or TTY state to decide a
level. So `src/runtime/colour.mjs` exists: about 560 lines replacing chalk,
ansi-styles, supports-color, color-convert, picocolors, kleur, colorette and
strip-ansi, roughly 320 million downloads a week between them.

Four things had to be built rather than borrowed:

*The close codes.* ECMA-48 has no "close bold". SGR 22 closes **both** bold and
dim, so a naive implementation that emits SGR 0 to end a bold clears everything
else the caller had open. 23 closes italic, 24 underline, 55 overline, 39 any
foreground, 49 any background — and a bright foreground still closes with 39, not
99. `tests/runtime/colour.test.mjs` asserts these as literal numbers, against
ECMA-48 rather than against our own table, because a table that agrees with
itself proves nothing.

*Downsampling.* `hex('#ff8800')` must emit `38;2;255;136;0` on a truecolour
terminal, `38;5;214` on a 256-colour one and `93` on sixteen. The 256-colour
palette is 16 system colours, then a 6×6×6 cube at 16-231, then a 24-step grey
ramp at 232-255. Greys must take the ramp: routed through the cube diagonal, a
grey gradient bands into six steps. There is a test that walks a five-stop grey
ramp and fails if any stop lands below 232. The 16-colour path is deliberately
routed *through* 256 so the two downsample paths cannot disagree.

*Nesting repair.* `red('a' + green('b') + 'c')` naively produces a `c` with no
colour, because the inner green closed with 39 and 39 means "default", not "what
my parent had". The fix is to rewrite each ancestor's close code into that
ancestor's open code, walking innermost-first so an inner close doubles as an
outer reopen. Separately, a background must be closed before every `\n` and
reopened after it (CRLF included), or it paints to the right-hand edge of every
wrapped line. Both behaviours are in the vector table.

*Detection.* The precedence is `FORCE_COLOR` → `NO_COLOR` → `TERM=dumb` →
TTY-or-known-CI → `COLORTERM`/`TERM_PROGRAM`/`TERM` patterns, and it is written
down here because every one of those rules is a judgement call someone will
disagree with. Two worth stating: `FORCE_COLOR` beats `NO_COLOR` on the grounds
that it is the more specific instruction; and an *empty* `FORCE_COLOR` means
colour while an empty `NO_COLOR` means nothing, which is what the ecosystem
already does. 33 rows of matrix in `tests/runtime/level.test.mjs`.

`util.stripVTControlCharacters` does exist and is genuinely all of `strip-ansi`,
so `strip()` delegates to it and `node:util` is the module's only import. That is
also what the CLI's own test uses to compare styled output against plain output,
so the comparison is made with someone else's stripper and not with ours.

The level scale matches chalk's numbering (0 none, 1 sixteen, 2 palette, 3
truecolour) so that code migrating off chalk and comparing `level` against a
number keeps meaning the same thing. `createColour()` returns an **independent**
instance: with a shared singleton, a library setting `level = 0` silences the
application that imported it.

`bin/nirdep.mjs` styles itself through this module. That is the point of building
it first — the replacement for supports-color decides what the replacement for
chalk emits, in the shipped binary, and `tests/cli/entry.test.mjs` asserts both
halves: a pipe produces not one escape byte, and `FORCE_COLOR=3` produces
sequences that close correctly.

**Version comparison.** Node has none. `process.versions` gives you strings and
comparing them lexically is wrong at the first two-digit minor. No range
grammar, no prerelease precedence, no `satisfies`. `runtime/semver.mjs` is 1760
lines and exports 43 names — 38 functions, the error class and four constants —
matching the reference package name for name, because a codemod that rewrites an
import must not also rewrite the call sites underneath it.

*No regular expressions.* Not one, anywhere in the module — every scanner is a
loop over character codes. The reason is CVE-2022-25883: node-semver's range
parser backtracked, so any call site that passed a user-supplied range string
could be hung by it, and the fix shipped as a patch release that many lockfiles
never took. A hand-written scanner reads each character once and cannot
backtrack, so the whole class of bug is absent rather than patched. The claim is
asserted, not asserted-in-prose: `tests/runtime/semver.test.mjs` strips the
comments and fails if a single `/` survives.

*Parity over taste.* Where the reference package is strange, this module is
strange in the same way. `inc('1.2.3', 'nonsense')` returns `null` rather than
throwing, because the two failures — bad version, bad release name — really do
deserve different answers and a rewritten call site that tested for `null` must
keep getting `null`. `SemverError extends TypeError` for the same reason: an
existing `catch (e) { if (e instanceof TypeError) ... }` keeps firing. Every
throw carries a stable `code`. A parsed version is frozen plain data with a
non-enumerable `toString`, so `${version}` still prints `1.2.3` while
`Object.keys` and `JSON.stringify` see only data.

*How it was checked.* A differential harness called `semver@7.8.5` as a black
box — called, never read, and from a directory outside this repository so the
verifier never sees it — across 55 versions, 118 ranges, 4 option sets, 10
release types and 28 coercion inputs, on every exported function. **507,316
checks; 507,244 agree; 72 disagree.** Every one of the 72 was then re-checked
against that package's own `satisfies`, and in every case it contradicts itself:
56 are `intersects` cells where its own `satisfies` finds no version in both
ranges, and 16 are `subset` cells where its own `satisfies` finds nothing in the
sub-range that falls outside the containing range. Two further disagreements are
crashes rather than answers — `cmp(v, '===', null)` and `satisfies(1.2, '*')`
throw a `TypeError` from inside the reference implementation, while a predicate
here answers `false`.

The sharpest of the 72: **`intersects` is not symmetric there.**
`intersects('1.2.3-beta', '*')` is `false` and `intersects('*', '1.2.3-beta')` is
`true`, for the same pair. Ours is `false` both ways, which is what its own
`satisfies` says — a bare range admits no prerelease, so the only version in
`1.2.3-beta` is not in `*`. There is a test that checks symmetry over the whole
118×118 grid.

The six cells where the reference contradicts itself are marked
`exceptSubset` / `exceptIntersects` in `tests/vectors/semver/relations.json` and
asserted by name in the test file instead, so the table never quietly records an
answer we believe is wrong.

**A JavaScript reader. Node parses JavaScript and will not tell you about it.**
This is the gap that decided the shape of the whole project. `node:vm` will
compile a string and throw if it is not valid, which is a yes-or-no answer;
`import()` will run a module. Neither hands back a tree, a token list or a byte
offset. There is no `node:parser`, and the packages that fill the gap —
`acorn`, `espree`, `@babel/parser`, `recast`, `jscodeshift` — are exactly the
dependencies a tool arguing against dependencies cannot take.

So `src/lex/lexer.mjs` is a hand-written scanner of roughly 700 lines, and it is
deliberately **not a parser**. It produces tokens with byte ranges and never
prints code back out, because a printer is where codemods lose formatting,
comments and blank lines. Everything downstream edits the original bytes by
range. The two problems that cannot be solved without context are solved with a
stack rather than a tree: a `/` is a division or a regexp depending on what came
before it, and a `)` or `}` only says which by remembering what it closed; a `}`
closes a block, an object literal or a template substitution, and the three
behave differently. The whitelist that decides block-or-object is biased towards
"block" on purpose — reading `if (x) {} /re/.test(y)` as a division would
misread every byte after it.

The property that makes it safe to build a patcher on: `accountsForEverySource`
checks that the token ranges reassemble the file byte for byte, whitespace and
comments included. It runs over every `.mjs` file in this repository on every
test run, and `nirdep apply` calls it as a precondition — a file whose tokens do
not add up is refused rather than patched. A truncated file reports the contexts
it left open instead of guessing, for the same reason: if the brace stack is
wrong at the end it may have been wrong in the middle.

`src/lex/bindings.mjs` is the layer above it, and the one that decides whether a
rewrite is allowed. It builds a scope tree from brace pairing — no syntax tree —
so that it can answer which names a dependency introduced, which later mentions
are really references to them, and whether a name the codemod wants to introduce
is already taken. Property accesses, object keys, class members, labels,
accessor modifiers and clause words are all excluded, and a `var` hoists to its
function while a `let` does not leave its block, so a rename touches the sites
that mean the binding and no others.

It is **not a complete binding resolver**, and the limits are listed at the foot
of that file rather than left to be discovered: a function expression's own name
is declared one scope too wide, a concise arrow body ends at the first delimiter
at the arrow's depth, `with` is treated as an ordinary block, and a computed
specifier — a template, a variable, `createRequire` — is recorded as
unanalysable and never rewritten. Every limit is biased the same way: the
analysis records less than the truth, so the codemod declines. A declined
rewrite is a line in a report; a wrong one is somebody's broken build.

Two checks are worth more than the rest. Every specifier the analyser reports
must also be found by the blunt scanner in `src/audit/imports.mjs`, so the
grammar-aware layer is provably a subset of the one the dependency proof uses —
if they ever disagreed about what a dependency is, the proof would stop being a
proof. And every unresolved name across all 25 `.mjs` files in this repository
must be a real global: `JSON`, `Object`, `process`, `Math` and friends, nothing
else. A local name that leaked into that list would be a reference resolved to
nothing, which is precisely the failure that breaks a build after a rename.

## Borrowed test data

`tests/vectors/semver/` — six tables, 1266 lines. The input columns were chosen
by hand, one input per rule that has a wrong answer. The **expectation columns
were filled in by calling `semver@7.8.5` as a black box**, and that needs saying
plainly: a range grammar is not specified anywhere, so the only available
definition of "correct" is what npm resolves. No line of that package's source
was read or copied, and no line of its test suite was copied either; the vectors
are captured output, and the six cells where its output contradicts its own
`satisfies` were not captured but overridden and argued in the test. The package
lives in an unrelated project's `node_modules`; the harness that calls it lives
outside this repository and ships with nothing.

The 75 colour vectors in `tests/vectors/colour/` were written by hand from
ECMA-48 and the close-code conventions chalk established, not copied from chalk's
test suite and not captured from our own output. Vectors are data; the
implementations under test are ours.

The lexer and binding tables in `tests/vectors/lex/` were written by hand too —
49 token cases and 41 binding cases, each carrying a `why` that says which
ambiguity it is about. Nothing was captured from a parser package, and no
parser's test suite was read. They live in JSON rather than inline in the test
files for a reason worth stating: many of the cases are import statements, and
`tools/verify.mjs` scans `.mjs` files for exactly that shape. A fixture that
looked like a real dependency would have made the dependency proof lie about this
repository, and weakening the proof to accommodate a fixture was not an option.

## Things I expected to need and did not

`node:util`'s `stripVTControlCharacters` removed the need for a `strip-ansi`
replacement entirely — one of the three modules I had originally scoped turned
out to be a single existing function, which is the best possible outcome for a
project whose thesis is that you probably do not need the package.
