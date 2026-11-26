---
name: captain-setup
description: "The captain's first-turn setup interview: which agent, model and effort do large, focused and simple work, what to do when an agent hits its usage limit, accounts threads never use, where threads run and how much they may do. Run it once per project, or when the user asks to redo the captain's setup."
disable-model-invocation: true
---

# Captain setup

`captain` below means `node .captainstack/bin/captain.mjs`, run from the repo root.

## 1. Refuse inside Ghostex

```bash
node <this skill's folder>/../captain/scripts/captain.mjs setup check
```

(or `captain setup check` once `.captainstack/` exists). It exits with code 3 inside Ghostex
(Ghostex sets `GHOSTEX_*` variables, and `ghostex agents whoami` answers there). Then tell the user,
in one line, that CaptainStack does not run inside Ghostex and that Ghostex's own coordinators do
all of this natively, and stop. Do not work around it.

## 2. A captain session

No `.captainstack/` or no session yet:
`node <the captain skill's folder>/scripts/captain.mjs session new --title "<what this captain runs>"`.
A new session copies the project's setup when one exists; then `captain status` says "Setup: done"
and you skip to step 5 unless the user asked to redo it.

## 3. Ask

```bash
captain setup page
```

It writes the interview as a Live page, prefilled from the user's default (from an earlier project)
or a recommended setup built from the agents installed here, starts the answer server and opens the
page in the browser. Tell the user in one line that the setup page is open (give its URL) and that
it comes prefilled, so they may send it as is. Then wait for the answer (captain-threads, "Waking
up": `captain watch`). The questions:

- **Who does which work**: an agent, a model and an effort for large, complex work; hard, focused
  work; and simple, contained work.
- **When usage runs low**: A. stay on the same agent (wait for the reset), B. switch new work to a
  fallback agent, C. share between both then switch, D. ask each time; and the fallback agent.
- **Accounts or config folders threads never use** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **Where threads may run**: this computer, or also hosts over ssh.
- **Thread permissions**: standard (edits and safe commands) or full access.

No browser (a remote shell, a CI box)? Ask the same five questions in chat, one short message, each
with its recommended answer, and save them as JSON (step 4).

## 4. Save

When `captain watch` prints `Answer from the user: page-setup`:

```bash
captain setup save --from-page
```

From chat answers instead:

```bash
captain setup save --body-file - <<'EOF'
{"large": {"agent": "claude", "model": "opus", "effort": "high"},
 "focused": {"agent": "codex", "model": "default", "effort": "medium"},
 "simple": {"agent": "claude", "model": "sonnet", "effort": "low"},
 "usageLow": "switch", "fallback": "codex",
 "neverUse": [], "computers": "this computer only", "permission": "standard"}
EOF
```

It saves this captain's setup, the project's copy (`.captainstack/setup.json`, for later captains
here) and the user's default for new projects (`~/.captainstack/defaults.json`). Read the summary it
prints back to the user in one line ("Large work on Claude Opus high, focused on Codex medium,
simple on Claude Sonnet low; on a limit, new work moves to Codex").

## 5. Offer two things, then do the first request

Ask one inbox question (captain-ask) with two answers, both recommended and pick any:
"Show how working with a captain goes" (a short Live page: you talk only to the captain, threads do
the work, questions arrive in the inbox and at the end of each reply, reports arrive as Live pages)
and "Suggest Live pages for this project" (a triage page of open issues, a release checklist, a
progress board). Then do the user's first request.

## Redo or copy

The user asks to redo or change the setup: run the interview again (step 3). They name another
captain session to copy from: `captain setup copy <session id>`. Setup changes only through the
interview or `setup copy`, never through `captain remember`.
