import sys
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

if __name__ == "__main__":
    unittest.main()
