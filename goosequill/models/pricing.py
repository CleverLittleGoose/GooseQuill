import os
import json
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class ModelPricing:
    name: str
    input_standard: float   # USD per 1M tokens
    output_standard: float  # USD per 1M tokens
    input_batch: float     # USD per 1M tokens (50% discount)
    output_batch: float    # USD per 1M tokens (50% discount)
    context_cache: float   # USD per 1M tokens
    description: str = ""
    recommended_for: str = ""
    context_window: str = "1M tokens"
    tier: str = "Standard"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class CostEstimate:
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_standard_usd: float
    cost_batch_usd: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "est_input_tokens": self.input_tokens,
            "est_output_tokens": self.output_tokens,
            "est_tokens": self.total_tokens,
            "est_cost_usd": self.cost_standard_usd,
            "est_cost_standard_usd": self.cost_standard_usd,
            "est_cost_batch_usd": self.cost_batch_usd,
        }

class PricingRegistry:
    """Official Google Gemini Token Pricing Registry (Rates per 1,000,000 tokens in USD)."""
    
    BASE_MODELS: Dict[str, ModelPricing] = {
        "gemini-3.1-flash-lite": ModelPricing(
            name="Gemini 3.1 Flash-Lite",
            input_standard=0.25,
            output_standard=1.50,
            input_batch=0.125,
            output_batch=0.75,
            context_cache=0.025,
            description="Our most cost-efficient model, optimized for high-volume agentic tasks, translation, and simple data processing.",
            recommended_for="Default / Recommended — Ultra Low Cost & High Speed OCR",
            context_window="1M tokens",
            tier="Default / Economy"
        ),
        "gemini-3.5-flash-lite": ModelPricing(
            name="Gemini 3.5 Flash-Lite",
            input_standard=0.30,
            output_standard=2.50,
            input_batch=0.15,
            output_batch=1.25,
            context_cache=0.03,
            description="Our most cost-efficient GA model, optimized for high-volume agentic tasks, translation, and simple data processing.",
            recommended_for="Cost-Efficient GA — High-Volume Processing",
            context_window="1M tokens",
            tier="Economy"
        ),
        "gemini-3.7-flash": ModelPricing(
            name="Gemini 3.7 Flash",
            input_standard=0.75,
            output_standard=3.75,
            input_batch=0.375,
            output_batch=1.875,
            context_cache=0.075,
            description="Our most capable Flash model for agentic workflows and multimodal reasoning.",
            recommended_for="Flagship Hybrid Reasoning & Complex Multimodal OCR",
            context_window="1M tokens",
            tier="Frontier Flash"
        ),
        "gemini-3.6-flash": ModelPricing(
            name="Gemini 3.6 Flash",
            input_standard=0.75,
            output_standard=3.75,
            input_batch=0.375,
            output_batch=1.875,
            context_cache=0.075,
            description="Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.",
            recommended_for="Frontier Speed & Multimodal Intelligence",
            context_window="1M tokens",
            tier="High-Speed Flash"
        ),
        "gemini-3.5-flash": ModelPricing(
            name="Gemini 3.5 Flash",
            input_standard=1.50,
            output_standard=9.00,
            input_batch=0.75,
            output_batch=4.50,
            context_cache=0.15,
            description="Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.",
            recommended_for="Balanced Intelligence & Speed",
            context_window="1M tokens",
            tier="Standard Flash"
        ),
        "gemini-3-flash-preview": ModelPricing(
            name="Gemini 3 Flash Preview",
            input_standard=0.50,
            output_standard=3.00,
            input_batch=0.25,
            output_batch=1.50,
            context_cache=0.05,
            description="Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.",
            recommended_for="Next-Gen Flash Preview Intelligence",
            context_window="1M tokens",
            tier="Preview Flash"
        ),
        "gemini-3.1-pro-preview": ModelPricing(
            name="Gemini 3.1 Pro Preview",
            input_standard=2.00,
            output_standard=12.00,
            input_batch=1.00,
            output_batch=6.00,
            context_cache=0.20,
            description="The latest performance, intelligence, and usability improvements to the best model family in the world for multimodal understanding, agentic capabilities, and vibe-coding.",
            recommended_for="Frontier Multimodal Understanding & Complex Layouts",
            context_window="1M tokens",
            tier="Frontier Pro"
        ),
        "gemini-2.5-pro": ModelPricing(
            name="Gemini 2.5 Pro",
            input_standard=1.25,
            output_standard=10.00,
            input_batch=0.625,
            output_batch=5.00,
            context_cache=0.125,
            description="Our state-of-the-art multipurpose model, which excels at coding and complex reasoning tasks.",
            recommended_for="Complex Layouts & Deep Reasoning",
            context_window="1M tokens",
            tier="Pro"
        ),
        "gemini-2.5-flash": ModelPricing(
            name="Gemini 2.5 Flash",
            input_standard=0.30,
            output_standard=2.50,
            input_batch=0.15,
            output_batch=1.25,
            context_cache=0.03,
            description="Our first hybrid reasoning model which supports a 1M token context window and has thinking budgets.",
            recommended_for="Hybrid Reasoning & Thinking Budget",
            context_window="1M tokens",
            tier="Standard Flash"
        ),
        "gemini-2.5-flash-lite": ModelPricing(
            name="Gemini 2.5 Flash-Lite",
            input_standard=0.10,
            output_standard=0.40,
            input_batch=0.05,
            output_batch=0.20,
            context_cache=0.01,
            description="Our smallest and most cost effective model, built for at scale usage.",
            recommended_for="Ultra-Low Cost Scaling",
            context_window="1M tokens",
            tier="Economy"
        )
    }

    MODELS: Dict[str, ModelPricing] = dict(BASE_MODELS)

    # When the rates above were last fetched from Google, as an ISO-8601 UTC
    # string. ``None`` means nobody has ever synced, and the figures are the
    # ones bundled with this release.
    #
    # That distinction is the whole point of recording it. Without it a rate
    # card that has never been synced looks exactly like one synced this
    # morning, and the reader has no way to tell a current figure from one
    # frozen at whenever the release was cut.
    synced_at: Optional[str] = None

    DEFAULT_MODEL = "gemini-3.1-flash-lite"
    PRICING_DOC_URL = "https://ai.google.dev/gemini-api/docs/pricing"
    PRICING_RAW_URL = "https://ai.google.dev/gemini-api/docs/pricing.md.txt"

    @classmethod
    def get(cls, model_name: str) -> ModelPricing:
        return cls.MODELS.get(model_name, cls.MODELS.get(cls.DEFAULT_MODEL, list(cls.MODELS.values())[0]))

    @classmethod
    def get_all_raw(cls) -> Dict[str, Dict[str, Any]]:
        return {k: v.to_dict() for k, v in cls.MODELS.items()}

    @classmethod
    def update_model_pricing(cls, model_key: str, pricing: ModelPricing):
        cls.MODELS[model_key] = pricing

    @classmethod
    def load_overrides(cls, cache_file: Path):
        """Load cached pricing overrides, and when they were fetched."""
        if not cache_file.exists():
            return
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            models, synced_at = cls._unpack_cache(data)
            loaded = 0
            for k, v in models.items():
                if isinstance(v, dict) and "input_standard" in v:
                    cls.MODELS[k] = ModelPricing(**v)
                    loaded += 1

            # A cache written before the sync time was recorded carries none,
            # and reporting that as ``None`` would tell the reader these rates
            # had never been synced when in fact they had — the exact confusion
            # the field exists to remove. The file's own mtime is when it was
            # written, which is when the sync happened. The next sync replaces
            # this with the real thing.
            if synced_at is None and loaded:
                synced_at = datetime.fromtimestamp(
                    cache_file.stat().st_mtime, tz=timezone.utc
                ).isoformat(timespec="seconds")

            cls.synced_at = synced_at

            logger.info(f"Loaded pricing overrides from {cache_file}")
        except Exception as e:
            logger.warning(f"Failed to load pricing overrides from {cache_file}: {e}")

    @staticmethod
    def _unpack_cache(data: Any) -> tuple:
        """
        The rates in a cache file, and the time they were fetched.

        Caches written before the sync time was recorded are a bare
        ``{model_id: rates}`` map. Those are read rather than discarded — the
        rates in them are real and current, and only the "when" is missing, so
        they load with an unknown sync time rather than none of their figures.
        """
        if not isinstance(data, dict):
            return {}, None
        if isinstance(data.get("models"), dict):
            return data["models"], data.get("synced_at")
        return data, None

    @classmethod
    def save_overrides(cls, cache_file: Path):
        """Persist current pricing registry, and its sync time, to cache file."""
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump({"synced_at": cls.synced_at, "models": cls.get_all_raw()}, f, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save pricing overrides to {cache_file}: {e}")
