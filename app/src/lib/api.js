import { writable } from 'svelte/store'

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

/**
 * Read the stored access token.
 *
 * @returns {string|null} The token, or null when signed out.
 */
export function accessToken() {
  return localStorage.getItem(ACCESS_KEY)
}

/**
 * Persist a freshly issued token pair and mark the session as active.
 *
 * @param {{access_token: string, refresh_token?: string}} tokens Login or refresh response.
 */
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
 * @returns {Promise<boolean>} True when a new access token was obtained.
 */
async function refreshAccessToken() {
  const refresh_token = localStorage.getItem(REFRESH_KEY)
  if (!refresh_token) return false
  const response = await fetch('/api/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token }),
  })
  if (!response.ok) return false
  storeTokens(await response.json())
  return true
}

/**
 * Call the API, refreshing the access token once if it has expired.
 *
 * Throws on failure so callers can decide whether to surface a toast; the
 * questionnaire deliberately does not await its writes.
 */
export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = {}
  const token = accessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 401 && retry && (await refreshAccessToken())) {
    return api(path, { method, body, retry: false })
  }
  if (response.status === 401) {
    // Replace rather than push: the expired page must not stay in history, or
    // Back lands on it, 401s again and bounces forward to login for ever.
    clearTokens()
    window.location.replace('/login')
    throw new Error('Session expired')
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const payload = await response.json()
      if (payload.detail) detail = payload.detail
    } catch {
      /* keep the status-code message */
    }
    throw new Error(detail)
  }
  if (response.status === 204) return null
  return response.json()
}

/** Call the API and surface any failure as a toast, returning null instead. */
export async function tryApi(path, options) {
  try {
    return await api(path, options)
  } catch (error) {
    pushToast(error.message)
    return null
  }
}
