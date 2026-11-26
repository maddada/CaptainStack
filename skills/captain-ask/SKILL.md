---
name: captain-ask
description: "Ask the user well as a captain: only what only they can decide, one question per dimension, a recommendation, a full description, through the inbox (or a Live page), with answers read back from the answer server or the chat. Use whenever a captain needs a decision, an approval or an action from the user."
---

# Captain ask

`captain` below means `node .captainstack/bin/captain.mjs`.

Ask only what only the user can decide. If there is a sensible default, a standing rule, or the
choice is easy to undo, decide yourself and tell them in the reply. Ask each question in exactly
one place, never in plain text the user has to type an answer to, and never with your agent's
built-in question tool: the user reads it in the inbox page or the Needs you list, usually without
your reply beside it, so **the question alone must hold everything they need to decide**.

## Where

- **It belongs to a line of work**:
  `captain item ask W<n> "<title>" --detail "<full context>" --answer "A" --answer "B" --recommended "A"`.
  `--holds` when the work stops until they answer (the item shows Blocked); `--multiple` when they
  may pick several (`--recommended A,B`).
- **No line of work fits**: `captain ask "<title>" --detail … --answer … --recommended …`.
- **Something the user must do** (sign in, approve, paste): `captain ask --todo "<title>" --detail "<the exact steps, text in a fenced block, the link>"`. Its answer is Done.
- **More than 4 answers, answers that need a sentence each, or things to look at** (mockups, fixes
  from a report): a Live page with a card per choice and the question under them (captain-pages).
  Never repeat a page's questions with `ask`.

`ask` allows at most 4 answers of a few words each (about 40 characters, a label like "Fix as
suggested"). Explain each answer in `--detail`.

## Every question

- **The "away for a day" test**: the title names the thing in plain words (about ten words), makes
  clear what each answer does, and holds no internal ids (`W12`, `Q4`, thread ids, hashes): the CLI
  refuses them. Never "it" or "this" without the thing it stands for.
- **Description** (`--detail`, at least 120 characters, refused when thinner): what the thing is,
  what each answer does, what you recommend and why, any risks, and links (a Markdown link with the
  full URL, or a file path). Whatever the user needs to act goes in it: the text to paste in its own
  fenced block, the command, the link, the steps. For anything posted in the user's name, its full
  verbatim text.
- **One question per dimension**: when options differ in more than one way, ask one question per
  kind of choice. Pick any unless the choices truly exclude each other; say why when it is pick one.
- Mark the answer you recommend.
- **"I don't get it"**: withdraw the question (`captain inbox withdraw Q<n>`) and ask again more
  simply. Never re-send the same wording.
- A thread's question: ask it yourself, rewritten so the title names the subject and the
  description says what it is about and why (the user has not read the thread's report), then send
  the answer back to the thread.

## Answers

The user answers on the inbox page (the answer server writes the answer to
`.captainstack/sessions/<captain>/answers/Q<n>.json` and wakes `captain watch`), or in the chat
("Q3 A", "Q3 wait for the fix"). For a chat answer, record it: `captain answer Q3 "A"` (a letter
picks that answer; any other words are kept as they are).

- `captain answers` prints the new answers since you last looked and marks them seen. Act on each;
  never ask it again.
- Open your reply with the combined pick in one line ("Building A + D, A darker in dark mode"), so a
  misread shows at once.
- In the same turn, withdraw every open question the user settled another way (in plain words, by
  doing it, by a later answer): `captain inbox withdraw Q<n>`, or `captain inbox done Q<n>` for a
  to-do they did.
- End your turn after asking (start the watcher first); the answer wakes you.

Example:

```bash
captain item ask W12 "Merge the stalled-uploads fix from an outside contributor?" \
  --detail "The pull request [#412](https://github.com/org/repo/pull/412) retries chunk uploads after a 30s timeout instead of failing the whole transfer. All tests pass.

- **Ask for changes first (recommended):** cap retries at 3 and log each one, so a bad connection cannot loop forever. Delays the fix by a day or two.
- **Merge now:** ships today; a follow-up adds the cap and the logging.

Risk if merged as is: an offline client retries until it is closed." \
  --answer "Ask for changes first" --answer "Merge now" --recommended "Ask for changes first"
```
