// The Node surface the vendored files ask for, implemented for a browser.
//
// One module stands in for six specifiers -- node:fs, node:path, node:util, node:module,
// node:url and node:vm -- because ESM named imports only need the names to exist somewhere,
// and four blobs re-exporting the same thing would have been four times the loader for no
// extra truth.
//
// The disk is two Maps: one of file text, one of directory listings. `mount` builds both, so
// the real walk in src/fs/walk.mjs, the real reader in src/fs/read.mjs and the real writes in
// src/apply and src/eject all run unmodified over a tree that does not exist. That is the
// point of the panels they power: the commands are not simulated, the filesystem under them
// is. `snapshot` hands the tree back afterwards so the page can show what was written.
//
// Paths are posix and relative. A browser has no cwd to be absolute against, so `/a/b` and
// `a/b` are the same key here; that is a divergence from Node and it is the only one that
// touches behaviour rather than availability.

/** @type {Map<string, string>} */
const FILES = new Map();
/** @type {Map<string, Array<{ name: string, dir: boolean }>>} */
const DIRECTORIES = new Map();

const key = (path) => {
  const clean = String(path).split('\\').join('/').replace(/\/+$/, '').replace(/^\/+/, '');
  return clean === '' || clean === '.' ? '.' : clean.replace(/^\.\//, '');
};

/** Register one path in its parent's listing, and every directory above it. */
function register(path, dir) {
  const parts = key(path).split('/').filter((one) => one !== '' && one !== '.');
  let at = '.';
  if (!DIRECTORIES.has('.')) DIRECTORIES.set('.', []);
  for (let n = 0; n < parts.length; n += 1) {
    const last = n === parts.length - 1;
    const listing = DIRECTORIES.get(at);
    if (!listing.some((one) => one.name === parts[n])) listing.push({ name: parts[n], dir: !last || dir });
    at = at === '.' ? parts[n] : `${at}/${parts[n]}`;
    if (!last || dir) {
      if (!DIRECTORIES.has(at)) DIRECTORIES.set(at, []);
    }
  }
  return at;
}

const sorted = () => {
  for (const listing of DIRECTORIES.values()) listing.sort((a, b) => (a.name < b.name ? -1 : 1));
};

/**
 * Install a tree. An array of paths mounts empty files -- enough for a walk -- and an object
 * mounts `{ path: text }`, which is what the commands need.
 */
export function mount(tree) {
  FILES.clear();
  DIRECTORIES.clear();
  DIRECTORIES.set('.', []);
  const entries = Array.isArray(tree) ? tree.map((one) => [one, '']) : Object.entries(tree);
  for (const [path, text] of entries) {
    register(path, false);
    FILES.set(key(path), String(text));
  }
  sorted();
  return Array.isArray(tree) ? tree : Object.keys(tree);
}

/** Add to the mounted tree without clearing it, for a second project beside the first. */
export function mountMore(tree) {
  for (const [path, text] of Object.entries(tree)) {
    register(path, false);
    FILES.set(key(path), String(text));
  }
  sorted();
  return Object.keys(tree);
}

/** Every file, in one order, so the page can diff before against after. */
export function snapshot() {
  return [...FILES.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, text]) => ({ path, text }));
}

/** The shape node:fs hands back with withFileTypes, cut to the members the walk reads. */
const dirent = (entry) => ({
  name: entry.name,
  isDirectory: () => entry.dir,
  isFile: () => !entry.dir,
  isSymbolicLink: () => false,
});

/** Throws the way Node throws, because every caller here catches by code. */
function fail(code, path, what) {
  const error = new Error(`${code}: ${what}, ${path}`);
  error.code = code;
  return error;
}

export function readdirSync(path) {
  const entries = DIRECTORIES.get(key(path));
  if (entries === undefined) throw fail('ENOENT', path, 'no such file or directory');
  return entries.map(dirent);
}

export function readFileSync(path, encoding) {
  const at = key(path);
  if (DIRECTORIES.has(at) && !FILES.has(at)) throw fail('EISDIR', path, 'illegal operation on a directory');
  const text = FILES.get(at);
  if (text === undefined) throw fail('ENOENT', path, 'no such file or directory');
  // The callers all ask for utf8; a Buffer here would be a lie about what this holds.
  return encoding === undefined || encoding === null ? text : text;
}

