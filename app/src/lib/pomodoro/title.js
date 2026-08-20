import { get } from 'svelte/store'

import { pomodoros } from '../store.js'
import { progress, pomodoroState, RUNNING } from './derive.js'

/**
 * The browser tab counts down while a pomodoro runs.
 *
 * The tab title is the one part of the app visible from another tab, which is
 * where somebody in a focus block usually is. Nothing else can say how long is
 * left without being looked at.
 *
 * Started once for the life of the tab, from `App.svelte`, so the countdown
 * survives moving around inside the app. It **reads** the pomodoro store and
 * never loads it: a page that has not asked for today's pomodoros gets the
 * plain title rather than a request it did not ask for.
 */

/** What the tab is called when nothing is running. */
const PLAIN = document.title

/** How often the title is rewritten. A second, matching what it displays. */
const EVERY = 1000

/**
 * Format the remaining seconds the way a timer reads.
 *
 * @param {number} seconds
 * @returns {string} `M:SS`, or `MM:SS` past ten minutes.
 */
function countdown(seconds) {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Keep `document.title` in step with the running pomodoro.
 *
 * @returns {() => void} Stops the timer and restores the plain title.
 */
export function watchTitle() {
  const paint = () => {
    const now = Date.now()
    const running = (get(pomodoros) ?? []).find(
      (row) => pomodoroState(row, now) === RUNNING
    )
    if (!running) {
      if (document.title !== PLAIN) document.title = PLAIN
      return
    }
    const bar = progress(running, now)
    // Which phase, because "5:00 left" means opposite things across the two and
    // the tab has no room to explain itself.
    const what = bar.phase === 'break' ? 'break' : running.task || 'focus'
    document.title = `${countdown(bar.remaining)} · ${what}`
  }

  paint()
  const handle = setInterval(paint, EVERY)
  return () => {
    clearInterval(handle)
    document.title = PLAIN
  }
}
