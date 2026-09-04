"""Turning the wire's `inferenceConfig` into litellm/CrewAI `LLM(...)` kwargs.

Standard library only, and separate from `crew_flow.py` for the same reason
`qa_verdict.py` is: this is the mapping that broke a live Mac run, so it must be
testable without CrewAI or Ollama installed.

── The trap this module exists to document ─────────────────────────────────

`numPredict` maps to litellm's `max_tokens`, which becomes Ollama's
`num_predict` — a cap on the tokens the model may EMIT.

`qwen3.5:35b-a3b-q4_K_M` is a reasoning model: it emits a `<think>…</think>`
preamble before its answer, and that preamble is charged against the same
budget. Cap it too low and the model is cut off mid-reasoning, having emitted
no answer at all. CrewAI then reports:

    Invalid response from LLM call - None or empty

which is what a live Mac run produced with `numPredict: 1024` — while the
isolated POC, which passed model and base_url and nothing else, worked. The
multi-agent prompts are much longer than the POC's (system + brief + user + the
JSON contract, and for the Editor the whole draft as well), so the reasoning
block is longer too, which is why the cap bit here and not there.

The same wall has been hit elsewhere in this repo:
`MAX_UNDERSTANDING_OUTPUT_TOKENS` was raised from 500 to 1200 because the old
cap "left a capable local model no room to finish a maximal answer, let alone
one that also emits a thinking preamble before its JSON".

So the mapping below is KEPT — a caller that deliberately pins both A/B arms
needs it — but nothing is pinned by default, and `numPredict` in particular
should only ever be set to a value measured against a thinking model's real
output, never copied from the single-agent request.

── Why pinning nothing is also the CORRECT A/B default ─────────────────────

The control arm's `TextWorkerProvider.generate` forwards `temperature` and
`maxTokens` into Ollama's `options` ONLY when `request.format` is set — and post
generation never sets `format`; only translation does. So on the text-worker
path the control arm sends no sampling options at all and inherits the model's
Modelfile defaults.

If the sidecar pinned sampling while the control arm pinned none, the two arms
would differ on temperature and token budget while reporting the same model and
the same provider — silently invalidating an experiment that is supposed to
vary orchestration alone. Pinning neither is the resolution that requires no
change to existing single-agent behaviour.
"""

from __future__ import annotations

from typing import Any

DEFAULT_BASE_URL = "http://127.0.0.1:11434"

# The wire name → the litellm/CrewAI `LLM(...)` argument name.
#
# Ordered, and kept as data rather than a chain of ifs, so the mapping is a
# thing that can be READ and tested rather than inferred from control flow.
SAMPLING_ARGS: tuple[tuple[str, str], ...] = (
    ("temperature", "temperature"),
    ("topP", "top_p"),
    ("topK", "top_k"),
    ("seed", "seed"),
    # See the module docstring — this is the one that strangles a thinking model.
    ("numPredict", "max_tokens"),
    ("repeatPenalty", "repeat_penalty"),
    ("stop", "stop"),
)


class NonLoopbackOllamaError(ValueError):
    """The sidecar may only ever reach Ollama on loopback."""


def llm_kwargs(inference: dict[str, Any]) -> dict[str, Any]:
    """Builds the `LLM(...)` kwargs for one request.

    A sampling parameter is forwarded ONLY when the caller actually sent it. An
    absent parameter and a parameter set to the model's own default are
    different facts — the first means "Ollama used its Modelfile value", the
    second means "we pinned it" — and the inference fingerprint the A/B report
    compares distinguishes them, so this must not invent a value to fill a gap.
    """
    model = inference["model"]
    if not model.startswith("ollama/"):
        model = f"ollama/{model}"

    base_url = inference.get("baseUrl") or DEFAULT_BASE_URL
    if not is_loopback(base_url):
        raise NonLoopbackOllamaError(f"Refusing a non-loopback Ollama base_url: {base_url!r}")

    kwargs: dict[str, Any] = {"model": model, "base_url": base_url}
    for wire, arg in SAMPLING_ARGS:
        if inference.get(wire) is not None:
            kwargs[arg] = inference[wire]
    return kwargs


def is_loopback(base_url: str) -> bool:
    """Loopback literals only.

    A prefix test rather than a parse, deliberately narrow: `127.0.0.1` and
    `localhost` are the only hosts this process may reach, and a hostname that
    merely BEGINS with one of them (`127.0.0.1.example.com`) must not pass, so
    the character after the host has to be a port colon or a path.
    """
    for host in ("http://127.0.0.1", "http://localhost", "http://[::1]"):
        if base_url == host:
            return True
        if base_url.startswith(host) and base_url[len(host) :][:1] in {":", "/"}:
            return True
    return False
