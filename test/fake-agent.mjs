#!/usr/bin/env node
// A stand-in agent CLI for the tests: it speaks Claude Code's stream-json (and Codex's --json
// when FAKE_AGENT_STYLE=codex), reads the file its prompt points at, and answers from it.
// FAKE_AGENT_LIMIT=1 makes it fail like a usage limit; FAKE_AGENT_SLEEP_MS delays the answer;
// FAKE_AGENT_NOTE=1 sends a mid-turn note through the captain CLI first.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.length - 1] || '';
const style = process.env.FAKE_AGENT_STYLE || 'claude';
const resumeAt = args.indexOf(style === 'codex' ? 'resume' : '--resume');
const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : null;
const sessionId = resumeId && style !== 'codex' ? resumeId : resumeAt >= 0 ? args[args.length - 2] : `fake-${process.pid}`;
const file = (/(\S+\.md)\b/.exec(prompt) || [])[1];
const body = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (process.env.FAKE_AGENT_LIMIT) {
  process.stderr.write("You've hit your usage limit. Resets at 5pm.\n");
  process.exit(1);
}
if (process.env.FAKE_AGENT_NOTE && process.env.CAPTAINSTACK_ROOT) {
  const cli = path.join(process.env.CAPTAINSTACK_ROOT, '.captainstack', 'bin', 'captain.mjs');
  spawnSync(process.execPath, [cli, 'note', 'fake agent: halfway there'], { stdio: 'ignore' });
}
const wait = Number(process.env.FAKE_AGENT_SLEEP_MS || 0);
const until = Date.now() + wait;
while (Date.now() < until) {
  /* pretend to work */
}
const task = body.split('\n---\n')[0].replace(/^A message from your captain:\s*/, '').trim();
const reply = `✅ Done:\n- Did: ${task.split('\n')[0]}\n- Thread ${process.env.CAPTAINSTACK_THREAD} of ${process.env.CAPTAINSTACK_SESSION}`;
if (style === 'codex') {
  out({ type: 'thread.started', thread_id: sessionId });
  out({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  out({ type: 'turn.completed' });
} else {
  out({ type: 'system', subtype: 'init', session_id: sessionId });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] }, session_id: sessionId });
  out({ type: 'result', subtype: 'success', result: reply, session_id: sessionId, is_error: false });
}
