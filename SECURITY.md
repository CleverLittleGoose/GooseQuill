# Security

## The trust model, in one paragraph

This is a **single-user, local-first tool**. The API has no authentication, and
by design it reads and writes files inside whichever documents folder you point
it at. The server therefore binds to `127.0.0.1` and should stay there. Anyone
who can reach the port can read and modify every document in your workspace.

## If you expose it

Don't, unless you put your own authentication in front of it. Setting
`GOOSEQUILL_HOST=0.0.0.0` binds to every network interface — on shared or public
Wi-Fi that hands your documents to anyone on the same network. The app logs a
warning when you do this.

## What the app does protect against

- All client-supplied paths are resolved and confined to the active documents
  root; traversal attempts (`../`, absolute paths) are rejected with `403`.
- Uploaded filenames and folder names are stripped to a single safe component,
  so a crafted name cannot write outside the target folder.
- Only `.pdf` files can be rendered and only `.md` files can be read or written
  through the file endpoints.
- Model output is rendered through DOMPurify before it reaches the DOM, so a PDF
  containing markup cannot inject script into the viewer.

## Your API key

Your Gemini key is read from `.env` or the environment and never written to
disk elsewhere, never logged, and never sent anywhere except Google's API.
`.env` is gitignored — keep it that way. If you think a key has leaked, revoke
it at https://aistudio.google.com/apikey.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository rather than opening a public issue.
