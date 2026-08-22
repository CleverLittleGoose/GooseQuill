import sys
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.cost_calculator import CostCalculator
from goosequill.models.pricing import PricingRegistry

IN = CostCalculator.INPUT_TOKENS_PER_PAGE
OUT = CostCalculator.OUTPUT_TOKENS_PER_PAGE


class TestCostCalculatorService(unittest.TestCase):
    def test_per_page_assumptions_match_what_gemini_actually_bills(self):
        """Pin the constants, so changing them has to be deliberate.

        Input is the flat per-image rate Gemini 3 charges at the default media
        resolution (1120) plus the prompt; it is not derived from pixel count.
        Output is the measured mean across 11,190 converted pages of UK
        statutory accounts.
        """
        self.assertEqual(IN, 1262)
        self.assertEqual(OUT, 650)

    def test_estimate_tokens(self):
        inp, out, total = CostCalculator.estimate_tokens(10)
        self.assertEqual(inp, 10 * IN)
        self.assertEqual(out, 10 * OUT)
        self.assertEqual(total, 10 * (IN + OUT))

    def test_calculate_cost_for_pages(self):
        cost_31 = CostCalculator.calculate_cost_for_pages("gemini-3.1-flash-lite", 100)
        self.assertEqual(cost_31.input_tokens, 100 * IN)
        self.assertEqual(cost_31.output_tokens, 100 * OUT)
        self.assertEqual(cost_31.total_tokens, 100 * (IN + OUT))

        rates = PricingRegistry.MODELS["gemini-3.1-flash-lite"]
        expected = (
            (100 * IN) / 1_000_000 * rates.input_standard
            + (100 * OUT) / 1_000_000 * rates.output_standard
        )
        self.assertAlmostEqual(cost_31.cost_standard_usd, expected, places=6)
        self.assertAlmostEqual(cost_31.cost_batch_usd, expected / 2, places=6)

    def test_calculate_aggregate_costs(self):
        doc_pages = [10, 20, 30]
        agg_cost = CostCalculator.calculate_aggregate_costs(doc_pages, "gemini-3.7-flash")
        self.assertEqual(agg_cost.total_tokens, 60 * (IN + OUT))

    def test_flash_lite_35_costs_more_than_31_for_the_same_pages(self):
        """The choice between them is a quality decision, not a free one."""
        cost_31 = CostCalculator.calculate_cost_for_pages("gemini-3.1-flash-lite", 12_493)
        cost_35 = CostCalculator.calculate_cost_for_pages("gemini-3.5-flash-lite", 12_493)
        self.assertGreater(cost_35.cost_batch_usd, cost_31.cost_batch_usd)
        # ...but not by enough to decide a corpus-sized run on price alone.
        self.assertLess(cost_35.cost_batch_usd - cost_31.cost_batch_usd, 10.0)


if __name__ == "__main__":
    unittest.main()
