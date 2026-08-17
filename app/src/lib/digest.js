/**
 * Comparing two change digests.
 *
 * Arithmetic only, and kept apart from `revalidate.js` for the reason
 * `series.js` is kept apart from the pages that draw it: this is the part with
 * the interesting edge cases, and it is worth being testable without a server,
 * a store, or a browser behind it.
 */

/**
 * Which collections two digests disagree about.
 *
 * @param {Record<string, {n: number, at: string|null}>|null} previous The digest
 *   last seen, or null when there is none — the first check of a page load,
 *   which establishes a baseline and moves nothing.
 * @param {Record<string, {n: number, at: string|null}>} next The digest now.
 * @returns {Array<string>} Names of the collections to re-read, possibly empty.
 */
export function diffDigest(previous, next) {
  if (!previous) return []
  return Object.keys(next).filter((name) => {
    const was = previous[name]
    // A collection the server has started reporting: read it once rather than
    // wait for its second change. One that has *stopped* being reported is not
    // here to iterate over, which is the right answer — there is nothing to
    // re-read, and a refetch for a key with no fingerprint could not be checked
    // against anything next time.
    if (!was) return true
    return was.n !== next[name].n || was.at !== next[name].at
  })
}