export function writeFileSync(path, text) {
  const at = key(path);
  const cut = at.lastIndexOf('/');
  const parent = cut === -1 ? '.' : at.slice(0, cut);
  if (!DIRECTORIES.has(parent)) throw fail('ENOENT', path, 'no such file or directory');
  register(at, false);
  FILES.set(at, String(text));
  sorted();
}

export function mkdirSync(path) {
  register(path, true);
  sorted();
  return undefined;
}

export function statSync(path) {
  const at = key(path);
  const directory = DIRECTORIES.has(at) && !FILES.has(at);
  if (!directory && !FILES.has(at)) throw fail('ENOENT', path, 'no such file or directory');
  return {
    isDirectory: () => directory,
    isFile: () => !directory,
    size: directory ? 0 : FILES.get(at).length,
  };
}

export const sep = '/';

/** posix join, which is the only dialect a browser has any business with. */
export function join(...parts) {
  const out = [];
  for (const part of parts) {
    for (const piece of String(part).split('/')) {
      if (piece === '' || piece === '.') continue;
      if (piece === '..') out.pop();
      else out.push(piece);
    }
  }
  const joined = out.join('/');
  return joined === '' ? '.' : joined;
}

/** Nothing is absolute in here, so resolving is joining against the mount root. */
export const resolve = (...parts) => join(...parts);

export const isAbsolute = (path) => String(path).startsWith('/');

export function relative(from, to) {
  const a = key(from) === '.' ? [] : key(from).split('/');
  const b = key(to) === '.' ? [] : key(to).split('/');
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  const up = new Array(a.length - same).fill('..');
  return [...up, ...b.slice(same)].join('/');
}

export function dirname(path) {
  const at = key(path);
  const cut = at.lastIndexOf('/');
  return cut === -1 ? '.' : at.slice(0, cut);
}

export function basename(path, extension = '') {
  const name = key(path).split('/').pop() ?? '';
  return extension !== '' && name.endsWith(extension) ? name.slice(0, -extension.length) : name;
}

export function extname(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * The one caller is src/eject/project.mjs, working out where its own copy of nirdep lives so
 * it can read the runtime files it is about to hand over. A blob URL has no path to convert,
 * so it is given the path it would have had -- and the page mounts nirdep at exactly that
 * place, where npm would have put it, which is what makes the answer true rather than
 * convenient.
 */
export const fileURLToPath = () => 'node_modules/nirdep/src/eject/project.mjs';

/** No terminal here, so there is nothing to strip but the sequences themselves. */
export const stripVTControlCharacters = (text) => String(text)
  .split(String.fromCharCode(27)).map((piece, index) => (index === 0 ? piece : piece.replace(/^\[[0-9;]*m/, '')))
  .join('');

// A list, not a resolver, because a browser has no module registry to ask. It is the set a
// pasted file is likely to mention; a name that is missing is reported as third-party, which
// is the same direction tools/verify.mjs errs in and for the same reason.
const BUILTIN = new Set(['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http',
  'https', 'module', 'net', 'os', 'path', 'process', 'readline', 'stream', 'string_decoder',
  'test', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);

export function isBuiltin(specifier) {
  const name = String(specifier);
  if (name.startsWith('node:')) return true;
  return BUILTIN.has(name.split('/')[0]);
}

/**
 * node:vm and node:child_process, present and empty on purpose.
 *
 * src/patch/gate.mjs reaches for both to get at a real parser: `vm.SourceTextModule` when the
 * flag is on, `node --check` over stdin otherwise. Neither exists in a browser and neither is
 * faked here, because a syntax gate that says "checked" without checking is the one bug in
 * this tool that would corrupt somebody's repository. The page passes `checkByLexer` instead
 * and labels the verdict `lex`, which is a smaller claim, honestly made.
 */
export default { name: 'browser', Script: undefined, SourceTextModule: undefined };

export function execFileSync() {
  throw fail('ENOENT', 'node', 'a browser cannot spawn a process');
}
