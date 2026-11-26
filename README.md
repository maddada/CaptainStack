# CaptainStack

A portable captain (a PM, or coordinator) for any agent CLI or ADE. Run `/captain` in Claude Code,
Codex, Cursor CLI, OpenCode, Copilot CLI or Pi, and that agent becomes the project's captain: it
plans your requests, hands the work to **threads** (headless runs of any of those agents in the
background), follows them, keeps a **work board** and an **inbox** of what needs you, asks you only
what matters, and reports on **Live pages** you answer in the browser.

It is files and one small Node CLI (standard library only, macOS, Linux and Windows). No server to
host, no daemon, no account.

> CaptainStack is the portable version of [Ghostex](https://github.com/maddada/Ghostex)'s
> coordinators. Inside Ghostex, use Ghostex's own coordinators: they do all of this natively (and
> more, see below), so CaptainStack's setup refuses to run there.

## What you get

| Skill | Who runs it | What it does |
| --- | --- | --- |
| `captain` | you | Be this project's captain for the session: read the board, inbox and memory, then plan, start threads, follow them and report. |
| `captain-setup` | you | The first-turn interview: which agent, model and effort for large, focused and simple work; what to do on a usage limit; accounts never to use; where threads run; how much they may do. |
| `captain-inbox` | you | Walk through what needs you right now, in chat or on the inbox page. |
| `captain-threads` | the agent | Brief, start, follow, heal and collect threads, with a recipe per agent CLI and the watcher that wakes the captain. |
| `captain-board` | the agent | Work items on `work.json`: status, now line, steps, waits, asks and threads. |
| `captain-ask` | the agent | Ask well: only what only you can decide, one question per dimension, a recommendation and a full description. |
| `captain-memory` | the agent | Lasting notes and overrides, saved only after you confirm the wording. |
| `captain-pages` | the agent | Reports, plans and mockups as Live pages with questions at the end, answered in the browser. |

And the CLI behind them, `node .captainstack/bin/captain.mjs` (the captain installs it in your repo
on its first run):

- **Threads**, the same verbs as Ghostex's coordinators: `start-thread`, `send` (follow-ups resume
  the agent's own session), `read` (the last N messages both ways, or the agent's log), `threads`,
  `status`, `stop`, `close`. Threads talk back with `note` and wait for the captain with
  `wait-message`.
- **Watchers**: `captain watch` blocks until a thread reports, notes, fails or hits a usage limit,
  or you answer, then exits, so the captain wakes up (on Claude Code as a background command; on
  the others by waiting in the turn). The captain-threads skill says how, per agent.
- **Work board** (`item add|now|step|wait|ask|done|drop|list --check`), **inbox** (`ask`, `answer`,
  `answers`, to-dos), **memory** (`remember`, `forget`, overrides), the **setup** answers.
- **Live pages** in Ghostex's page format, served with Ghostex's own page kit (MIT) by a small
  **answer server** on `127.0.0.1` that writes your answers back to files and wakes the captain. It
  has a clean JSON API (`/api/s/<id>/state` and friends) for the Captain window, a GUI that plugs in
  later.
- **The Needs you footer** at the end of every captain reply (`captain footer`) and a one-line
  status (`captain statusline`).

All state sits in `.captainstack/` in your repo (added to `.gitignore` for you), one folder per
captain session, so several captains in one repo each keep their own memory, board, inbox and
threads:

```
.captainstack/
  bin/captain.mjs          the CLI every agent runs (any permission level can reach it)
  kit/ghostex-kit.html     Ghostex's page kit
  setup.json               this project's setup answers, copied into new captains
  server.json              the answer server, while it runs
  sessions/c1/
    session.json  setup.json  memory.md  work.json  WORK.md  inbox.json  events.jsonl
    answers/      Q3.json, page-<name>.json
    pages/        setup.html, reports and plans
    threads/t1/   brief.md  thread.json  messages.jsonl  log.jsonl  stderr.log  report.md
```

Your setup default lives in `~/.captainstack/defaults.json`, rules for every captain in
`~/.captainstack/overrides.md`.

## Install

Pick one route per agent: installing both a plugin and skills.sh gives you every skill twice. Node
18 or newer must be on your PATH (it already is wherever an npm-installed agent CLI runs).

