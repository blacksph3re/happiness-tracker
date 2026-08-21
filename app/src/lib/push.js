import { get, writable } from 'svelte/store'

import { unwrap } from './api.js'
import {
  forgetPushSubscription,
  getPushKey,
  registerPushSubscription,
} from './generated/sdk.gen'

/**
 * Enrolling this browser for notifications, and letting it go.
 *
 * Phase one of `PUSH_NOTIFICATIONS_PROPOSAL.md`: nothing here sends anything.
 * What it does is the half that has to be right before sending is worth
 * writing — a browser the server can address, and can stop addressing.
 *
 * Two constraints shape all of it. Permission may only be asked for **from a
 * user gesture**, so nothing here runs on load; and on iOS the Push API exists
 * only in a web app added to the Home Screen, so a Safari tab has no
 * `PushManager` at all and must be told why rather than shown a dead switch.
 */

/** What this browser can do, as far as we can tell without asking anybody. */
export const pushSupport = writable({
  /** Whether the browser exposes the Push API here at all. */
  available: false,
  /** Whether the *server* has VAPID keys. Both halves are needed. */
  configured: false,
  /** `granted`, `denied`, `default`, or `unsupported`. */
  permission: 'unsupported',
  /** Whether this browser is registered with the server right now. */
  subscribed: false,
})

/**
 * Whether the Push API is reachable in this browsing context.
 *
 * On iOS this is false in an ordinary Safari tab and true in the same app added
 * to the Home Screen — which is the single most confusing thing about web push,
 * and the reason the setting explains itself rather than simply disappearing.
 *
 * @returns {boolean}
 */
export function pushAvailable() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** Turn the server's base64url VAPID key into the bytes `subscribe` wants. */
function keyBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

/** A short name for this device, so a list of them can be told apart. */
function deviceLabel() {
  const agent = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(agent)) return 'iPhone or iPad'
  if (/Android/.test(agent)) return 'Android'
  if (/Macintosh/.test(agent)) return 'Mac'
  if (/Windows/.test(agent)) return 'Windows'
  return 'This device'
}

/**
 * Read what this browser and this server can do between them.
 *
 * Safe on load: it asks for no permission and shows no prompt. It reports the
 * *existing* permission, which the browser hands over without a gesture.
 *
 * @returns {Promise<object>} The value now in `pushSupport`.
 */
export async function readPushSupport() {
  const available = pushAvailable()
  const key = await unwrap(() => getPushKey()).catch(() => null)
  const registration = available
    ? await navigator.serviceWorker.getRegistration()
    : null
  const existing = await registration?.pushManager?.getSubscription?.()
  const state = {
    available,
    configured: Boolean(key?.configured),
    permission: available ? Notification.permission : 'unsupported',
    subscribed: Boolean(existing),
  }
  pushSupport.set(state)
  return state
}

/**
 * Ask for permission and register this browser. **Call from a click.**
 *
 * @returns {Promise<{ok: boolean, reason?: string}>} Why, when it did not work.
 */
export async function enablePush() {
  if (!pushAvailable()) {
    return { ok: false, reason: 'This browser cannot receive notifications here.' }
  }
  const key = await unwrap(() => getPushKey()).catch(() => null)
  if (!key?.configured) {
    return { ok: false, reason: 'This server is not set up to send notifications.' }
  }

  // From the gesture that called this. Asked on load, browsers either refuse
  // outright or count it against the site.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    await readPushSupport()
    return {
      ok: false,
      reason:
        permission === 'denied'
          ? 'Notifications are blocked for this site in the browser’s own settings.'
          : 'Notifications were not allowed.',
    }
  }

  const registration = await navigator.serviceWorker.ready
  // Re-used when there is one: `subscribe` returns the existing subscription
  // for the same key, and a different key throws rather than replacing it.
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Non-negotiable, and the reason push cannot carry silent data sync:
      // every message has to show the person something.
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key.public_key),
    }))

  await sendSubscription(subscription)
  await readPushSupport()
  return { ok: true }
}

/**
 * Tell the server about a subscription this browser holds.
 *
 * Also called on launch, which is what prunes devices that stop coming back:
 * a push service cannot be relied on to report one as gone — Apple has been
 * seen answering `201` for an endpoint it had already replaced.
 *
 * @param {PushSubscription} subscription
 * @returns {Promise<void>}
 */
export async function sendSubscription(subscription) {
  const json = subscription.toJSON()
  await unwrap(() =>
    registerPushSubscription({
      body: {
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        label: deviceLabel(),
      },
    })
  )
}

/**
 * Stop notifications for this browser, here and on the server.
 *
 * Both halves, and the server first: unsubscribing locally and failing to say
 * so leaves an endpoint that is pushed to forever and answers nothing.
 *
 * @returns {Promise<void>}
 */
export async function disablePush() {
  const registration = await navigator.serviceWorker?.getRegistration?.()
  const subscription = await registration?.pushManager?.getSubscription?.()
  if (subscription) {
    await unwrap(() =>
      forgetPushSubscription({ body: { endpoint: subscription.endpoint } })
    ).catch(() => {
      // Unreachable. Better to drop it here anyway than to leave the person
      // with a switch that will not turn off.
    })
    await subscription.unsubscribe()
  }
  await readPushSupport()
}

/**
 * Give up this browser's subscription because the session is ending.
 *
 * Signing out means "stop telling me about pomodoros", and a subscription
 * outlives a token: nothing about clearing an access token reaches the push
 * service, so a browser left enrolled goes on being pushed to by an account
 * nobody is signed in to. The same applies to signing in as somebody else,
 * where the device would otherwise keep the previous account's enrolment and
 * receive their notifications.
 *
 * **Order matters and the failure path is deliberate.** The server is told
 * first, while there is still a token to tell it with; then the browser
 * unsubscribes, which is the half that actually stops delivery and is done
 * whether or not the server could be reached. A device that cannot reach the
 * server on the way out still stops receiving, and the row it left behind is
 * pruned the next time something is sent to it.
 *
 * @returns {Promise<void>} When the browser is no longer subscribed.
 */
export async function purgePush() {
  // Local checks only before committing to any network work: on a browser that
  // was never enrolled — which is most of them, and every test — this returns
  // without a request.
  if (!pushAvailable() || Notification.permission !== 'granted') return
  try {
    await disablePush()
  } catch {
    // Never block a sign-out. Whatever went wrong, leaving is the thing the
    // person asked for.
  }
}

/**
 * Re-register on launch, if this browser is already enrolled.
 *
 * Silent by design: it asks for nothing and shows nothing, and does nothing at
 * all unless permission was granted earlier. What it buys is the `updated_at`
 * that says this device still exists.
 *
 * @returns {Promise<void>}
 */
export async function refreshSubscription() {
  // Everything cheap and local first. This runs on every app start, and asking
  // the server whether push is configured — for a browser that has never been
  // granted permission and so has nothing to refresh — is a request that
  // cannot change the answer. It also put a round trip in front of the first
  // paint, which is a cost paid by every page load to serve almost none.
  if (!pushAvailable() || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager?.getSubscription?.()
  if (!subscription) return
  await sendSubscription(subscription).catch(() => {})
  await readPushSupport()
}
