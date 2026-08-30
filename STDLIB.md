# STDLIB.md — where the standard library was enough, and where it stopped

Published by Nastik AI. Developed by Hardik.

This is the log the Zero Dependency Hackathon asks for: a running note of what
we reached for in `node:*`, what it gave us, and what it would not give us.
It is written to be read by someone deciding whether to delete a dependency of
their own, so the interesting entries are the ones where the answer was *no*.

`nirdep stdlibmd .` generates the machine-checkable half of a document like this
one — the claim, the tables, the per-module sections — from package.json, the
lockfile and the imports, so those parts cannot drift from the code. `make
stdlibmd` prints what it says about this repository. It is a separate file on
purpose: the command refuses to overwrite a document that says something else,
and the paragraphs below are the half no generator can write.

Last updated by hand: 30 August 2026, against Node v22.23.2. 499 tests passing.

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

**Glob matching.** Node 22 added `fs.globSync`, which walks a disk. It does not
answer the question every tool actually asks first — *does this string match this
pattern* — and it has no brace expansion options, no `partial`, no reusable
compiled matcher. `runtime/glob.mjs` is 1149 lines and exports 17 names, matching
`minimatch@10.2.6` name for name and covering the matching half of `glob`.
Together those two are a transitive dependency of most of the registry, which is
the reason this module exists rather than a third replacement for something
fashionable.

*No regular expressions, again.* This is the same story as semver, told twice,
which is what turns a lucky fix into a policy. minimatch's ReDoS —
CVE-2022-3517 — was its own compiled pattern backtracking on an adversarial
brace body, in the package node-semver depends on. Both are answered here the
same way: two nested state-set simulations, one over path segments and one over
the characters of a segment, so the work is bounded by positions times tokens and
there is nothing to backtrack. Same proof as semver, too — the test strips the
comments and fails if one `/` survives, and there is nothing left in the file
that could put one there: the separator itself is a character code and nothing
divides.

*Bounded means enforced.* Three ceilings, because unbounded work refused late is
still unbounded work: 65536 pattern characters (`TOO_LONG`), 8192 brace
expansions (`TOO_MANY_EXPANSIONS`), 16 levels of brace or extglob nesting
(`TOO_DEEP`). A pattern that merely *looks* wrong is not an error — an
unterminated `[` is literal text, exactly as it is in a shell — so the only thing
refused is cost. `makeRe()` exists and throws `NO_REGEXP` naming
`matcher(pattern)` as the replacement: a rewritten call site that wanted a
`RegExp` should fail at the call, not hours later with `undefined is not a
function`.

*How it was checked.* The same shape of harness as semver, calling
`minimatch@10.2.6` as a black box from outside this repository: **222,495
matching checks and 6,357 surface checks; 697 disagree.** Every one of the 697
has a recorded cause, and the causes are pinned by count so a new disagreement
cannot arrive quietly — it lands in `unknown`, and `unknown` is asserted empty.
**576** are `[[:print:]]`, which compiles there to the same thing as
`[[:cntrl:]]`, the inverse of what POSIX says. **91** are non-ASCII characters in
a POSIX class: ours are ASCII tables plus case mapping, so `中` is not
`[[:alpha:]]` — a stated limit rather than a bug, and the only one worth knowing
before adopting this module. **18** are `partial`, where theirs descends into
directories that cannot match. **12** are brace expansion: their expander
reserves backslash as an internal sentinel, so `{A..z}` loses ASCII 92 and then
matches the empty path. Ours keeps all 58 characters of that span.

*And it is used here.* A pattern layer built on a package we tell other people to
delete would be a joke, so `src/fs/walk.mjs` compiles this module's `matcher()`
for both of its filters. `ignore` stays a Set of bare names — one hash lookup per
entry, right for the five names every project has — while `exclude` and `include`
are patterns matched against the root-relative path, which is the only way to say
"not `tests/fixtures`" without also losing `src/fixtures`. Pruning follows
`globSync`'s rule: a directory that matches an exclude is never opened, and a
directory is only entered when some include could still match inside it, which is
`partial: true` doing real work in the shipped tool. Sorting is untouched by
either, so `make repro` still compares byte for byte. One `selectFiles()` serves
`scan`, `plan`, `apply` and `stdlibmd`, because a file the codemod never read is
not a file the scan may report as rewritten. Pointed at itself: 84 files,
`--exclude 'tests/**'` 38, `--include 'src/runtime/**'` 4.

**Reaching into an object. Node has the answers and not the questions.**
`structuredClone`, `util.isDeepStrictEqual` and `Object.groupBy` cover three
lines of lodash and stop there. Nothing in Node reads `a.b[0].c` off an object or
writes one back, nothing merges two trees, nothing debounces, and
`structuredClone` throws on a function and silently drops a symbol key.
`runtime/collect.mjs` is 994 lines and exports the seventeen names people
actually reach for — `get set has unset toPath pick omit cloneDeep merge isEqual
groupBy keyBy uniqBy chunk sortBy debounce throttle` — plus `CollectError` and a
frozen default carrying all eighteen, which is the shape a default binding of
lodash expects, so a call site can be rewritten rather than rewritten *and*
rethought.

