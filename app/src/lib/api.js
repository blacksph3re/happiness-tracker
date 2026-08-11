import { writable } from 'svelte/store'

import { client } from './generated/client.gen'
import { refreshAccessToken as refreshCall } from './generated/sdk.gen'
import { pushToast } from './toasts.js'

const ACCESS_KEY = 'ht.access'
const REFRESH_KEY = 'ht.refresh'

/**
 * Whether a session is currently held.
 *
 * A store rather than a plain localStorage read, because components need to
 * re-render the moment a session starts or ends.
 */
export const signedIn = writable(Boolean(localStorage.getItem(ACCESS_KEY)))

/** Read the stored access token, or null when signed out. */
function accessToken() {
  return localStorage.getItem(ACCESS_KEY)
}

/** Persist a freshly issued token pair and mark the session as active. */
export function storeTokens({ access_token, refresh_token }) {
  localStorage.setItem(ACCESS_KEY, access_token)
  if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token)
  signedIn.set(true)
}

/** Forget every stored token and mark the session as ended. */
export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
  signedIn.set(false)
}

/**
 * Trade the stored refresh token for a new access token.
 *
 * @returns {Promise<boolean>} True when a usable access token is now stored.
 */
async function ensureFreshToken() {
  const refresh_token = localStorage.getItem(REFRESH_KEY)
  if (!refresh_token) return false
  const { data } = await refreshCall({ body: { refresh_token }, auth: false })
  if (!data) return false
  storeTokens(data)
  return true
}

/**
 * Turn an error body into one sentence a person can act on.
 *
 * A handler raising HTTPException puts a string in `detail`, but a failed
 * schema validation puts a *list* of `{loc, msg}` objects there instead.
 * Passing that list to `new Error()` yields "[object Object]", which tells the
 * reader nothing about which field was wrong.
 */
function describeFailure(payload, status) {
  const detail = payload?.detail
  if (typeof detail === 'string' && detail) return detail

  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((problem) => {
        // `loc` is ["body", "password"]; the field name is the informative part.
        const field = Array.isArray(problem.loc)
          ? problem.loc.filter((part) => part !== 'body').join('.')
          : ''
        return field ? `${field}: ${problem.msg ?? 'is not valid'}` : problem.msg
      })
      .join('; ')
  }

  return `Request failed (${status})`
}

// Every generated call carries the bearer token, so no call site handles auth.
client.setConfig({ auth: () => accessToken() ?? undefined })

let refreshing = null

/** Refresh at most once at a time, however many calls hit 401 together. */
function refreshOnce() {
  refreshing ??= ensureFreshToken().finally(() => {
    refreshing = null
  })
  return refreshing
}

/**
 * Run a generated SDK call, refreshing the session once if it has expired.
 *
 * Takes a function rather than a promise so the call can simply be made again
 * after a refresh, with no need to reconstruct its arguments.
 *
 * @param {() => Promise<{data?: unknown, error?: unknown, response: Response}>} call
 * @returns {Promise<unknown>} The response body, or null for a 204.
 */
export async function unwrap(call) {
  let { data, error, response } = await call()

  if (response.status === 401) {
    if (await refreshOnce()) {
      ;({ data, error, response } = await call())
    }
    if (response.status === 401) {
      // Replace rather than push: the expired page must not stay in history, or
      // Back lands on it, 401s again and bounces forward to login for ever.
      clearTokens()
      window.location.replace('/login')
      throw new Error('Session expired')
    }
  }

  if (!response.ok) throw new Error(describeFailure(error, response.status))
  return response.status === 204 ? null : data
}

/** Run an SDK call, reporting any failure as a toast and returning null. */
export async function attempt(call) {
  try {
    return await unwrap(call)
  } catch (failure) {
    pushToast(failure.message)
    return null
  }
}
