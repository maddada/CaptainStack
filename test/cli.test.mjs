// End-to-end checks of the captain CLI with a fake agent: no real agent, no usage.
// Run: node --test test/   (also on Windows: node --test test\)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'captain', 'scripts', 'captain.mjs');
const FAKE = path.join(here, 'fake-agent.mjs');

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GHOSTEX_') && !k.startsWith('CAPTAINSTACK_')) env[k] = v;
  return { ...env, CAPTAINSTACK_SKIP_GHOSTEX_CLI_CHECK: '1', CAPTAINSTACK_NO_OPEN: '1', ...extra };
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captainstack-test-'));
  fs.mkdirSync(path.join(dir, '.git'));
  const home = path.join(dir, '..', path.basename(dir) + '-home');
  fs.mkdirSync(home, { recursive: true });
  const env = cleanEnv({ CAPTAINSTACK_HOME: home, CAPTAINSTACK_CLAUDE_BIN: FAKE, CAPTAINSTACK_CODEX_BIN: FAKE });
  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input, timeout: opts.timeout || 30000 });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const json = (args, opts) => {
    const r = run([...args, '--json'], opts);
    assert.equal(r.code, 0, `${args.join(' ')} failed: ${r.err}`);
    return JSON.parse(r.out);
  };
  return { dir, env, run, json };
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('refuses inside Ghostex', () => {
  const { run } = makeRepo();
  const r = run(['session', 'new', '--title', 'x'], { env: { GHOSTEX_SESSION_ID: 'abc' } });
  assert.equal(r.code, 3);
  assert.match(r.err, /does not run inside Ghostex/);
  assert.match(r.err, /coordinator/);
});

test('init: state folder, gitignore, CLI copy, sessions apart', () => {
  const { dir, json } = makeRepo();
  const a = json(['session', 'new', '--title', 'First captain']);
  assert.equal(a.session, 'c1');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/\.captainstack\/$/m);
  assert.ok(fs.existsSync(path.join(dir, '.captainstack', 'bin', 'captain.mjs')));
  assert.ok(fs.existsSync(path.join(dir, '.captainstack', 'kit', 'ghostex-kit.html')));
  const b = json(['session', 'new', '--title', 'Second captain']);
  assert.equal(b.session, 'c2');
  json(['remember', 'only c2 knows this', '-s', 'c2']);
  const memA = json(['memory', '-s', 'c1']);
  assert.equal(memA.memory.length, 0);
  const memB = json(['memory', '-s', 'c2']);
  assert.match(memB.memory[0], /^1\. \d{4}-\d\d-\d\d: only c2 knows this$/);
  // .gitignore is not duplicated
  json(['init']);
  assert.equal((fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').match(/captainstack\//g) || []).length, 1);
});

test('threads: start, report, watch wakes, send resumes the same session, read, close', async () => {
  const { dir, json, run } = makeRepo();
  json(['session', 'new', '--title', 'Threads']);
  const started = json(['start-thread', '--agent', 'claude', '--title', 'Write hello', '--task', 'Write hello.txt with a greeting']);
  assert.equal(started.status, 'started');
  assert.equal(started.thread, 't1');
  const w = run(['watch', '--timeout', '20']);
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /Thread report: t1 "Write hello"/);
  const threads = json(['threads']);
  assert.equal(threads[0].status, 'idle');
  const sid = threads[0].agentSessionId;
  assert.ok(sid);
  // nothing new: watch times out with code 2
  assert.equal(run(['watch', '--timeout', '1']).code, 2);
  const sent = json(['send', 't1', 'Also add a second line']);
  assert.equal(sent.status, 'delivered');
  const w2 = run(['watch', '--timeout', '20']);
  assert.match(w2.out, /Thread report: t1/);
  const t = json(['threads']);
  assert.equal(t[0].agentSessionId, sid, 'the follow-up resumed the same agent session');
  assert.equal(t[0].turns, 2);
  const read = json(['read', 't1', '--last', '2']);
  assert.equal(read.length, 2);
  assert.equal(read[0].from, 'captain');
  assert.equal(read[1].from, 'thread');
  assert.match(read[1].text, /Also add a second line/);
  assert.ok(fs.existsSync(path.join(dir, '.captainstack', 'sessions', 'c1', 'threads', 't1', 'log.jsonl')));
  const closed = json(['close', 't1']);
  assert.equal(closed.status, 'closed');
  assert.equal(json(['threads']).length, 0);
});

