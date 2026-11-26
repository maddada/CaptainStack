---
name: captain-pages
description: "Make a captain's reports, plans and mockups as Live pages: one self-contained HTML page in Ghostex's page format with questions at the end, checked, served by the local answer server and opened in the browser, with the answers written back to files. Use when a captain passes on results longer than a few lines, or asks something the user must look at."
---

# Captain pages

`captain` below means `node .captainstack/bin/captain.mjs`.

A report goes on a Live page, never in your reply. Anything longer than a few lines (results,
findings, research, test outcomes, a comparison) is a page that ends with a question, usually
"What next?" with concrete choices, so the answer comes back to you. Your reply only says the page
is there. Short status news (pushed, still running) stays in the reply.

## Make one

```bash
captain page new --title "Upload retry: test results"   # a skeleton in the session's pages/, with a fresh tag
captain next-tag                                         # another tag for each extra question
```

Pages use Ghostex's page markup, so the same file also opens as a real Live page inside Ghostex:

- `<meta name="ghostex-page" content="v2">` and a `<title>` that names the subject.
- The whole page inside one `<gx-questions submit="Send to the captain">`: a `<header>` with
  `<span class="gx-eyebrow">`, `<h1>`, `<p class="gx-lede">` and `<div class="gx-chips">` of
  `<span class="gx-chip">`; then sections, tables, `.gx-stats`/`.gx-stat` tiles, and
  `<gx-wide><div class="gx-options">` rows of `<section data-question="Q1" data-choice="a">` cards
  for side-by-side variants.
- Each `<gx-question tag="Q1" title="…">` sits right under what it asks about: a `<p>` explains it,
  then `<gx-choice value="…" recommended>Label<small>one line</small></gx-choice>`. `multiple` for
  pick any; `type="text"` for a text box; `type="menus"` with named `<select>`s. The kit adds Other,
  the note boxes, "Anything else?" and the Send button: write none of them.
- Every question follows the captain-ask rules (a title that names its subject, no internal ids, a
  recommendation, one question per dimension).
- Draw only the page's own parts in a `<style>`; the kit paints the page, cards, glass and buttons
  (`var(--gx-fg)`, `--gx-muted`, `--gx-line`, `--gx-surface`, `--gx-pick`, `--chart-1..5`). Plain
  language, no em dashes.

## Check and show

```bash
captain page check <file>     # fails on a missing marker or title, a reused tag, an em dash, a pointer question
captain page show <file>      # checks, copies it into the session's pages/, starts the answer server, opens it
```

`show` puts the page in the user's Needs you list (it appears in `captain footer` with its link)
and opens it in the browser through the answer server, which adds Ghostex's page kit (its theme,
page API and question kit, MIT) so the page looks and works like a Live page. The user answers
and presses Send: the server writes `answers/page-<name>.json` and `captain watch` wakes you with
`Answer from the user`. Read them with `captain answers`. Inside Ghostex, `ghostex show <file>`
publishes the same file natively.

- A newer version of the same file: `page show` it again; the old entry is replaced.
- A page you replaced with another or that is out of date: `captain page retire <page>`.
- To send a page to someone without the server: `captain page export <file>` writes a standalone
  copy whose Send shows the answers as JSON to copy back; `captain page import <answers.json>`
  records them.
- No browser at all: write a short Markdown report with the same question at the end, and ask it
  with `captain ask`.

## The answer server

`captain serve --background` (started for you by `page show` and `setup page`) listens on
`127.0.0.1` only, refuses posts from other sites, and writes everything to files in
`.captainstack/`. `captain serve --stop` stops it. Its JSON API (for the Captain window and any
tool): `GET /api/health`, `/api/sessions`, `/api/s/<id>/state` (the board, inbox, threads, pages,
memory, setup and recent events in one call), `/api/s/<id>/board|inbox|needs-you|threads|threads/<t>|pages|memory|setup`,
`/api/s/<id>/events?since=<n>&wait=<seconds>` (long-poll); `POST /api/s/<id>/answer`
`{"tag":"Q3","answer":"A","note":"…"}` and `/api/s/<id>/withdraw` `{"tag":"Q3"}`. The inbox page is
`/s/<id>/inbox`; pages are `/s/<id>/pages/<file>`.
