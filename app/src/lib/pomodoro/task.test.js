import { describe, expect, it } from 'vitest'

import { taskTitle } from './task.js'

const block = (fields = {}) => ({
  client_id: 'pom',
  task: 'What was typed',
  todo_client_id: null,
  ...fields,
})

const task = (fields = {}) => ({ client_id: 'cat', title: 'Feed the cat', ...fields })

describe('what a pomodoro is called', () => {
  it('is its own text when it names no task', () => {
    expect(taskTitle(block(), [task()])).toBe('What was typed')
  })

  it('is the linked task’s current title', () => {
    // The reason the link exists: renaming the task renames the hours.
    const linked = block({ todo_client_id: 'cat' })
    expect(taskTitle(linked, [task({ title: 'Feed the cats' })])).toBe('Feed the cats')
  })

  it('falls back to its own text when the task is not on this device', () => {
    // A deleted task, or one in a page of the archive nobody has read.
    expect(taskTitle(block({ todo_client_id: 'cat' }), [])).toBe('What was typed')
  })

  it('is nothing at all for an unnamed pomodoro', () => {
    expect(taskTitle(block({ task: null }), [])).toBeNull()
  })
})
