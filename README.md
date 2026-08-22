# GooseQuill — Universal PDF to Markdown Pipeline

A high-fidelity OCR and document transcription pipeline using Google's **Gemini Interactions API** (`gemini-3.1-flash-lite`, `gemini-3.7-flash`, etc.).

Built for dense statutory financial statements, balance sheets, legal filings, technical whitepapers, and general multi-page PDF documents.

---

## Features

- **Gemini Interactions API**: Direct integration with Google's latest `interactions.create` API using `gemini-3.1-flash-lite` (default, ultra low latency & lowest cost) or full Gemini 3.x/2.5 vision models (`gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`, etc.).
- **Live Official Pricing Sync**: On-demand synchronization with Google AI's live documentation feed ([ai.google.dev/pricing](https://ai.google.dev/gemini-api/docs/pricing)) via UI button or API endpoint.
- **Zero External CDN Dependencies**: 100% self-contained and offline-ready with local Marked, DOMPurify, and self-hosted fonts.
- **Smart Page-Level Caching**: Every page is cached in `.cache/` as it completes. If interrupted, the job resumes instantly without re-processing completed pages.
- **Interactive Web Interface**:
  - Drag-and-drop PDF uploader.
  - Document & folder explorer with live status indicators.
  - Document Studio: the transcript beside the page it came from, with a page index, find-in-document, and several documents open at once as tabs.
  - Compare two filings side by side, with change highlighting across years of the same entity — over the Markdown as written, or over the words it renders to.
  - Workspace-wide search across every converted document, showing the page each match sits on.
  - Markdown Consolidation & Combiner Studio with live preview, smart chronological/alphabetical sorting, Table of Contents generation, and instant export.
  - Deflate: boilerplate removal that prices a selection against a Claude Project before you build it.
  - Choose the working documents folder from your own Finder/Explorer dialog, opened by the local server since no browser will report a folder's path.
  - Keyboard-driven: `Cmd/Ctrl+K` to open a document, `?` for the full list.
  - Rich Model Picker with live specification & rate cards (Standard, Batch 50% off, Context caching).
  - Customizable OCR prompts and presets (Financial Statements, Dense Tables, General Documents).
  - Asynchronous Batch API jobs with 50% discount.
- **Object-Oriented Architecture**: Modular `goosequill` Python package with typed dataclasses, single-responsibility services, and decoupled testing.
- **Standalone CLI Tools**: `cli.py convert`, `cli.py combine`, `cli.py deflate` and `cli.py serve`, plus the simpler `convert_reports_to_markdown.py` and `combine_markdown.py` scripts.

---

## Deflate — getting a corpus into a Claude Project

Statutory accounts are mostly the same words. The audit report, the directors'
responsibilities statement, the accounting policies: every company prints them,
and in a workspace of a few hundred filings you are paying for the same
paragraph a hundred times over. Deflate finds the repeated text and replaces
each copy after the first with a pointer to the one that stays.

It only ever deletes. Every word in a lightweight file came from the transcript
it was made from — nothing is generated, paraphrased or summarised.

### What makes something boilerplate

Repetition **across companies**, not across filings. A passage is boilerplate
when several separate entities print it; a company repeating itself year on
year is keeping its own standing description, which is the opposite of
boilerplate and is left alone.

Two ways to qualify:

- seen at **three or more separate companies** anywhere in the workspace; or
- seen at **two or more companies inside one format family** — companies whose
  names share a leading word, which is how a group's subsidiaries are usually
  filed — where the filings are drafted off a shared template and word their
  statutory notes the same way. Different families word the same note
  differently and never match each other, so the corpus-wide count alone misses
  a stack's own template text.

### What is never removed

Primary financial statements; anything with a table in it; going concern,
material uncertainty, qualified opinions, key audit matters; related parties,
subsidiaries, controlling party and ultimate parent notes; board appointments
and resignations; and any passage carrying a monetary figure the surviving copy
does not contain.

That last rule matters more than it looks. Fingerprinting masks amounts and
dates so that structurally identical prose matches whatever the numbers in it —
which is exactly how a sentence reporting a figure unique to one filing could
be mistaken for one that says nothing. Nothing carrying a new number is
removed.

### A caveat worth stating plainly

The protected-keyword lists are tuned for **UK statutory company accounts** —
going concern, controlling party, key audit matters, and the rest. On that
material they are careful. On anything else — technical whitepapers, court
filings, research papers — they protect nothing in particular, and the only
guards left are the structural ones (tables, short sections, figures the kept
copy lacks). Run `--mode dry-run` first and read the report before letting it
write anything over an unfamiliar corpus.

