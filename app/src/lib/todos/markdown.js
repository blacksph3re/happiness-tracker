import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * A task's description, rendered.
 *
 * Markdown because a description is prose somebody wrote, and a list of three
 * things is the ordinary case. Two libraries rather than one, and the second is
 * not optional: `marked` passes inline HTML straight through — that is what
 * makes it a markdown renderer rather than a sanitiser — so what it emits is
 * untrusted markup and goes into `{@html}` only through `DOMPurify`.
 *
 * A description is the account's own text, which makes this look like a
 * formality. It is not: the same row arrives from the server, an import, or a
 * device somebody else has, and the boundary is where the check belongs rather
 * than the provenance.
 */

/**
 * Force every link outward and severed from this page.
 *
 * Registered once, at import: a hook added per call would stack up and run as
 * many times as the module had been asked for. `noopener` is the half that
 * matters — a new tab that can reach `window.opener` can navigate this one, and
 * the app it would be navigating away from is holding an unsent queue.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener')
  }
})

/**
 * Render a description to HTML that is safe to put in `{@html}`.
 *
 * @param {string|null|undefined} text The markdown as it was typed.
 * @returns {string} Sanitised HTML, empty for empty text.
 */
export function renderMarkdown(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.trim()) return ''
  // `breaks`, because a description is typed in a textarea where Enter means a
  // new line and markdown's "two spaces" rule is a surprise. `gfm` for tables
  // and task lists, which is what anybody writing notes expects of markdown.
  const html = marked.parse(source, { gfm: true, breaks: true, async: false })
  // `target` and `rel` are named as allowed as well as set by the hook. The
  // hook runs after attribute sanitisation, so it is what actually puts them
  // on; the allowance is what stops a link that *arrived* carrying one being
  // stripped before the hook can normalise it. That the pair really is on the
  // rendered link is asserted from the outside, in `todos-modal.spec.js`,
  // rather than reasoned about here.
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] })
}
