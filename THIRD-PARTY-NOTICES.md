# Third-Party Notices

This project bundles the following third-party components. Each remains under
its own licence; the full texts are included alongside the files themselves.

## Bundled in this repository

| Component | Version | Licence | Licence text |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 15.0.7 | MIT | [`web/vendor/LICENSE-marked.txt`](web/vendor/LICENSE-marked.txt) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.4 | Apache-2.0 OR MPL-2.0 | [`web/vendor/LICENSE-DOMPurify.txt`](web/vendor/LICENSE-DOMPurify.txt) |
| [Inter](https://github.com/rsms/inter) | Variable | SIL OFL 1.1 | [`web/vendor/fonts/LICENSE-Inter.txt`](web/vendor/fonts/LICENSE-Inter.txt) |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | Variable | SIL OFL 1.1 | [`web/vendor/fonts/LICENSE-JetBrainsMono.txt`](web/vendor/fonts/LICENSE-JetBrainsMono.txt) |

The SIL Open Font License requires that the licence accompany the font files;
both licence texts are therefore included in `web/vendor/fonts/`.

## Python dependencies

Installed from PyPI at runtime rather than bundled here — see
[`requirements.txt`](requirements.txt). At the time of writing:

| Package | Licence |
|---|---|
| google-genai | Apache-2.0 |
| pypdfium2 | BSD-3-Clause / Apache-2.0 |
| python-dotenv | BSD-3-Clause |
| Pillow | MIT-CMU |
| FastAPI | MIT |
| Uvicorn | BSD-3-Clause |
| tqdm | MPL-2.0 / MIT |
| python-multipart | Apache-2.0 |
| requests | Apache-2.0 |

> **A note on PDF rendering:** this project uses
> [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) (a binding to Google's
> BSD-licensed PDFium) rather than PyMuPDF. PyMuPDF is the more common choice,
> but it is licensed AGPL-3.0, which would have been incompatible with releasing
> this project under Apache-2.0. Every component here is permissively licensed,
> so you can use GooseQuill in commercial and closed-source settings without
> copyleft obligations.
