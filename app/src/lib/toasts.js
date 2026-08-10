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

/** Dismiss a toast early. */
export function dismissToast(id) {
  toasts.update((all) => all.filter((toast) => toast.id !== id))
}
