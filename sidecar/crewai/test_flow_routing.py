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
import qa_verdict


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


class QaAspectRubric(unittest.TestCase):
    """ISSUE 1 regression — QA must not reject solely on `coreMessage != aspect`.

    The failure class discovered in the Test 2 validation run:
      - the source article is fundamentally a reader competition (prize,
        eligibility, closing date);
      - the mined aspect is "seasonal autumn actions like foraging, stargazing";
      - the post BODY materially discusses those seasonal actions;
      - the `coreMessage` truthfully summarises the competition / prize / who may
        enter;
      - QA then rejected `content`/`factual` for the coreMessage "not restating
        the mandated aspect", burned both revision rounds, and the whole outer
        attempt was lost as `rejected_unroutable`.

    A real model cannot be scripted to reject on cue, so what is asserted here is
    (a) the scoping rubric reaches QA on the SAME call the reviewer judges from,
    and (b) when QA follows it, the real loop converges to `pass`.
    """

    COMPETITION_REQUEST = {
        **REQUEST,
        "articleUnderstanding": {
            **REQUEST["articleUnderstanding"],
            "mainSubject": (
                "A weekly reader competition: share a UK autumn day-out tip to win a "
                "200-pound voucher; UK residents only; closes in one week."
            ),
        },
        "generationRequirements": {
            **REQUEST["generationRequirements"],
            "systemPrompt": "sys",
            "userPrompt": (
                "Write about this competition article. Mandatory aspect to build the post "
                "body around: suggest specific seasonal autumn actions like foraging, "
                "stargazing, or visiting fiery gardens."
            ),
        },
    }

    # Body honours the aspect (foraging / stargazing); coreMessage states the
    # competition fact — factual, specific, article-supported.
    CANDIDATE = json.dumps(
        {
            "text": (
                "Autumn in the UK is the season to get outside — forage for berries, "
                "stargaze on a clear night, or walk a garden ablaze with colour."
            ),
            "hashtags": ["autumn"],
            "coreMessage": (
                "The weekly competition lets UK residents win a 200-pound voucher for "
                "sharing their best autumn day-out tip."
            ),
            "topic": "UK autumn competition",
        }
    )

    def test_the_aspect_rubric_reaches_qa_on_the_call_it_judges_from(self) -> None:
        seen: dict[str, str] = {}

        def capture(agent, description: str, expected_output: str) -> str:
            role = agent.role.lower()
            if "review" in role or "quality" in role:
                seen["qa"] = description
                return qa_pass()
            return self.CANDIDATE

        with mock.patch.object(crew_flow, "_run_single", side_effect=capture):
            result = crew_flow.run_flow(self.COMPETITION_REQUEST)

        self.assertEqual(result.qa.decision, "pass")
        qa_text = seen["qa"].lower()
        # The reviewer is told the coreMessage need not match the aspect …
        self.assertIn("coremessage", qa_text)
        self.assertIn("aspect", qa_text)
        self.assertTrue(
            "not require" in qa_text
            or "do not require" in qa_text
            or "need not" in qa_text
            or "not merely because" in qa_text,
            f"QA task is missing the coreMessage/aspect scoping rubric:\n{seen['qa']}",
        )
        # … and it still received the mandated aspect itself to judge the body against.
        self.assertIn("foraging", qa_text)

    def test_loop_converges_to_pass_when_qa_follows_the_rubric(self) -> None:
        # QA obeys the rubric: the body honours the aspect and the coreMessage is
        # a supported fact, so it passes on the first judge call — no revision
        # rounds, no rejected_unroutable.
        scripted = ScriptedAgents([self.CANDIDATE], [self.CANDIDATE], [qa_pass()])
        with mock.patch.object(crew_flow, "_run_single", side_effect=scripted):
            result = crew_flow.run_flow(self.COMPETITION_REQUEST)

        self.assertEqual(result.qa.decision, "pass")
        self.assertNotEqual(result.qa.decision, "rejected_unroutable")
        self.assertEqual(result.counters.revisions, 0)


