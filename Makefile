# nirdep -- one command to a runnable artifact, and one command to prove the
# manifest is empty. No third-party build tooling: this Makefile drives Node,
# which is the toolchain the rules already allow.

NODE ?= node
DIST ?= dist

.PHONY: all build test verify repro conformance clean help

all: verify test build

## build: produce the runnable artifact in dist/
build:
	@$(NODE) tools/build.mjs

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

clean:
	@rm -rf $(DIST)

help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
