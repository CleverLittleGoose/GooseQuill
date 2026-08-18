import re
import time
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional
import requests

from ..models.pricing import PricingRegistry, ModelPricing

logger = logging.getLogger(__name__)

class PricingSyncService:
    """Fetches and parses Google Gemini official pricing documentation (pricing.md.txt) on demand."""

    PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing.md.txt"

    # Vertex publishes its own rates at
    # https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
    # and they are NOT synced. That page has no machine-readable equivalent —
    # `.md.txt` 404s — so reading it would mean scraping 16 tables out of a
    # 2.8 MB templated HTML page, which would break quietly and report wrong
    # prices rather than no prices. For every model in the registry the Vertex
    # rates matched the Gemini API rates when checked on 2026-08-18, so the
    # estimates hold in either mode; if they ever diverge, Vertex is
    # authoritative for Vertex and the UI links there.
    VERTEX_PRICING_DOC = ("https://cloud.google.com/gemini-enterprise-agent-platform"
                          "/generative-ai/pricing")

    def __init__(self, cache_dir: Optional[Path] = None, timeout: float = 8.0):
        self.cache_dir = Path(cache_dir) if cache_dir else Path(".cache")
        self.cache_file = self.cache_dir / "pricing_overrides.json"
        self.timeout = timeout

    def sync_pricing(self) -> Dict[str, Any]:
        """Fetch pricing from Google, update PricingRegistry, and save to local cache."""
        try:
            resp = requests.get(self.PRICING_URL, timeout=self.timeout)
            if resp.status_code != 200:
                return {
                    "status": "error",
                    "message": f"HTTP {resp.status_code} when fetching pricing",
                    "pricing": PricingRegistry.get_all_raw()
                }

            text = resp.text
            parsed_models = self.parse_pricing_markdown(text)
            if not parsed_models:
                return {
                    "status": "warning",
                    "message": "No model pricing matched from markdown content",
                    "pricing": PricingRegistry.get_all_raw()
                }

            updated_keys = []
            for model_id, rates in parsed_models.items():
                if model_id in PricingRegistry.BASE_MODELS:
                    base = PricingRegistry.BASE_MODELS[model_id]
                    updated = ModelPricing(
                        name=rates.get("name", base.name),
                        input_standard=rates.get("input_standard", base.input_standard),
                        output_standard=rates.get("output_standard", base.output_standard),
                        input_batch=rates.get("input_batch", base.input_batch),
                        output_batch=rates.get("output_batch", base.output_batch),
                        context_cache=rates.get("context_cache", base.context_cache),
                        description=rates.get("description", base.description),
                        recommended_for=base.recommended_for,
                        context_window=base.context_window,
                        tier=base.tier
                    )
                    PricingRegistry.update_model_pricing(model_id, updated)
                    updated_keys.append(model_id)

            PricingRegistry.save_overrides(self.cache_file)

            return {
                "status": "success",
                "message": f"Successfully updated rates for {len(updated_keys)} Gemini models from Google AI docs.",
                "updated_models": updated_keys,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "pricing": PricingRegistry.get_all_raw()
            }
        except Exception as e:
            logger.warning(f"Pricing sync failed: {e}")
            return {
                "status": "error",
                "message": f"Failed to sync pricing: {str(e)}",
                "pricing": PricingRegistry.get_all_raw()
            }

    @classmethod
    def parse_pricing_markdown(cls, markdown_text: str) -> Dict[str, Dict[str, Any]]:
        """Parse models and rates from raw pricing markdown text."""
        models: Dict[str, Dict[str, Any]] = {}

        # Split markdown text by level-2 headings "## <Model Name>"
        sections = re.split(r'\n##\s+', markdown_text)
        for sec in sections:
            lines = sec.strip().split('\n')
            if not lines:
                continue
            model_name = lines[0].strip()

            # Find model ID on the italicised ID line, e.g. *`model-id`*.
            # Some sections list several IDs on one line, e.g.
            # *`gemini-3.1-pro-preview` and `gemini-3.1-pro-preview-customtools`*
            # so match the line opener and take the first ID rather than
            # requiring the closing asterisk to follow immediately.
            id_match = re.search(r'^\*`([^`]+)`', sec, re.MULTILINE)
            if not id_match:
                continue
            model_id = id_match.group(1).strip()

            # Find description (first paragraph after model ID)
            desc_lines = []
            capture_desc = False
            for line in lines[1:]:
                clean_l = line.strip()
                if clean_l.startswith("###") or clean_l.startswith("|"):
                    break
                if clean_l.startswith("[Try it") or clean_l.startswith("*`"):
                    continue
                if clean_l:
                    desc_lines.append(clean_l)
            description = " ".join(desc_lines).strip()

            # Parse standard table
            input_std = None
            output_std = None
            cache_std = None
            std_match = re.search(r'###\s+Standard\s+([\s\S]*?)(?=###|\n##|$)', sec)
            if std_match:
                std_table = std_match.group(1)
                in_m = re.search(r'\|\s*Input price[^|]*\|\s*[^|]+\|\s*\$?([0-9\.]+)', std_table, re.IGNORECASE)
                if in_m:
                    input_std = float(in_m.group(1))
                out_m = re.search(r'\|\s*Output price[^|]*\|\s*[^|]+\|\s*\$?([0-9\.]+)', std_table, re.IGNORECASE)
                if out_m:
                    output_std = float(out_m.group(1))
                cache_m = re.search(r'\|\s*Context caching price[^|]*\|\s*[^|]+\|\s*\$?([0-9\.]+)', std_table, re.IGNORECASE)
                if cache_m:
                    cache_std = float(cache_m.group(1))

            # Parse batch table
            input_batch = None
            output_batch = None
            batch_match = re.search(r'###\s+Batch\s+([\s\S]*?)(?=###|\n##|$)', sec)
            if batch_match:
                batch_table = batch_match.group(1)
                in_bm = re.search(r'\|\s*Input price[^|]*\|\s*[^|]+\|\s*\$?([0-9\.]+)', batch_table, re.IGNORECASE)
                if in_bm:
                    input_batch = float(in_bm.group(1))
                out_bm = re.search(r'\|\s*Output price[^|]*\|\s*[^|]+\|\s*\$?([0-9\.]+)', batch_table, re.IGNORECASE)
                if out_bm:
                    output_batch = float(out_bm.group(1))

            if input_std is not None and output_std is not None:
                # Default batch to 50% discount if not explicitly parsed
                if input_batch is None:
                    input_batch = round(input_std * 0.5, 4)
                if output_batch is None:
                    output_batch = round(output_std * 0.5, 4)
                if cache_std is None:
                    cache_std = round(input_std * 0.1, 4)

                models[model_id] = {
                    "name": model_name,
                    "input_standard": input_std,
                    "output_standard": output_std,
                    "input_batch": input_batch,
                    "output_batch": output_batch,
                    "context_cache": cache_std,
                    "description": description
                }

        return models
