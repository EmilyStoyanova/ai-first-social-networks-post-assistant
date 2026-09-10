"""The transport-safety boundary — the exact failure class from the live run.

Run on the Mac (needs `pydantic`, which CrewAI installs; needs no Ollama and
makes no model call):

    python -m unittest test_post_candidate -v

The live failure (run fe70f7d1): a Bulgarian post whose `text` contained the
show name `„Ндра’нгета"` with a BARE ASCII double-quote. `json.loads` raised
`Expecting ',' delimiter` and the whole generation was lost. These tests prove
the strict model round-trips that content when it is properly escaped, and
REJECTS — never repairs — it when it is not.
"""

from __future__ import annotations

import json
import unittest

from post_candidate import (
    POST_CANDIDATE_RESPONSE_FORMAT,
    PostCandidate,
    PostCandidateError,
    parse_post_candidate,
)

# The regression payload. Every quote style and character class from the live
# failure, escaped the way grammar-constrained decoding produces them.
QUOTE_HEAVY_TEXT = (
    'Представи си „езеро и дворец“ 🏰\n\n'
    'Сериалът "The Gentlemen" го показва, а "Ндра\'нгета" го използва.\n'
    "Пиши в коментарите! 👇"
)


def post_json(**overrides: object) -> str:
    body: dict[str, object] = {
        "text": QUOTE_HEAVY_TEXT,
        "hashtags": ["#TheGentlemen", "#пътувания"],
        "coreMessage": 'Окръгът около езерото не е „сърце", но "Ндра\'нгета" го използва.',
        "imagePrompt": 'A weathered lakeside palazzo, architect\'s "muted" palette.',
        "topic": "Локации от The Gentlemen",
    }
    body.update(overrides)
    return json.dumps(body, ensure_ascii=False)


class RoundTrips(unittest.TestCase):
    def test_quote_heavy_bulgarian_content_survives_serialisation(self) -> None:
        parsed = parse_post_candidate(post_json())
        # Pydantic serialises the text as ordinary string data...
        dumped = parsed.model_dump(exclude_none=True)
        # ...and the sidecar's json.dumps of the envelope is then valid JSON
        # regardless of the quote characters inside.
        envelope = json.dumps({"status": "ok", "candidate": {"json": dumped}})
        back = json.loads(envelope)
        self.assertEqual(back["candidate"]["json"]["text"], QUOTE_HEAVY_TEXT)
        self.assertIn('"The Gentlemen"', back["candidate"]["json"]["text"])
        self.assertIn("„езеро и дворец“", back["candidate"]["json"]["text"])
        self.assertIn("🏰", back["candidate"]["json"]["text"])
        self.assertIn("\n", back["candidate"]["json"]["text"])
        self.assertIn("'", back["candidate"]["json"]["coreMessage"])

    def test_model_validate_json_is_lossless(self) -> None:
        parsed = parse_post_candidate(post_json())
        again = PostCandidate.model_validate_json(parsed.model_dump_json())
        self.assertEqual(again.model_dump(), parsed.model_dump())

    def test_optional_fields_absent_behave_like_the_current_contract(self) -> None:
        parsed = parse_post_candidate(
            json.dumps({"text": "a post", "coreMessage": "a claim"})
        )
        # hashtags defaults to [] (mirrors z.array(z.string()).default([]))
        self.assertEqual(parsed.hashtags, [])
        # absent optionals are absent, not explicit null, after exclude_none
        self.assertEqual(
            parsed.model_dump(exclude_none=True),
            {"text": "a post", "hashtags": [], "coreMessage": "a claim"},
        )

    def test_optional_fields_present_are_kept(self) -> None:
        parsed = parse_post_candidate(post_json(notes="a note"))
        dumped = parsed.model_dump(exclude_none=True)
        self.assertEqual(dumped["notes"], "a note")
        self.assertIn("imagePrompt", dumped)
        self.assertIn("topic", dumped)

    def test_a_recognised_code_fence_is_stripped(self) -> None:
        fenced = "```json\n" + post_json() + "\n```"
        parsed = parse_post_candidate(fenced)
        self.assertEqual(parsed.text, QUOTE_HEAVY_TEXT)

    def test_coremessage_is_trimmed_like_the_zod_contract(self) -> None:
        parsed = parse_post_candidate(post_json(coreMessage="  a claim  "))
        self.assertEqual(parsed.coreMessage, "a claim")


class Rejects(unittest.TestCase):
    def test_the_exact_live_failure_raw_is_rejected_not_repaired(self) -> None:
        # A bare ASCII double-quote closes the string early — invalid JSON, the
        # precise shape of run fe70f7d1's step #11.
        broken = (
            '{\n  "text": "Представи си „Ндра\'нгета" я използва заради контрабандата",\n'
            '  "hashtags": ["#TheGentlemen"],\n  "coreMessage": "нещо"\n}'
        )
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(broken)

    def test_trailing_comma_is_not_repaired(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate('{"text":"a","coreMessage":"b","hashtags":[],}')

    def test_an_unexpected_field_is_rejected(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(post_json(surpriseField="nope"))

    def test_a_missing_required_field_is_rejected(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(json.dumps({"coreMessage": "a claim"}))
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(json.dumps({"text": "a post"}))

    def test_hashtags_must_be_a_list_of_strings(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(post_json(hashtags="growth"))
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(post_json(hashtags=[1, 2, 3]))

    def test_empty_and_whitespace_values_are_rejected(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(post_json(text=""))
        with self.assertRaises(PostCandidateError):
            parse_post_candidate(post_json(coreMessage="   "))

    def test_prose_around_the_json_is_rejected(self) -> None:
        with self.assertRaises(PostCandidateError):
            parse_post_candidate("Here is the post you asked for:\n" + post_json())

    def test_empty_input_is_rejected(self) -> None:
        for value in (None, "", "   ", "\n\n"):
            with self.assertRaises(PostCandidateError):
                parse_post_candidate(value)  # type: ignore[arg-type]


class ResponseFormatEnvelope(unittest.TestCase):
    """The schema handed to Ollama for constrained decoding."""

    def test_it_is_a_strict_json_schema_envelope(self) -> None:
        self.assertEqual(POST_CANDIDATE_RESPONSE_FORMAT["type"], "json_schema")
        js = POST_CANDIDATE_RESPONSE_FORMAT["json_schema"]
        self.assertEqual(js["name"], "PostCandidate")
        self.assertIs(js["strict"], True)

    def test_the_schema_forbids_extra_properties_and_matches_the_model(self) -> None:
        schema = POST_CANDIDATE_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertIs(schema["additionalProperties"], False)
        self.assertEqual(
            set(schema["properties"]),
            {"text", "hashtags", "coreMessage", "imagePrompt", "topic", "notes"},
        )
        # No product field was invented beyond the TypeScript LlmPostSchema.
        self.assertEqual(set(PostCandidate.model_fields), set(schema["properties"]))


if __name__ == "__main__":
    unittest.main()
