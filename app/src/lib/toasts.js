import { writable } from 'svelte/store'

/** Toast messages currently on screen. */
export const toasts = writable([])

let nextId = 1

/** Show a message for a few seconds without blocking interaction. */
export function pushToast(message, tone = 'danger') {
  const id = nextId++
  toasts.update((all) => [...all, { id, message, tone }])
  setTimeout(() => {
    toasts.update((all) => all.filter((toast) => toast.id !== id))
  }, 5000)
}

/** Put every toast away at once, for a sign-out: none of them is about the next account. */
export function clearToasts() {
  toasts.set([])
}

/** Dismiss a toast early. */
export function dismissToast(id) {
  toasts.update((all) => all.filter((toast) => toast.id !== id))
}
