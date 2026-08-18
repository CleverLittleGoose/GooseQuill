from typing import Tuple, List, Optional
from ..models.pricing import CostEstimate, PricingRegistry

class CostCalculator:
    """Accurate token usage & cost estimator for Google Gemini Models."""

    # Page token defaults for 200 DPI PNG financial reports:
    # - Input: ~258 image tokens (200 DPI PNG) + ~142 prompt tokens = 400 input tokens/page
    # - Output: ~850 tokens of dense Markdown financial tables and text per page
    INPUT_TOKENS_PER_PAGE: int = 400
    OUTPUT_TOKENS_PER_PAGE: int = 850

    @classmethod
    def estimate_tokens(cls, total_pages: int) -> Tuple[int, int, int]:
        """Returns (input_tokens, output_tokens, total_tokens)."""
        inp = total_pages * cls.INPUT_TOKENS_PER_PAGE
        out = total_pages * cls.OUTPUT_TOKENS_PER_PAGE
        return inp, out, inp + out

    @classmethod
    def calculate_cost_for_pages(cls, model_name: str, total_pages: int) -> CostEstimate:
        """Calculate standard and batch costs for a given page count and model."""
        inp, out, total = cls.estimate_tokens(total_pages)
        pricing = PricingRegistry.get(model_name)

        cost_standard = (inp / 1_000_000 * pricing.input_standard) + (out / 1_000_000 * pricing.output_standard)
        cost_batch = (inp / 1_000_000 * pricing.input_batch) + (out / 1_000_000 * pricing.output_batch)

        return CostEstimate(
            input_tokens=inp,
            output_tokens=out,
            total_tokens=total,
            cost_standard_usd=round(cost_standard, 6),
            cost_batch_usd=round(cost_batch, 6)
        )

    @classmethod
    def calculate_aggregate_costs(cls, page_counts: List[int], model_name: str) -> CostEstimate:
        """Calculate total aggregate token and dollar costs across multiple documents."""
        total_pages = sum(page_counts)
        return cls.calculate_cost_for_pages(model_name, total_pages)
