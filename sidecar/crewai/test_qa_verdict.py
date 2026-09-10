"""Tests for the QA routing logic. Standard library only — no CrewAI, no Ollama.

Run with:  python -m unittest discover -s sidecar/crewai -p "test_*.py"

The heart of the file is `test_never_a_pass`: every unreadable reply must become
`unavailable`, and every unactionable rejection must become
`rejected_unroutable`. There is no input for which an unread critic becomes an
approval.
"""

from __future__ import annotations

import unittest

from qa_verdict import (
    ADVISORY_DIMENSION_ORDER,
    ADVISORY_DIMENSIONS,
    EDITOR_DIMENSIONS,
    QA_DIMENSION_ORDER,
    QA_VERDICT_RESPONSE_FORMAT,
    SEVERITY_ORDER,
    VALID_SEVERITIES,
    WRITER_DIMENSIONS,
    parse_qa_reply,
)


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


class TestResponseFormatSchema(unittest.TestCase):
    """The constraint Ollama compiles, and its one source of truth.

    The schema exists to make `rejected_unroutable`-by-vocabulary unreachable:
    a critic that cannot SAY an unknown dimension cannot produce a complaint the
    router must refuse. That guarantee holds only while the enum and the routing
    table are the same list, which is what these tests pin.
    """

    def _issue_properties(self) -> dict:
        return QA_VERDICT_RESPONSE_FORMAT["json_schema"]["schema"]["properties"]["issues"][
            "items"
        ]["properties"]

    def test_it_is_a_strict_json_schema_envelope(self) -> None:
        self.assertEqual(QA_VERDICT_RESPONSE_FORMAT["type"], "json_schema")
        envelope = QA_VERDICT_RESPONSE_FORMAT["json_schema"]
        self.assertEqual(envelope["name"], "QaVerdict")
        self.assertIs(envelope["strict"], True)

    def test_the_dimension_enum_IS_the_routing_table(self) -> None:
        # Not "contains" — equal as a set. An enum offering a dimension the
        # router does not know would reintroduce the unroutable verdict; an
        # enum missing one the router accepts would silently narrow the critic.
        enum = self._issue_properties()["dimension"]["enum"]
        self.assertEqual(set(enum), EDITOR_DIMENSIONS | WRITER_DIMENSIONS)
        self.assertEqual(enum, list(QA_DIMENSION_ORDER))
        self.assertEqual(len(enum), len(set(enum)))

    def test_the_severity_enum_IS_the_canonical_severity_set(self) -> None:
        enum = self._issue_properties()["severity"]["enum"]
        self.assertEqual(set(enum), VALID_SEVERITIES)
        self.assertEqual(enum, list(SEVERITY_ORDER))

    def test_every_enumerated_dimension_actually_routes(self) -> None:
        # The strongest form of "schema and router cannot drift": drive each
        # value the model is permitted to emit through the real parser and
        # require a NON-`rejected_unroutable` terminal outcome. A blocking
        # dimension routes for revision; an advisory one (`angle`/`hook`/`cta`)
        # converges to `pass` with the note kept — never a stuck rejection.
        for dimension in QA_DIMENSION_ORDER:
            for severity in SEVERITY_ORDER:
                with self.subTest(dimension=dimension, severity=severity):
                    verdict = parse_qa_reply(
                        '{"decision": "revise", "issues": [%s]}'
                        % _json(issue(dimension, severity))
                    )
                    if dimension in ADVISORY_DIMENSIONS:
                        self.assertEqual(verdict.decision, "pass")
                        self.assertEqual(len(verdict.issues), 1)
                    else:
                        self.assertIn(verdict.decision, {"revise_writer", "revise_editor"})

    def test_the_decision_enum_is_what_the_MODEL_may_say(self) -> None:
        # Two words, not the five `QaDecision` states — the other three are
        # DERIVED by the router from the decision plus the issues.
        schema = QA_VERDICT_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertEqual(schema["properties"]["decision"]["enum"], ["pass", "revise"])

    def test_unspecified_keys_are_forbidden_at_both_levels(self) -> None:
        schema = QA_VERDICT_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertIs(schema["additionalProperties"], False)
        self.assertIs(schema["properties"]["issues"]["items"]["additionalProperties"], False)

    def test_required_fields_are_explicit(self) -> None:
        schema = QA_VERDICT_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertEqual(sorted(schema["required"]), ["decision", "issues"])
        self.assertEqual(
            sorted(schema["properties"]["issues"]["items"]["required"]),
            ["detail", "dimension", "severity"],
        )

    def test_a_schema_valid_pass_and_a_schema_valid_revise_both_parse(self) -> None:
        # The constraint narrows what the critic may say; `parse_qa_reply`
        # stays authoritative over what it means.
        self.assertEqual(parse_qa_reply('{"decision": "pass", "issues": []}').decision, "pass")
        self.assertEqual(
            parse_qa_reply(
                '{"decision": "revise", "issues": [%s]}' % _json(issue("grounding", "factual"))
            ).decision,
            "revise_writer",
        )

    def test_the_constraint_does_NOT_remove_rejected_unroutable(self) -> None:
        # A schema-valid `revise` naming nothing is still unroutable, and a
        # schema-valid `revise` after the last allowed round is a genuine
        # convergence failure the loop must still be able to report.
        self.assertEqual(
            parse_qa_reply('{"decision": "revise", "issues": []}').decision,
            "rejected_unroutable",
        )