*The security story here is prototype pollution, and it is lodash's own.*
`CVE-2018-3721` was `_.merge`, `CVE-2020-8203` was `_.set` and `_.zipObjectDeep`,
`CVE-2019-10744` was `_.defaultsDeep`: four years of the same bug in the same
package, because a deep write that accepts `__proto__` writes to every object in
the program at once. The three-name blocklist — `__proto__`, `constructor`,
`prototype`, raised here as `ERR_UNSAFE_KEY` rather than ignored — is the obvious
half. The other half is what the blocklist cannot see: `_.set({},
'toString.polluted', 'yes')` names nothing forbidden, walks into the *inherited*
`Object.prototype.toString`, materialises it and writes there, after which an
unrelated `_.pick({}, 'toString')` hands the value straight back. So a deep write
in this module never follows a property the object does not own. Reproduced
against the package in `oracle/pollution.mjs`; the fix is four lines and the bug
was worth a CVE three times.

*Every write is a `Reflect` call, which is a portability fix rather than a
flourish.* lodash's dist runs sloppy: a write to a frozen slot or a delete of a
non-configurable key quietly did nothing there and **throws** in a module, so a
straight port would have turned silent no-ops into crashes at other people's call
sites. `Reflect.set` and `Reflect.deleteProperty` decline the impossible quietly
with a lodash-compatible return, while a genuinely dangerous operation still
throws. A complaint the object raises itself — `arr.length = {}` — is passed on,
because it is the object's answer and not ours. Swallowing that one turned three
divergences into eighty-seven.

*How it was checked, and the eleven that stand.* The semver harness again, and
the same disclosure: **lodash 4.18.1 called as a black box** from outside this
repository, **120,000 comparisons over 8000 seeded rounds**, every difference
pinned by cause and by count so a new one lands in `unknown` and `unknown` is
asserted empty. Eleven remain and each is a decision. Four are own-only walking
in `set`, `unset`, `pick` and `merge`. `cloneDeep(new Error(…))` clones the error;
lodash returns `{}`. `omit` copies own keys only — lodash copies inherited ones,
so `_.omit(Buffer.from('hi'), '0')` comes back with 95 keys, including
`Buffer.prototype.inspect`, and **throws when you try to log it**. `merge` into a
primitive returns the primitive rather than a boxed wrapper, keeps a typed array
typed, and merges symbol keys. Brackets quote their content, so `a[x.y]` is two
keys: lodash's path regex accepts only numbers and quoted strings inside brackets
and reads anything else as though the brackets were absent. `sortBy` ties two
`NaN`s, where lodash's comparator answers "greater" in both directions and so
leaves the order to the sort algorithm *and* skips the remaining criteria. Two
small buckets are lodash's own pollution damage answering later calls with
`TypeError: Cannot convert object to primitive value`. The one admitted *limit*,
not a repair: an object iteratee matches partially but not with lodash's full
partial-array semantics.

*And the same rule as glob applies.* `groupBy`, `keyBy` and `sortBy` walk any
iterable rather than only arrays and plain objects, because the tool needed to
group a `Set` and a module that cannot do what its own author needed is a module
nobody should adopt.

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
proof. And every unresolved name across all 41 `.mjs` files in this repository
must be a real global: `JSON`, `Object`, `process`, `Math` and friends, nothing
else. A local name that leaked into that list would be a reference resolved to
nothing, which is precisely the failure that breaks a build after a rename.

### Applying a rewrite: `src/patch/` — no stdlib answer, and three npm answers

Node has no diff. It has no patcher either. The packages that fill the gap are
`jscodeshift` and `recast` for the rewriting, `magic-string` for the splicing and
`diff` for the display, and between them they are the reason a codemod is usually
a heavier install than the code it edits.

`src/patch/edits.mjs` is the splicing, and it is the dullest module in the
project on purpose: it takes byte ranges and replacement text, applies them right
to left so no offset is ever stale, and knows nothing about JavaScript. Nothing
goes through a printer, which is the whole point — a printer hands back your file
with its blank lines rearranged and its comments moved, and then a two-line
change is a two-hundred-line diff nobody reads. Two refusals earn their keep.
Every edit must carry a reason, because `plan` prints reasons and an edit nobody
can explain has no business in a patch. And two edits that want the same bytes
are a bug in the caller rather than a merge to attempt: whichever one lost would
be dropped silently, which is how a rewrite half-happens.

`src/patch/diff.mjs` is Myers 1986, the greedy edit-graph walk git uses, in about
120 lines. Its shape suits the job: O((N+M)D) in the size of the edit script, and
a codemod changes a handful of lines in a large file, so D stays small and the
file's size barely matters. The matching head and tail are trimmed before the
search, D is capped, and past the cap the whole middle becomes one
delete-then-insert — a correct patch, just an unhelpful one to read, and it says
so with `truncated`. Lines carry their terminators through the comparison, which
is how `"a"` and `"a\n"` come out as a change instead of vanishing, and how
`\ No newline at end of file` lands in the right place.

Two checks stand behind it. The hunks are compared byte for byte against what GNU
`diff -u` prints for the same inputs, headers included. And on 320 seeded random
pairs, the edit script Myers finds is checked for length against an independent
shortest-edit-distance table written by dynamic programming in the test file — if
the clever algorithm ever finds a longer script than the boring one, the clever
one is wrong.