test('codex style output and a queued message while busy', async () => {
  const { json, run } = makeRepo();
  json(['session', 'new', '--title', 'Codex']);
  const env = { FAKE_AGENT_STYLE: 'codex', FAKE_AGENT_SLEEP_MS: '2500' };
  json(['start-thread', '--agent', 'codex', '--title', 'Slow one', '--task', 'Do a slow thing'], { env });
  await until(() => json(['threads'])[0].status === 'running');
  const q = json(['send', 't1', 'Queued follow-up'], { env });
  assert.equal(q.status, 'queued');
  // first report, then the queued message runs by itself and reports again
  await until(() => json(['threads'])[0].turns === 2 && json(['threads'])[0].status === 'idle', 20000);
  const msgs = json(['read', 't1']);
  assert.equal(msgs.filter((m) => m.from === 'thread' && m.kind === 'report').length, 2);
  assert.match(msgs[msgs.length - 1].text, /Queued follow-up/);
});

test('thread note and wait-message: messages both ways mid-turn', async () => {
  const { dir, json, run, env } = makeRepo();
  json(['session', 'new', '--title', 'Notes']);
  json(['start-thread', '--agent', 'claude', '--title', 'Noter', '--task', 'Send a note first'], { env: { FAKE_AGENT_NOTE: '1', FAKE_AGENT_SLEEP_MS: '1500' } });
  const w = run(['watch', '--timeout', '20']);
  assert.match(w.out, /Thread note: t1 "Noter": fake agent: halfway there/);
  // A thread waiting for its captain mid-turn wakes when the captain sends.
  await until(() => json(['threads'])[0].status === 'idle');
  const waiter = spawn(process.execPath, [CLI, 'wait-message', '--timeout', '20'], { cwd: dir, env: { ...env, CAPTAINSTACK_SESSION: 'c1', CAPTAINSTACK_THREAD: 't1' } });
  let got = '';
  waiter.stdout.on('data', (d) => (got += d));
  await new Promise((r) => setTimeout(r, 800));
  // the captain sends while the thread is "busy" waiting: simulate by holding the runner pid
  fs.writeFileSync(path.join(dir, '.captainstack', 'sessions', 'c1', 'threads', 't1', 'runner.pid'), String(waiter.pid));
  const q = json(['send', 't1', 'Here is your answer: use blue']);
  assert.equal(q.status, 'queued');
  const code = await new Promise((r) => waiter.on('close', r));
  assert.equal(code, 0);
  assert.match(got, /use blue/);
});

test('usage limit marks the thread limited and wakes the captain', () => {
  const { json, run } = makeRepo();
  json(['session', 'new', '--title', 'Limits']);
  json(['start-thread', '--agent', 'claude', '--title', 'Limited one', '--task', 'Anything'], { env: { FAKE_AGENT_LIMIT: '1' } });
  const w = run(['watch', '--timeout', '20']);
  assert.match(w.out, /usage limit/);
  assert.equal(json(['threads'])[0].status, 'limited');
  const held = json(['send', 't1', 'carry on']);
  assert.equal(held.status, 'held');
});

