from typing import Tuple, List, Optional
from ..models.pricing import CostEstimate, PricingRegistry

class CostCalculator:
    """Accurate token usage & cost estimator for Google Gemini Models."""

    # Page token defaults for a 200 DPI PNG page of a dense financial report.
    #
    # Input: Gemini 3 bills an image at a flat rate set by media_resolution,
    # not by pixel count — 1120 tokens at the default for images, which is
    # the high tier. The 258 figure quoted here previously is the cost of a
    # single 768x768 tile, which only applies to images small enough to fit
    # in one. A full page never is. Add ~142 tokens for the prompt.
    #
    # Output: measured across 11,190 converted pages of UK statutory
    # accounts, which averaged 2,345 characters — about 650 tokens. The
    # previous 850 was a guess, and an over-estimate.
    INPUT_TOKENS_PER_PAGE: int = 1262
    OUTPUT_TOKENS_PER_PAGE: int = 650

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
