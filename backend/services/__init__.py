"""Domain rules, framework-free, split by the part of the app they belong to.

`wellbeing` holds the question, score and auto-tracked-answer rules; `timetrack`
holds the project and session rules. Neither imports the other — anything both
needed would belong here instead, and nothing does yet.

Everything public is re-exported, so a caller writes ``from services import
score_for_day`` without caring which half it lives in.
"""

from services.timetrack import (
    TimeRuleError,
    check_entry_shape,
    daily_slices,
    duration_seconds,
    group_by_tag,
    summarise,
)
from services.wellbeing import (
    MONTH_LABELS,
    SYSTEM_QUESTION_SPECS,
    WEEKDAY_LABELS,
    QuestionRuleError,
    ScoreRuleError,
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
    "MONTH_LABELS",
    "SYSTEM_QUESTION_SPECS",
    "WEEKDAY_LABELS",
    "QuestionRuleError",
    "ScoreRuleError",
    "TimeRuleError",
    "check_entry_shape",
    "check_question_bounds",
    "check_question_options",
    "check_question_shape",
    "check_score_shape",
    "create_catalogue",
    "daily_slices",
    "duration_seconds",
    "group_by_tag",
    "question_is_answered",
    "score_bounds",
    "score_for_day",
    "summarise",
    "sync_system_answers",
]