### Modes

| Mode | What it does |
| :--- | :--- |
| `algorithmic` | Deterministic, no API calls. The default. |
| `safe` | As above, then a model confirms each candidate. Removes a section **only** on an explicit verdict — an unreachable classifier means nothing is removed, not that everything is. |
| `dry-run` | Reports what would happen and writes no files. |

### Where the output goes

Lightweight copies are written to `<Entity>/Lightweight/`, alongside but
separate from `Markdown/`. They are excluded from search and from the Combiner
by default, since a deflated filing is its own transcript with less in it and
offering both means listing the same document twice. The Deflate view switches
the Combiner over to them when it hands a set across.

```bash
python cli.py deflate --all --mode dry-run
```

```bash
python cli.py deflate --folder "Example Holdings Limited"
```

### How much smaller

On a 26 MB corpus of 379 filings across 28 companies, around 12% — roughly
800,000 tokens. Useful, and not magic: most of a set of accounts is tables and
figures, which is the part you are keeping. If a selection still does not fit,
the budget meter in the Deflate view says so before you build anything, and the
answer is a narrower selection rather than a harder squeeze.

---

## Supported Gemini Models

| Model ID | Model Name | Standard Input / Output (per 1M) | Overnight Batch (50% Off) | Best For |
|---|---|---|---|---|
| `gemini-3.1-flash-lite` | **Gemini 3.1 Flash-Lite (Default)** | $0.25 / $1.50 | $0.125 / $0.75 | Ultra low cost, high-speed statutory OCR |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash-Lite | $0.30 / $2.50 | $0.150 / $1.25 | Cost-efficient GA high-volume processing |
| `gemini-3.7-flash` | Gemini 3.7 Flash | $0.75 / $3.75 | $0.375 / $1.875 | Flagship hybrid reasoning & multimodal OCR |
| `gemini-3.6-flash` | Gemini 3.6 Flash | $0.75 / $3.75 | $0.375 / $1.875 | Frontier speed & multimodal intelligence |
| `gemini-3.5-flash` | Gemini 3.5 Flash | $1.50 / $9.00 | $0.750 / $4.50 | Balanced intelligence & speed |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | $0.50 / $3.00 | $0.250 / $1.50 | Next-gen flash preview |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | $2.00 / $12.00 | $1.000 / $6.00 | Complex multi-column financial layouts |
| `gemini-2.5-pro` | Gemini 2.5 Pro | $1.25 / $10.00 | $0.625 / $5.00 | Deep reasoning & legacy pro accuracy |
| `gemini-2.5-flash` | Gemini 2.5 Flash | $0.30 / $2.50 | $0.150 / $1.25 | Hybrid reasoning with thinking budget |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash-Lite | $0.10 / $0.40 | $0.050 / $0.20 | Ultra-low cost legacy scaling |

*The rates above are the ones bundled with this release, correct at the time of
writing. They are a snapshot, and Google changes them — nothing in this file
updates itself. GooseQuill does not read its prices from here: the app costs
every estimate against its own registry, which **Settings → Sync Rates** refreshes
from Google, and the **Economics** view shows the live figures along with when they
were last checked. Treat that card, or
[Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing), as
authoritative — not this table.*

---

## Getting Started

### Requirements

- Python 3.10 or newer
- A Google Gemini API key — see below

### Getting a Gemini API key

There are two places to get one, and **the choice matters if your documents are
confidential**.

#### Option 1 — Google AI Studio (quickest)

Go to [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) and
create a key. This is the fastest route and has a free tier.

> ⚠️ **On the free tier, Google may use your prompts and responses to improve
> their products** — which here means the contents of every PDF you process.
> Google's own pricing tables state this explicitly ("Used to improve our
> products: **Yes**" for Free Tier, **No** for Paid Tier).
>
> If you are processing anything confidential — client accounts, contracts,
> unpublished filings, personal data — **enable billing and use a paid-tier
> key**. Paid usage of the models listed above is inexpensive: a typical
> 15-page annual report costs a fraction of a penny on `gemini-3.1-flash-lite`.
> The in-app cost estimator shows you the figure before you commit.

Free-tier keys also carry per-minute and per-day rate limits, which this tool
will hit on large batches. You can review yours at
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).

