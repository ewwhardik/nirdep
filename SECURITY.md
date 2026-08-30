# SECURITY.md — four bugs, told once each

The advisory table nirdep ships has 40 rows across 34 packages, last read against its sources
on 2026-08-30. As news that is forty incidents. As engineering it is **four bugs**, each of
which was answered with a version bump where a design change was needed, and each of which
came back.

This document walks the four. For every one it says what broke, who it happened to, and what
this project does instead — structurally, so the class cannot recur, rather than a range that
is safe until the next variant.

Two things to hold on to while reading. Everything here is **offline**: the table is data in
`src/scan/advisories.mjs` with a review date on it, and no run of nirdep contacts a registry.
And it is **not `npm audit`**: it covers the eleven packages nirdep replaces plus the
incidents that happened in the same street. Thirteen of the forty rows land on a package this
tool can replace. The rest are there because they are the same story with a different name on
it, and a tool that says "delete chalk" should be able to say what happened to the people who
did not.

## 1. A pattern compiled to a backtracking engine

| date | id | package | what broke |
| --- | --- | --- | --- |
| 2021-09-17 | CVE-2021-3807 | ansi-regex | the pattern that recognises an escape sequence, hung by a string of them |
| 2022-10-17 | CVE-2022-3517 | minimatch | brace expansion compiled to a pattern that backtracked on a crafted body |
| 2021-06-03 | CVE-2020-28469 | glob-parent | splitting a glob at its first magic character, on repeated separators |
| 2023-06-21 | CVE-2022-25883 | semver | the range parser, on any user-supplied range |
| 2024-05-13 | CVE-2024-4068 | braces | nested braces with no ceiling: gone before a match is attempted |
| 2024-05-14 | CVE-2024-4067 | micromatch | the matcher above braces, same shape of input |
| 2021-02-15 | CVE-2020-28500 | lodash | `trim`, `trimEnd` and `toNumber`, on a long run of whitespace |

Five packages, seven advisories, one bug: a pattern is compiled to a regular expression, the
engine backtracks, and one string somebody else chose spends the whole CPU. Nobody installs
four of these on purpose, which is exactly what made them everywhere.

**What nirdep does instead.** `runtime/semver` and `runtime/glob` contain no regular
expression at all — no literal, and not the constructor either. Ranges are parsed by walking
characters; globs match one path segment at a time and never backtrack, so there is no
pathological input because there is no backtracking to trigger. `tests/repo/no-regex.test.mjs`
lexes both files with this project's own lexer and fails on a single regexp token: a comment
claiming a property of the source is worth nothing without a test underneath it.

Size is the one thing left, and size gets a ceiling with an error code rather than a hang: a
pattern over 65,536 characters, a brace expansion over 8,192 results, or extglob nesting over
16 raises a `GlobError` the caller can catch. `runtime/collect` answers the lodash row by
calling `String.prototype.trim`, which has been correct since ES5.

## 2. A deep write that follows `__proto__`

| date | id | package | what broke |
| --- | --- | --- | --- |
| 2018-06-07 | CVE-2018-3721 | lodash | `merge`, `mergeWith`, `defaultsDeep` walked a `__proto__` key in attacker JSON |
| 2019-07-08 | CVE-2019-10744 | lodash | `defaultsDeep` again, by a route the 2018 fix left open |
| 2020-03-11 | CVE-2020-7598 | minimist | `--__proto__.polluted=yes` assigned straight onto `Object.prototype` |
| 2020-07-15 | CVE-2020-8203 | lodash | `zipObjectDeep`, third time, same class |
| 2022-03-17 | CVE-2021-44906 | minimist | the same hole a second time, through the path the first fix missed |

Three advisories in three years for one lodash feature, and two for one minimist feature.
Both were fixed by adding a name to a blocklist, which is the wrong shape for this bug: a
blocklist is a list of the routes somebody has already found.

**What nirdep does instead.** `runtime/collect`'s deep writes are own-property only — a path
stops at the first key the object does not own itself, so there is no route to a prototype to
blocklist. `__proto__`, `constructor` and `prototype` raise a `CollectError` with code
`ERR_UNSAFE_KEY` rather than being skipped in silence, because a skipped key is a behaviour
difference nobody will notice and a throw is a bug report.

`runtime/args` has no dot notation at all. Both minimist advisories were that one feature, and
nesting a command line is a config file's job, so the feature is gone rather than guarded.
That is a divergence from minimist, and it is written down in STDLIB.md next to the others
rather than discovered by somebody's test suite.

## 3. Input compiled into code

| date | id | package | what broke |
| --- | --- | --- | --- |
| 2021-02-15 | CVE-2021-23337 | lodash | `template` compiled its input into a function, so an untrusted template was execution by design |

Not a mistake in the implementation. The feature was the vulnerability, which is why it earned
a high rating and no clean fix.

**What nirdep does instead.** There is no template surface: `runtime/collect` is sixteen
functions and none of them compiles anything. Since this project does reach a parser, it is
worth saying exactly how — `src/patch/gate.mjs` puts every rewritten file in front of Node's
own parser before it touches the disk, through `vm.Script`, `vm.SourceTextModule` where the
flag allows it, or `node --check` over stdin. All three **compile and none evaluate**. A
codemod that ran the code it was editing would be a worse idea than the bug it was fixing.

