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

# ── What a rejection has to carry to be actionable ──────────────────────────
#
# A `revise` is a REJECTION, and a rejection the router cannot act on wastes a
# whole Writer→Editor→QA attempt: the caller cannot accept the candidate (a
# critic ran and said no) and cannot correct it either (nothing was named). So
# the contract is stated positively and checked here, in one place:
#
#   decision "revise"  ⇒  at least one BLOCKING issue, whose
#                         • `dimension` is in `QA_DIMENSION_ORDER`, and
#                         • `detail` is non-empty
#                         The FIRST such issue is the one actionable dimension
#                         the route is taken from; anything after it rides along
#                         as context and decides nothing.
#
# Each way that can be broken gets its own name rather than a single "invalid",
# because the name is read back TO THE CRITIC by `qa_repair_instruction`: a
# re-prompt that says "you named no dimension" and one that says "your detail
# was empty" ask for different corrections, and a generic "that was invalid"
# asks for neither.
QaContractViolation = Literal[
    #: `revise` with no issues at all — the reported production failure.
    "no_issues",
    #: The blocking issue's dimension is not one the router can act on.
    "unknown_dimension",
    #: A recognised dimension with no concrete feedback attached to it.
    "empty_detail",
    #: `pass` that nonetheless lists failures. A contradiction, not a pass.
    "pass_with_issues",
]

#: The most QA re-prompts allowed on ONE candidate before the rejection is
#: taken at face value and the attempt is reported as non-converged.
#:
#: Two, matching `DEFAULT_MAX_QA_ROUNDS`: a malformed verdict is a formatting
#: slip, and a critic that cannot state a dimension in three tries is not going
#: to state one on the fourth. These are QA-ONLY calls on the SAME candidate —
#: no Writer call, no Editor call, no outer attempt — which is the whole point:
#: a formatting slip must not cost a complete generation.
DEFAULT_MAX_QA_REPAIRS = 2

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
    #: Why a `rejected_unroutable` could not be routed — set ONLY when the
    #: critic's own reply broke the contract above, and therefore only when
    #: RE-ASKING THE SAME CRITIC ABOUT THE SAME CANDIDATE could still produce a
    #: routable verdict. A `rejected_unroutable` reached any other way (the
    #: revision rounds ran out with the critic still asking for changes) leaves
    #: this None, because there is nothing malformed to repair there and
    #: re-prompting would only burn calls.
    contract_violation: QaContractViolation | None = None


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
                                actionable: no issues, an unknown dimension, a
                                recognised dimension with no feedback attached,
                                or a "pass" that also lists failures. Never
                                acceptable, even when every deterministic gate
                                passes — but `contract_violation` says WHICH of
                                those it was, so the caller can re-ask the SAME
                                critic about the SAME candidate instead of
                                spending a fresh Writer→Editor→QA attempt on a
                                formatting slip.
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
        return (
            QaVerdict("rejected_unroutable", issues, "pass_with_issues")
            if issues
            else QaVerdict("pass", [])
        )

    if decision != "revise":
        # Includes a missing decision and any word the contract does not define.
        return QaVerdict("unavailable", issues)

    if not issues:
        return QaVerdict("rejected_unroutable", [], "no_issues")

    # Rotation guidance (`angle`/`hook`/`cta`) is advisory everywhere else in
    # the system, so QA is held to the same rule: those issues stay on the
    # verdict as notes, but the routing/terminal decision is taken from the
    # rest. A rejection that named nothing BUT advisory dimensions converges —
    # as a `pass` carrying the notes — instead of burning revision rounds and an
    # outer attempt on guidance the deterministic gates never checked.
    blocking = [issue for issue in issues if issue["dimension"] not in ADVISORY_DIMENSIONS]
    if not blocking:
        return QaVerdict("pass", issues)

    # THE one actionable dimension. Everything after it is context: the route,
    # and therefore what the next agent is asked to fix, is taken from this
    # issue alone.
    primary = blocking[0]

    # The contract, checked before the routing table rather than after it.
    # Checked FIRST because the severity was the older first signal, and a
    # complaint whose dimension the router does not understand would otherwise
    # be filed under "style" and acted on as if it were a voice note — the one
    # thing the module docstring says must never happen. A dimension the router
    # cannot act on and a dimension named with no feedback attached are both
    # unroutable, and both are the critic's own reply to fix.
    if primary["dimension"] not in EDITOR_DIMENSIONS and primary["dimension"] not in WRITER_DIMENSIONS:
        return QaVerdict("rejected_unroutable", issues, "unknown_dimension")
    if not primary["detail"].strip():
        return QaVerdict("rejected_unroutable", issues, "empty_detail")

    if primary["severity"] in {"factual", "content"} or primary["dimension"] in WRITER_DIMENSIONS:
        return QaVerdict("revise_writer", issues)
    # Every remaining dimension is an editor one — the two vocabularies are
    # exhaustive over what reaches here — so this is a total branch, not a
    # default.
    return QaVerdict("revise_editor", issues)


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


#: What each contract breach has to be told back to the critic, in ITS OWN
#: terms. Keyed by `QaContractViolation` so a new breach cannot be added to the
#: vocabulary without a sentence explaining it — a repair prompt that cannot
#: name the mistake is just a second roll of the same dice.
QA_REPAIR_REASONS: dict[str, str] = {
    "no_issues": (
        'you answered "revise" but listed no issues at all, so there is nothing to fix'
    ),
    "unknown_dimension": (
        'you answered "revise" but the dimension you named is not one of the allowed '
        "dimensions, so the rejection cannot be routed to an agent"
    ),
    "empty_detail": (
        'you answered "revise" and named a dimension but left its "detail" empty, so '
        "there is no concrete instruction to act on"
    ),
    "pass_with_issues": (
        'you answered "pass" but also listed failing issues, which contradicts itself'
    ),
}


def qa_repair_instruction(verdict: QaVerdict) -> str:
    """The re-prompt for a critic whose previous reply broke the contract.

    Deliberately explicit about three things, because a vague "try again" is
    what produces the same malformed reply a second time:

      1. The previous reply was INVALID, and exactly why.
      2. The two ways out — either genuinely pass the post, or reject it with
         one named dimension and one concrete sentence. Both are offered, so
         the re-prompt cannot be read as pressure to reject (or to approve).
      3. The dimension vocabulary again, verbatim from `QA_DIMENSION_ORDER`.

    Returns "" when there is nothing to repair, so a caller can apply it
    unconditionally without first re-deriving the check.
    """
    reason = QA_REPAIR_REASONS.get(verdict.contract_violation or "")
    if reason is None:
        return ""
    return (
        "## Your previous answer was INVALID and was not accepted\n"
        "\n"
        f"It was rejected because {reason}.\n"
        "\n"
        "Judge the SAME post again — it has not changed — and answer in exactly one of "
        "these two ways:\n"
        '- If nothing blocks publication: {"decision": "pass", "issues": []}.\n'
        '- If something blocks publication: {"decision": "revise", "issues": [ one issue ]}, '
        "where that issue names exactly ONE dimension from this list — "
        + ", ".join(QA_DIMENSION_ORDER)
        + " — and whose \"detail\" is one concrete sentence saying what is wrong and what "
        "would fix it.\n"
        "\n"
        'Do not answer "revise" without naming a dimension from that list. Do not invent a '
        "dimension of your own. Do not repeat your previous answer."
    )


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