<details open>
<summary><strong>Claude Code</strong> (plugin marketplace, updates itself)</summary>

```bash
claude plugin marketplace add maddada/CaptainStack
claude plugin install captainstack@captainstack
```

Then, in a repo: `/captain` (or ask "be my captain").

</details>

<details open>
<summary><strong>Codex</strong> (plugin marketplace, updates at startup)</summary>

```bash
codex plugin marketplace add maddada/CaptainStack
codex plugin add captainstack@captainstack
```

Then: `$captain` (or ask "use the captain skill").

</details>

<details>
<summary><strong>Copilot CLI</strong> (plugin marketplace)</summary>

```bash
copilot plugin marketplace add maddada/CaptainStack
copilot plugin install captainstack@captainstack
```

Not tested yet: tell us how it goes.

</details>

<details open>
<summary><strong>Cursor CLI, OpenCode, Pi and every other agent</strong> (skills.sh, manual updates)</summary>

```bash
npx skills@latest add maddada/CaptainStack -a cursor      # or -a opencode, -a pi; omit -a to choose
```

Take all eight skills when it asks. Update with `npx skills@latest update`, and run `add` again to
pick up new skills.

</details>

From a local clone instead (to try changes): `claude plugin marketplace add ./CaptainStack`,
`codex plugin marketplace add ./CaptainStack`, or `npx skills@latest add ./CaptainStack -a <agent>`.

## How a captain turn goes

1. **Read state**: `captain status` (setup, usage rule, what needs you, what is new, threads,
   board).
2. **Decide**: answer it, reuse a thread, or start one per unrelated task.
3. **Start threads**: `captain start-thread --kind focused --title "…" --body-file -`, the brief in a
   heredoc. The thread runs in the background with its log in its folder.
4. **Ask and report**: questions to the inbox, long results to a Live page, the board updated.
5. **Wait and end the turn**: start `captain watch`, end with the Needs you list. A thread's report
   or your answer wakes the captain for its next turn.

## Agents

| Agent | Captain | Threads | Wakes on a thread report | Install route |
| --- | --- | --- | --- | --- |
| Claude Code | yes | `claude -p`, resumed by session id | yes: a background `captain watch`, or Monitor | plugin marketplace |
| Codex | yes | `codex exec`, resumed by thread id | waits on `captain watch` in the turn | plugin marketplace |
| Cursor CLI | yes | `cursor-agent -p`, resumed by chat id | waits in the turn | skills.sh |
| OpenCode | yes | `opencode run`, resumed by session id | waits in the turn | skills.sh |
| Copilot CLI | untested | `copilot -p`, resumed by id | waits in the turn | plugin marketplace |
| Pi | yes | `pi -p --mode json`, resumed by session id | waits in the turn | skills.sh |

Gemini CLI is not supported.

## Usage limits

No agent CLI exposes a usage meter a script can read, so CaptainStack works from the limit itself:
when a thread stops on a usage-limit error, the runner marks it `limited` and wakes the captain,
which follows the rule you picked in the setup interview (stay and wait, switch new work to a
fallback agent, share then switch, or ask each time). It never spends your limit resets and never
switches the account you are signed in with.

## What stays Ghostex-only

| Ghostex has | CaptainStack gets instead |
| --- | --- |
| Reports pushed to the coordinator the moment a thread ends, on every agent | A watcher the captain waits on; a real wake-up on Claude Code |
| One-tap answers above the chat box, on the phone and in notifications | The inbox page, the answer server and the Needs you footer |
| Usage meters, LOW and OUT warnings, automatic account moves | A fallback after a usage-limit error, by your setup's rule |
| Threads as visible sessions you can open and type into | Logs and messages you read with `captain read` |
| Nudges and healing for quiet or stuck threads | A "quiet" mark in `status` and `item list --check` |
| Threads on connected computers with their approvals | ssh, when you name the hosts in the setup |
| Checked pages (`ghostex visual check`), private secret cards | `captain page check`, and best effort by the skills' rules |

## Develop

```bash
npm test                 # the CLI end to end with a fake agent (no usage)
npm run check            # skill frontmatter, manifests, and nothing private or off-style
```

## License

MIT, see [LICENSE](LICENSE). The page kit in `skills/captain/kit/` comes from Ghostex, also MIT
([NOTICE](skills/captain/kit/NOTICE.md)).
