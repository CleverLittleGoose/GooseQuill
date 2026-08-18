# Privacy

**This is a notice about what the software does with your documents.** It is not
a policy about a service we run, because we don't run one — GooseQuill executes
entirely on your own machine, and Clever Little Goose LLC never sees anything you
process with it.

For how Clever Little Goose LLC handles personal data as a company — email,
suppliers, the website — see [cleverlittlegoose.com/privacy](https://cleverlittlegoose.com/privacy).
That document covers the company. This one covers the tool.

---

## The short version

GooseQuill sends your PDF pages to Google's Gemini API, because that is how it
reads them. Everything else stays on your machine. There is no telemetry, no
analytics, no account, and nothing reports back to us.

**The one thing worth reading twice:** on a free-tier Google API key, Google may
use your documents to improve their products. If what you're processing is
confidential, use a paid-tier key.

---

## Where your documents actually go

GooseQuill makes network requests to exactly **two** destinations. You can verify
this yourself — the whole codebase is here, and `grep` for `https://` will find
both in under a second.

**1. Google's Gemini API** (`generativelanguage.googleapis.com`), via the
official `google-genai` SDK.

Each page of each PDF you convert is rasterized to an image and sent to Google,
together with your chosen OCR prompt. Google returns the transcribed Markdown.
This is the core function of the tool and cannot be turned off — it is what
GooseQuill *is*. If you are not comfortable with a document reaching Google, do
not process that document with GooseQuill.

Your API key is sent with each request, because that is how the API
authenticates you.

**If you have configured Vertex AI**, that first destination changes: requests
go to Google's EU multi-region residency endpoint
(`aiplatform.eu.rep.googleapis.com`) instead, and your documents are processed
inside the EEA. That is a configuration you have to switch on deliberately —
the README explains how, and it takes three lines in `.env`. GooseQuill never
falls back from it to the global endpoint; a broken Vertex configuration stops
the job instead of quietly relocating your documents.

**2. Google's published pricing document** (`ai.google.dev`), when you press
**Sync Pricing**.

A plain `GET` for a public documentation page, so the cost estimates stay
accurate. **No document content, no API key, and no information about you is
sent** — it is the same request your browser would make visiting the page. It
happens only when you ask for it, never automatically.

That is the complete list. No third-party fonts, scripts or CDNs: Inter,
JetBrains Mono, marked and DOMPurify are all vendored into this repository and
served from your own machine, so opening the interface contacts nobody.

---

## Free tier versus paid tier

This is the most consequential decision you will make when setting GooseQuill up,
and it is easy to get wrong because the free tier is the default path.

Google's own pricing tables carry a row headed **"Used to improve our
products"**. For the **Free Tier** it reads **Yes**. For the **Paid Tier** it
reads **No**.

In the context of this tool, "used to improve our products" means the contents of
every PDF you convert. If you are processing statutory accounts, contracts,
unpublished filings, medical records, or anything containing other people's
personal data, **enable billing and use a paid-tier key.**

The cost is not the obstacle it might sound like: a fifteen-page annual report
costs a fraction of a penny on `gemini-3.1-flash-lite`, and the interface shows
you the estimate before you commit. See the README for how to get either kind of
key.

Google's terms for the API are at
[ai.google.dev/gemini-api/terms](https://ai.google.dev/gemini-api/terms). Your
use of the API is a matter between you and Google; we are not a party to it.

---

## What stays on your machine

- **Your PDFs and Markdown** — in your documents folder, wherever you pointed it.
- **The page cache** (`.cache/`) — transcribed text, kept so an interrupted job
  can resume. Delete the folder whenever you like; it costs you nothing but
  reprocessing.
- **Batch job records** (`.cache/batches/`) — job IDs and file paths for
  asynchronous jobs.
- **Your API key** (`.env`) — read at startup, never logged, never written
  anywhere else, and never transmitted to anyone but Google. `.env` is
  gitignored; keep it that way.

None of this is encrypted at rest. It has exactly the protection your user
account and disk encryption give it, which for most people is enough — but if you
are processing something sensitive on a shared machine, that is worth knowing.

---

## What GooseQuill never does

- No telemetry, crash reporting, usage statistics, or "anonymous diagnostics".
- No account, licence check, activation, or update ping.
- No advertising, tracking, or profiling.
- No sending your documents anywhere except Google's API, as described above.
- No network access at all beyond those two destinations — including at startup.

The server also binds to `127.0.0.1` by default, so nothing is exposed to your
network. See [SECURITY.md](SECURITY.md) for why that matters.

---

## If you are processing other people's personal data

GooseQuill is a tool you run; it is not a service we operate. If you use it to
process documents containing personal data, **you are the data controller** for
that processing, and Google is your processor under the Gemini API terms. Clever
Little Goose LLC has no role in it, no access to it, and no ability to retrieve
anything you have processed.

Under UK GDPR and EU GDPR that means the usual obligations are yours: a lawful
basis, appropriate safeguards for the transfer to Google, and — because sending
documents to a third-party AI service is exactly the kind of processing that
tends to warrant one — potentially a DPIA. **Do not use a free-tier key for
anyone else's personal data.** The training permission is difficult to reconcile
with most lawful bases, and impossible to reconcile with a duty of
confidentiality.

**If the transfer itself is your difficulty rather than the training**, the
Vertex AI option above keeps processing inside the EEA, which removes the
international transfer from the analysis entirely. It is the better answer for
UK and EU practitioners handling client documents, and it is three lines of
configuration.

This paragraph is a signpost, not legal advice.

---

## Questions

Open an issue on this repository, or write to
[hello@cleverlittlegoose.com](mailto:hello@cleverlittlegoose.com).

*Last updated: 18 August 2026.*