test('board: add, now, wait, ask, done, check, WORK.md', () => {
  const { dir, json, run } = makeRepo();
  json(['session', 'new', '--title', 'Board']);
  assert.equal(json(['item', 'add', 'Checkout redesign']).item, 'W1');
  json(['item', 'add', 'Release notes']);
  json(['item', 'now', 'W1', 'building the one-page layout']);
  assert.equal(json(['item', 'show', 'W1']).status, 'In progress');
  assert.notEqual(run(['item', 'now', 'W1', 'waiting on your review']).code, 0);
  json(['item', 'wait', 'W2', '--on', 'W1']);
  assert.equal(json(['item', 'show', 'W2']).status, 'Waiting');
  const detail = 'The checkout can be one page or three steps. One page is faster to build and test; three steps match the old flow. I recommend one page because it halves the work.';
  assert.notEqual(run(['item', 'ask', 'W1', 'Which layout?', '--detail', 'short', '--answer', 'One page']).code, 0, 'thin detail refused');
  assert.notEqual(run(['item', 'ask', 'W1', 'Is W3 ready?', '--detail', detail, '--answer', 'Yes']).code, 0, 'internal id refused');
  const ask = json(['item', 'ask', 'W1', 'Which checkout layout should the thread build?', '--detail', detail, '--answer', 'One page', '--answer', 'Three steps', '--recommended', 'One page', '--holds']);
  assert.equal(ask.tag, 'Q1');
  assert.equal(json(['item', 'show', 'W1']).status, 'Blocked');
  assert.match(fs.readFileSync(path.join(dir, '.captainstack', 'sessions', 'c1', 'WORK.md'), 'utf8'), /## Blocked[\s\S]*W1 Checkout redesign/);
  json(['answer', 'Q1', 'A']);
  const answers = json(['answers']);
  assert.equal(answers[0].answer, 'One page');
  assert.equal(json(['answers']).length, 0, 'answers are read once');
  json(['item', 'done', 'W1', 'one-page checkout shipped']);
  assert.equal(json(['item', 'show', 'W2']).status, 'Not being worked on', 'a wait on a finished item clears');
  const check = json(['item', 'list', '--check']);
  assert.equal(check.ok, false);
  assert.match(check.issues.join('\n'), /W2 "Release notes" is not being worked on/);
});

test('setup page, answer server, page answers, inbox page, footer, statusline', async () => {
  const { dir, json, run } = makeRepo();
  json(['session', 'new', '--title', 'Setup']);
  const page = json(['setup', 'page', '--no-open']);
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/c1\/pages\/setup\.html$/);
  const html = await get(page.url);
  assert.match(html, /<style id="ghostex-theme">/);
  assert.match(html, /ghostex\.__state\(\{"answered":false/);
  assert.match(html, /Captain setup: which agents do which work/);
  // the browser's Send posts here
  const answers = { large: { agent: 'claude', model: 'opus', effort: 'high' }, focused: { agent: 'codex', model: 'default', effort: 'medium' }, simple: { agent: 'claude', model: 'haiku', effort: 'low' }, usageLow: 'switch', fallback: { agent: 'codex' }, neverUse: 'skipped', computers: 'this computer only', permission: 'standard' };
  const posted = await post(page.url + '/answers', { answers });
  assert.equal(posted.ok, true);
  assert.equal((await postRaw(page.url + '/answers', { answers }, {})).status, 409);
  assert.equal((await postRaw(page.url + '/answers', { answers }, { origin: 'https://evil.example' })).status, 403);
  const w = run(['watch', '--timeout', '5']);
  assert.match(w.out, /Answer from the user: page-setup/);
  const saved = json(['setup', 'save', '--from-page']);
  assert.equal(saved.usageLow.mode, 'switch');
  assert.equal(saved.usageLow.fallback, 'codex');
  const status = run(['status']);
  assert.match(status.out, /Usage fallback rule: Switch when low/);
  // an ask answered through the inbox page
  const detail = 'Two ways to name the file. hello.txt is the usual name; greeting.txt says what it holds. Either is easy to change later, so I recommend hello.txt for now.';
  json(['ask', 'What should the greeting file be called?', '--detail', detail, '--answer', 'hello.txt', '--answer', 'greeting.txt', '--recommended', 'hello.txt']);
  const footer = run(['footer']);
  assert.match(footer.out, /Needs you/);
  assert.match(footer.out, /Q\d+ What should the greeting file be called\?: A\. hello\.txt \(recommended\)/);
  const base = page.url.replace(/\/s\/.*$/, '');
  const inbox = await get(`${base}/s/c1/inbox`);
  assert.match(inbox, /What should the greeting file be called\?/);
  const tag = /tag="(Q\d+)" name="\1" title="What should the greeting/.exec(inbox)[1];
  await post(`${base}/s/c1/inbox/answers`, { answers: { [tag]: 'greeting.txt' } });
  const got = json(['answers']);
  assert.equal(got.find((q) => q.tag === tag).answer, 'greeting.txt');
  const state = JSON.parse(await get(`${base}/api/s/c1/state`));
  assert.ok(state.setup && state.threads && state.board && state.inbox);
  assert.match(run(['statusline']).out, /^captain c1 · \d+ needs? you · 0 threads running/);
  json(['serve', '--stop']);
});

test('page check catches the usual slips', () => {
  const { dir, run } = makeRepo();
  const bad = path.join(dir, 'bad.html');
  fs.writeFileSync(bad, '<html><head><title>X</title></head><body><gx-questions><gx-question tag="Q1" title="See the page for W3"></gx-question><gx-question tag="Q1" title="Again"></gx-question></gx-questions>\u2014</body></html>');
  const r = run(['page', 'check', bad]);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /ghostex-page/);
  assert.match(r.out + r.err, /used twice/);
  assert.match(r.out + r.err, /em dash/);
});

function get(url) {
  return new Promise((resolve, reject) => http.get(url, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); }).on('error', reject));
}
function postRaw(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function post(url, body) {
  const r = await postRaw(url, body, {});
  return JSON.parse(r.body);
}
