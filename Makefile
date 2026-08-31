# nirdep -- one command to a runnable artifact, and one command to prove the
# manifest is empty. No third-party build tooling: this Makefile drives Node,
# which is the toolchain the rules already allow.

NODE ?= node
DIST ?= dist

.PHONY: all build test verify repro conformance stdlibmd page demo bench clean help

all: verify test build

## build: produce the runnable artifact in dist/
build:
	@$(NODE) tools/build.mjs

## page: rebuild docs/index.html -- the recorded demo plus the live sandboxes
# The recording is a real run of the real pipeline, so this target is also a
# smoke test: if any stage of `demo` fails, the page does not get written.
page:
	@$(NODE) tools/playground.mjs

## demo: plant a broken project, migrate it, and run it
demo:
	@$(NODE) bin/nirdep.mjs demo

## bench: measure, rewrite bench.json, print the table
# Committed as data on purpose. The page reads bench.json and never runs this,
# so two builds of the page agree byte for byte even though two runs of a
# benchmark never do. Add --against <node_modules> to compare on disk against
# the real packages; without it every reference figure stays null.
bench:
	@$(NODE) tools/bench.mjs

## test: run the whole suite on the stdlib test runner
test:
	@$(NODE) --test --test-reporter=spec "tests/**/*.test.mjs"

## verify: prove zero third-party dependencies, write deps-proof.txt
verify:
	@$(NODE) tools/verify.mjs

## repro: build twice, publish both hashes, fail unless byte-identical
repro:
	@$(NODE) tools/build.mjs --repro

## conformance: pass/fail/skip table for every runtime module
conformance:
	@$(NODE) bin/nirdep.mjs conformance

## stdlibmd: print the document this tool would generate about itself
# Prints rather than writes. STDLIB.md here is a hand-written disclosure with
# paragraphs no generator produced, and --write would refuse to touch it -- as
# it should. Redirect it somewhere else if you want the file.
stdlibmd:
	@$(NODE) bin/nirdep.mjs stdlibmd .

clean:
	@rm -rf $(DIST)

help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
