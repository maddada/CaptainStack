---
name: captain-board
description: "Keep the captain's work items on the work.json board: one item per line of work, with its status, now line, steps, waits, asks and threads, rendered to WORK.md. Use when a captain starts, moves or finishes a line of work, or checks the board before ending its turn."
---

# Captain board

`captain` below means `node .captainstack/bin/captain.mjs`. The board is
`.captainstack/sessions/<captain>/work.json`, changed only through these verbs, which check the
rules and rewrite `WORK.md` beside it (read it, never edit it).

Every line of work is one item, named the way the user would name it ("Checkout redesign"),
including work you do yourself (a release, a merge). A thread, a step, a rebuild or a question is
never an item: attach it to one. Item ids (`W12`) are CLI handles, never how you talk to the user.

```bash
captain item add "Checkout redesign" --thread t2      # W1
captain item now W1 "building the one-page layout"    # one line that replaces the last
captain item step W1 "mockups" --done                 # a step the user cares about; --chore for rebuilds
captain item wait W1 --on W2                          # or --on Q3, or --on "CI run 8812"; --clear
captain item ask W1 "<title>" --detail "<full context>" --answer "Yes" --answer "Wait" --recommended "Yes" [--holds]
captain item done W1 "one-page checkout on main"      # the one line worth keeping
captain item drop W1                                  # abandoned (withdraws its asks)
captain item edit W1 --status parked                  # set aside (Later); --status open brings it back
captain item link W1 --thread t3
captain item list [--all] · captain item show W1
captain item list --check                             # before you end every turn
```

## Statuses (worked out, never set by hand)

- **Blocked**: an open ask with `--holds`: the user must act now. Nothing else is Blocked.
- **Needs you**: an open ask on the item.
- **In progress**: a thread on it is running, or it has a now line (you are on it right now).
- **Waiting**: on something outside that hasn't happened: another item (clears when it is done), a
  question (clears when answered), or words ("CI run 8812", cleared by the next `now` or
  `wait --clear`). Never the user.
- **Not being worked on**: nobody is on it; finish it, park it, ask, or work on it.
- **Later**: parked. **Done**: `item done`.

## Rules

- Update the item in the turn something changes: the thread reported (`now` or `done`), the work
  waits (`wait`), the user must decide (`ask`).
- Never park the user's part in a now or wait line ("waiting on your review" is refused): when only
  the user can unblock it, `item ask` (captain-ask). If there is a sensible default or it is easy
  to undo, decide yourself and say so.
- Done means done: the thread reported, the change is committed (and pushed when the user wants
  that). Never hold finished work In progress waiting on the user.
- `item list --check` names what to fix: In progress with nobody on it, quiet or failed threads, a
  thread that reported after its item last changed, items nobody works on, threads on no item.
  Fix them before you end your turn.
