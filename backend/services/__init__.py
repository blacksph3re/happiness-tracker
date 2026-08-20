"""Domain rules, framework-free, split by the part of the app they belong to.

`wellbeing` holds the question, score and auto-tracked-answer rules, `timetrack`
the project and session rules, `pomodoro` the focus-timer rules. None of the
three imports another. What more than one of them needs lives in `clock`, which
is how `local_day` got there: a session and a pomodoro both have to agree which
local day a UTC instant lands in.

Everything public is re-exported, so a caller writes ``from services import
score_for_day`` without caring which half it lives in.
"""

from services.clock import (
    MAX_UTC_OFFSET,
    MIN_UTC_OFFSET,
    local_day,
    offset_is_real,
)
from services.pomodoro import (
    ABANDONED,
    COMPLETE,
    RUNNING,
    PomodoroRuleError,
    Transferable,
    check_pomodoro_shape,
    effective_end,
    elapsed_seconds,
    planned_end,
    pomodoro_state,
    split_seconds,
    transferable,
)
from services.timetrack import (
    TimeRuleError,
    added_for,
    check_entry_shape,
    check_no_overlap,
    daily_slices,
    day_offsets,
    deduction_for,
    duration_seconds,
    group_by_tag,
    reported,
    starting_day,
    summarise,
)
from services.wellbeing import (
    MONTH_LABELS,
    SYSTEM_QUESTION_SPECS,
    WEEKDAY_LABELS,
    QuestionRuleError,
    ScoreRuleError,
    build_from_template,
    check_answer,
    check_question_bounds,
    check_question_options,
    check_question_shape,
    check_score_shape,
    create_catalogue,
    question_is_answered,
    score_bounds,
    score_for_day,
    sync_system_answers,
)

__all__ = [
    "ABANDONED",
    "COMPLETE",
    "RUNNING",
    "MAX_UTC_OFFSET",
    "MIN_UTC_OFFSET",
    "PomodoroRuleError",
    "Transferable",
    "check_pomodoro_shape",
    "effective_end",
    "elapsed_seconds",
    "local_day",
    "offset_is_real",
    "planned_end",
    "pomodoro_state",
    "split_seconds",
    "transferable",
    "check_answer",
    "MONTH_LABELS",
    "SYSTEM_QUESTION_SPECS",
    "WEEKDAY_LABELS",
    "QuestionRuleError",
    "ScoreRuleError",
    "TimeRuleError",
    "added_for",
    "check_entry_shape",
    "check_no_overlap",
    "check_question_bounds",
    "check_question_options",
    "check_question_shape",
    "check_score_shape",
    "build_from_template",
    "create_catalogue",
    "daily_slices",
    "day_offsets",
    "deduction_for",
    "duration_seconds",
    "group_by_tag",
    "question_is_answered",
    "reported",
    "score_bounds",
    "score_for_day",
    "starting_day",
    "summarise",
    "sync_system_answers",
]
