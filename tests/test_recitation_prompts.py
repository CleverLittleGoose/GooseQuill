"""What we ask for when a page is refused.

Statutory filings recite standard wording by design, so the auditor's report
trips Gemini's recitation filter constantly. The old way past it was to ask for
a summary instead — which worked, and left 566 pages of the first corpus run
holding paraphrase rather than the text printed on the page, with nothing
marking them apart. In a corpus someone will quote from, that is worse than a
hole: a hole is visible.
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.models.document import (
    PRESET_PROMPT_ID,
    RECITATION_FALLBACK_PROMPTS,
)


class TestRecitationPrompts(unittest.TestCase):
    def test_every_attempt_but_the_last_asks_for_the_text_itself(self):
        verbatim = [p for p in RECITATION_FALLBACK_PROMPTS if p.verbatim]
        self.assertGreaterEqual(len(verbatim), 3, "transcription must be tried properly first")
        self.assertTrue(RECITATION_FALLBACK_PROMPTS[0].verbatim)
        self.assertFalse(RECITATION_FALLBACK_PROMPTS[-1].verbatim,
                         "something is better than nothing, but only last")

    def test_no_attempt_that_claims_to_transcribe_asks_for_a_summary(self):
        """The exact defect: a prompt that says 'summarize' returns a summary."""
        for prompt in RECITATION_FALLBACK_PROMPTS:
            if not prompt.verbatim:
                continue
            with self.subTest(prompt=prompt.id):
                lowered = prompt.text.lower()
                for word in ("summarize", "summarise", "summary", "paraphrase"):
                    # Allowed only as a prohibition — "do not summarise".
                    if word in lowered:
                        self.assertRegex(
                            lowered,
                            rf"(do not|no)[^.]*{word}",
                            f"{prompt.id} asks for a {word} rather than forbidding one",
                        )

    def test_every_attempt_forbids_a_preamble(self):
        """"Based on the provided page, here is a summary..." is not a filing."""
        for prompt in RECITATION_FALLBACK_PROMPTS:
            with self.subTest(prompt=prompt.id):
                lowered = prompt.text.lower()
                self.assertTrue(
                    "output only" in lowered or "no preamble" in lowered,
                    f"{prompt.id} lets the model talk about the page instead of transcribing it",
                )

    def test_every_attempt_insists_the_figures_survive(self):
        for prompt in RECITATION_FALLBACK_PROMPTS:
            with self.subTest(prompt=prompt.id):
                lowered = prompt.text.lower()
                self.assertTrue(
                    any(word in lowered for word in ("figure", "number", "table")),
                    f"{prompt.id} does not protect the numbers",
                )

    def test_each_attempt_is_identifiable_and_distinct(self):
        ids = [p.id for p in RECITATION_FALLBACK_PROMPTS]
        self.assertEqual(len(ids), len(set(ids)), "ids are stamped into pages; they must be unique")
        self.assertNotIn(PRESET_PROMPT_ID, ids, "a fallback must not look like an ordinary conversion")

        texts = [p.text for p in RECITATION_FALLBACK_PROMPTS]
        self.assertEqual(len(texts), len(set(texts)), "asking the same thing twice is not a retry")


if __name__ == "__main__":
    unittest.main()
