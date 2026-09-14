/**
 * The width every todo page centres, as a `max-w-*` class for `Frame`.
 *
 * The heading and toolbar of Tasks, Calendar and Lists all live in it, so they
 * hold still across every page and every view. Content that is one column — a
 * stack, the archive, the calendar's Day, the Lists rows — fills it; a board of
 * several columns and the calendar's Week are handed to `Frame` as `board` with
 * `spread`, and fill the frame instead. It is the 1112px a stack always had.
 */
export const COLUMN = 'max-w-todo-reading'
