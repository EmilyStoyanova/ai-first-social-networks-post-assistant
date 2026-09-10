"""The strict shape the final post candidate MUST satisfy before a run succeeds.

── Why this module exists ──────────────────────────────────────────────────

The Writer and Editor are asked to emit the post as a JSON object (see
`crew_flow.POST_JSON_CONTRACT`). Until now the sidecar returned that model
string verbatim and TypeScript re-parsed it with `JSON.parse`. A live run
failed there: the model wrote a Bulgarian post containing the show name
`„Ндра’нгета"` with a BARE, unescaped ASCII double-quote, which terminated the
JSON string early — `json.loads` raised `Expecting ',' delimiter` and the whole
generation was lost as `LLM_RESPONSE_PARSE_ERROR`. The model had escaped the
SAME quote correctly a few characters earlier (`„The Gentlemen\"`); it was
simply inconsistent across a long string.

Two independent guarantees now stand between that and a corrupted contract:

 1. **Constrained decoding.** `POST_CANDIDATE_RESPONSE_FORMAT` is attached to
    the Writer/Editor LLM via `additional_params={"response_format": …}`, which
    CrewAI's OpenAI-compatible provider forwards verbatim to Ollama's
    `/v1/chat/completions`. Ollama 0.33.1 compiles the JSON schema to a GBNF
    grammar and the model then CANNOT emit a bare quote inside a string — it is
    forced to `\"`. Probed directly against `qwen3.5:35b-a3b-q4_K_M` on
    2026-09-09: the model tried to write `„ezero i dvorets"` and the grammar
    forced `„ezero i dvorets\"`.

 2. **This boundary.** `parse_post_candidate` validates the final candidate
    string against `PostCandidate` (Pydantic, `extra="forbid"`) on the Python
    side. It NEVER repairs malformed JSON — a broken candidate raises
    `PostCandidateError`, `crew_flow` turns that into a `StageFailure`, and the
    HTTP layer returns `503 unavailable` (a retryable infrastructure fault, not
    a success and not a persisted post). The transport envelope the sidecar
    then serialises with `json.dumps` is valid regardless of what quote
    characters the post text contains, because the text is ordinary string
    data by the time it is dumped.

── The contract is `lib/ai/parse-llm-post.ts` `LlmPostSchema`, mirrored ─────

`text`, `hashtags`, `coreMessage`, `imagePrompt?`, `topic?`, `notes?` — and
nothing else. No product field is invented here: a field added on one side of
the boundary and not the other is exactly the drift this model exists to
catch. `coreMessage` is trimmed and required non-empty, matching that file's
`z.string().trim().min(1)`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class PostCandidate(BaseModel):
    """The post, structured. Mirrors `LlmPostSchema` in the TypeScript app.

    `extra="forbid"` so a candidate carrying an unexpected key is rejected
    rather than silently trimmed — the same posture the TypeScript response
    contract takes toward a sidecar that has drifted ahead of it.
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    hashtags: list[str] = Field(default_factory=list)
    coreMessage: str = Field(min_length=1)
    imagePrompt: str | None = None
    topic: str | None = None
    notes: str | None = None

    @field_validator("coreMessage")
    @classmethod
    def _core_message_trimmed_non_empty(cls, value: str) -> str:
        # Mirrors `z.string().trim().min(1)`: the stored value is trimmed, and a
        # value that is only whitespace fails rather than passing on its length.
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("coreMessage must be non-empty after trimming")
        return trimmed


class PostCandidateError(ValueError):
    """The final candidate string was not a valid `PostCandidate`.

    Carries a short, path-only reason. It NEVER carries a repaired value,
    because there is no repair step — a malformed candidate is a failed run.
    """


def _strip_known_fences(raw: str) -> str:
    """Removes a leading ```/```json fence and a trailing ``` if present.

    Deliberately narrow: it strips only a recognised code fence wrapper, never
    "everything before the first `{`". A candidate with prose around the JSON is
    a contract violation and must fail validation, not be salvaged.
    """
    text = raw.strip()
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _summarise(error: ValidationError) -> str:
    reasons = []
    for item in error.errors()[:4]:
        location = ".".join(str(part) for part in item.get("loc", ())) or "(root)"
        reasons.append(f"{location}: {item.get('type', 'invalid')}")
    return "; ".join(reasons) or "schema validation failed"


def parse_post_candidate(raw: str | None) -> PostCandidate:
    """Validates a model-authored candidate string. Raises, never repairs."""
    if raw is None or not str(raw).strip():
        raise PostCandidateError("empty candidate")
    cleaned = _strip_known_fences(str(raw))
    try:
        return PostCandidate.model_validate_json(cleaned)
    except ValidationError as err:
        raise PostCandidateError(_summarise(err)) from err


def _response_format_schema() -> dict[str, Any]:
    """The JSON schema Ollama constrains decoding against.

    This is Pydantic's own `model_json_schema()` — `additionalProperties:
    false`, `minLength` on `text`/`coreMessage`, and the optional fields as
    `anyOf: [string, null]`. Probed on 2026-09-09: Ollama 0.33.1's GBNF
    compiler accepts this shape and the model's output validates against
    `PostCandidate` unchanged.
    """
    return PostCandidate.model_json_schema()


#: Passed to the Writer/Editor LLM as
#: `additional_params={"response_format": POST_CANDIDATE_RESPONSE_FORMAT}`.
#: NOT applied to the QA agent — QA answers in its own verdict shape, which this
#: schema would forbid, and carries its own constraint for it
#: (`qa_verdict.QA_VERDICT_RESPONSE_FORMAT`).
POST_CANDIDATE_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "PostCandidate",
        "strict": True,
        "schema": _response_format_schema(),
    },
}
