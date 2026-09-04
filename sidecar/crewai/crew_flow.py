"""The inner QA loop: Writer → Editor → QA, with QA routing back to EITHER.

    Writer → Editor → QA
        QA pass                     → return the candidate
        QA style/clarity issue      → Editor → QA
        QA factual/content issue    → Writer → Editor → QA
    at most `max_qa_rounds` revision cycles

`max_qa_rounds` counts REVISION CYCLES — cycles after the first QA evaluation —
so QA evaluations are `1 + qa_revision_rounds`. Getting that wrong by one is the
difference between two revisions and three.

── Two rules that are easy to lose and expensive to lose ────────────────────

**A Writer revision is never accepted without a further Editor pass.** The
Editor is the last hand on the text in every single path. That makes the worst
case `3 + 3R` calls, not `3 + 2R` — 9 at R=2, not 7 — and the TypeScript client
re-derives that arithmetic from the counters this file reports and REFUSES a run
whose Editor count is short. So a regression here is caught by the caller rather
than discovered later in published posts.

**A QA reply that cannot be parsed is `unavailable`, never a pass.** There is no
default verdict anywhere in this file. A critic that could not be read said
nothing, and the caller's deterministic gates become the whole verdict — with
the run marked degraded. Defaulting to pass would publish text no critic
approved, which is precisely the failure the QA stage exists to prevent.

── Why `Process.sequential` is not enough ───────────────────────────────────

`Process.sequential` runs a fixed list once and cannot express a verdict that
routes back to a CHOSEN earlier agent. The routing above is a conditional
CrewAI Flow, which is why this module is built on `Flow` / `@start` / `@listen`
/ `@router` rather than on a Crew alone.

NOTE FOR THE MAC: the Flow API surface is version-sensitive. This module is
written against the pinned CrewAI in `requirements.txt` and MUST be exercised on
the Mac (the four scenarios in `README.md`) before it is trusted — it has never
run on the Windows dev machine, where neither CrewAI nor Ollama is installed.
`run_flow` is deliberately the only thing `app.py` imports, so a validated POC
implementation can replace this file's internals without the HTTP layer or the
contract changing.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from crewai import Agent, Crew, Process, Task

# `LLM` is re-exported from the package root in current CrewAI and lives in
# `crewai.llm` in older layouts. Both are tried so a version difference in an
# IMPORT PATH cannot be mistaken for a problem with the design — the class is
# the same object either way, and a genuine absence still raises here.
try:
    from crewai import LLM
except ImportError:  # pragma: no cover - depends on the installed layout
    from crewai.llm import LLM

from guards import assert_agent_posture

# The routing logic and the LLM kwarg mapping both live in stdlib-only modules,
# so each is testable without CrewAI or Ollama installed.
from qa_verdict import QaVerdict, parse_qa_reply
from inference_config import llm_kwargs


def redact_llm_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """The LLM configuration, safe to log.

    Logged on every run because the defect that cost a live Mac cycle was a
    SAMPLING value — `numPredict: 1024` strangling a thinking model — and the
    sidecar's logs said nothing about what it had actually configured. One line
    turns "why was the response empty" from a guess into a reading.

    There is nothing secret in here (a model tag and a loopback URL), but the
    `base_url` is still reduced to its host so a log shipped elsewhere never
    carries an internal path.
    """
    safe = dict(kwargs)
    url = safe.get("base_url")
    if isinstance(url, str):
        # scheme://host — the first three segments of a split on "/".
        safe["base_url"] = "/".join(url.split("/")[:3])
    return safe


class StageFailure(RuntimeError):
    """A named stage produced nothing usable.

    Carries the STAGE, because "the run failed" and "the Writer came back empty"
    lead to different investigations, and the sidecar's HTTP layer can only say
    the second if the exception says it first.
    """

    def __init__(self, stage: str, detail: str) -> None:
        super().__init__(f"{stage}: {detail}")
        self.stage = stage
        self.detail = detail


@dataclass
class RunCounters:
    writer: int = 0
    editor: int = 0
    qa: int = 0
    revisions: int = 0
    routes: list[str] = field(default_factory=list)
    degraded_stages: list[str] = field(default_factory=list)

    def degrade(self, stage: str) -> None:
        if stage not in self.degraded_stages:
            self.degraded_stages.append(stage)


@dataclass
class FlowResult:
    candidate: str | None
    qa: QaVerdict
    counters: RunCounters
    latency_ms: int


def build_llm(inference: dict[str, Any]) -> LLM:
    """The ONE model every agent uses, pinned by the CALLER.

    The sidecar never chooses a model and has no fallback: for an A/B run this
    is the same tag and the same sampling the control arm was pinned to, which
    is what makes the two arms' inference fingerprints comparable. A hosted
    provider is not reachable from here — no key for one is in the environment,
    so a mistake fails loudly rather than billing silently.

    The kwarg mapping lives in `inference_config.llm_kwargs`, which is stdlib
    only and separately tested — read its docstring before pinning `numPredict`
    against a thinking model.
    """
    kwargs = llm_kwargs(inference)
    print(f"[crew-sidecar] LLM kwargs: {redact_llm_kwargs(kwargs)}")
    return LLM(**kwargs)


def _accepted_kwargs(cls: type, desired: dict[str, Any]) -> dict[str, Any]:
    """Keeps only the kwargs `cls` actually declares.

    CrewAI's `Agent` and `Crew` are pydantic models whose field NAMES have moved
    between versions — `memory` on an Agent is the clearest example, having been
    an agent-level concern once and a crew-level one since. A pydantic model that
    forbids unknown fields turns a stale kwarg into a construction error, so
    passing the union of every version's names blindly would make the sidecar
    refuse to start over a parameter name rather than over anything real.

    Filtering is safe here — and only here — because the POSTURE IS ASSERTED
    AFTERWARDS, on the constructed object, by `assert_agent_posture`. So a
    setting silently dropped because this version does not declare it is still
    caught if this version defaults it to something permissive. The filter
    changes which kwargs are OFFERED; it cannot weaken what is GUARANTEED.
    """
    fields = getattr(cls, "model_fields", None)
    if not isinstance(fields, dict):
        return desired
    return {name: value for name, value in desired.items() if name in fields}


def build_agents(llm: LLM) -> tuple[Agent, Agent, Agent]:
    """Three agents, no tools, no delegation, no memory.

    `allow_delegation=False` on all three is what keeps the routing THIS file's
    decision. With delegation on, an agent could hand work sideways and the
    reported counters would stop describing the loop that actually ran — which
    would defeat the client-side arithmetic check as well as the design.
    """
    common = _accepted_kwargs(
        Agent,
        {
            "llm": llm,
            "tools": [],
            "allow_code_execution": False,
            "allow_delegation": False,
            "memory": False,
            "verbose": False,
        },
    )
    # The one kwarg the filter must NEVER be allowed to drop.
    #
    # An Agent constructed without an `llm` falls back to CrewAI's own default,
    # which is OpenAI — so a renamed field would turn this filter into a silent
    # cloud fallback, the exact thing the whole design forbids. Every other
    # dropped kwarg degrades to a posture check that `assert_agent_posture`
    # still catches; this one would degrade to billing someone.
    if "llm" not in common:
        raise StageFailure(
            "build_agents",
            "The installed CrewAI Agent does not declare an `llm` field, so the pinned "
            "local model would be dropped and a default provider used. Refusing to run.",
        )
    writer = Agent(
        role="Social media writer",
        goal="Write one social post that satisfies every requirement given, exactly as given.",
        backstory=(
            "You write for one company's audience. You follow the brief and the requirements "
            "literally: the language, the angle, the hook, the structure, the call to action and "
            "the character limit are instructions, not suggestions. You never invent facts the "
            "brief does not contain."
        ),
        **common,
    )
    editor = Agent(
        role="Editor",
        goal="Improve the post's voice, clarity and compliance without changing what it claims.",
        backstory=(
            "You are the last hand on every version of the text. You fix voice, rhythm, clarity, "
            "length and forbidden wording. You do NOT change the post's central claim or its "
            "subject — that is the writer's job, and silently replacing it would hide a problem "
            "the reviewer needs to see. You always return the full edited post."
        ),
        **common,
    )
    qa = Agent(
        role="Quality reviewer",
        goal="Judge the post against the requirements and name what fails, precisely.",
        backstory=(
            "You are a critic, not an editor: you never rewrite. You decide whether the post "
            "meets the requirements and, when it does not, name the ONE dimension that fails "
            "most and whether it is a matter of style/clarity or of fact/content. You answer "
            "only in the JSON shape you are given. You never approve a post to be agreeable."
        ),
        **common,
    )
    assert_agent_posture([writer, editor, qa])
    # And the pinned model really is the one each agent holds — asserted on the
    # CONSTRUCTED objects, so a version that silently substituted its own
    # default is caught here rather than on someone's OpenAI invoice.
    for agent in (writer, editor, qa):
        if getattr(agent, "llm", None) is not llm:
            raise StageFailure(
                "build_agents",
                f"Agent {agent.role!r} is not holding the pinned local model.",
            )
    return writer, editor, qa


def _run_single(agent: Agent, description: str, expected_output: str) -> str:
    """One agent, one task, one call.

    `Process.sequential` over a single task is used deliberately: the CONDITIONAL
    routing lives in `run_flow` below, and each stage here is a plain single-step
    execution. That is the one place a sequential process is still correct.
    """
    task = Task(description=description, expected_output=expected_output, agent=agent)
    crew = Crew(
        agents=[agent],
        tasks=[task],
        process=Process.sequential,
        **_accepted_kwargs(
            Crew,
            {"memory": False, "cache": False, "share_crew": False, "verbose": False},
        ),
    )
    # Asserted on the CONSTRUCTED crew, every call: whatever the filter above
    # did or did not offer, a crew that came out with memory or share_crew
    # enabled is refused here.
    assert_agent_posture([agent], crew)
    return str(crew.kickoff())


POST_JSON_CONTRACT = (
    "Reply with a SINGLE JSON object and nothing else — no prose before or after it, no markdown "
    'fences:\n'
    '{ "text": "<the post>", "hashtags": ["<tag>"], "coreMessage": "<the one central claim, one '
    'sentence>", "imagePrompt": "<a short image description, or omit>", "topic": "<a short topic '
    'label>" }'
)

QA_JSON_CONTRACT = (
    "Reply with a SINGLE JSON object and nothing else:\n"
    '{ "decision": "pass" | "revise", "issues": [ { "dimension": "<one of: voice, tone, length, '
    'language_quality, clarity, forbidden_term, cta, hook, grounding, accuracy, angle, substance, '
    'factual, content>", "severity": "style" | "clarity" | "factual" | "content", "detail": "<what '
    'is wrong, in one sentence>" } ] }\n'
    'Use "pass" only when nothing fails. When you use "revise" you MUST name at least one issue '
    "with a dimension from that list — a rejection that names nothing cannot be acted on."
)


def _brief_block(brief: dict[str, Any]) -> str:
    """The article brief, rendered.

    The brief comes from the caller already formatted from an EXISTING article
    understanding. There is no research agent and no research call: re-deriving
    what the classification pipeline already read the whole article to establish
    would cost a model call and could disagree with the verdict the article was
    classified under.
    """
    if not brief or brief.get("source") == "none" or not (brief.get("mainSubject") or "").strip():
        return ""
    lines = ["## What the source article is about", "", brief["mainSubject"]]
    if brief.get("centralThesis"):
        lines += ["", f"The article's own thesis: {brief['centralThesis']}"]
    if brief.get("centralConflict"):
        lines += ["", f"The central tension: {brief['centralConflict']}"]
    if brief.get("secondaryTopics"):
        lines += ["", f"Discussed in service of the main subject: {', '.join(brief['secondaryTopics'])}"]
    if brief.get("incidentalTopics"):
        lines += [
            "",
            "Mentioned only in passing — NOT what the article is about: "
            + ", ".join(brief["incidentalTopics"]),
        ]
    if brief.get("entities"):
        lines += ["", f"Named in the article: {', '.join(brief['entities'])}"]
    return "\n".join(lines)


def run_flow(request: dict[str, Any]) -> FlowResult:
    """The whole inner loop, for one OUTER attempt.

    Returns a `FlowResult` and never raises for a QA problem: a QA that could
    not run is a verdict (`unavailable`) rather than an exception, because the
    candidate is still usable and the caller's gates are still authoritative.
    Only a WRITER that produced nothing usable is an exception — with no
    candidate there is nothing to judge and nothing to save.
    """
    started = time.monotonic()
    counters = RunCounters()

    reqs = request["generationRequirements"]
    attempt_ctx = request.get("attemptContext") or {}
    max_qa_rounds = int(attempt_ctx.get("maxQaRounds", 2))

    llm = build_llm(request["inferenceConfig"])
    writer, editor, qa_agent = build_agents(llm)

    brief = _brief_block(request.get("articleUnderstanding") or {})
    max_len = reqs.get("maxTextLength")
    limit_line = f"The post text must be at most {max_len} characters." if max_len else ""

    base_instructions = "\n\n".join(
        part
        for part in [
            reqs["systemPrompt"],
            brief,
            reqs["userPrompt"],
            limit_line,
            POST_JSON_CONTRACT,
        ]
        if part
    )

    # ── Writer → Editor → QA (3 calls) ──────────────────────────────────────
    counters.writer += 1
    try:
        draft = _run_single(
            writer,
            base_instructions,
            "A single JSON object holding the post.",
        )
    except StageFailure:
        raise
    except Exception as err:  # noqa: BLE001 - re-raised, only the stage is added
        # CrewAI's own "Invalid response from LLM call - None or empty" arrives
        # here. Naming the stage is what turns a 503 into a diagnosis: with a
        # thinking model, an empty reply is very often a `numPredict` cap
        # consumed entirely by the reasoning preamble — see inference_config.py.
        raise StageFailure("writer", f"{type(err).__name__}: {err}") from err
    if not draft or not draft.strip():
        # NOT retried and NOT substituted. An empty candidate stays a failure,
        # which is what makes the caller release its claimed article and report
        # the run as unavailable rather than saving nothing-shaped-like-a-post.
        raise StageFailure("writer", "The Writer produced no output.")

    candidate = _edit(editor, counters, draft, base_instructions)
    verdict = _judge(qa_agent, counters, candidate, base_instructions)

    # ── The revision cycles ─────────────────────────────────────────────────
    for round_index in range(1, max_qa_rounds + 1):
        if verdict.decision in {"pass", "rejected_unroutable", "unavailable"}:
            break

        detail = _issue_summary(verdict)

        if verdict.decision == "revise_writer":
            counters.routes.append("writer")
            counters.writer += 1
            rewritten = _run_single(
                writer,
                f"{base_instructions}\n\n## A reviewer rejected your previous version\n\n"
                f"{detail}\n\nFix that specifically. Return the complete post as JSON.",
                "A single JSON object holding the revised post.",
            )
            if rewritten and rewritten.strip():
                # The Editor is re-entered unconditionally: a Writer revision is
                # NEVER eligible for acceptance without a further Editor pass.
                candidate = _edit(editor, counters, rewritten, base_instructions)
        else:
            counters.routes.append("editor")
            candidate = _edit(
                editor,
                counters,
                candidate,
                base_instructions,
                note=f"## A reviewer rejected this version\n\n{detail}\n\nFix that specifically.",
            )

        counters.revisions = round_index
        verdict = _judge(qa_agent, counters, candidate, base_instructions)

    # The loop ran out of rounds without a terminal verdict: the critic still
    # wants changes. That is not a pass, so it is reported as unroutable — a
    # non-converged attempt for the caller to spend an outer attempt on.
    if verdict.decision in {"revise_writer", "revise_editor"}:
        verdict = QaVerdict("rejected_unroutable", verdict.issues)

    return FlowResult(
        candidate=candidate,
        qa=verdict,
        counters=counters,
        latency_ms=int((time.monotonic() - started) * 1000),
    )


def _edit(
    editor: Agent,
    counters: RunCounters,
    text: str,
    base_instructions: str,
    note: str = "",
) -> str:
    """One Editor pass. A failed edit DEGRADES rather than failing the run.

    The previous version is still a usable candidate, and discarding it because
    the polish step broke would turn a slightly rougher post into no post.
    """
    counters.editor += 1
    parts = [
        base_instructions,
        "## Edit this post",
        "",
        text,
        "",
        "Return the complete edited post as a single JSON object. Do not change its central claim.",
    ]
    if note:
        parts.insert(1, note)
    try:
        edited = _run_single(editor, "\n\n".join(parts), "A single JSON object holding the post.")
    except Exception as err:  # noqa: BLE001 - a broken stage must degrade, not abort
        print(f"[crew-sidecar] editor stage failed, degrading: {err}")
        counters.degrade("editor")
        return text
    if not edited or not edited.strip():
        counters.degrade("editor")
        return text
    return edited


def _judge(qa_agent: Agent, counters: RunCounters, candidate: str, base_instructions: str) -> QaVerdict:
    """One QA pass. A QA that cannot run is `unavailable`, never a pass."""
    counters.qa += 1
    try:
        reply = _run_single(
            qa_agent,
            "\n\n".join(
                [
                    base_instructions,
                    "## Judge this post against the requirements above",
                    "",
                    candidate,
                    "",
                    QA_JSON_CONTRACT,
                ]
            ),
            "A single JSON object holding the verdict.",
        )
    except Exception as err:  # noqa: BLE001 - see the docstring: never a pass
        print(f"[crew-sidecar] qa stage failed, degrading: {err}")
        counters.degrade("qa")
        return QaVerdict("unavailable", [])

    verdict = parse_qa_reply(reply)
    if verdict.decision == "unavailable":
        counters.degrade("qa")
    return verdict


def _issue_summary(verdict: QaVerdict) -> str:
    return "\n".join(
        f"- {issue['dimension']} ({issue['severity']}): {issue['detail']}"
        for issue in verdict.issues
    ) or "- The reviewer rejected the post without naming a dimension."