class TestAdvisoryDimensions(unittest.TestCase):
    """Rotation guidance (`angle`/`hook`/`cta`) is a note, never a blocker.

    Parity with the rest of the generation system: `generation-compliance`
    lists exactly these under `notChecked` and the single-agent path never
    revises for them, so QA cannot fail a whole outer attempt on them either. A
    rejection whose ONLY issues are advisory converges to `pass` with the notes
    kept; a blocking issue alongside still routes and can still exhaust to
    `rejected_unroutable`.
    """

    def test_the_advisory_set_is_a_subset_of_the_schema_enum(self) -> None:
        # The critic can only emit what the schema enumerates; every advisory
        # dimension must therefore be one the model is actually allowed to say.
        self.assertTrue(ADVISORY_DIMENSIONS.issubset(set(QA_DIMENSION_ORDER)))
        self.assertEqual(list(ADVISORY_DIMENSION_ORDER), ["angle", "hook", "cta"])

    def test_the_advisory_set_touches_nothing_that_must_block(self) -> None:
        # None of the genuinely mandatory dimensions may leak into the advisory
        # set, or a real failure would be silently downgraded to a note.
        must_block = {
            "grounding",
            "accuracy",
            "substance",
            "factual",
            "content",
            "forbidden_term",
            "language_quality",
        }
        self.assertEqual(ADVISORY_DIMENSIONS & must_block, set())

    # ── 1 & 2 & 3: a lone soft issue cannot terminally reject ───────────────
    def test_angle_alone_cannot_block(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}'
            % _json(issue("angle", "content", "not framed as an industry trend"))
        )
        self.assertEqual(v.decision, "pass")

    def test_cta_alone_cannot_block(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}'
            % _json(issue("cta", "content", "no reflection-style call to action"))
        )
        self.assertEqual(v.decision, "pass")

    def test_hook_alone_cannot_block(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("hook", "style", "weak hook"))
        )
        self.assertEqual(v.decision, "pass")

    def test_several_advisory_issues_together_still_only_a_pass(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("angle", "content")), _json(issue("cta", "style")))
        )
        self.assertEqual(v.decision, "pass")

    def test_the_advisory_note_is_kept_on_the_verdict(self) -> None:
        # Downgraded to non-blocking, NOT discarded — the detail still reaches
        # the trace so a human can see what the critic flagged.
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}'
            % _json(issue("angle", "content", "reads as a single-hotel feature"))
        )
        self.assertEqual(v.decision, "pass")
        self.assertEqual(len(v.issues), 1)
        self.assertEqual(v.issues[0]["dimension"], "angle")
        self.assertEqual(v.issues[0]["detail"], "reads as a single-hotel feature")

    # ── 4: a blocking issue alongside advisory still routes ─────────────────
    def test_a_blocking_issue_after_an_advisory_one_still_routes_writer(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("angle", "content")), _json(issue("grounding", "factual")))
        )
        self.assertEqual(v.decision, "revise_writer")
        self.assertEqual(len(v.issues), 2)

    def test_a_blocking_issue_before_an_advisory_one_still_routes_writer(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("grounding", "factual")), _json(issue("cta", "content")))
        )
        self.assertEqual(v.decision, "revise_writer")

    def test_an_advisory_issue_alongside_an_editor_issue_routes_editor(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("hook", "style")), _json(issue("language_quality", "style")))
        )
        self.assertEqual(v.decision, "revise_editor")

    # ── 5 & 6: genuinely mandatory dimensions still reject ──────────────────
    def test_language_quality_still_blocks(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}'
            % _json(issue("language_quality", "style", "calque from English, unnatural Bulgarian"))
        )
        self.assertEqual(v.decision, "revise_editor")

    def test_forbidden_term_still_blocks(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}'
            % _json(issue("forbidden_term", "style", "uses a banned word"))
        )
        self.assertEqual(v.decision, "revise_editor")

    def test_factual_and_grounding_still_route_to_the_writer(self) -> None:
        for dimension in ("factual", "grounding", "accuracy", "substance", "content"):
            with self.subTest(dimension=dimension):
                v = parse_qa_reply(
                    '{"decision": "revise", "issues": [%s]}'
                    % _json(issue(dimension, "content"))
                )
                self.assertEqual(v.decision, "revise_writer")

    # ── regressions: the filter must not weaken the other refusals ──────────
    def test_an_unknown_dimension_alone_is_still_unroutable(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s]}' % _json(issue("vibes", "unknowable"))
        )
        self.assertEqual(v.decision, "rejected_unroutable")

    def test_an_unknown_dimension_alongside_advisory_is_still_unroutable(self) -> None:
        v = parse_qa_reply(
            '{"decision": "revise", "issues": [%s, %s]}'
            % (_json(issue("cta", "style")), _json(issue("vibes", "unknowable")))
        )
        self.assertEqual(v.decision, "rejected_unroutable")

    def test_an_empty_revise_is_still_unroutable(self) -> None:
        self.assertEqual(
            parse_qa_reply('{"decision": "revise", "issues": []}').decision,
            "rejected_unroutable",
        )

    def test_a_pass_that_lists_only_advisory_failures_is_still_refused(self) -> None:
        # `decision: pass` + issues is a self-contradiction regardless of which
        # dimensions — the advisory downgrade applies only to `revise`.
        v = parse_qa_reply(
            '{"decision": "pass", "issues": [%s]}' % _json(issue("angle", "content"))
        )
        self.assertEqual(v.decision, "rejected_unroutable")


def _json(obj: dict[str, str]) -> str:
    import json

    return json.dumps(obj)


if __name__ == "__main__":
    unittest.main()