`src/patch/gate.mjs` is the part that stops a bad rewrite reaching the disk, and
it is where the standard library needed the most reading. A codemod that writes
broken JavaScript is worse than one that does nothing. So every patch is parsed
by Node's own parser before it is written — not by our lexer, which is
token-level and forgiving by design. Getting at that parser without a dependency
took three attempts, all measured on Node v22.23.2: `vm.Script` only knows script
grammar and rejects the word export outright; `vm.SourceTextModule` is
module-aware but locked unless the process was started with
`--experimental-vm-modules`, so the handle is tried and the failure treated as
"not available"; and what remains is `node --check --input-type=module` over
stdin. That last one is a subprocess, and it is worth being precise about why it
is allowed: it spawns `process.execPath`, the running interpreter, not a tool
somebody had to install. It costs about 19ms a file, against 0.025ms when the vm
door is open, and the lexer runs first as a free filter — a file it cannot
tokenise is broken already and needs no second opinion. When the fast path does
report a failure it carries no position at all, so that one case is handed to
`node --check` purely to find the line.

The gate checks both sides of a patch and reports **blame**. A file that did not
parse before we touched it is not evidence against the rewrite, and reporting it
as one sends the user hunting for a bug in the wrong place. Both sides are
checked even when the first fails, because a second 19ms is cheaper than a wrong
accusation. Every `.mjs` file in this repository goes through the gate on every
test run: the check that guards other people's code is held to the same standard
by our own.

### Deciding what may be rewritten: `src/rules/` — a judgement, not a table

The npm answer here is `jscodeshift`, and it is the wrong shape for the question.
A codemod framework will happily map one specifier onto another; what it will not
do is tell you that the mapping is a lie. The interesting content of this layer is
therefore not the rewriting. It is the refusing.

`src/rules/registry.mjs` splits the packages into two actions and only two.
A **rewrite** rule claims the replacement takes the same calls in the same shape,
so a machine may edit the file: `chalk`, `strip-ansi`, `semver`. An **advise** rule
says the shapes differ and a person has to look: `supports-color`, `ansi-styles`,
`minimist`, `commander`, `yargs`. The temptation is to file `minimist` as a rewrite
— `src/runtime/args.mjs` replaces it and the specifier swap is one line — and the
result would be green output and a broken program, because minimist returns a bag
of parsed values and `parse` wants a declared spec. The tool would have been more
impressive and less true. There are more advise rules than rewrite rules, and a
test fails if that ever stops being so.

A rewrite rule also has to answer for each of the three ways a binding can arrive.
`chalk` answers for the default binding and refuses the named one, because chalk's
named exports are a class and per-stream instances and this runtime has neither.
`strip-ansi` answers for the default binding by renaming it: one function in, one
named export out, aliased to whatever local name the file already uses. Each
refusal carries the sentence the report will print, and a test rejects any refusal
short enough to be a code word rather than an explanation.

The member lists are not written down. They are read off the runtime modules at
load — `Object.keys(colour.styles)` for the style names, the keys of semver's
default export for the range surface — so a rule cannot claim a member the module does not have, and a test checks the
correspondence in both directions so a newly implemented member cannot be quietly
left out of the rules either. semver's surface legitimately includes constants as
well as functions, `MAX_LENGTH` and `RELEASE_TYPES` among them, because call sites
read those.

`src/rules/rewrite.mjs` is where the binding analyser from `src/lex/` earns its
keep. For each import of a replaceable package it collects every member reached
through the local name — including through `?.`, through an assignment target, and
link by link along a chain like `chalk.bold.underline.bgRgb` — and checks each one
against the covered set. A name used as a value rather than as an object is refused
outright under `shape`, because no list of member names describes what a call site
does with the whole thing. Refusals come back as one of six codes, each with a
line number: `unreadable`, `unsafe` (the file calls `eval`, so nothing static about
a binding holds), `shape`, `member`, `form` (a `require` call, a bare side-effect
import, a re-export: forms where the names are not visible to check) and `advice`.

The rule that costs the most and matters the most is that a rewrite is all of a
statement or none of it. A statement whose default binding is fine and whose named
binding is not would end up pointing half its names at a module that lacks them,
so a declining binding takes the specifier edit down with it. Two tests hold the
line: one asserts a declined file's text is byte-identical afterwards, another
asserts a file that reports a refusal never also reports a change.

### Running it over a project: `src/apply/` — two passes, and blame

`src/apply/project.mjs` walks the tree, and the cheap parts are deliberate. Only
`.mjs`, `.cjs`, `.js` and `.jsx` are opened. Before the lexer sees a file, a
substring test asks whether any replaceable package name appears in it at all;
that filter over-accepts by design, so a package named in a comment costs one
lex and is then correctly left alone, and it never under-accepts. On this
repository it reads 21 of 41 files and rewrites none of them, which is the answer
you want from a tool whose whole claim is that it has no dependencies.

Writing happens in two passes because a half-migrated repository is worse than an
unmigrated one. Every patch is applied in memory and put through `src/patch/gate.mjs`
first; only when every gate has passed does a single byte reach the disk. If a
patch would not parse, the run halts having written nothing.

