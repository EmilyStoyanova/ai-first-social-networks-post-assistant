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
from typing import Literal

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
EDITOR_DIMENSIONS = frozenset(
    {"voice", "tone", "length", "language_quality", "clarity", "forbidden_term", "cta", "hook"}
)
WRITER_DIMENSIONS = frozenset({"grounding", "accuracy", "angle", "substance", "factual", "content"})

VALID_SEVERITIES = frozenset({"style", "clarity", "factual", "content"})


@dataclass
class QaVerdict:
    decision: QaDecision
    issues: list[dict[str, str]] = field(default_factory=list)


def parse_qa_reply(raw: str | None) -> QaVerdict:
    """Turns a QA reply into a verdict, refusing to guess.

      * `pass`                — decision "pass" and nothing listed as failing.
      * `revise_editor` /
        `revise_writer`       — a recognised complaint, routed by severity first
                                and by the dimension table second.
      * `rejected_unroutable` — the critic rejected the post but named nothing
                                actionable: no issues, an unknown dimension, or
                                a "pass" that also lists failures. A
                                non-converged attempt — never acceptable, even
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

    primary = issues[0]
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
