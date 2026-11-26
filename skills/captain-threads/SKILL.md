---
name: captain-threads
description: "Brief, start, follow, heal and collect a captain's threads: headless runs of Claude Code, Codex, Cursor CLI, OpenCode, Copilot CLI or Pi in the background with a log, follow-up messages both ways, and the watcher that wakes the captain when a thread reports. Use when a captain starts or follows a thread, or waits for one."
---

# Captain threads

`captain` below means `node .captainstack/bin/captain.mjs`, run from the repo root.

A thread is a headless run of an agent CLI in the background, in its own folder
`.captainstack/sessions/<captain>/threads/<t>/`: `brief.md`, `log.jsonl` (the agent's own JSON
events), `stderr.log`, `messages.jsonl` (every captain message and thread reply), `report.md` (the
last report) and `thread.json` (agent, model, status, the agent's session id). A follow-up resumes
the same agent session by its id, so the thread keeps its context. Any captain can start any agent:
a Claude captain hands focused work to Codex and back.

## Start

```bash
captain start-thread --kind focused --title "Fix the upload retry" --item W2 --body-file - <<'EOF'
<the brief>
EOF
```

- `--kind large|focused|simple` takes the agent, model and effort from the setup; `--agent <a>`
  (`claude`, `codex`, `cursor`, `opencode`, `copilot`, `pi`) with `--model` and `--effort` picks them
  yourself. Use the setup unless the user asked for another.
- The brief stands alone: the thread has none of your context. Say what to achieve, which files or
  areas matter, and what not to touch; put long material in a file and point to it. CaptainStack
  appends the reporting rules (final report sections, `captain note`, `captain wait-message`, no
  pushing): repeat none of them. Your memory is not sent: add the notes the task needs, worded for
  the thread ("do not deploy").
- Ask for light proof by default (build what changed, run the touched files' tests); careful proof
  on dangerous work (security, a release, a data migration or deletion).
- One task per message. A thread reports only by ending its turn.
- Threads that need the same files run one after another; `--cwd <worktree>` for parallel ones.
- The receipt is one line of JSON: `started` means the runner has it. Read its `status` directly.

Then attach it to its work item (`--item`, or `captain item link W2 --thread t3`), tell the user in
one line what you started (by title), start the watcher and end your turn.

## Follow up, read, list, close

```bash
captain send t3 "Also cover the empty file case"     # delivered | queued | held
captain read t3 --last 2          # the last messages both ways
captain read t3 --log 40          # the agent's own events, for healing
captain threads                   # every open thread: status and last reply
captain status thread t3
captain stop t3                   # a hung turn; then send "carry on" with what you saw
captain close t3                  # its work is taken and nothing more is expected
```

`queued`: the thread is working; it gets the message when its turn ends (the runner resumes it by
itself), or at once if it is waiting with `wait-message`. Never resend. `held`: it hit a usage
limit; follow the usage rule instead (`--force` resumes it anyway).

Statuses: `running`, `idle` (finished its turn, reported), `failed` (exited without a report),
`limited` (a usage-limit error), `stopped` (its runner died mid-turn: send "carry on"), `closed`.
`status` adds "quiet" to a running thread whose log has not grown for 10 minutes.

## What the thread can do

The brief tells every thread:

- Its final message is its report; CaptainStack forwards it to the captain.
- `captain note "<line>"`: mid-turn news; wakes the captain.
- `captain wait-message --timeout 300`: wait in the middle of its turn for the captain's next
  message (exit code 2 when nothing came). Threads on Claude Code can run it as a background
  command and keep working until it wakes them.

## Waking up: the watcher, per agent

`captain watch` blocks until something the captain must see happens (a thread reported, noted,
failed or hit a limit; the user answered a question or a page), prints one line per event, marks
it seen and exits 0. Exit code 2 means the timeout passed with nothing new. `--follow` streams lines
without exiting. Never poll `status` in a loop instead.

- **Claude Code**: before you end your turn, run `captain watch` with the Bash tool's
  `run_in_background: true`. When it exits, Claude Code starts your next turn with its output: a
  thread report wakes you the way a message does. Or use the Monitor tool on
  `captain watch --follow` to get each event as it happens. Threads on Claude Code do the same with
  `captain wait-message`.
- **Codex**: Codex keeps a long-running command alive in the turn (unified exec) but does not wake
  an idle session when one ends. Run `captain watch --timeout 540` and keep waiting on it (poll the
  running command with an empty input until it prints); on exit code 2 run it again. The user can
  still interrupt you.
- **Cursor CLI, OpenCode, Copilot CLI, Pi**: no wake on a background command. Wait in the turn:
  run `captain watch --timeout <seconds under your shell tool's limit>` (OpenCode and Pi: 110,
  Cursor: 240, Copilot: 240 with the bash tool in sync mode) and run it again on exit code 2,
  until it prints events. Say in one line that you are waiting for the threads, so the user knows
  why the turn is still open.
- Any agent, no waiting: end your turn; at the user's next message `captain status` shows what is
  new ("New since you last looked").

## The runner, per agent

`captain start-thread` and `send` start `captain.mjs __run` detached (`windowsHide` on Windows).
It passes the agent a one-line prompt that points at the brief or message file, so no shell ever
sees the brief's text (safe with quotes, backticks and long text on Windows too), and strips the
parent agent's session variables (`CLAUDECODE`, `CLAUDE_CODE_*`) so a nested CLI starts clean.

| Agent | First turn | Follow-up | Reads |
| --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --permission-mode auto [--model] [--effort] "<prompt>"` | `--resume <session_id>` | `session_id`, the `result` event |
| Codex | `codex exec --json --skip-git-repo-check -o last.txt --sandbox workspace-write [-m] [-c model_reasoning_effort=…] "<prompt>"` | `codex exec resume … <thread_id> "<prompt>"` | `thread.started`, the last `agent_message` |
| Cursor CLI | `cursor-agent -p --output-format stream-json --force --trust [--model] "<prompt>"` | `--resume <chatId>` | `session_id`, the `result` event |
| OpenCode | `opencode run --format json [--model provider/model#effort] --title "<title>" "<prompt>"` | `--session <id>` | `sessionID`, the last message's text parts |
| Copilot CLI | `copilot -p "<prompt>" --allow-all-tools --no-ask-user -s [--model]` | `--resume=<id>` | its plain output (untested here) |
| Pi | `pi -p --mode json [--model provider/id] [--thinking <level>] "<prompt>"` | `--session <id>` | the session event, the last assistant message |

Permission "full" in the setup swaps in each agent's no-prompt mode (`--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`). `CAPTAINSTACK_<AGENT>_BIN` points the runner at
another binary (for example `CAPTAINSTACK_CODEX_BIN=/opt/codex/bin/codex`).

A usage limit: the runner looks for a usage-limit error (`usage limit`, `rate limit`, `429`,
`quota`, "hit your limit") only when the turn failed or gave no final message, marks the thread
`limited` and wakes the captain with `Thread hit a usage limit`. The captain follows its setup's
usage rule (the captain skill, "Usage limits").

## Healing

Healing is your job:

1. `captain status thread <t>` and `captain read <t> --log 40`: its state and what it did last.
   A build whose output still comes is not stuck.
2. A hung run: `captain stop <t>`, then `captain send <t> "carry on: <what you saw>"`.
3. `failed`: read `stderr.log` in its folder; fix the cause (a missing login is the user's: ask),
   then send "carry on", or start a new thread.
4. Tell the user only when you moved or restarted a thread, or healing failed.
