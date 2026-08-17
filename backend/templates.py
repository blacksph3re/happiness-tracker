"""Starter question sets an account can be built from.

Defined in code rather than as rows, and that is the point of them. A template
stored in the database would be a catalogue belonging to nobody — the exact
thing per-user catalogues removed — and maintaining it would need the editing
permission back that the same change dropped. Here they are read-only by
construction, identical for every account, and changed by a deployment rather
than by an API call.

A template is a starting point and nothing more. Building a catalogue from one
copies its questions in; it does not link them, so changing a template later
leaves every catalogue already made from it alone.

Starting from nothing needs no template: `POST /api/catalogues` already creates
an empty catalogue, carrying only the auto-tracked questions every catalogue
has.
"""

from dataclasses import dataclass

WHO5_PROMPTS = (
    "I have felt cheerful and in good spirits",
    "I have felt calm and relaxed",
    "I have felt active and vigorous",
    "I woke up feeling fresh and rested",
    "My daily life has been filled with things that interest me",
)
"""The five items of the WHO-5 Well-Being Index, in their published order.

Reproduced verbatim so the catalogue stays comparable with the instrument. The
WHO-5 is validated over a two-week recall window, so a daily reading is an
adaptation: the trend is meaningful, the published clinical cut-offs are not.
"""

WHO5_BOUNDS = (0.0, 5.0, "At no time", "All of the time")
"""The WHO-5 response scale: a six-point frequency rating from 0 to 5."""

SCORE_POSITION = 500
"""Where a template's score sorts: after the questions it reads, before the
auto-tracked variables, which start at 1000."""


@dataclass(frozen=True)
class ScaledQuestion:
    """One scaled question in a template."""

    prompt: str
    """The question as it is asked."""

    bounds: tuple[float, float, str, str]
    """Low value, high value, and the label at each end."""


@dataclass(frozen=True)
class Template:
    """A named set of questions a catalogue can be built from."""

    name: str
    """What the catalogue is called when it is created. Editable afterwards."""

    description: str
    """One line, shown beside the name wherever a template is offered."""

    questions: tuple[ScaledQuestion, ...] = ()
    """The asked questions, in display order."""

    score: str | None = None
    """Name of a total over every question above, or None for no score.

    Seeded as catalogue data exactly as the questions are: nothing in the code
    knows what the WHO-5 is or that its items are meant to be added up.
    """


CATALOGUE_TEMPLATES: dict[str, Template] = {
    "who-5": Template(
        name="WHO-5",
        description=(
            "The five-item WHO-5 Well-Being Index, on a six-point frequency "
            "scale, with a raw score over them."
        ),
        questions=tuple(
            ScaledQuestion(prompt=prompt, bounds=WHO5_BOUNDS) for prompt in WHO5_PROMPTS
        ),
        score="Raw score",
    ),
}
"""Every template on offer, keyed by the identifier the API accepts."""

DEFAULT_TEMPLATE = "who-5"
"""What a new account is built from when nothing else is asked for."""