That is where blame does real work. A file that was already broken before the
codemod ran is not evidence against the rewrite, and treating it as such would
mean one unparseable file in a large repository could block the migration of every
other. So `blame: 'patch'` — we broke it — rejects and halts, while
`blame: 'source'` reports that file as `was broken`, skips it, and lets the rest
proceed. The distinction is tested from both directions, including with a
deliberately corrupted patch, which is the only way to prove the halt is real.

Without `--runtime`, imports are rewritten to the package subpath
`nirdep/runtime/colour`. With it, they are rewritten to a relative path into the
directory the runtime was ejected into, computed per file: `../nirdep/runtime/colour.mjs`
one level down, `../../nirdep/runtime/colour.mjs` two, `./colour.mjs` for a file
sitting beside it. That is the difference between a tool that assumes it will be
installed and one that can hand a project its own copy and leave.

`src/apply/report.mjs` prints. The diff carries `a/` and `b/` prefixes and real
hunk ranges, on stdout, so `nirdep plan | git apply` is a workflow rather than a
claim; a test asserts the header format for exactly that reason. Reasons are
folded at 76 columns rather than truncated, since a refusal you cannot finish
reading is a refusal you cannot act on. Exit codes say what happened: a project
with nothing to replace is a success, not a usage error, so it exits 0; a rejected
patch or an unreadable file exits 1; and a path that does not exist exits 2 with a
message naming it, because the walker swallows `ENOENT` at every level and a typo
would otherwise print the same spotless report as a clean repository.

### Reading a project: `src/scan/` — three readers, and their disagreements

`nirdep scan` answers one question — what would it cost to stop depending on
this? — from three sources that each know a different part of the answer.
`package.json` says what was promised. The lockfile says what actually arrives.
The project's own source says what is really used. Most of what the command
reports is a disagreement between them: a package imported but declared nowhere,
a package declared but imported nowhere and named in no script, a range that
promises less than the lock delivers.

The lockfile reader in `src/scan/lockfile.mjs` handles five formats with no
parser dependency, because three of them are JSON and Node parses JSON.
`package-lock.json` v1 nests, v2 and v3 key by install path, and both shapes are
reduced to the same record; `pnpm-lock.yaml` and yarn's two formats are read by a
small line-oriented scanner rather than a YAML parser, which is honest about its
own limits — it reads the two-space block structure those files actually use and
would not survive an arbitrary YAML document. Every entry ends up with the same
fifteen fields, so nothing downstream has to know which package manager it is
looking at. Reading a file that `npm` wrote is reading a file, not running a
package manager, and when no lockfile is committed the command says so and
reports the smaller set of things `package.json` alone can support.

The blast radius is the number the command exists to produce, and it is a
subtraction rather than a sum. For one direct dependency, `strandedBy` computes
everything reachable from all roots minus everything reachable from the roots
that remain. Summing per-package counts gets the interesting case wrong: two
packages that share a child each own nothing, and removing both takes three
packages out. The walk is iterative because peer-dependency cycles are ordinary
in real lockfiles, and a recursive version is a stack overflow waiting for a
user with a large project.

Source is read twice, in order of trust. `src/audit/imports.mjs` is a regex
scanner that over-accepts — it will find a specifier mentioned in a comment — and
it runs first because it is cheap, and a file it finds nothing in cannot contain
an import the lexer would find either. When it does find something, the real
lexer runs and its answer replaces the guess. A file the lexer refuses is named
in the report and its blunt answer is kept rather than dropped, tagged
`read: 'scanned'` so that nothing downstream can present it as a parsed result.

The report ends with a block headed *what this scan did not check*, and it is
printed even when nothing was found, because "nothing found" means very little
without "and here is what I could not have found". Four limits are stated there
and are worth repeating here. The vulnerability check is a curated table and not
the advisory database: `src/scan/advisories.mjs` holds 40 rows across 34 packages
— the ones nirdep offers to replace and the incidents that happened beside them —
so a clean `nirdep scan` is not a clean `npm audit`, and the report prints the
coverage figure, the date the table was last reviewed and how many names matched
right next to the claim. The dependency graph is keyed by package
name rather than by name and version, so a package installed at two versions is
one node, which makes every "would leave with it" count an **upper bound** — the
alternative needs each edge's resolved range, which two of the three lockfile
formats do not write down. Every number comes from the files as committed rather
than from `node_modules` as installed. And only the root `package.json` is read,
so a monorepo has to be scanned one package at a time; workspace roots declared
in npm's and pnpm's lockfiles are picked up, but a workspace member's own
dependency fields are not.

That table is the one place in this project where the standard library is not the
question — nothing in Node knows which releases were malicious — so the design
decisions are worth stating. It is a source file, dated, frozen, and offline by
construction; a test reads the module's own bytes and fails if `fetch`,
`node:http` or a URL appears in it, because "makes no network request" is a
property of the file rather than of a run. It holds two record kinds. A **flaw**
has a CVE, an affected range and a fix, and is matched with `runtime/semver` —
the module that replaces the package with the ReDoS is the module that decides
whether you are still exposed to it — with `includePrerelease`, because
`7.5.1-rc.1` is affected even if no resolver would have chosen it. An
**incident** has exact versions and deliberately no "fixed in": a malicious
release sits between two innocent ones, so there is no upper bound to be below,
only an artefact to not have. Its `hand` field records whether the hand was an
attacker's or the maintainer's own, which changes the advice rather than the
severity: no review of the version you approved can find what was in the version
you got.

