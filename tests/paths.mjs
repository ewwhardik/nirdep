// Fixture trees are objects whose keys are absolute paths, written posix-style, because a
// test that spells a path the way the host platform does is a test nobody can read.
//
// The code under test resolves and joins before it reads -- that is the point of `resolve`,
// and it is why a relative `../vendor/colour.mjs` can be matched against a file the walk
// found. On Linux and macOS the result comes back looking like the key. On Windows it comes
// back as `C:\n\vendor\colour.mjs`, the lookup misses, and a test about provenance fails for
// a reason that has nothing to do with provenance.
//
// So the seam normalises what it is handed, rather than every fixture spelling both forms.
// The drive letter goes because `resolve` invents it and the fixture never had one.

/**
 * The posix key a fixture would have used for this path.
 *
 * @param {string} file a path the code under test built, in either dialect
 * @returns {string}
 */
export const fixtureKey = (file) => file.replace(/^[A-Za-z]:/, '').split('\\').join('/');
