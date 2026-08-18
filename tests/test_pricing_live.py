"""Opt-in canary: does Google's *real* pricing document still parse?

The rest of the suite is hermetic and stubs the network, so a change to Google's
published format would otherwise go unnoticed until a user pressed Sync and got
nothing back. This test catches that, but only when you ask for it:

    GOOSEQUILL_LIVE_TESTS=1 python -m unittest discover tests

Keep it out of ordinary CI runs — it depends on a third party being up, and a
failure here means "upstream changed", not "this commit is broken".
"""

import os
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.pricing_sync import PricingSyncService
from goosequill.models.pricing import PricingRegistry


@unittest.skipUnless(
    os.environ.get("GOOSEQUILL_LIVE_TESTS") == "1",
    "Live network test — set GOOSEQUILL_LIVE_TESTS=1 to run."
)
class TestPricingLive(unittest.TestCase):
    """Verifies the parser against the live upstream document."""

    @classmethod
    def setUpClass(cls):
        import requests
        resp = requests.get(PricingSyncService.PRICING_URL, timeout=20)
        resp.raise_for_status()
        cls.parsed = PricingSyncService.parse_pricing_markdown(resp.text)

    def test_live_document_still_parses(self):
        """The document should still yield a plausible number of models."""
        self.assertGreaterEqual(
            len(self.parsed), 5,
            "Parsed too few models — Google's pricing format has probably changed. "
            "Update parse_pricing_markdown() and tests/fixtures.py."
        )

    def test_bundled_models_are_all_still_published(self):
        """Every model we ship a rate card for should still exist upstream."""
        missing = [m for m in PricingRegistry.BASE_MODELS if m not in self.parsed]
        self.assertEqual(
            missing, [],
            f"Bundled models no longer found in Google's pricing docs: {missing}. "
            "They may have been retired — consider removing them from the registry."
        )

    def test_bundled_rates_match_upstream(self):
        """Our bundled defaults should not drift from the published rates."""
        drifted = []
        for model_id, bundled in PricingRegistry.BASE_MODELS.items():
            live = self.parsed.get(model_id)
            if not live:
                continue
            for field in ("input_standard", "output_standard"):
                if abs(live[field] - getattr(bundled, field)) > 1e-6:
                    drifted.append(
                        f"{model_id}.{field}: bundled {getattr(bundled, field)} "
                        f"vs live {live[field]}"
                    )
        self.assertEqual(
            drifted, [],
            "Bundled pricing has drifted from Google's published rates:\n  "
            + "\n  ".join(drifted)
        )


if __name__ == "__main__":
    unittest.main()
