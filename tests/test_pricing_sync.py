import json
import sys
import tempfile
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fixtures import SAMPLE_MARKDOWN
from goosequill.services.pricing_sync import PricingSyncService
from goosequill.models.pricing import PricingRegistry


class TestPricingSyncService(unittest.TestCase):
    def test_parse_pricing_markdown(self):
        parsed = PricingSyncService.parse_pricing_markdown(SAMPLE_MARKDOWN)
        self.assertIn("gemini-3.1-flash-lite", parsed)
        self.assertIn("gemini-3.7-flash", parsed)

        lite = parsed["gemini-3.1-flash-lite"]
        self.assertEqual(lite["input_standard"], 0.25)
        self.assertEqual(lite["output_standard"], 1.50)
        self.assertEqual(lite["input_batch"], 0.125)
        self.assertEqual(lite["output_batch"], 0.75)
        self.assertEqual(lite["context_cache"], 0.025)
        self.assertIn("cost-efficient model", lite["description"])

        flash = parsed["gemini-3.7-flash"]
        self.assertEqual(flash["input_standard"], 0.75)
        self.assertEqual(flash["output_standard"], 3.75)
        self.assertEqual(flash["input_batch"], 0.375)
        self.assertEqual(flash["output_batch"], 1.875)
        self.assertEqual(flash["context_cache"], 0.075)


class TestSyncTimeIsRecorded(unittest.TestCase):
    """
    When the rates were last fetched, and why it has to survive a restart.

    The registry is the rates bundled with the release until somebody presses
    Sync, and the rate card cannot tell the reader which they are looking at
    unless the sync time is written down and read back.
    """

    def setUp(self):
        self._original = PricingRegistry.synced_at
        self._dir = tempfile.TemporaryDirectory()
        self.cache = Path(self._dir.name) / "pricing_overrides.json"

    def tearDown(self):
        PricingRegistry.synced_at = self._original
        self._dir.cleanup()

    def test_never_synced_reads_as_never_rather_than_as_a_guess(self):
        PricingRegistry.synced_at = None
        PricingRegistry.load_overrides(self.cache)  # file does not exist
        self.assertIsNone(PricingRegistry.synced_at,
                          "no cache means nobody has ever synced, and the card says so")

    def test_the_sync_time_survives_a_restart(self):
        PricingRegistry.synced_at = "2026-08-19T09:00:00+00:00"
        PricingRegistry.save_overrides(self.cache)

        PricingRegistry.synced_at = None  # as if the process had restarted
        PricingRegistry.load_overrides(self.cache)
        self.assertEqual(PricingRegistry.synced_at, "2026-08-19T09:00:00+00:00")

    def test_the_saved_file_still_carries_every_rate(self):
        PricingRegistry.synced_at = "2026-08-19T09:00:00+00:00"
        PricingRegistry.save_overrides(self.cache)

        written = json.loads(self.cache.read_text())
        self.assertEqual(set(written), {"synced_at", "models"})
        self.assertEqual(written["models"], PricingRegistry.get_all_raw())

    def test_a_cache_written_before_sync_times_existed_is_still_read(self):
        """
        The old format is a bare {model_id: rates} map. Its rates are real, and
        discarding them would throw away a sync that did happen.
        """
        self.cache.write_text(json.dumps(PricingRegistry.get_all_raw()))

        PricingRegistry.synced_at = None
        PricingRegistry.load_overrides(self.cache)

        self.assertEqual(PricingRegistry.MODELS["gemini-3.1-flash-lite"].input_standard, 0.25,
                         "the rates in an old cache still load")
        self.assertIsNotNone(PricingRegistry.synced_at,
                             "an old cache was synced at some point; reporting None would "
                             "tell the reader it never had been")

    def test_a_corrupt_cache_does_not_take_the_registry_down_with_it(self):
        self.cache.write_text("[not even an object]")
        PricingRegistry.synced_at = None
        PricingRegistry.load_overrides(self.cache)
        self.assertIn("gemini-3.1-flash-lite", PricingRegistry.MODELS,
                      "a bad cache falls back to the bundled rates rather than raising")


if __name__ == "__main__":
    unittest.main()
