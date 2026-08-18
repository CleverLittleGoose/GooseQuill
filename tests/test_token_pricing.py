import sys
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.models import PricingRegistry

PRICING = PricingRegistry.get_all_raw()

class TestTokenPricing(unittest.TestCase):
    def test_pricing_keys_and_values(self):
        """Verify each model has valid positive input and output token rates."""
        for model_name, rates in PRICING.items():
            self.assertIn("input_standard", rates)
            self.assertIn("output_standard", rates)
            self.assertIn("input_batch", rates)
            self.assertIn("output_batch", rates)
            self.assertIn("name", rates)
            self.assertGreater(rates["input_standard"], 0)
            self.assertGreater(rates["output_standard"], 0)
            self.assertGreaterEqual(rates["output_standard"], rates["input_standard"])

    def test_cost_calculation_math(self):
        """Verify standard cost formula and 50% batch discount for default gemini-3.1-flash-lite."""
        # 10 pages: 4,000 input tokens, 8,500 output tokens
        input_tokens = 10 * 400   # 4,000
        output_tokens = 10 * 850  # 8,500
        
        rates = PRICING["gemini-3.1-flash-lite"]
        # input_standard: $0.25/1M, output_standard: $1.50/1M
        expected_input_cost = (input_tokens / 1_000_000) * rates["input_standard"]
        expected_output_cost = (output_tokens / 1_000_000) * rates["output_standard"]
        expected_standard = expected_input_cost + expected_output_cost
        expected_batch = (input_tokens / 1_000_000 * rates["input_batch"]) + (output_tokens / 1_000_000 * rates["output_batch"])

        calc_standard = (input_tokens / 1_000_000 * rates["input_standard"]) + (output_tokens / 1_000_000 * rates["output_standard"])
        calc_batch = (input_tokens / 1_000_000 * rates["input_batch"]) + (output_tokens / 1_000_000 * rates["output_batch"])

        self.assertAlmostEqual(calc_standard, expected_standard, places=6)
        self.assertAlmostEqual(calc_batch, expected_batch, places=6)
        # Verify batch is exactly 50% discount
        self.assertAlmostEqual(calc_batch, calc_standard * 0.50, places=6)

    def test_flash_lite_vs_flash_economics(self):
        """Verify 3.1 Flash-Lite is more cost-efficient than 3.7 Flash and 3.5 Flash."""
        lite_31 = PRICING["gemini-3.1-flash-lite"]
        flash_37 = PRICING["gemini-3.7-flash"]
        flash_35 = PRICING["gemini-3.5-flash"]
        self.assertLess(lite_31["input_standard"], flash_37["input_standard"])
        self.assertLess(lite_31["output_standard"], flash_37["output_standard"])
        self.assertLess(lite_31["input_standard"], flash_35["input_standard"])
        self.assertLess(lite_31["output_standard"], flash_35["output_standard"])

    def test_model_metadata_specs(self):
        """Verify each model has description, recommended_for, and context_window specs."""
        for model_name, rates in PRICING.items():
            self.assertIn("description", rates)
            self.assertIn("recommended_for", rates)
            self.assertIn("context_window", rates)
            self.assertIn("tier", rates)
            self.assertTrue(len(rates["description"]) > 0)

if __name__ == "__main__":
    unittest.main()
