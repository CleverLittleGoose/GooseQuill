"""Shared test fixtures.

A trimmed excerpt of Google's published pricing document, kept here so the
suite can exercise the parser without reaching the network. Update it if the
live format changes (test_pricing_live.py will tell you when that happens).
"""

SAMPLE_MARKDOWN = """
## Gemini 3.1 Flash-Lite

*`gemini-3.1-flash-lite`*

[Try it in Google AI Studio](https://aistudio.google.com/prompts/new_chat?model=gemini-3.1-flash-lite)

Our most cost-efficient model, optimized for high-volume agentic tasks,
translation, and simple data processing.

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.25 (text / image / video) |
| Output price (including thinking tokens) | Free of charge | $1.50 |
| Context caching price | Not available | $0.025 |

### Batch

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.125 |
| Output price (including thinking tokens) | Free of charge | $0.75 |

## Gemini 3.7 Flash

*`gemini-3.7-flash`*

[Try it in Google AI Studio](https://aistudio.google.com?model=gemini-3.7-flash)

Our most capable Flash model for agentic workflows and multimodal reasoning.

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.75 |
| Output price (including thinking tokens) | Free of charge | $3.75 |
| Context caching price | Free of charge | $0.075 |

### Batch

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Not available | $0.375 |
| Output price (including thinking tokens) | Not available | $1.875 |
"""
