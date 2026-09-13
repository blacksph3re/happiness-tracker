/**
 * The icons a habit, a task or a step may wear, and the words that find them.
 *
 * A curated set rather than the whole of Unicode, and that is the point: the
 * field used to take any text at all, so a habit could be labelled `AAAA` and
 * the chip would render it as letters where an icon belongs. Choosing from a
 * list makes that unrepresentable rather than merely discouraged — there is no
 * free-text path to the stored value, so nothing has to be rejected afterwards.
 *
 * Emoji rather than an icon font: no asset pipeline, no build step, they render
 * on every device the app runs on, and they carry their own colour.
 *
 * Shared rather than in the wellbeing zone, which is where it started: a task
 * and a step carry an icon in place of their tickbox, and it must be chosen
 * rather than typed for exactly the reason a habit's must be. Reading an icon is
 * still just rendering a string, which the landing page and the streak rows do
 * without knowing anything about this list.
 */

/**
 * Every icon on offer, each with the words that should find it.
 *
 * Search terms rather than a single name, because the word somebody reaches for
 * is not always the one an emoji is called: a run is found by "run", by "jog"
 * and by "exercise", and none of those is its Unicode name.
 */
export const ICONS = [
  { icon: '🏃', terms: 'run running jog exercise cardio sport gym' },
  { icon: '🏋️', terms: 'gym weights lift strength training exercise' },
  { icon: '🚴', terms: 'bike cycle cycling ride commute' },
  { icon: '🏊', terms: 'swim swimming pool' },
  { icon: '🧘', terms: 'meditate meditation yoga calm mindfulness breathe' },
  { icon: '🚶', terms: 'walk walking steps outside stroll' },
  { icon: '⛰️', terms: 'hike hiking mountain outdoors climb' },
  { icon: '📖', terms: 'read reading book study' },
  { icon: '✍️', terms: 'write writing journal diary notes' },
  { icon: '🎸', terms: 'guitar music practice instrument play' },
  { icon: '🎹', terms: 'piano keyboard music practice' },
  { icon: '🎨', terms: 'art draw paint drawing creative' },
  { icon: '📷', terms: 'photo photography camera picture' },
  { icon: '🧑‍💻', terms: 'code coding work programming study computer' },
  { icon: '📚', terms: 'study learning course revision books' },
  { icon: '🗣️', terms: 'language speak practice conversation talk' },
  { icon: '💧', terms: 'water hydrate drink glass' },
  { icon: '🥗', terms: 'salad vegetables greens healthy eat food' },
  { icon: '🍎', terms: 'fruit apple healthy eat snack' },
  { icon: '🥦', terms: 'vegetables broccoli greens healthy' },
  { icon: '🍳', terms: 'cook cooking breakfast eggs meal' },
  { icon: '🍽️', terms: 'meal eat dinner lunch food' },
  { icon: '💊', terms: 'pills medication vitamins supplement medicine' },
  { icon: '😴', terms: 'sleep bed rest early night' },
  { icon: '⏰', terms: 'wake early alarm morning rise' },
  { icon: '🦷', terms: 'teeth floss brush dental' },
  { icon: '🚿', terms: 'shower wash cold' },
  { icon: '🧹', terms: 'clean cleaning tidy chores house' },
  { icon: '🧺', terms: 'laundry washing chores clothes' },
  { icon: '🛏️', terms: 'bed make tidy bedroom' },
  { icon: '🌱', terms: 'plants water garden grow' },
  { icon: '🐕', terms: 'dog walk pet animal' },
  { icon: '💸', terms: 'spend money budget expense' },
  { icon: '🏦', terms: 'save saving money bank budget' },
  { icon: '🚭', terms: 'smoke smoking cigarette quit nicotine' },
  { icon: '🍷', terms: 'alcohol wine drink booze' },
  { icon: '🍺', terms: 'beer alcohol drink pub' },
  { icon: '☕', terms: 'coffee caffeine tea drink' },
  { icon: '🍬', terms: 'sugar sweets candy snack treat' },
  { icon: '📱', terms: 'phone screen scrolling social media' },
  { icon: '📺', terms: 'tv television screen watch' },
  { icon: '🎮', terms: 'games gaming play console' },
  { icon: '🧑‍🤝‍🧑', terms: 'friends social people meet see' },
  { icon: '📞', terms: 'call phone family ring contact' },
  { icon: '💌', terms: 'letter message write contact' },
  { icon: '🙏', terms: 'gratitude thanks pray reflect' },
  { icon: '🌤️', terms: 'outside daylight sun fresh air' },
  { icon: '🧊', terms: 'cold plunge ice bath' },
  { icon: '🎯', terms: 'goal focus target aim' },
  { icon: '✅', terms: 'done check tick complete general' },
]

/** Every icon on offer as a plain set, for checking one is known. */
const KNOWN = new Set(ICONS.map((entry) => entry.icon))

/**
 * Report whether an icon is one this app offers.
 *
 * An empty icon is allowed and means the habit has none, which is why this is
 * not simply a set lookup.
 *
 * @param {string|null|undefined} icon
 * @returns {boolean}
 */
export function isKnownIcon(icon) {
  return !icon || KNOWN.has(icon)
}

/**
 * The icons matching what somebody has typed, best first.
 *
 * Matched on whole words starting with the query rather than on a substring
 * anywhere: "at" should not offer everything containing those two letters, and
 * a person typing three characters is naming the start of a word.
 *
 * @param {string} search What was typed. Empty offers everything.
 * @returns {Array<{icon: string, terms: string}>}
 */
export function findIcons(search) {
  const query = search.trim().toLowerCase()
  if (!query) return ICONS
  // The icon itself, pasted in from somewhere else, is a match for itself.
  if (KNOWN.has(search.trim())) {
    return ICONS.filter((entry) => entry.icon === search.trim())
  }
  return ICONS.filter((entry) =>
    entry.terms.split(' ').some((term) => term.startsWith(query))
  )
}