There are four verdicts and not a boolean. `hit` and `clear` are the easy two.
`unversioned` means the table names the package but not the affected releases —
true of the September 2025 phishing wave, where the honest answer is a name match
and the finding says so in its own sentence rather than in a footnote. `unknown`
means the lockfile recorded a git URL, a path or a tag, so no comparison applies.
Inventing a version number would be worse than either gap. The single most
valuable test in `tests/scan/advisories.test.mjs` asserts that every row's own
`fixed` version does *not* satisfy that row's affected range: a range with a typo
in it reads perfectly and quietly tells somebody they are safe.

One field is less tidy than the rest and should be said out loud rather than
discovered: `source.packages[].forms` mixes the lexer's names for a statement
shape with the blunt scanner's names, for the files where the scanner had the
last word. The counts and the package names are unaffected; the form label is
descriptive only, and nothing reads it to make a decision.

Exit codes follow from what the command is for. A scan reports; it does not judge.
Findings do not fail, because a command that exits 1 on a deprecation notice gets
wrapped in `|| true` within a week and then never fails again — `guard` is the
command that fails, on rules a person chose. The one non-zero case is a file we
were asked to read and could not, which is a question about the report's own
completeness rather than about the project.

### Taking the runtime with you: `src/eject/` — a copy, and a reason to trust it

A codemod that swaps eight dependencies for one is a smaller number and the same
problem, so `nirdep eject` writes a runtime module into the target tree as a plain
file and `apply --runtime` points the rewritten imports at it. The standard
library supplies all of this — `readFileSync`, `writeFileSync`, `mkdirSync` with
`{ recursive: true }`, and `path` — and every one of them is injected rather than
imported at the call site, which is why the eject tests never touch a disk.

What the stdlib does not supply is the reason to trust the copy. Three rules
carry that. The module list is derived from this project's own `exports` map
rather than typed out, because a hand-written list disagrees with `package.json`
the first time somebody adds a module, and it disagrees by offering a subpath that
does not resolve. The output is deterministic — no timestamp, no username, no
"generated on" line — which is what makes the second run able to compare bytes and
say *up to date* instead of writing again. And the six-line banner at the top of
the file names where it came from, which version wrote it, and what it replaces,
because a reviewer finding nine hundred unfamiliar lines in a diff deserves a
first line that explains them. MIT asks for the notice; nothing asks for an
advertisement.

The refusals are the interesting part of the exit code. A destination that is
byte-identical is skipped, not failed, so re-running is free. A destination that
differs is somebody's edit, and it is refused with the suggestion to diff it —
clobbering an edit is how a tool loses the benefit of the doubt. A destination
that exists and cannot be read is refused even under `--force`, because a file we
cannot compare is not a file to overwrite on a hunch. All of those are exit 2
rather than 1: the user resolves them, with `--force` or by moving their file.
Exit 1 is reserved for a write that we attempted and lost. The directory is
created lazily, once, at the first real write, because a dry run that leaves an
empty directory behind has written to a tree it promised not to touch.

One limit, admitted rather than discovered: the banner carries the version, so a
version bump makes every previously ejected file *differ*. The report says exactly
that — already there, and not what this version writes — and leaves the choice
alone.

### Keeping it out: `src/guard/` — strict enough to fail on its own typos

`nirdep guard` is the CI half: it re-runs the scan and fails the build if a
package on the deny list has come back. The policy is JSON, read either from
`.nirdeprc.json` or from a `nirdep.guard` object inside `package.json`, and JSON
is where the standard library ends. There is no schema validator in `node:*`, so
`validatePolicy` is eighty lines of hand-written type checking that returns a list
of problems rather than throwing on the first one, because a config with three
mistakes in it should produce three lines and not one line three runs in a row.

That validator is strict on purpose, and the strictness is the design. An unknown
key is an error with a did-you-mean, not a shrug: a typo in a CI config that
silently disables the check is worse than no check at all, because the build stays
green and the dependency comes back anyway. An empty `signals` array is rejected,
since a guard watching for nothing passes on everything. A policy that cannot be
read at all exits 2 and refuses to scan — guarding against half a policy is the
same class of mistake as the typo that produced it. Exemptions may be written as
an array of names, but the object form takes a reason per package, and that is the
form the code argues for: an exemption with no reason beside it is the one that is
still there two years later and nobody remembers why.

