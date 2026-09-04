"""Tests for the QA routing logic. Standard library only — no CrewAI, no Ollama.

Run with:  python -m unittest discover -s sidecar/crewai -p "test_*.py"

The heart of the file is `test_never_a_pass`: every unreadable reply must become
`unavailable`, and every unactionable rejection must become
`rejected_unroutable`. There is no input for which an unread critic becomes an
approval.
"""

from __future__ import annotations

import unittest

from qa_verdict import parse_qa_reply


def issue(dimension: str, severity: str = "style", detail: str = "d") -> dict[str, str]:
    return {"dimension": dimension, "severity": severity, "detail": detail}


class TestPass(unittest.TestCase):
    def test_a_clean_pass(self) -> None:
        v = parse_qa_reply('{"decision": "pass", "issues": []}')
        self.assertEqual(v.decision, "pass")

    def test_a_pass_with_no_issues_key(self) -> None:
        self.assertEqual(parse_qa_reply('{"decision": "pass"}').decision, "pass")

    def test_a_pass_wrapped_in_prose_is_still_read(self) -> None:
        # A local model routinely emits a thinking preamble before its JSON.
        # Refusing that would report a healthy critic as unavailable.
        v = parse_qa_reply('Let me think about this.\n{"decision": "pass", "issues": []}\nDone.')
        self.assertEqual(v.decision, "pass")

    def test_a_pass_that_also_lists_failures_is_REFUSED(self) -> None:
        # A contradiction is not a pass. Taking the verdict would publish text
        # the same reply calls broken; taking the issues would invent a
        # rejection the critic did not make.
        v = parse_qa_reply(
            '{"decision": "pass", "issues": [{"dimension": "voice", "severity": "style", "detail": "off"}]}'
        )
        self.assertEqual(v.decision, "rejected_unroutable")


class TestRouting(unittest.TestCase):
    def test_style_and_clarity_route_to_the_editor(self) -> None:
        for severity in ("style", "clarity"):
            with self.subTest(severity=severity):
                v = parse_qa_reply(
                    '{"decision": "revise", "issues": [%s]}'
                    % _json(issue("voice", severity))
                )
                self.assertEqual(v.decision, "revise_editor")

    def test_factual_and_content_route_to_the_writer(self) -> None:
        for severity in ("factual", "content"):
            with self.subTest(severity=severity):
                v = parse_qa_reply(
                    '{"decision": "revise", "issues": [%s]}'
                    % _json(issue("grounding", severity))
                )
                self.assertEqual(v.decision, "revise_writer")

    def test_a_known_dimension_routes_even_when_the_severity_is_unusable(self) -> None:
        # Severity is the first signal, the dimension table the second. A critic
        # that named a real dimension but garbled the severity is still
        # actionable.
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("length", "vibes"))
        )
        self.assertEqual(v.decision, "revise_editor")

        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("substance", "vibes"))
        )
        self.assertEqual(v.decision, "revise_writer")

    def test_the_FIRST_issue_decides_the_route(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("grounding", "factual")), _json(issue("voice", "style")))
        )
        self.assertEqual(v.decision, "revise_writer")
        self.assertEqual(len(v.issues), 2)


class TestNeverAPass(unittest.TestCase):
    """The rule the whole taxonomy exists to enforce (requirement 7)."""

    def test_unreadable_replies_are_unavailable(self) -> None:
        for raw in [
            None,
            "",
            "   ",
            "The post looks good to me.",
            "{not json at all}",
            '{"decision"',
            "[1, 2, 3]",
            '["decision", "pass"]',
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(parse_qa_reply(raw).decision, "unavailable")

    def test_an_undefined_decision_word_is_unavailable_not_a_pass(self) -> None:
        for word in ["approved", "ok", "looks_fine", "PASSED", ""]:
            with self.subTest(word=word):
                v = parse_qa_reply('{"decision": "%s", "issues": []}' % word)
                self.assertEqual(v.decision, "unavailable")

    def test_a_missing_decision_is_unavailable(self) -> None:
        self.assertEqual(parse_qa_reply('{"issues": []}').decision, "unavailable")


class TestUnroutable(unittest.TestCase):
    def test_a_rejection_naming_nothing(self) -> None:
        v = parse_qa_reply('{"decision": "revise", "issues": []}')
        self.assertEqual(v.decision, "rejected_unroutable")

    def test_a_rejection_with_no_issues_key(self) -> None:
        self.assertEqual(parse_qa_reply('{"decision": "revise"}').decision, "rejected_unroutable")

    def test_a_rejection_naming_an_unknown_dimension(self) -> None:
        # Never routed to whichever agent seems closest: revising against a
        # critique the router did not understand is worse than admitting it.
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("vibes", "unknowable"))
        )
        self.assertEqual(v.decision, "rejected_unroutable")

    def test_a_rejection_whose_issues_are_not_objects(self) -> None:
        v = parse_qa_reply('{"decision": "revise", "issues": ["it is bad"]}')
        self.assertEqual(v.decision, "rejected_unroutable")


class TestNormalization(unittest.TestCase):
    def test_an_unrecognised_severity_becomes_unknown_not_a_valid_one(self) -> None:
        # Coercing it to "style" would file an unroutable complaint under the
        # editor and silently make it actionable.
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("vibes", "terrible"))
        )
        self.assertEqual(v.issues[0]["severity"], "unknown")

    def test_a_missing_dimension_becomes_unknown(self) -> None:
        v = parse_qa_reply('{"decision": "revise", "issues": [{"severity": "style"}]}')
        self.assertEqual(v.issues[0]["dimension"], "unknown")
        self.assertEqual(v.decision, "revise_editor")

    def test_the_detail_is_bounded(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("voice", "style", "x" * 2000))
        )
        self.assertEqual(len(v.issues[0]["detail"]), 500)

    def test_the_dimension_is_matched_case_insensitively(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("GROUNDING", "unknown"))
        )
        self.assertEqual(v.decision, "revise_writer")


def _json(obj: dict[str, str]) -> str:
    import json

    return json.dumps(obj)


if __name__ == "__main__":
    unittest.main()
