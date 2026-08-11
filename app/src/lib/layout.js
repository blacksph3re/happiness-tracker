/**
 * The height the answer area holds on a wide screen.
 *
 * A scale, a slider and the closing card are different shapes, and left to
 * their own content they came out three different heights - so the frame
 * flickered as the run moved between question kinds. This is a floor, not a
 * fixed height: an enum whose labels are long enough to need more room takes
 * it rather than clipping.
 */
export const ANSWER_MIN_HEIGHT = 'md:min-h-56'