#### Option 2 — Google Cloud Console (for existing Cloud users)

If you already have a Google Cloud project with billing configured, create the
key at
[console.cloud.google.com/agent-platform/studio/settings/api-keys](https://console.cloud.google.com/agent-platform/studio/settings/api-keys).
Keys made against a billed project are paid-tier from the start, so the training
caveat above does not apply.

#### Option 3 — Vertex AI, if your documents must stay in the EEA

Options 1 and 2 both use the Gemini Developer API, which is a **global**
endpoint: you get no say in which territory your documents are processed in.
For client accounts, contracts or anything carrying other people's personal
data, that may not be good enough.

Vertex AI's **EU multi-region residency endpoint** fixes that. You need a
Google Cloud project and an API key belonging to it — no service account, no
`gcloud` login:

```env
GOOSEQUILL_USE_VERTEX=1
GOOGLE_CLOUD_PROJECT=your-project-id
VERTEX_API_KEY=your_project_scoped_key
```

That is the whole configuration. It defaults to
`https://aiplatform.eu.rep.googleapis.com`, in the `eu` multi-region.

**Two things that are easy to get wrong:**

- **It must be the multi-region (`eu`), not a single region like
  `europe-west4`.** Several Flash-Lite models are served in the US and EU
  multi-regions *only*, with no single-region availability anywhere. Note the
  hostname shape — `.rep.`, rather than a `{region}-` prefix.
- **The API key must belong to the project** in `GOOGLE_CLOUD_PROJECT`.

**There is no fallback to the global endpoint.** If the Vertex configuration is
incomplete, GooseQuill refuses to start the job rather than quietly sending your
documents somewhere else — which is the failure a residency endpoint exists to
prevent.

Two limitations, both stated plainly rather than discovered later:

| | |
|---|---|
| **Batch jobs** | Not available. The batch flow uploads its payload through the Gemini File API, which Vertex doesn't offer — it stages batch input in Cloud Storage instead, which GooseQuill doesn't implement. Convert normally and pay the standard rate rather than the 50% batch rate. |
| **Cost estimates** | Still accurate, but not synced. Vertex publishes its own rates, [here](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) — and for every model GooseQuill ships a rate card for, they match the Gemini API rates (spot-checked 18 August 2026: Flash-Lite, 3.7 Flash, 3.5 Flash and 2.5 Pro all agree on input *and* output). **Sync Pricing** reads the Gemini API page, because that one is published as a machine-readable document and the Vertex page is not. If the two ever diverge, the Vertex page is authoritative for Vertex. |

#### Keeping the key safe

Put the key in `.env`, which is gitignored — never paste it into source files or
commit it. If you think a key has leaked, revoke it immediately from the same
page you created it on.

### 1. Clone and configure

```bash
git clone https://github.com/CleverLittleGoose/GooseQuill.git
cd GooseQuill
cp .env.example .env
```

Then open `.env` and add your key:

```env
PDF_MARKDOWN_KEY=your_gemini_api_key_here
```

*(`GEMINI_API_KEY` and `GOOGLE_API_KEY` are also accepted.)*

### 2. Launch

```bash
./launch.sh
```

On first run this creates a virtual environment, installs dependencies, starts
the server, and opens http://localhost:8000 in your browser. Subsequent runs
skip straight to launching.

Drop your PDFs into the `documents/` folder — or use the in-app uploader, or
point the app at any folder on your machine from **Settings → Working Directory**.

That setting has a **Choose Folder** button that opens your own Finder or
Explorer dialog. It works in a way worth knowing about, because it is not
something a web page can normally do: browsers deliberately refuse to tell a
page where a folder sits on disk — `webkitdirectory` hands over the files
inside it, `showDirectoryPicker()` hands over a handle, and neither is a path.
GooseQuill gets around this by having the *server* open the dialog, which it
can do because it is running on the same machine you are sitting at.

The consequence: **the dialog opens wherever the server is running, not
wherever your browser is.** Run GooseQuill normally and those are the same
machine, so it behaves as you would expect. Serve it to another machine and the
dialog would open on the server's screen, out of your reach — so type the path
into the field instead, which does the same job. The button hides itself on
hosts with no dialog to show, such as a headless server.

If GooseQuill is already running, `./launch.sh` opens the browser at it rather
than trying to start a second copy. If something else holds the port, it tells
you what.

#### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `GOOSEQUILL_PORT` | `8000` | Port to serve on. |
| `GOOSEQUILL_HOST` | `127.0.0.1` | Bind address. Leave it alone unless you have read [SECURITY.md](SECURITY.md) — the API is unauthenticated. |
| `GOOSEQUILL_RELOAD` | `0` | `1` restarts the server when the code changes. Watches the code only, not your documents. |
| `GOOSEQUILL_VERBOSE_ACCESS` | `0` | `1` logs every request. Off, page images and static assets are logged only when they fail. |

### Notes on privacy and security

**Your documents are sent to Google's Gemini API** — that is how GooseQuill reads
them. Nothing else leaves your machine, there is no telemetry, and we never see
anything you process. [PRIVACY.md](PRIVACY.md) sets out exactly what is sent
where, and why the free-tier/paid-tier choice above matters.

### A note on security

This tool is **local-first and single-user**. The API has no authentication and
can read and write files in your documents folder, so the server binds to
`127.0.0.1` only. Please read [SECURITY.md](SECURITY.md) before changing that.

---

## Testing & Developer Guide

### Running the Test Suite

Run the automated test runner script directly from the project root:
```bash
./test.sh
```

`test.sh` runs both suites: the Python backend under `unittest`, and the
frontend modules under Node's built-in test runner. Note that **`pytest` is not
a dependency of this project and is not installed** — reach for `unittest`.

Or activate the virtual environment and run `unittest` directly:
```bash
source venv/bin/activate

# Standard library unittest
python -m unittest discover tests
```

The suite is hermetic — it makes no network calls, so it runs offline and in CI.

#### The frontend tests

They run on Node's built-in test runner, so there is nothing to install. One
group is the exception: the tests for search highlighting need a real DOM and
use [jsdom](https://github.com/jsdom/jsdom). It is a development dependency and
nothing in GooseQuill itself ever loads it — the app is Python serving static
files, and does not need Node at all.

Without it those tests report as skipped and everything else runs as normal. To
run them:

```bash
npm install
```

There are two opt-in exceptions. Google occasionally changes the format of its
published pricing document, which would silently break the **Sync Pricing**
feature. This check catches that, and is skipped unless you ask for it:

```bash
GOOSEQUILL_LIVE_TESTS=1 python -m unittest discover tests
```

A failure there means *upstream changed*, not that your commit is broken — see
[`tests/test_pricing_live.py`](tests/test_pricing_live.py).

---

## Standalone CLI Usage

### 1. Batch Document Conversion

```bash
source venv/bin/activate

# Convert all discovered PDFs with default gemini-3.1-flash-lite
python convert_reports_to_markdown.py

# Convert with Gemini 3.7 Flash
python convert_reports_to_markdown.py --model gemini-3.7-flash

# Convert a single PDF file
python convert_reports_to_markdown.py --file "documents/Annual Report 2024.pdf"

# Test run on the first 3 pages only
python convert_reports_to_markdown.py --limit-pages 3
```

### 2. Markdown Consolidation & Combining

```bash
source venv/bin/activate

# Combine all converted markdowns in a company folder in chronological order with Table of Contents
python combine_markdown.py --folder "Acme Corporation" --output "Acme_Consolidated.md"

# Combine specific markdown or PDF files
python combine_markdown.py --files "Report 2019.md" "Report 2020.md" "Report 2021.md" --output "Consolidated_2019-2021.md"

# Combine all converted markdowns across all folders in workspace
python combine_markdown.py --all --output "All_Documents_Master.md"
```

---

## Output Structure

Converted markdown files are saved directly in a `Markdown/` subfolder alongside the original PDF:
- `<document_folder>/Markdown/<pdf_name>.md`
- Consolidated outputs: `<document_folder>/Consolidated/<combined_name>.md`

Consolidations live in their own folder because a consolidation contains every
document it was made from. Beside the transcripts they counted as converted
documents, appeared in the list of things to consolidate — so combining a folder
swept up yesterday's combination of it — and matched every search twice.

If you have consolidations from an earlier version sitting in `Markdown/`,
`python migrate_consolidated.py` will show you what would move, and
`--apply` moves it.

---

## Contributing

Issues and pull requests are welcome. Please run the test suite before opening a
PR:

```bash
./test.sh
```

---

## Licence

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Clever Little Goose LLC.

This project bundles third-party components (marked, DOMPurify, Inter and
JetBrains Mono) which remain under their own licences — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Every dependency is permissively licensed — there is no copyleft anywhere in
the stack — so you can use GooseQuill commercially and in closed-source work.
