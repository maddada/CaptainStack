---
name: captain-memory
description: "Keep the captain's lasting notes: preferences, decisions and pitfalls from the user as numbered, dated one-liners, saved only after the user confirms the wording, plus overrides for every captain. Use when the user states a lasting preference or rule, or after a compaction."
---

# Captain memory

`captain` below means `node .captainstack/bin/captain.mjs`.

Each captain session keeps its own `memory.md` in `.captainstack/sessions/<captain>/`, inside the
repo (so the captain can read it under any permission level) and git-ignored. Threads never read it:
nothing points them there. What a thread needs from it goes in its brief, worded for the thread.

```bash
captain memory                      # this captain's notes, the overrides and the setup
captain remember "<one line>"       # appends "N. YYYY-MM-DD: <line>"
captain forget <N>
captain override add "<rule>"       # a rule for every captain, in every project
captain override list | remove <N>
```

- A lasting preference, decision or pitfall from the user ("release only on Fridays", "never touch
  the billing folder"): propose the exact one-line wording and ask; once they confirm, `remember`
  it. The confirmation is the answer to that question.
- Read `captain memory` at the start of a session and after every compaction: notes are not in a
  compaction summary.
- A rule every thread in this project must follow belongs in the project's `AGENTS.md` (or
  `CLAUDE.md`): offer to add it there instead.
- A rule for all captains ("every captain should…") is an override: propose the wording, and once
  they confirm, `captain override add`. Never rewrite the other overrides.
- Setup answers change only through the setup interview (captain-setup), never with `remember`.
