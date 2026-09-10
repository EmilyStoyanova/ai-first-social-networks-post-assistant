"""Parsing a QA reply into a verdict — pure, and importable without CrewAI.

Deliberately its own module. `crew_flow.py` imports CrewAI at module level, so a
test of the routing logic would need the whole dependency tree installed; this
file needs only the standard library, so the rule that carries the most weight
in the design — **a QA reply that cannot be read is never a pass** — is testable
on any machine and in CI, not only on the Mac with Ollama running.

There is no default verdict anywhere below. Every path returns one of the five
states explicitly, because a default is the mechanism by which an unread critic
becomes an approval.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

QaDecision = Literal[
    "pass",
    "revise_writer",
    "revise_editor",
    "rejected_unroutable",
    "unavailable",
]

# ── The routing table ───────────────────────────────────────────────────────
#
# Which agent fixes which kind of problem. An unrecognised dimension is NOT
# routed to whichever agent seems closest: it becomes `rejected_unroutable`, a
# non-converged attempt. Revising against a critique the router did not
# understand is worse than admitting it did not understand it.
#
# Declared as ORDERED tuples and frozen from them, rather than the other way
# round. Two things read this vocabulary — the router below and the response
# schema further down — and a `frozenset` iterates in an arbitrary order, which
# would make the schema (and therefore the grammar Ollama compiles, and every
# test asserting on it) differ between runs. The tuple order is also the order
# the prompt lists them in, so there is exactly one place to add a dimension.
EDITOR_DIMENSION_ORDER: tuple[str, ...] = (
    "voice",
    "tone",
    "length",
    "language_quality",
    "clarity",
    "forbidden_term",
    "cta",
    "hook",
)
WRITER_DIMENSION_ORDER: tuple[str, ...] = (
    "grounding",
    "accuracy",
    "angle",
    "substance",
    "factual",
    "content",
)
SEVERITY_ORDER: tuple[str, ...] = ("style", "clarity", "factual", "content")

EDITOR_DIMENSIONS = frozenset(EDITOR_DIMENSION_ORDER)
WRITER_DIMENSIONS = frozenset(WRITER_DIMENSION_ORDER)

#: Every dimension the router can act on, editor-routed first. The single source
#: for both the QA prompt's list and the response schema's enum.
QA_DIMENSION_ORDER: tuple[str, ...] = EDITOR_DIMENSION_ORDER + WRITER_DIMENSION_ORDER

VALID_SEVERITIES = frozenset(SEVERITY_ORDER)

# ── Advisory dimensions — rotation guidance, not a gate ─────────────────────
#
# `angle`, `hook` and `cta` are the levers the diversity rotation varies so a
# feed does not read the same way twice. EVERYWHERE ELSE in the generation
# system they are guidance, never a rejection reason: `generation-compliance`
# lists exactly these under `notChecked` ("a post is never rejected for missing
# one"), and the single-agent path never revises for them. QA is brought into
# parity here — it MAY still name one, and the `detail` is kept on the verdict
# as a note, but a rejection whose ONLY issues are advisory is NOT a blocking
# failure: the router resolves it to `pass`, carrying the notes, instead of
# spending revision rounds and an outer attempt on guidance no gate enforces.
#
# `structure` is guidance too, but it is not in `QA_DIMENSION_ORDER`, so the
# response schema already stops the critic from raising it — nothing to do here.
#
# Ordered tuple + frozenset, like the vocabularies above: the prompt lists them
# in this order, and there is exactly one place to add one.
ADVISORY_DIMENSION_ORDER: tuple[str, ...] = ("angle", "hook", "cta")
ADVISORY_DIMENSIONS = frozenset(ADVISORY_DIMENSION_ORDER)


@dataclass
class QaVerdict:
    decision: QaDecision
    issues: list[dict[str, str]] = field(default_factory=list)


def parse_qa_reply(raw: str | None) -> QaVerdict:
    """Turns a QA reply into a verdict, refusing to guess.

      * `pass`                — decision "pass" and nothing listed as failing,
                                OR decision "revise" whose ONLY issues are
                                advisory rotation guidance (`angle`/`hook`/
                                `cta`). Those issues stay on the verdict as
                                notes; they do not block, matching how every
                                deterministic check already treats them.
      * `revise_editor` /
        `revise_writer`       — a recognised BLOCKING complaint, routed by
                                severity first and by the dimension table
                                second. Advisory issues alongside a blocking one
                                ride along but do not decide the route.
      * `rejected_unroutable` — the critic rejected the post but named nothing
                                actionable: no issues, only an unknown
                                dimension, or a "pass" that also lists failures.
                                A non-converged attempt — never acceptable, even
                                when every deterministic gate passes.
      * `unavailable`         — the reply could not be read at all. Degraded;
                                the caller's gates become the whole verdict.
    """
    if raw is None or not raw.strip():
        return QaVerdict("unavailable", [])

    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return QaVerdict("unavailable", [])
    try:
        parsed = json.loads(match.group(0))
    except (ValueError, TypeError):
        return QaVerdict("unavailable", [])
    if not isinstance(parsed, dict):
        return QaVerdict("unavailable", [])

    decision = str(parsed.get("decision", "")).strip().lower()
    issues = _normalize_issues(parsed.get("issues"))

    if decision == "pass":
        # A "pass" that also lists failing issues is a CONTRADICTION, not a
        # pass. Refused rather than resolved in either direction: taking the
        # verdict would publish text the same reply says is broken, and taking
        # the issues would invent a rejection the critic did not make.
        return QaVerdict("rejected_unroutable", issues) if issues else QaVerdict("pass", [])

    if decision != "revise":
        # Includes a missing decision and any word the contract does not define.
        return QaVerdict("unavailable", issues)

    if not issues:
        return QaVerdict("rejected_unroutable", [])

    # Rotation guidance (`angle`/`hook`/`cta`) is advisory everywhere else in
    # the system, so QA is held to the same rule: those issues stay on the
    # verdict as notes, but the routing/terminal decision is taken from the
    # rest. A rejection that named nothing BUT advisory dimensions converges —
    # as a `pass` carrying the notes — instead of burning revision rounds and an
    # outer attempt on guidance the deterministic gates never checked.
    blocking = [issue for issue in issues if issue["dimension"] not in ADVISORY_DIMENSIONS]
    if not blocking:
        return QaVerdict("pass", issues)

    primary = blocking[0]
    if primary["severity"] in {"factual", "content"} or primary["dimension"] in WRITER_DIMENSIONS:
        return QaVerdict("revise_writer", issues)
    if primary["severity"] in {"style", "clarity"} or primary["dimension"] in EDITOR_DIMENSIONS:
        return QaVerdict("revise_editor", issues)
    return QaVerdict("rejected_unroutable", issues)


def _normalize_issues(raw_issues: object) -> list[dict[str, str]]:
    """Keeps every well-formed issue and drops nothing silently that matters.

    An unrecognised severity becomes `"unknown"` rather than being coerced to a
    valid one — that is what lets an unroutable complaint stay unroutable
    instead of being quietly filed under style.
    """
    if not isinstance(raw_issues, list):
        return []
    issues: list[dict[str, str]] = []
    for entry in raw_issues:
        if not isinstance(entry, dict):
            continue
        dimension = str(entry.get("dimension", "")).strip().lower() or "unknown"
        severity = str(entry.get("severity", "")).strip().lower()
        if severity not in VALID_SEVERITIES:
            severity = "unknown"
        issues.append(
            {
                "dimension": dimension,
                "severity": severity,
                "detail": str(entry.get("detail", ""))[:500],
            }
        )
    return issues


def _qa_verdict_schema() -> dict[str, Any]:
    """The JSON schema Ollama constrains the QA reply's decoding against.

    Built from the routing table above, never from a second hand-written list:
    an enum that drifted from `EDITOR_DIMENSIONS`/`WRITER_DIMENSIONS` would let
    the model emit a dimension the router cannot act on, which is precisely the
    `rejected_unroutable` outcome this constraint exists to make unreachable.

    Hand-written rather than derived from a Pydantic model, deliberately: this
    module is standard-library only (see the module docstring) so the rule that
    an unreadable critic is never a pass stays testable without CrewAI, Pydantic
    or Ollama installed. `post_candidate.py` can use `model_json_schema()`
    because it already depends on Pydantic for its validation boundary; nothing
    here does.

    `decision` is `pass | revise` — the two words the MODEL may say. The five
    `QaDecision` states are what `parse_qa_reply` DERIVES from that plus the
    issues, and `rejected_unroutable` in particular must stay reachable: a
    schema-valid `revise` after the last allowed revision round is a genuine
    convergence failure, not a formatting one.
    """
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["decision", "issues"],
        "properties": {
            "decision": {"type": "string", "enum": ["pass", "revise"]},
            # Required and always present, empty on a pass. An absent key would
            # be legal JSON but leaves "did the critic name nothing, or forget
            # the key" ambiguous, and the two route differently.
            "issues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["dimension", "severity", "detail"],
                    "properties": {
                        "dimension": {"type": "string", "enum": list(QA_DIMENSION_ORDER)},
                        "severity": {"type": "string", "enum": list(SEVERITY_ORDER)},
                        "detail": {"type": "string"},
                    },
                },
            },
        },
    }


#: Passed to the QA LLM as
#: `additional_params={"response_format": QA_VERDICT_RESPONSE_FORMAT}` — the
#: counterpart of `post_candidate.POST_CANDIDATE_RESPONSE_FORMAT`, which
#: constrains the Writer/Editor. Measured against `qwen3.5:35b-a3b-q4_K_M` on
#: 2026-09-09: an unconstrained QA reply cost 3,179-4,986 output tokens (the
#: model reasons at length before its JSON); the same judgement under this
#: schema cost 50, in one Ollama call, and `parse_qa_reply` routed it.
#:
#: It constrains what the critic MAY SAY. It does not weaken what we CHECK —
#: `parse_qa_reply` remains authoritative over every reply, constrained or not.
QA_VERDICT_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "QaVerdict",
        "strict": True,
        "schema": _qa_verdict_schema(),
    },
}
