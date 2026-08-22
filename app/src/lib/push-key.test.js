import { describe, expect, test } from 'vitest'

import { keyBytes } from './push-key.js'

/**
 * The one piece of the enrolment path that can be tested without a browser.
 *
 * One thing here is deliberately *not* asserted: the padding `keyBytes` puts
 * back. Both Node's `atob` and Chromium's accept unpadded input, so removing
 * that line changes no observable behaviour in either — a test for it passed
 * against the broken version, which is worse than no test. It stays in the
 * code as defence against a stricter engine and is honestly untested here.
 *
 * Everything else in `push.js` needs a `PushManager`, a service worker and a
 * permission prompt. This does not, and it is the part most likely to be
 * wrong: base64url is base64 with two characters swapped and the padding
 * dropped, and `pushManager.subscribe` rejects anything that is not exactly a
 * 65-byte P-256 point.
 */

// The example key from RFC 8291, which is a real uncompressed P-256 point.
const VAPID = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'

describe('keyBytes', () => {
  test('decodes to a 65-byte uncompressed P-256 point', () => {
    const bytes = keyBytes(VAPID)
    expect(bytes).toBeInstanceOf(Uint8Array)
    // 1 prefix byte plus two 32-byte coordinates. `subscribe` rejects any
    // other length outright.
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(0x04)
  })

  test('reads the base64url alphabet, not plain base64', () => {
    // The whole substitution, in one case: `-` and `_` stand where `+` and `/`
    // do. Decoded as plain base64 these give different bytes — which is the
    // failure that would reach a device as "the key is not valid".
    //
    // Asserted against the bytes, not against not-throwing: `atob` accepts
    // both alphabets' characters in some positions, so a test that only
    // checked for an exception would pass on the broken version.
    const urlSafe = '-_-_'
    const plain = '+/+/'
    expect(Array.from(keyBytes(urlSafe))).toEqual(
      Array.from(Uint8Array.from(atob(plain), (c) => c.charCodeAt(0)))
    )
  })

  test('round-trips a key the server would actually send', () => {
    const bytes = keyBytes(VAPID)
    const back = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(back).toBe(VAPID)
  })
})
