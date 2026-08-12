import pytest


def test_the_application_is_type_checked_at_runtime():
    # A guard on a guard. The beartype hook in conftest turns every annotation
    # in the application into an assertion for the duration of the suite; if it
    # ever stops being installed, that checking disappears and no other test
    # would notice.
    from beartype.roar import BeartypeCallHintParamViolation

    import services

    with pytest.raises(BeartypeCallHintParamViolation):
        services.score_for_day("not a question", {})
