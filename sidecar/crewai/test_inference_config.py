"""Tests for the LLM kwarg mapping. Standard library only — no CrewAI, no Ollama.

    python -m unittest test_inference_config -v

These exist because of a REAL live-integration defect. The isolated POC used

    LLM(model="ollama/qwen3.5:35b-a3b-q4_K_M", base_url="http://127.0.0.1:11434")

and worked. The repo sidecar, given a fixture that pinned `numPredict: 1024`,
sent `max_tokens=1024` as well — and `qwen3.5` spent that budget on its
`<think>` preamble, emitting no answer, so CrewAI raised

    Invalid response from LLM call - None or empty

`test_reproduces_the_live_defect` below pins the difference exactly.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from inference_config import NonLoopbackOllamaError, is_loopback, llm_kwargs

FIXTURE = Path(__file__).parent / "fixtures" / "request.json"

QWEN = "qwen3.5:35b-a3b-q4_K_M"


class TestTheLiveDefect(unittest.TestCase):
    def test_reproduces_the_live_defect(self) -> None:
        """A pinned numPredict becomes max_tokens — the strangler."""
        kwargs = llm_kwargs({"model": QWEN, "baseUrl": "http://127.0.0.1:11434", "numPredict": 1024})
        self.assertEqual(kwargs["max_tokens"], 1024)

    def test_the_shipped_fixture_pins_NO_sampling(self) -> None:
        """The regression guard, read from the real fixture.

        Pinning nothing reproduces the POC exactly AND matches what the control
        arm really sends: `TextWorkerProvider` forwards temperature/maxTokens to
        Ollama only when `format` is set, and post generation never sets it. So
        an arm that pinned sampling here would differ from the control arm while
        reporting the same model — invalidating an experiment meant to vary
        orchestration alone.
        """
        inference = json.loads(FIXTURE.read_text(encoding="utf-8"))["inferenceConfig"]
        kwargs = llm_kwargs(inference)

        self.assertEqual(set(kwargs), {"model", "base_url"})
        # Named individually so a failure says WHICH pin came back.
        for forbidden in ("max_tokens", "temperature", "top_p", "top_k", "repeat_penalty", "stop"):
            self.assertNotIn(forbidden, kwargs, f"the fixture must not pin {forbidden}")

    def test_the_fixture_matches_the_POC_call_exactly(self) -> None:
        inference = json.loads(FIXTURE.read_text(encoding="utf-8"))["inferenceConfig"]
        self.assertEqual(
            llm_kwargs(inference),
            {"model": f"ollama/{QWEN}", "base_url": "http://127.0.0.1:11434"},
        )


class TestMapping(unittest.TestCase):
    def test_the_ollama_prefix_is_added_once(self) -> None:
        self.assertEqual(llm_kwargs({"model": QWEN})["model"], f"ollama/{QWEN}")
        self.assertEqual(llm_kwargs({"model": f"ollama/{QWEN}"})["model"], f"ollama/{QWEN}")

    def test_an_absent_parameter_is_not_invented(self) -> None:
        # An absent parameter and one set to the model's default are different
        # facts, and the A/B inference fingerprint distinguishes them.
        self.assertEqual(set(llm_kwargs({"model": QWEN})), {"model", "base_url"})

    def test_every_sampling_parameter_maps_to_its_litellm_name(self) -> None:
        kwargs = llm_kwargs(
            {
                "model": QWEN,
                "temperature": 0.85,
                "topP": 0.9,
                "topK": 40,
                "seed": 7,
                "numPredict": 4096,
                "repeatPenalty": 1.1,
                "stop": ["</post>"],
            }
        )
        self.assertEqual(kwargs["temperature"], 0.85)
        self.assertEqual(kwargs["top_p"], 0.9)
        self.assertEqual(kwargs["top_k"], 40)
        self.assertEqual(kwargs["seed"], 7)
        self.assertEqual(kwargs["max_tokens"], 4096)
        self.assertEqual(kwargs["repeat_penalty"], 1.1)
        self.assertEqual(kwargs["stop"], ["</post>"])

    def test_a_zero_is_forwarded_because_it_is_a_real_value(self) -> None:
        # `temperature: 0` is deterministic sampling, not "unset". Only None
        # means unset, which is why the check is `is not None` and not truthiness.
        self.assertEqual(llm_kwargs({"model": QWEN, "temperature": 0})["temperature"], 0)

    def test_the_base_url_defaults_to_loopback_ollama(self) -> None:
        self.assertEqual(llm_kwargs({"model": QWEN})["base_url"], "http://127.0.0.1:11434")


class TestThinkOff(unittest.TestCase):
    """`think: false` (A/B only) becomes the field Ollama's /v1 endpoint honours.

    Probed 2026-09-09 against Ollama 0.33.1 + qwen3.5:35b-a3b-q4_K_M:
    a top-level `think: false` on /v1/chat/completions is silently ignored;
    `reasoning_effort: "none"` is what disables the reasoning preamble. CrewAI's
    OpenAICompatibleCompletion merges `additional_params` into the OpenAI
    client's `create(**params)`, and the SDK forwards `extra_body` as raw JSON.
    """

    def test_think_false_maps_to_reasoning_effort_none_via_extra_body(self) -> None:
        kwargs = llm_kwargs({"model": QWEN, "think": False})
        self.assertEqual(
            kwargs["additional_params"],
            {"extra_body": {"reasoning_effort": "none"}},
        )

    def test_absent_think_forwards_nothing(self) -> None:
        self.assertNotIn("additional_params", llm_kwargs({"model": QWEN}))

    def test_think_true_forwards_nothing(self) -> None:
        # Only an explicit False acts. `true` leaves the model default alone.
        self.assertNotIn("additional_params", llm_kwargs({"model": QWEN, "think": True}))

    def test_think_off_does_not_disturb_sampling_mapping(self) -> None:
        kwargs = llm_kwargs({"model": QWEN, "think": False, "temperature": 0.85})
        self.assertEqual(kwargs["temperature"], 0.85)
        self.assertEqual(kwargs["additional_params"], {"extra_body": {"reasoning_effort": "none"}})

    def test_the_returned_additional_params_is_a_fresh_dict(self) -> None:
        # Mutating one request's kwargs must not bleed into the next.
        a = llm_kwargs({"model": QWEN, "think": False})
        a["additional_params"]["extra_body"]["reasoning_effort"] = "high"
        b = llm_kwargs({"model": QWEN, "think": False})
        self.assertEqual(b["additional_params"], {"extra_body": {"reasoning_effort": "none"}})


class TestLoopbackGuard(unittest.TestCase):
    def test_accepts_loopback(self) -> None:
        for url in (
            "http://127.0.0.1:11434",
            "http://localhost:11434",
            "http://127.0.0.1",
            "http://127.0.0.1/",
        ):
            self.assertTrue(is_loopback(url), url)

    def test_refuses_anything_that_could_leave_the_box(self) -> None:
        for url in (
            "http://10.0.0.5:11434",
            "https://ollama.example.com",
            "http://0.0.0.0:11434",
            # The prefix trap: a hostname that merely BEGINS with the literal.
            "http://127.0.0.1.evil.com:11434",
            "http://localhost.evil.com",
        ):
            self.assertFalse(is_loopback(url), url)

    def test_llm_kwargs_raises_on_a_remote_ollama(self) -> None:
        with self.assertRaises(NonLoopbackOllamaError):
            llm_kwargs({"model": QWEN, "baseUrl": "http://10.0.0.5:11434"})


if __name__ == "__main__":
    unittest.main()