## 4. The account, not the code

| date | package | hand | what happened |
| --- | --- | --- | --- |
| 2018-07-12 | eslint-scope | attacker | a maintainer account with a reused password; the release read your `.npmrc` token and posted it away |
| 2018-11-26 | event-stream | attacker | a volunteer asked for publish rights, got them, and added a wallet stealer aimed at one application |
| 2018-11-26 | flatmap-stream | attacker | the payload: eleven honest lines and a blob encrypted with the victim's own package description |
| 2021-10-22 | ua-parser-js | attacker | three releases in one afternoon, a password stealer and a miner, pulled within hours and installed anyway |
| 2021-11-04 | coa, rc | attacker | two packages nobody chose, unmaintained for years, republished with a credential stealer |
| 2022-01-08 | colors, faker | **author** | the maintainer shipped an infinite loop, then emptied the library, to make a point about unpaid work |
| 2022-03-15 | node-ipc | **author** | protestware that overwrote files on disk based on the IP address it geolocated you to |
| 2025-09-08 | 18 packages | attacker | a maintainer phished, and the releases that followed rewrote crypto transactions in the browser |

Two different lessons, so the table records whose hand it was. A hijack is an argument for
better account hygiene. `colors`, `faker` and `node-ipc` are not: the code was published by
the person you were trusting, so no review of the code as reviewed would have caught it. What
failed was the trust, and the trust was in one unpaid stranger with millions of weekly
installs.

The September 2025 wave is the version of this that should end the argument. The eighteen
packages it reached were the smallest, dullest, most-installed leaves in the ecosystem —
nobody chose them, nobody was watching them. Four of them are packages this project replaces:
`chalk`, `strip-ansi`, `supports-color` and `ansi-styles`, together about 1.25 billion weekly
downloads on the figures quoted in `src/rules/registry.mjs`, all four answered by one file
that calls `node:util`.

**What nirdep does instead.** There is no account to compromise when there is no package. This
repository installs nothing: `node tools/verify.mjs` walks every import in `src/`, `bin/` and
`tools/` and reports 12 builtin modules and 0 packages. `nirdep guard` then keeps it that way
in CI, and its policy draws one line it will not let you cross: an allow list can waive a
package you decided to keep, and it cannot waive a version the advisory table names. You do
not get to annotate a malicious release as acceptable.

## What none of this claims

A security document that only lists strengths is an advertisement. The limits, in the order
they are likely to matter:

**It is a neighbourhood, not a database.** Forty rows against the GitHub Advisory Database's
tens of thousands. A clean `nirdep scan` means the packages in this table are clear, and says
nothing whatever about the other four hundred entries in your tree. Keep running `npm audit`.

**Some rows match a name and not a version.** The September 2025 wave, `coa` and `rc` have no
versions recorded here, because this table was written afterwards from summaries and a version
number nobody verified would be worse than the gap. Those rows report as "this package was in
an incident, look it up" — a prompt, not a verdict.

**Five packages, not eleven, can be rewritten by machine.** `chalk`, `strip-ansi`, `semver`,
`minimatch` and `lodash` take the same calls in the same shape, so a codemod can move the call
sites. `minimist`, `commander`, `yargs`, `glob`, `supports-color` and `ansi-styles` get advice
and a diff nobody writes for you, because the shapes differ and a green run over a changed
shape is the failure mode worth avoiding most.

**The replacements diverge, on purpose, in writing.** Eleven pinned differences in
`runtime/collect`, four in `runtime/glob`, and the places where the reference package
contradicts itself in `runtime/semver` — all listed in STDLIB.md, all covered by the
conformance vectors. Divergences you can read are worth more than a claim of bug-compatibility
nobody checked.

**Figures that could not be verified are not printed as numbers.** This machine has no network
egress, so where a weekly download count could not be checked the table carries `—` and the
report says "unverified" rather than a plausible-looking million.

## The proof, in four commands

```
node tools/verify.mjs               # 12 builtin modules, 0 packages
node --test "tests/**/*.test.mjs"   # 585 tests, 585 pass
node bin/nirdep.mjs conformance     # 11 packages, 3593 vector cases against the real packages
node tools/build.mjs                # 47 files, sha256 of the tarball printed
```

`make repro` runs the build twice and compares the hashes, which is the check that keeps the
sorting rules in this repository honest: every ordered table goes through one codepoint
comparator, never `localeCompare`, because a build claiming byte-identical output cannot sort
in the machine's locale.

## Reporting something in nirdep

No dependencies is not no bugs. If you find one — a rewrite that changes behaviour, a matcher
that disagrees with the package it replaces, a row in the table that is wrong — open an issue
with the input and the version of Node, or say so privately if you would rather.

The audit surface is unusually small, and that is the point: what you are reviewing is the
files in this repository and the Node you run them on. There is no transitive tree behind
them, and no account but this one to compromise.

Published by Nastik AI. Developed by Hardik.