class StructuredCandidateOutput(unittest.TestCase):
    """The response_format constraint and the Python-side validation boundary.

    Neither needs Ollama: `_prepare_completion_params` is offline, and
    `_run_single` is stubbed so no model call happens.
    """

    def _capture_llms(self, scripted: ScriptedAgents):
        captured: dict[str, object] = {}
        real = crew_flow.build_agents

        def capturing(candidate_llm, qa_llm):
            captured["candidate_llm"] = candidate_llm
            captured["qa_llm"] = qa_llm
            return real(candidate_llm, qa_llm)

        with mock.patch.object(crew_flow, "build_agents", side_effect=capturing), mock.patch.object(
            crew_flow, "_run_single", side_effect=scripted
        ):
            result = crew_flow.run_flow(REQUEST)
        return captured, result

    def test_each_model_carries_its_OWN_response_format(self) -> None:
        scripted = ScriptedAgents([post_json()], [post_json()], [qa_pass()])
        captured, _ = self._capture_llms(scripted)

        msg = [{"role": "user", "content": "x"}]
        candidate_params = captured["candidate_llm"]._prepare_completion_params(msg)
        qa_params = captured["qa_llm"]._prepare_completion_params(msg)

        self.assertIn("response_format", candidate_params)
        self.assertEqual(
            candidate_params["response_format"]["json_schema"]["name"], "PostCandidate"
        )
        # QA answers in the VERDICT shape, and is constrained to it — not to the
        # post schema, which would forbid a verdict outright.
        self.assertIn("response_format", qa_params)
        self.assertEqual(qa_params["response_format"]["json_schema"]["name"], "QaVerdict")
        self.assertTrue(qa_params["response_format"]["json_schema"]["strict"])
        # The two constraints must not be the same object or the same schema.
        self.assertNotEqual(
            candidate_params["response_format"], qa_params["response_format"]
        )
        # And no tool/function-calling was introduced on either path.
        self.assertNotIn("tools", candidate_params)
        self.assertNotIn("tool_choice", candidate_params)
        self.assertNotIn("tools", qa_params)
        self.assertNotIn("tool_choice", qa_params)

    def test_the_qa_constraint_does_not_disturb_the_think_off_extra_body(self) -> None:
        # The A/B control arm's `reasoning_effort: "none"` rides in
        # `extra_body`; merging a second schema in must not clobber it, on the
        # QA model any more than on the candidate model.
        scripted = ScriptedAgents([post_json()], [post_json()], [qa_pass()])
        think_off_request = {
            **REQUEST,
            "inferenceConfig": {**REQUEST["inferenceConfig"], "think": False},
        }
        captured: dict[str, object] = {}
        real = crew_flow.build_agents

        def capturing(candidate_llm, qa_llm):
            captured["qa_llm"] = qa_llm
            return real(candidate_llm, qa_llm)

        with mock.patch.object(crew_flow, "build_agents", side_effect=capturing), mock.patch.object(
            crew_flow, "_run_single", side_effect=scripted
        ):
            crew_flow.run_flow(think_off_request)

        params = captured["qa_llm"]._prepare_completion_params(
            [{"role": "user", "content": "x"}]
        )
        self.assertEqual(params["response_format"]["json_schema"]["name"], "QaVerdict")
        self.assertEqual(params.get("extra_body"), {"reasoning_effort": "none"})

    def test_the_qa_contract_prompt_lists_exactly_the_routable_vocabulary(self) -> None:
        # The prompt and the schema are built from the same tuples, so a
        # dimension can never be offered to the critic that the router would
        # then refuse as unroutable.
        for dimension in qa_verdict.QA_DIMENSION_ORDER:
            self.assertIn(dimension, crew_flow.QA_JSON_CONTRACT)
        for severity in qa_verdict.SEVERITY_ORDER:
            self.assertIn(f'"{severity}"', crew_flow.QA_JSON_CONTRACT)

    def test_the_think_off_extra_body_still_coexists_with_response_format(self) -> None:
        scripted = ScriptedAgents([post_json()], [post_json()], [qa_pass()])
        think_off_request = {
            **REQUEST,
            "inferenceConfig": {**REQUEST["inferenceConfig"], "think": False},
        }
        captured: dict[str, object] = {}
        real = crew_flow.build_agents

        def capturing(candidate_llm, qa_llm):
            captured["candidate_llm"] = candidate_llm
            return real(candidate_llm, qa_llm)

        with mock.patch.object(crew_flow, "build_agents", side_effect=capturing), mock.patch.object(
            crew_flow, "_run_single", side_effect=scripted
        ):
            crew_flow.run_flow(think_off_request)

        params = captured["candidate_llm"]._prepare_completion_params(
            [{"role": "user", "content": "x"}]
        )
        self.assertIn("response_format", params)
        # reasoning_effort:"none" rides in extra_body; the two must not clobber.
        self.assertEqual(params.get("extra_body"), {"reasoning_effort": "none"})

    def test_a_valid_candidate_is_parsed_onto_the_result(self) -> None:
        scripted = ScriptedAgents([post_json()], [post_json()], [qa_pass()])
        _, result = self._capture_llms(scripted)
        self.assertEqual(result.qa.decision, "pass")
        self.assertIsNotNone(result.parsed)
        self.assertEqual(result.parsed.coreMessage, result.parsed.coreMessage.strip())
        self.assertTrue(result.parsed.text)

    def test_a_structurally_broken_final_candidate_raises_a_candidate_stage_failure(self) -> None:
        # A bare unescaped quote — the live failure class. The Editor is the last
        # hand, so its output is what the boundary validates.
        broken = '{"text": "a „quote" breaks it", "hashtags": [], "coreMessage": "x"}'
        scripted = ScriptedAgents([post_json()], [broken], [qa_pass()])
        with mock.patch.object(crew_flow, "_run_single", side_effect=scripted):
            with self.assertRaises(crew_flow.StageFailure) as ctx:
                crew_flow.run_flow(REQUEST)
        self.assertEqual(ctx.exception.stage, "candidate")
        # It is NOT repaired into a success.
        self.assertIn("schema validation", ctx.exception.detail)
