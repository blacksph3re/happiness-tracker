/**
 * Turning a VAPID public key into the bytes `pushManager.subscribe` wants.
 *
 * Its own module, with no imports, for the reason `digest.js` is: `push.js`
 * reaches `localStorage` through `api.js` at import time, so anything living
 * there cannot be unit-tested in a plain node environment. This is the one
 * piece of the enrolment path that needs no browser, and it is the piece most
 * likely to be wrong.
 */

/**
 * Decode a base64url VAPID key.
 *
 * Base64url is base64 with two characters swapped and the padding dropped, and
 * `subscribe` is strict about the result: a P-256 point is exactly 65 bytes
 * beginning with `0x04`. Get any of that wrong and the failure arrives as a
 * browser exception on a device, part-way into somebody's focus block — which
 * is the worst place to find out.
 *
 * @param {string} base64url The key as the server reports it.
 * @returns {Uint8Array} The raw bytes.
 */
export function keyBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}
