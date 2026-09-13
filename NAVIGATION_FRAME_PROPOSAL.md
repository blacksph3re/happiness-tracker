# Nothing moves when you change view — proposal

*First draft. Asked for as a concept: "the navigation components jump left/right
when navigating between task views". Nothing is built yet, and the files it
touches are in use by three other changes, so the answers can come back before
any of it is. `[assumed: X]` marks a default that will be taken unless answered.*

## What actually moves, measured

Seeded account, fourteen tasks across five days, two lists. For each view the
left edge of every control was read with `getBoundingClientRect`, and the spread
is the largest minus the smallest across the seven views (Tasks in all five
groupings, Calendar, Lists).

| Left edge, spread across views | 1280, no scrollbar | 1280, scrollbar | 1920, scrollbar |
| --- | --- | --- | --- |
| Section links in the header | 0px | 8px | 8px |
| Page heading | **192px** | **192px** | **512px** |
| List chips | 64px | 56px | 376px |
| Grouping pills | **409px** | **402px** | **722px** |

Three causes, and they are independent of each other — fixing one leaves the
other two:

1. **The frame follows what the page draws.** A column layout draws full width
   (heading at 20px), a stacked or quadrant view centres a 72rem column (84px at
   1280, 397px at 1920), and the Lists page centres a narrower one (212px, 532px).
   This is the rule *a region's width belongs to what it draws* doing exactly
   what it says: it was written so a heading lines up with the first column of a
   wide board, and it moves the heading every time the board changes shape.
2. **A control that disappears lets everything after it slide.** Under the Lists
   grouping the list chips are hidden, because every list is a column there, and
   the grouping pills move into the space they left: 365px to 20px at 1280.
3. **The scrollbar comes and goes.** A view taller than the window gains a 15px
   scrollbar on a desktop with classic scrollbars, the page is 15px narrower, and
   everything centred moves by half of it. Headless Chromium hides scrollbars by
   default, which is why no test here has ever seen this.

**On a phone**, measured at 390 and 320 by reading each control's left and top
edge across the same seven views:

| Spread across views | Left | Top |
| --- | --- | --- |
| Page heading | 8px (the Lists page only) | 0px |
| List chips | 0px | 0px |
| Grouping pills | 0px | **46px** |

The frame *is* the screen there, so cause 1 does not arise. Cause 2 does,
vertically: under the Lists grouping the chips' row disappears and the grouping
pills move **up by 46px**. And a fourth, small cause the desktop run could not
show: the Lists page heading sits **8px** left of the Tasks and Calendar headings,
because that page narrowed its side gutter so six 44px colour swatches fit on one
row at 320. A gutter chosen per page is the same mistake as a frame chosen per
view, one size smaller.

## The concept

**One frame for the whole todo half, fixed by the screen and never by the view.**
Every todo page — Tasks in every grouping and layout, Calendar, Lists — draws
inside the same frame: full width less the gutter, capped at the width the
widest board needs, centred. At any one window size its left edge is one number.
The heading and the toolbar always sit at that edge.

**Inside the frame, content anchors left.** A column board fills the frame. A
stacked list keeps its reading width but starts at the frame's left edge instead
of centring itself, and so do the Lists page and the calendar's controls. That
keeps the rule the region-width fix was written for — the heading lines up with
the first column — and drops the part that moved it: *centred* is what changed
with every view, not *wide*.

**A toolbar ordered from stable to conditional.** Left to right: the grouping
pills, which every Tasks view has, then the list selector, which one grouping
hides. A control that can disappear sits to the right of everything that cannot,
so its absence moves nothing that stays. The layout toggle, which only some
groupings offer, is anchored to the frame's **right** edge, where its appearing
moves nothing either. Under the Lists grouping the list selector's place is kept
and says *Every list is a column*, so the row does not change height on a phone
either.

**The scrollbar's room is always reserved.** `scrollbar-gutter: stable` on the
root element, so a short view and a tall one are the same width. On a system with
overlay scrollbars it changes nothing at all.

**One gutter for the half.** The frame owns the side gutter, so no page picks its
own. The Lists page needed 12px on a phone to fit six 44px swatches at 320, and
reopening that measured fix to win back 8px would be worse than giving every todo
page the same 12px at phone width. `[assumed: 12px on a phone for the whole todo
half, 20px from the small breakpoint up, as today]`

## What it costs

- **A stacked list on a wide screen sits left, not centred.** At 1920 the Date
  grouping's list starts at the frame's left edge with empty page to its right,
  where today it is centred. This is the visible price of nothing moving, and it
  is the one real trade-off here. `[assumed: accepted]`
- **The scrollbar gutter is app-wide.** The jump happens in every half — a long
  Record table against a short Patterns page does it too — and a rule on the root
  element cannot be scoped to one section without being the wrong rule.
  `[assumed: app-wide]`
- **`CLAUDE.md` changes one rule.** *A region's width belongs to what it draws*
  becomes *the todo half has one frame, and content anchors left inside it*. The
  half of the old rule that still holds — a heading lines up with the first column
  — is kept by construction.
- **The grouping pills move to the front of the toolbar**, ahead of the list
  chips, which is a change a returning user will notice once. `[assumed: fine]`

## Tests

One browser test walks every view — Tasks in all five groupings and both layouts
where two exist, Calendar, Lists — at 1280, 1920, 390 and 320, and reads the left
edge of the header's section links, the heading and the grouping pills in every
view. **"Nothing moves" is a negative claim**, so it samples every view and
asserts the worst spread is zero, rather than polling until one pair agrees.
A second assertion reads `scrollbar-gutter` on the root, because headless
Chromium hides scrollbars and would pass against cause 3 however broken it was. At 390 and 320 the same
test also reads each control's **top** edge, since a phone's jump is vertical —
the grouping row's top must not change between the Lists grouping and the rest.

Probes, each failing that test by name: a stacked view centred again; the list
chips placed before the grouping pills; the layout toggle placed in the flow;
the gutter rule removed (the computed-style assertion).

## Open questions, marked as defaults

1. A stacked view anchored left on a wide screen rather than centred. `[assumed: yes]`
2. The scrollbar gutter reserved app-wide. `[assumed: app-wide]`
3. Grouping pills first, list chips second, layout toggle at the right edge. `[assumed: yes]`
4. Under the Lists grouping, the list selector's place kept with *Every list is a column*. `[assumed: yes]`
5. One side gutter for every todo page: 12px on a phone, 20px above it. `[assumed: yes]`
