// The claims behind the Reproducible Build bonus, asserted rather than asserted
// about. If these fail, the README must not claim the bonus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function build(args = []) {
  return execFileSync(process.execPath, ['tools/build.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('two builds produce byte-identical output', () => {
  const output = build(['--repro']);
  assert.match(output, /IDENTICAL/);
  const hashes = [...output.matchAll(/run \d\s+([0-9a-f]{64})/g)].map((match) => match[1]);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1]);
});

test('the archive carries no timestamps, uid or gid to vary between runs', () => {
  build();
  const gz = readFileSync(new URL(`../../dist/nirdep-${MANIFEST.version}.tar.gz`, import.meta.url));
  const tar = gunzipSync(gz);

  let offset = 0;
  let entries = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') break;
    const field = (start, width) => tar.subarray(offset + start, offset + start + width).toString('ascii').replace(/\0| /g, '');
    assert.equal(Number.parseInt(field(108, 8), 8), 0, `${name} uid is zero`);
    assert.equal(Number.parseInt(field(116, 8), 8), 0, `${name} gid is zero`);
    assert.equal(Number.parseInt(field(136, 12), 8), 0, `${name} mtime is zero`);
    assert.equal(tar.subarray(offset + 257, offset + 262).toString('ascii'), 'ustar', `${name} is a ustar header`);
    const size = Number.parseInt(field(124, 12), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
    entries += 1;
  }
  assert.ok(entries >= 4, `expected several entries, saw ${entries}`);
});

test('the header checksum we write is the one tar would verify', () => {
  build();
  const tar = gunzipSync(readFileSync(new URL(`../../dist/nirdep-${MANIFEST.version}.tar.gz`, import.meta.url)));
  const header = Buffer.from(tar.subarray(0, 512));
  const stated = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0| /g, ''), 8);
  header.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  assert.equal(stated, sum);
});

test('the staged artifact and the archived artifact are the same bytes', () => {
  build();
  const staged = readFileSync(new URL('../../dist/nirdep/bin/nirdep.mjs', import.meta.url));
  const source = readFileSync(new URL('../../bin/nirdep.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(staged).digest('hex'), createHash('sha256').update(source).digest('hex'));
});
