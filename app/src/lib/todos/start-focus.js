import { navigate } from '../router.js'
import { startPomodoro } from '../store.js'

/**
 * Start a pomodoro for a task, then open the timer it is running on.
 *
 * **The one gesture that crosses into another half**, at the owner's request:
 * the only thing anybody does after starting a timer is look at it. It is a
 * navigation made by an action and never a link — nothing under the todo half
 * is an `<a>` into another — and it goes through the shared router and the
 * shared store, so this zone still imports nothing from `lib/pomodoro/`.
 *
 * One place owns "start, then go", so the board's menu, the calendar's menu and
 * the modal cannot disagree about whether a press goes anywhere.
 *
 * **After the local write, never after the server.** `startPomodoro` resolves
 * once the intent is on disk and the block is in the store, and the focus view
 * paints from the store — so there is nothing to wait for, and offline the
 * timer is on screen at once with the write still queued. Waiting on a flush
 * would be a press that sits on the board for as long as the network thinks.
 *
 * Only when the write reached the device: a start that stored nothing has no
 * running block to show, and the timer would open on *Ready* as though the
 * press had been ignored somewhere else.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @returns {Promise<string|null>} The pomodoro's identity, or null when nothing
 *   reached the device and so nothing was opened.
 */
export async function startFocus(task) {
  const started = await startPomodoro({ task: task.title, todo: task })
  if (started) navigate('/focus')
  return started
}
