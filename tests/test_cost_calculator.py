import sys
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from goosequill.services.cost_calculator import CostCalculator
from goosequill.models.pricing import PricingRegistry

class TestCostCalculatorService(unittest.TestCase):
    def test_estimate_tokens(self):
        inp, out, total = CostCalculator.estimate_tokens(10)
        self.assertEqual(inp, 4000)
        self.assertEqual(out, 8500)
        self.assertEqual(total, 12500)

    def test_calculate_cost_for_pages(self):
        cost_31 = CostCalculator.calculate_cost_for_pages("gemini-3.1-flash-lite", 100)
        self.assertEqual(cost_31.input_tokens, 40000)
        self.assertEqual(cost_31.output_tokens, 85000)
        self.assertEqual(cost_31.total_tokens, 125000)
        
        # 40k / 1M * 0.25 = 0.010, 85k / 1M * 1.50 = 0.1275 => Total = 0.1375
        self.assertAlmostEqual(cost_31.cost_standard_usd, 0.1375, places=4)
        # Batch is 50% discount = 0.06875
        self.assertAlmostEqual(cost_31.cost_batch_usd, 0.06875, places=4)

    def test_calculate_aggregate_costs(self):
        doc_pages = [10, 20, 30]
        agg_cost = CostCalculator.calculate_aggregate_costs(doc_pages, "gemini-3.7-flash")
        self.assertEqual(agg_cost.total_tokens, 60 * 1250)

if __name__ == "__main__":
    unittest.main()
