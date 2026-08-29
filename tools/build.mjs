// One command to a runnable artifact, and the same bytes every time.
//
// The Reproducible Build bonus asks for two builds that hash identically. That
// is easy to claim and easy to get wrong, because the usual culprits are
// invisible: file mtimes, uid and gid, directory iteration order, and the
// timestamp gzip writes into its own header. So we write the tar stream
// ourselves rather than shelling out to tar -- which we could not do anyway,
// since invoking an installed tool is a dependency in disguise.
//
// Run: node tools/build.mjs            build once, print the hash
//      node tools/build.mjs --repro    build twice, fail unless identical

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { walk, displayPath } from '../src/fs/walk.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const BLOCK = 512;

// Fixed metadata. Every value here is a thing that would otherwise vary
// between two runs on the same machine.
const FIXED = {
  mtime: 0,
  uid: 0,
  gid: 0,
  uname: '',
  gname: '',
  fileMode: 0o644,
  execMode: 0o755,
};

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** A ustar header block for one file. */
function tarHeader(name, size, mode) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`path too long for a ustar header without a prefix split: ${name}`);
  }
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'ascii');
  header.write(octal(FIXED.uid, 8), 108, 8, 'ascii');
  header.write(octal(FIXED.gid, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(FIXED.mtime, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum field is spaces while summing
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(FIXED.uname, 265, 32, 'utf8');
  header.write(FIXED.gname, 297, 32, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function pad(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** Build a tar archive from [{ name, data, executable }] in the given order. */
function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const mode = entry.executable ? FIXED.execMode : FIXED.fileMode;
    parts.push(tarHeader(entry.name, entry.data.length, mode), entry.data, pad(entry.data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Collect the shipped files, sorted, so the archive order never depends on the filesystem. */
function collect() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const wanted = manifest.files ?? [];
  const entries = [];

  const add = (absolute, name) => {
    entries.push({
      name: posix.join(`nirdep-${manifest.version}`, name),
      data: readFileSync(absolute),
      executable: name.startsWith('bin/'),
    });
  };

  add(join(ROOT, 'package.json'), 'package.json');
  for (const target of wanted) {
    const absolute = join(ROOT, target);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) {
      for (const file of walk(absolute)) add(file, `${target}/${displayPath(absolute, file)}`);
    } else {
      add(absolute, target);
    }
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { manifest, entries };
}

function build() {
  const { manifest, entries } = collect();
  const archive = tar(entries);
  // Level is pinned and no filename or mtime goes into the gzip header, which
  // is where a naive gzip -9 would smuggle a timestamp into the output.
  const gz = gzipSync(archive, { level: zlibConstants.Z_BEST_COMPRESSION });

  // dist/ is overwritten in place rather than cleared. Clearing it would need
  // unlink permission the build does not require: the archive bytes are derived
  // from the source tree, never from dist/, so a stale file left behind cannot
  // change the hash. `make clean` is there when you do want it gone.
  //
  // The staged tree is written from the same `entries` the archive was built
  // from, so the artifact a judge runs and the artifact we hashed cannot drift.
  const stage = join(DIST, 'nirdep');
  for (const entry of entries) {
    const relative = entry.name.slice(entry.name.indexOf('/') + 1);
    const target = join(stage, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { mode: entry.executable ? FIXED.execMode : FIXED.fileMode });
  }

  const tarball = join(DIST, `nirdep-${manifest.version}.tar.gz`);
  writeFileSync(tarball, gz);
  return {
    version: manifest.version,
    files: entries.length,
    tarball,
    tarHash: sha256(archive),
    gzHash: sha256(gz),
  };
}

const repro = process.argv.includes('--repro');
const first = build();

if (!repro) {
  process.stdout.write([
    `nirdep ${first.version}`,
    `  artifact   dist/nirdep/bin/nirdep.mjs   (run: node dist/nirdep/bin/nirdep.mjs --about)`,
    `  tarball    ${displayPath(ROOT, first.tarball)}   (${first.files} files)`,
    `  sha256     ${first.gzHash}   .tar.gz`,
    `  sha256     ${first.tarHash}   .tar (uncompressed)`,
    '',
  ].join('\n'));
} else {
  const second = build();
  const identical = first.gzHash === second.gzHash && first.tarHash === second.tarHash;
  process.stdout.write([
    'Reproducible build check -- same machine, same toolchain, two runs.',
    `  run 1  ${first.gzHash}`,
    `  run 2  ${second.gzHash}`,
    '',
    identical
      ? 'IDENTICAL. Both runs produced the same bytes.'
      : 'DIFFERENT. The build is not reproducible; do not claim the bonus.',
    '',
  ].join('\n'));
  if (!identical) process.exitCode = 1;
}
