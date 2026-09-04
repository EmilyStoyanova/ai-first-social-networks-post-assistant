"""The four routing scenarios, driven deterministically through the REAL loop.

Run on the Mac (needs CrewAI installed; needs no Ollama and makes no model call):

    python -m unittest test_flow_routing -v

── Why this exists, and why it is not a throwaway POC ──────────────────────

Scenarios 2, 3 and 4 need QA to REJECT on cue, and a real model cannot be made
to do that reliably — asking Qwen to fail its own reviewer is not a test, it is
a coin toss. So this exercises `crew_flow.run_flow` — the actual production
function, with its actual counters, its actual `parse_qa_reply`, its actual
Editor re-entry and its actual degradation handling — and stubs exactly ONE
thing: `_run_single`, the single seam where an agent call leaves the process.

Everything the scenarios are about therefore runs for real. What is replaced is
only the model's reply, which is the one part that cannot be scripted any other
way. The live path (real Ollama, real Qwen, real HTTP) is covered separately by
scenario 1 in README.md §3, so the two together cover both halves.

The stub is keyed on the agent's ROLE rather than on call order, because keying
on order would encode the very sequence under test and pass even if the loop
called the agents in the wrong one.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

import crew_flow


def post_json(text: str = "A perfectly good post about the coast.") -> str:
    return json.dumps(
        {
            "text": text,
            "hashtags": ["coast"],
            "coreMessage": "The protest is about protected-area rules, not tourism in general.",
            "topic": "coastal development",
        }
    )


def qa_pass() -> str:
    return json.dumps({"decision": "pass", "issues": []})


def qa_revise(dimension: str, severity: str) -> str:
    return json.dumps(
        {
            "decision": "revise",
            "issues": [{"dimension": dimension, "severity": severity, "detail": "needs work"}],
        }
    )


REQUEST = {
    "articleUnderstanding": {
        "mainSubject": "Residents are protesting new tourism development in a protected area.",
        "centralThesis": None,
        "centralConflict": None,
        "articleType": "news",
        "secondaryTopics": ["tourism"],
        "incidentalTopics": ["beaches"],
        "entities": [],
        "confidence": 0.8,
        "source": "understanding",
    },
    "platform": "facebook",
    "language": "bg",
    "brandContext": {
        "companyName": "Example Ltd",
        "companyDescription": None,
        "toneOfVoice": None,
        "targetAudience": None,
        "forbiddenWords": [],
    },
    "generationRequirements": {
        "systemPrompt": "sys",
        "userPrompt": "user",
        "maxTextLength": 2000,
        "responseContract": "llm_post_json",
    },
    "inferenceConfig": {
        "model": "qwen3.5:35b-a3b-q4_K_M",
        "baseUrl": "http://127.0.0.1:11434",
        "temperature": 0.85,
    },
    "attemptContext": {"attempt": 1, "maxAttempts": 3, "maxQaRounds": 2, "previousRejection": None},
}


class ScriptedAgents:
    """Replies per ROLE, consumed in order within each role.

    Records the call ORDER across roles, which is what the Editor-bypass
    assertions actually read: counters alone cannot distinguish
    `Writer → Editor → QA` from `Writer → QA → Editor`.
    """

    def __init__(self, writer: list[str], editor: list[str], qa: list[str]) -> None:
        self.scripts = {"writer": list(writer), "editor": list(editor), "qa": list(qa)}
        self.order: list[str] = []

    def __call__(self, agent, description: str, expected_output: str) -> str:
        role = agent.role.lower()
        if "writer" in role:
            key = "writer"
        elif "editor" in role:
            key = "editor"
        else:
            key = "qa"
        self.order.append(key)
        script = self.scripts[key]
        # The last entry repeats, so a script need only describe what varies.
        return script.pop(0) if len(script) > 1 else script[0]


class RoutingScenarios(unittest.TestCase):
    def run_with(self, scripted: ScriptedAgents, request: dict | None = None):
        with mock.patch.object(crew_flow, "_run_single", side_effect=scripted):
            return crew_flow.run_flow(request or REQUEST)

    # ── Scenario 1: Writer → Editor → QA → PASS ─────────────────────────────
    def test_1_normal_pass(self) -> None:
        scripted = ScriptedAgents([post_json()], [post_json()], [qa_pass()])
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "pass")
        self.assertEqual(result.counters.revisions, 0)
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (1, 1, 1)
        )
        self.assertEqual(scripted.order, ["writer", "editor", "qa"])
        self.assertEqual(result.counters.routes, [])
        self.assertEqual(result.counters.degraded_stages, [])

    # ── Scenario 2: QA → Editor → QA ────────────────────────────────────────
    def test_2_editor_routed_revision(self) -> None:
        # A style complaint: the Editor fixes it, the Writer is not re-run.
        scripted = ScriptedAgents(
            [post_json()],
            [post_json(), post_json("An edited post.")],
            [qa_revise("voice", "style"), qa_pass()],
        )
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "pass")
        self.assertEqual(result.counters.revisions, 1)
        self.assertEqual(result.counters.routes, ["editor"])
        # 3 + 2R at R=1.
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (1, 2, 2)
        )
        self.assertEqual(scripted.order, ["writer", "editor", "qa", "editor", "qa"])

    # ── Scenario 3: QA → Writer → Editor → QA ───────────────────────────────
    def test_3_writer_routed_revision_re_enters_the_editor(self) -> None:
        # THE scenario. A factual complaint routes to the Writer, and the
        # Writer's new text MUST pass through the Editor before QA sees it.
        scripted = ScriptedAgents(
            [post_json(), post_json("A rewritten post.")],
            [post_json(), post_json("An edited rewrite.")],
            [qa_revise("grounding", "factual"), qa_pass()],
        )
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "pass")
        self.assertEqual(result.counters.revisions, 1)
        self.assertEqual(result.counters.routes, ["writer"])
        # 3 + 3R at R=1 — NOT 3 + 2R.
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (2, 2, 2)
        )
        # The order is the proof, not the counts: the Editor sits between the
        # Writer's revision and the QA that judged it.
        self.assertEqual(
            scripted.order, ["writer", "editor", "qa", "writer", "editor", "qa"]
        )

    def test_3b_no_writer_revision_ever_reaches_qa_unedited(self) -> None:
        """Requirement 6, asserted over the call ORDER for every writer round."""
        scripted = ScriptedAgents(
            [post_json()],
            [post_json()],
            [qa_revise("substance", "content"), qa_revise("accuracy", "factual"), qa_pass()],
        )
        result = self.run_with(scripted)

        self.assertEqual(result.counters.routes, ["writer", "writer"])
        order = scripted.order
        # Walk the sequence: every "writer" must be followed by an "editor"
        # before the next "qa".
        for i, call in enumerate(order):
            if call != "writer":
                continue
            rest = order[i + 1 :]
            self.assertTrue(rest, f"writer at {i} was the last call")
            next_qa = rest.index("qa") if "qa" in rest else len(rest)
            self.assertIn(
                "editor",
                rest[:next_qa],
                f"the writer call at index {i} reached QA without an Editor pass: {order}",
            )

    # ── Scenario 4: non-convergence and parse failure are NOT a pass ────────
    def test_4a_exhausted_rounds_become_rejected_unroutable(self) -> None:
        # A critic that never converges. The loop stops at maxQaRounds and
        # reports a NON-TERMINAL verdict as unroutable, never as a pass.
        scripted = ScriptedAgents(
            [post_json()], [post_json()], [qa_revise("voice", "style")]
        )
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "rejected_unroutable")
        self.assertNotEqual(result.qa.decision, "pass")
        self.assertEqual(result.counters.revisions, 2)
        self.assertEqual(result.counters.routes, ["editor", "editor"])
        # 3 + 2R at R=2, all editor-routed.
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (1, 3, 3)
        )

    def test_4b_all_writer_routed_exhaustion_is_3_plus_3R(self) -> None:
        scripted = ScriptedAgents(
            [post_json()], [post_json()], [qa_revise("grounding", "factual")]
        )
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "rejected_unroutable")
        self.assertEqual(result.counters.routes, ["writer", "writer"])
        # 3 + 3R at R=2 = 9 calls.
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (3, 3, 3)
        )
        self.assertEqual(
            result.counters.writer + result.counters.editor + result.counters.qa, 9
        )

    def test_4c_an_unparseable_qa_reply_is_unavailable_not_a_pass(self) -> None:
        scripted = ScriptedAgents(
            [post_json()], [post_json()], ["The post looks great to me!"]
        )
        result = self.run_with(scripted)

        self.assertEqual(result.qa.decision, "unavailable")
        self.assertNotEqual(result.qa.decision, "pass")
        self.assertIn("qa", result.counters.degraded_stages)
        # The candidate SURVIVES: the caller's deterministic gates become the
        # whole verdict. Degraded, not discarded.
        self.assertTrue(result.candidate)

    def test_4d_a_qa_that_raises_is_unavailable_not_a_pass(self) -> None:
        def explode(agent, description, expected_output):
            if "review" in agent.role.lower():
                raise RuntimeError("ollama went away")
            return post_json()

        with mock.patch.object(crew_flow, "_run_single", side_effect=explode):
            result = crew_flow.run_flow(REQUEST)

        self.assertEqual(result.qa.decision, "unavailable")
        self.assertIn("qa", result.counters.degraded_stages)
        self.assertTrue(result.candidate)

    def test_4e_a_rejection_naming_nothing_actionable_is_unroutable(self) -> None:
        scripted = ScriptedAgents(
            [post_json()],
            [post_json()],
            [json.dumps({"decision": "revise", "issues": []})],
        )
        result = self.run_with(scripted)
        self.assertEqual(result.qa.decision, "rejected_unroutable")
        # It ended the inner loop immediately rather than spending revisions on
        # a complaint it could not act on.
        self.assertEqual(result.counters.revisions, 0)


class DegradationAndBounds(unittest.TestCase):
    def test_a_failed_editor_degrades_and_keeps_the_previous_text(self) -> None:
        def flaky(agent, description, expected_output):
            role = agent.role.lower()
            if "editor" in role:
                raise RuntimeError("editor stage broke")
            if "writer" in role:
                return post_json("The writer's own draft.")
            return qa_pass()

        with mock.patch.object(crew_flow, "_run_single", side_effect=flaky):
            result = crew_flow.run_flow(REQUEST)

        self.assertIn("editor", result.counters.degraded_stages)
        # A broken polish step must not turn a usable post into no post.
        self.assertIn("The writer's own draft.", result.candidate)
        self.assertEqual(result.qa.decision, "pass")

    def test_a_writer_that_produces_nothing_RAISES(self) -> None:
        # The one genuine exception: with no candidate there is nothing to judge
        # and nothing to save, so the HTTP layer reports `unavailable`.
        scripted = ScriptedAgents([""], [post_json()], [qa_pass()])
        with self.assertRaises(RuntimeError):
            self.run_with(scripted)

    def run_with(self, scripted: ScriptedAgents):
        with mock.patch.object(crew_flow, "_run_single", side_effect=scripted):
            return crew_flow.run_flow(REQUEST)

    def test_maxQaRounds_zero_makes_no_revision_at_all(self) -> None:
        request = {
            **REQUEST,
            "attemptContext": {**REQUEST["attemptContext"], "maxQaRounds": 0},
        }
        scripted = ScriptedAgents(
            [post_json()], [post_json()], [qa_revise("voice", "style")]
        )
        with mock.patch.object(crew_flow, "_run_single", side_effect=scripted):
            result = crew_flow.run_flow(request)

        self.assertEqual(result.counters.revisions, 0)
        self.assertEqual(
            (result.counters.writer, result.counters.editor, result.counters.qa), (1, 1, 1)
        )
        self.assertEqual(result.qa.decision, "rejected_unroutable")

    def test_the_loopback_guard_refuses_a_remote_ollama(self) -> None:
        with self.assertRaises(ValueError):
            crew_flow.build_llm(
                {"model": "qwen3.5:35b-a3b-q4_K_M", "baseUrl": "http://10.0.0.5:11434"}
            )


if __name__ == "__main__":
    unittest.main()