Absent a policy file, the default denies every replaceable package, and the report
labels the source — `default`, `file`, `manifest` or `flags` — because no policy on
disk is not the same as no opinion, and a policy printed as "from .nirdeprc.json"
when a flag overrode half of it would be a lie with a receipt. Three signals stay
separate rather than collapsing into a boolean: declared but not installed,
installed but not declared (a phantom arriving through somebody else's tree), and
imported while being neither, are three different conversations.

What guard deliberately does not check is whether the replacement is being used. A
project can pass with none of nirdep in it, which is correct: the policy is about
what is absent, and "you must depend on us instead" is not a guard, it is a
lock-in. Two limits are stated in the output rather than here: `deny` has no
pattern matching, it is a sorted list of names; and when no lockfile was
understood, installed-but-undeclared packages cannot be seen from there at all,
which the report prints instead of quietly reporting nothing.

The fourth thing guard fails on is the one nobody chose. `scan` already crosses
the lockfile against the advisory table, so guard reads that record rather than
re-auditing: a scan handed over with no advisory pass in it reports "unchecked",
never "clean". The policy key is a ladder — `off`, `incidents`, `hits`, `all` —
so the footer prints one word and there is no third state to reason about, and it
defaults to `hits` because a version the table already names is a regression
whether or not anybody chose to install it. `true` and `false` are accepted as a
second spelling of the two ends, since nobody types `hits` the first time.

An allow list cannot waive an incident, and that asymmetry is the point of the
block. Naming a package is consent to it being *installed*; it is not consent to
the release of it that was published to steal wallet keys, and a tool that treats
those as the same sentence turns a two-year-old waiver into a hole. So an
exemption moves a flaw into an "allowed by name" block with its reason attached,
and leaves a malicious release exactly where it was, with a line saying why the
waiver did not reach it. Alarms print above the breach table for the same reason:
a wallet stealer under a table of chalk imports is a wallet stealer nobody read.

`--annotate` is the one output format in this project that is not ours, and
`src/guard/annotate.mjs` is a translation and nothing else — every field is one
the verdict already held. The escaping is the whole file: a newline inside a
workflow command ends it early and prints the rest of the sentence as build
output, so `%`, CR and LF are encoded in messages and `:` and `,` additionally in
property values. Findings attach to the line that imports the package, or to the
lockfile a version came from — never to a path inside `node_modules`, which is
not a file in the repository, and never to a guessed line, because a wrong line
number sends a reader somewhere worse than no line at all. GitHub shows ten
annotations per level and silently drops the rest, so nirdep prints nine and one
line saying how many are in the log.

`action.yml` is where this repository ends and somebody else's YAML begins. It is
a composite action with no install step, which is the argument: the thing it runs
is this repository's JavaScript under the Node the runner already has, and an
action that `npm install`s a dependency checker has added dependencies to the
build it is auditing. What it depends on, stated rather than assumed: the
runner's Node — checked for 22.17.0 with a sentence naming the version it found,
because a stack trace from inside `src/` is a worse first impression than a
requirement; `bash`, `cat` and `grep` from the runner image, which are the shell
the action is written in and not something the tool loads at runtime; and
`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` and `RUNNER_TEMP`, each with a fallback or
a guard. Inputs arrive as environment variables and are never interpolated into
`run:` — a package name is a string somebody else controls, and `run:` is a
shell.

### Answering for it: `src/explain/` — derived, except for one table

`nirdep explain chalk` prints what the standard library already gives you, what it
does not, and — for a package the codemod rewrites — which import forms will be
rewritten and which will be refused, with the refusal's reason. Almost all of it
is read off the rule registry and the runtime modules, because a hand-written
explanation is a second source of truth and the first time the two disagree the
tool is lying with confidence.

The exception is `src/explain/facts.mjs`, which is a table of Node APIs and the
versions that introduced them: `util.styleText` in 20.12.0, `util.stripVTControlCharacters`
in 16.11.0, `util.parseArgs` in 18.3.0. Those versions are in the document because a
reader on Node 18 needs to know that `styleText` is not going to be there. Nothing
in that file is derived from the code, so it is the one place in `src/` that can go
quietly out of date, and the mitigation is that `tests/explain/facts.test.mjs`
checks every API named there against the running Node rather than against the
table. The `semver` row has an empty "what it gives you" list, and that is not an
oversight — it is the argument for the file existing at all.

Whether a specifier is a builtin is answered by `isBuiltin` from `node:module`
rather than by a set built from `builtinModules`, and the difference matters:
`builtinModules` omits the prefix-only modules such as `node:test` and
`node:sqlite`, omits subpaths such as `node:assert/strict`, and pairing every name
with a `node:` form would wrongly accept bare `test`, which resolves to a package on
npm. A builtin gets a positive answer rather than an error — it is a perfectly
good answer, it just is not a rule — and only an unrecognised name exits 2, with a
suggestion. There is no exit 1 in this command: it reads nothing and writes
nothing.

### Proving it: `src/conformance/` — Node's test runner, read as TAP

`nirdep conformance` is the receipt for every runtime module, and it is the
one command that does not take a path: it reports on nirdep, not on your project.
Nothing in the table is declared. The module list comes from the rule registry, the
corpus comes from walking `tests/vectors/`, and a test file is attributed to a
module by scanning its own specifiers for `runtime/<name>.mjs` — because a
hand-typed conformance table is a claim about a number somebody wrote down once,
and it stays green after the cases are deleted.

The runner is `node --test --test-reporter=tap`, spawned through `process.execPath`,
one child per module so that a crash in one does not take the numbers of the others
with it. Spawning the interpreter is not spawning a tool: it is the same Node that
is already running, and there is deliberately no second executor in `src/`, because
two answers to "did the vectors pass" would drift and the one in `src/` would be the
one nobody runs. The standard library's gap here is the result: `node --test` emits
TAP text and no machine-readable object, so `parseTap` reads the trailing summary
lines with an anchored `^# <name> (\d+)$` rather than counting lines, since Node
prints one summary at column zero and indents everything a subtest says. The child
also has `NODE_TEST_CONTEXT` deleted from its environment — a child that inherits it
reports to its parent in V8-serialised frames instead of honouring the reporter, and
this command has to print the same page whether it was run from a shell or from
inside somebody else's suite.

There are three verdicts, not two. A module that never reached its own summary did
not fail a test, it failed to start, and it reports `null` counts rather than nought
failures, which would read as a pass. The same exit 2 covers the published-artifact
case: the vectors are not in the `files` list, because nobody wants fourteen hundred
test vectors in their `node_modules`, so an installed copy prints *NO VERDICT*, says
how many cases went unchecked, and tells the reader to clone the repository and run
`make conformance`. An artifact without the vectors in it must not print a pass it
did not earn.

### Writing this document: `src/stdlib/` — a generator that must not claim credit

`nirdep stdlibmd .` generates the derived half of a document like this one for
whatever project it is pointed at: the claim, the table of what left the manifest,
a section per runtime module, and a table of what stayed. It prints by default, so
it is safe to run on a repository you do not own, and `--write` follows the same
rules as `eject` — identical is *up to date*, different is *refused* at exit 2 with
`--force` offered, unreadable is refused even with `--force`. It is deterministic
for the same reason: this file is meant to be committed and read as a diff, so
nothing in the output can be dated, and a test asserts that no year, timezone or
Node version appears anywhere in it.

Every number is derived. The weekly download figures, the `codemod` versus *by hand*
column, the module-to-package mapping and the module list all come from the rule
registry and the `exports` map. What the generator will not write is the prose: each
heading that needs a sentence of judgement carries a TODO, the last TODO is to delete
the list of TODOs, and the receipt printed after a write says so, because a tool that
reported "done" about a write-up with five TODOs still in it would be the last thing
somebody read before publishing five TODOs.

The hard part is adoption, and it is hard because the document is generated *after*
the migration, when the package is gone and there is nothing left to scan for. At
that point an import is the only surviving evidence that anything happened, and
there are three ways to hold the replacement: as a package subpath
(`nirdep/runtime/colour`), as a copy somebody ejected, or as the tree the module
lives in. The copy is identified by the banner `eject` wrote and never by the file
name — half the JavaScript projects in the world have a `src/args.mjs` in them and
almost none of them got it from here — and only the first two hundred bytes of the
candidate are read, after the name has already got it that far. The third case is
decided by resolving the specifier against our own `exports` map, so the file is
never opened at all: the path is the evidence.

That third case exists because of a bug worth recording. Pointed at its own tree,
the generator said "declares 0 direct dependencies, and none of them is a package
nirdep replaces", and then, in the section on what was left, "every direct
dependency this project has is one nirdep replaces" — because an empty remainder is
true both of a project that replaced everything and of a project that never had
anything, and only one of those two may claim the credit. A generated document that
invents one claim is a document nobody should believe about the others, so the
no-dependencies case is now its own branch, it counts the replacements it can see in
the imports instead, and a test asserts that the false sentence is absent.

### Underneath all of them: `src/text/` and `src/fs/` — one answer each

Neither directory is a command. Twelve modules measure their output through
`src/text/format.mjs` and eight walk a tree through `src/fs/walk.mjs`, and both
files exist because the alternative was every command answering the same question
slightly differently.

**Folding text.** `node:util` gives colour (`styleText`) and gives the tool for
measuring a string that already has colour in it (`stripVTControlCharacters`), and
gives nothing at all for what every page here needs: fold this sentence at a width
and indent the continuations. So `WIDTH` is 76 and `COLUMNS` is 80, once, and a
paragraph is measured before it is painted — a styled string does not measure the
way it looks, so the fold sees plain text and the caller's style hooks go on line
by line afterwards. That is also why a report can be tested without an escape
sequence anywhere near it.

Two exports are there because English does not derive what a report needs. `plural`
counts a noun and `agree` conjugates a verb against a count it does not print,
because "1 dependencys" tells a reader exactly how much care went into the rest of
the table. `sizeOf` is the one that had already gone wrong: both commands that
write a file spelled the size phrase by hand with the numbers interpolated raw, so
a one-line file came back as "1 lines" — a grammar slip in the only sentence either
command makes about its own output. `columnWidth` is there for a crash instead:
`Math.max()` of nothing is `-Infinity`, `pad` turns that into a RangeError, and an
empty table is a perfectly ordinary thing to print.

**Walking a tree.** `fs.globSync` landed in Node 22 and would cover most of the
walk. What it does not cover is skipping `node_modules` and `.git` by name, and a
traversal order you can depend on. `ascending` is this project's only comparator and
it compares codepoints, never `localeCompare` — a build claiming byte-identical
output cannot have a sequence that depends on which machine ran it, and `make repro`
is the check that would catch it. `toPosix` is the same argument about reading: a
report that says `src\util.mjs` on one machine has told two stories about one file,
and only one of them matches a path anybody pastes back. The walk's `exclude`
patterns are compiled by `src/runtime/glob.mjs`, which is where that module came
from — we needed real pattern matching internally, and building it on the package we
tell other people to delete would have been a joke.

**Reading a file.** `src/fs/read.mjs` is three functions and closes two holes. One
is a test seam: every reader was spelling `options.read ?? readFileSync` out by
hand, which is a dozen chances for one command to take a reader nobody can
override. Every planted project in this suite is a Map and a closure rather than a
temporary directory, and that only works while there is one seam to plant into.

The other is that absence and unreadability are different answers. A missing file
is the ordinary case for `eject` and `stdlibmd`: write it. A file that is there and
throws is a file to leave alone, because a caller that overwrites on an error has
destroyed something it could not read. `present` returns the two separately, and
counts ENOTDIR and ENAMETOOLONG as missing alongside ENOENT — a path routed through
a file, and a name too long for the filesystem, both mean nothing is there. No
command in `src/` calls `existsSync`: it answers a question about the past, and the
answer that matters is the one the read itself gives.

**One duplication kept on purpose**, so a later pass does not tidy it away:
`src/runtime/colour.mjs` and `src/runtime/args.mjs` carry private copies of the
plain style set and of a wrap. They are published subpaths that `eject` vendors as
single files, and a shared import would leave a dangling path in somebody's tree.

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

The glob vectors in `tests/vectors/glob/` are the semver story again, and the
same disclosure applies. Five tables, 2035 cases: the input columns — 105 paths,
and the patterns crossed against them — were chosen by hand, one per rule that
has a wrong answer. **The expectation columns were filled in by calling
`minimatch@10.2.6` as a black box**, for the same reason: glob syntax has no
specification, and the only available definition of "correct" is what the package
the ecosystem already installed does. No line of its source was read and no line
of its test suite was copied. The 697 cells where its answer is one this project
declines to reproduce are marked `except` / `ours` in the tables and argued by
name and by count in `tests/runtime/glob.test.mjs`, so a borrowed expectation is
never silently overwritten with our own.

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

The scan vectors in `tests/vectors/scan/` are the same story and for the same
reason. `locks.json` holds seven lockfile texts — npm v1 and v3, yarn classic and
berry, pnpm 5 and 9, and one deliberately corrupt file — written by hand to carry
one awkward case each: a package with no integrity hash, a git install, a plain
HTTP tarball, a linked directory, an install script, a deprecation message that
wraps, and pnpm's peer-suffixed key `/react-dom/18.2.0_react@18.2.0`, which is
what caught a real bug in the key parser. `tree.json` holds three whole projects,
manifest and lockfile and source together, so the end-to-end numbers are asserted
against a tree somebody can read rather than against a snapshot. Nothing was
captured from a package manager's output and no package manager's test suite was
read. They live in JSON for the reason the lexer vectors do: a real specifier
inside a `.mjs` file would make `tools/verify.mjs` report this project as having a
dependency it does not have. The third of those projects, `unlucky`, pins three
malicious releases, a five-times-vulnerable lodash and a git-installed
`minimatch`, so all four advisory verdicts are exercised against a tree rather
than against a mock.

The advisory table in `src/scan/advisories.mjs` borrows no data and no code, and
that needs a sentence of its own because it is the one place in this project that
makes a claim about somebody else's package. Each row was written by hand from the
public record — the CVE identifier, the affected range, the fixed version, the
date and a plain description of what went wrong. Nothing was mirrored from an
advisory feed, no database was downloaded and no `npm audit` output was captured;
the identifiers are printed in the report precisely so a reader can go and check
each claim at a source that is not this repository. The versions were not taken
from a package's own metadata either, which is why the test suite re-derives the
one invariant that matters — every `fixed` must sit outside its own range — rather
than trusting the typing.

The 147 collect vectors in `tests/vectors/collect/` are the third telling of the
same story. Three tables — 43 path cases, 54 value cases, 50 write cases — with
the inputs chosen by hand, one per rule that has a wrong answer, and **the
expectation column filled in by calling `lodash 4.18.1` as a black box**, because
a path language and an assignment rule are specified nowhere except in the package
everybody installed. No line of its source was read and no line of its test suite
was copied. Where our answer is deliberately not theirs the row carries both, as
`out` and `ours`, plus a `why`, so a repaired prototype-pollution bug is never
filed as a passing test. Values JSON cannot hold — `NaN`, a `Map`, a cycle, a
`-0` — travel tagged, as `{"$":"nan"}` and the rest, and are decoded in the test
file rather than in the data. The harness that calls the package lives outside
this repository and ships with nothing; the package itself sits in an unrelated
project's `node_modules`.

The patch tests borrow nothing at all: the inputs are three-line files and seeded
random letters. Two oracles were used while writing them and both are stated
plainly. The golden hunks in `tests/patch/diff.test.mjs` were compared against
what GNU `diff -u` prints for the same inputs — a system tool run by hand during
development, not called by any test and not shipped with anything. And the
minimality check compares against a shortest-edit-distance table written from the
textbook in the test file itself, which is an oracle we wrote rather than one we
borrowed.

## Things I expected to need and did not

`node:util`'s `stripVTControlCharacters` removed the need for a `strip-ansi`
replacement entirely — one of the three modules I had originally scoped turned
out to be a single existing function, which is the best possible outcome for a
project whose thesis is that you probably do not need the package.
