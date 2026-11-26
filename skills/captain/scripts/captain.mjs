#!/usr/bin/env node
// CaptainStack: the captain's command line. One file, Node's standard library only, macOS, Linux
// and Windows. MIT License, Copyright 2026 Mohamad Yahia (maddada).
//
// Everything lives in the repo's git-ignored state folder (STATE_DIR_NAME), one folder per captain
// session: its board (work.json), inbox, memory, setup answers, Live pages and threads.
// `node captain.mjs help` lists the verbs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
/** The state folder's name, in the repo and in the user's home. Change it here only. */
export const STATE_DIR_NAME = '.captainstack';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT);
const IS_WIN = process.platform === 'win32';
const QUIET_MINUTES = 10;
const KINDS = ['large', 'focused', 'simple'];
const AGENTS = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'pi'];
const AGENT_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor CLI',
  opencode: 'OpenCode',
  copilot: 'Copilot CLI',
  pi: 'Pi',
};

// ---------------------------------------------------------------------------------------------
// Small helpers

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => {
  throw new CliError(message, code);
};
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}
function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}
function readLines(file) {
  const out = [];
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written line */
    }
  }
  return out;
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function firstLine(text, max = 100) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
/** A report's first line worth reading: skips section headers like "✅ **Done:**". */
function headline(text, max = 140) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const header = /^[\p{Extended_Pictographic}\uFE0F\s#]*(\*\*)?[\p{L} ]{1,30}:?(\*\*)?:?$/u;
  const line = (lines.find((l) => !header.test(l)) || lines[0] || '').replace(/^[-*]\s+/, '');
  return firstLine(line, max);
}
function slug(text, max = 40) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'page'
  );
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** A lock for read-modify-write of one file: a directory made atomically, stale after 15s. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code === 'ENOENT') {
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        continue;
      }
      if (Date.now() - mtimeMs(lock) > 15000) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > 20000) fail(`could not lock ${file}`);
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin briefly: this lock is held for milliseconds */
      }
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
function updateJson(file, fallback, fn) {
  return withLock(file, () => {
    const value = readJson(file, structuredClone(fallback));
    const result = fn(value);
    writeJson(file, value);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Arguments

const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'all', 'multiple', 'holds', 'force', 'follow', 'peek', 'no-open', 'open', 'background',
  'stop', 'check', 'done', 'chore', 'clear', 'global', 'quiet', 'unseen', 'todo', 'standalone', 'keep', 'from-page', 'no-default', 'quick',
]);
const REPEATABLE = new Set(['answer', 'thread']);
const SHORT = { s: 'session', h: 'help', n: 'last', m: 'model' };

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let name = null;
    let value;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        name = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else name = a.slice(2);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      name = SHORT[a[1]] || a[1];
    } else {
      pos.push(a);
      continue;
    }
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = true;
      else if (i + 1 < argv.length) value = argv[++i];
      else fail(`--${name} needs a value`);
    }
    if (REPEATABLE.has(name)) (flags[name] ||= []).push(value);
    else flags[name] = value;
  }
  return { pos, flags };
}

function readBody(flags, key = 'body-file') {
  const src = flags[key];
  if (src === undefined) return undefined;
  if (src === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(src, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Where things live

function findRoot(start = process.cwd()) {
  if (process.env.CAPTAINSTACK_ROOT) return path.resolve(process.env.CAPTAINSTACK_ROOT);
  let dir = path.resolve(start);
  let gitRoot = null;
  for (;;) {
    if (exists(path.join(dir, STATE_DIR_NAME, 'config.json'))) return dir;
    if (!gitRoot && exists(path.join(dir, '.git'))) gitRoot = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return gitRoot || path.resolve(start);
}

class Ctx {
  constructor(flags = {}) {
    this.flags = flags;
    this.root = flags.root ? path.resolve(flags.root) : findRoot();
    this.state = path.join(this.root, STATE_DIR_NAME);
    this.home = process.env.CAPTAINSTACK_HOME ? path.resolve(process.env.CAPTAINSTACK_HOME) : path.join(os.homedir(), STATE_DIR_NAME);
  }
  get initialized() {
    return exists(path.join(this.state, 'config.json'));
  }
  sessionsDir() {
    return path.join(this.state, 'sessions');
  }
  sessionIds() {
    try {
      return fs
        .readdirSync(this.sessionsDir())
        .filter((d) => exists(path.join(this.sessionsDir(), d, 'session.json')))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    } catch {
      return [];
    }
  }
  /** The captain session: --session, CAPTAINSTACK_SESSION (set for threads), the current one, the only one. */
  sessionId(required = true) {
    const want = this.flags.session || process.env.CAPTAINSTACK_SESSION;
    const ids = this.sessionIds();
    if (want) {
      if (!ids.includes(want)) fail(`no captain session "${want}" here (sessions: ${ids.join(', ') || 'none'})`);
      return want;
    }
    const current = readText(path.join(this.state, 'current')).trim();
    if (current && ids.includes(current)) return current;
    if (ids.length === 1) return ids[0];
    if (!required) return null;
    if (!ids.length) fail('No captain session yet. Start one: captain session new --title "<what this captain runs>"');
    fail(`Several captain sessions (${ids.join(', ')}): pass --session <id>`);
  }
  s(id = this.sessionId()) {
    return new Session(this, id);
  }
}

class Session {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.dir = path.join(ctx.sessionsDir(), id);
  }
  p(...parts) {
    return path.join(this.dir, ...parts);
  }
  get meta() {
    return readJson(this.p('session.json'), { id: this.id });
  }
  event(type, fields = {}) {
    return updateJson(this.p('events-counter.json'), { n: 0 }, (c) => {
      c.n += 1;
      const ev = { n: c.n, at: nowIso(), type, ...fields };
      appendLine(this.p('events.jsonl'), ev);
      return ev;
    });
  }
  events() {
    return readLines(this.p('events.jsonl'));
  }
  nextTag() {
    return updateJson(this.p('tags.json'), { next: 1 }, (t) => `Q${t.next++}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Inside Ghostex? CaptainStack is the portable version of Ghostex's coordinators; inside Ghostex
// the real ones do all of this natively, so the captain refuses to start there.

export function insideGhostex(env = process.env) {
  const vars = ['GHOSTEX_SESSION_ID', 'GHOSTEX_COORDINATOR_SESSION', 'GHOSTEX_GLOBAL_SESSION_REF', 'GHOSTEX_SESSION_TOKEN', 'GHOSTEX_CLI_EXECUTABLE'];
  const hit = vars.find((v) => env[v]);
  if (hit) return hit;
  if (env.CAPTAINSTACK_SKIP_GHOSTEX_CLI_CHECK) return null;
  const which = resolveCommand('ghostex', env);
  if (!which) return null;
  try {
    const r = spawnSync(which.cmd, [...which.pre, 'agents', 'whoami'], { encoding: 'utf8', timeout: 4000, env, windowsHide: true, windowsVerbatimArguments: which.verbatim });
    if (r.status === 0 && /Session ID:/i.test(r.stdout || '')) return 'ghostex agents whoami';
  } catch {
    /* no Ghostex session */
  }
  return null;
}
const GHOSTEX_REFUSAL =
  'CaptainStack does not run inside Ghostex. Ghostex has its own coordinators that do all of this natively (threads, the Inbox, work items, Live pages, usage fallback): start one from Ghostex instead, for example with `ghostex coordinator --help`.';
function refuseInsideGhostex() {
  const why = insideGhostex();
  if (why) fail(`${GHOSTEX_REFUSAL} (detected: ${why})`, 3);
}

// ---------------------------------------------------------------------------------------------
// init: the state folder, the .gitignore entry and the CLI copy every agent can run

function ensureGitignore(ctx) {
  const line = `/${STATE_DIR_NAME}/`;
  const file = path.join(ctx.root, '.gitignore');
  const text = readText(file);
  const has = text.split(/\r?\n/).some((l) => [line, `${STATE_DIR_NAME}/`, `/${STATE_DIR_NAME}`, STATE_DIR_NAME].includes(l.trim()));
  if (!has) fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + `# CaptainStack state (memory, board, inbox, threads)\n${line}\n`);
  // A second guard that works even if the repo's .gitignore is reverted.
  fs.writeFileSync(path.join(ctx.state, '.gitignore'), '*\n');
}

function installCli(ctx) {
  const bin = path.join(ctx.state, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const target = path.join(bin, 'captain.mjs');
  if (path.resolve(SCRIPT) !== path.resolve(target)) fs.copyFileSync(SCRIPT, target);
  const kitSrc = findKit();
  if (kitSrc) {
    fs.mkdirSync(path.join(ctx.state, 'kit'), { recursive: true });
    const kitDst = path.join(ctx.state, 'kit', 'ghostex-kit.html');
    if (path.resolve(kitSrc) !== path.resolve(kitDst)) fs.copyFileSync(kitSrc, kitDst);
  }
  fs.writeFileSync(path.join(bin, 'captain'), '#!/bin/sh\nexec node "$(dirname "$0")/captain.mjs" "$@"\n');
  try {
    fs.chmodSync(path.join(bin, 'captain'), 0o755);
  } catch {
    /* Windows */
  }
  fs.writeFileSync(path.join(bin, 'captain.cmd'), '@echo off\r\nnode "%~dp0captain.mjs" %*\r\n');
}

function findKit() {
  for (const p of [path.join(SCRIPT_DIR, '..', 'kit', 'ghostex-kit.html'), path.join(SCRIPT_DIR, 'kit', 'ghostex-kit.html')]) if (exists(p)) return p;
  return null;
}

function cmdInit(ctx) {
  fs.mkdirSync(ctx.sessionsDir(), { recursive: true });
  const cfgFile = path.join(ctx.state, 'config.json');
  const cfg = readJson(cfgFile, { createdAt: nowIso() });
  cfg.version = VERSION;
  cfg.stateDir = STATE_DIR_NAME;
  writeJson(cfgFile, cfg);
  ensureGitignore(ctx);
  installCli(ctx);
  return { ok: true, root: ctx.root, state: ctx.state, cli: `node ${path.join(STATE_DIR_NAME, 'bin', 'captain.mjs')}` };
}

// ---------------------------------------------------------------------------------------------
// Sessions

function cmdSession(ctx, [verb = 'show', ...rest], flags) {
  if (verb === 'new') {
    refuseInsideGhostex();
    if (!ctx.initialized) cmdInit(ctx);
    else installCli(ctx);
    const ids = ctx.sessionIds();
    const n = ids.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0) + 1;
    const id = `c${n}`;
    const s = ctx.s(id);
    fs.mkdirSync(s.p('threads'), { recursive: true });
    fs.mkdirSync(s.p('pages'), { recursive: true });
    fs.mkdirSync(s.p('answers'), { recursive: true });
    writeJson(s.p('session.json'), { id, title: flags.title || rest.join(' ') || 'Captain', agent: flags.agent || detectSelfAgent(), createdAt: nowIso() });
    writeJson(s.p('work.json'), { next: 1, items: [] });
    writeJson(s.p('inbox.json'), { items: [] });
    fs.writeFileSync(s.p('memory.md'), `# Captain memory (${id})\n\n`);
    // Copy the project's setup answers, or the user's default, so a new captain starts set up.
    const projectSetup = readJson(path.join(ctx.state, 'setup.json'), null);
    if (projectSetup) writeJson(s.p('setup.json'), { ...projectSetup, copiedFrom: 'project' });
    fs.writeFileSync(path.join(ctx.state, 'current'), id);
    renderBoard(s);
    return { ok: true, session: id, setup: projectSetup ? 'copied from this project' : 'not done', next: projectSetup ? 'captain status' : 'captain setup page' };
  }
  if (verb === 'list') {
    const current = readText(path.join(ctx.state, 'current')).trim();
    return ctx.sessionIds().map((id) => ({ ...ctx.s(id).meta, current: id === current }));
  }
  if (verb === 'use') {
    const id = rest[0] || fail('captain session use <id>');
    if (!ctx.sessionIds().includes(id)) fail(`no session ${id}`);
    fs.writeFileSync(path.join(ctx.state, 'current'), id);
    return { ok: true, session: id };
  }
  if (verb === 'show') return ctx.s().meta;
  fail(`unknown: session ${verb}`);
}

function detectSelfAgent(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM || env.CODEX_HOME_SET) return 'codex';
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor';
  if (env.OPENCODE || env.OPENCODE_SESSION) return 'opencode';
  if (env.COPILOT_CLI || env.GITHUB_COPILOT_CLI) return 'copilot';
  if (env.PI_CODING_AGENT || env.PI_SESSION) return 'pi';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Agents: finding them and the headless recipe for each

const AGENT_COMMANDS = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'agent'],
  opencode: ['opencode'],
  copilot: ['copilot'],
  pi: ['pi'],
};

/** Finds a command on PATH. On Windows a .cmd or .bat shim runs through cmd.exe. */
export function resolveCommand(name, env = process.env) {
  if (path.isAbsolute(name) && exists(name)) return wrapCommand(name);
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of IS_WIN ? ['', ...exts] : exts) {
      const full = path.join(dir, name + ext);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (IS_WIN && ext === '' && !exts.includes(path.extname(full).toLowerCase())) continue;
        if (!IS_WIN && !(st.mode & 0o111)) continue;
        return wrapCommand(full);
      } catch {
        /* not here */
      }
    }
  }
  return null;
}
function wrapCommand(full) {
  // A script file (a test double, or an agent installed as a .js file): run it with this Node.
  if (/\.(mjs|cjs|js)$/i.test(full)) return { cmd: process.execPath, pre: [full], verbatim: false, path: full };
  if (IS_WIN && /\.(cmd|bat)$/i.test(full)) return { cmd: process.env.ComSpec || 'cmd.exe', pre: ['/d', '/s', '/c', full], verbatim: false, path: full, shim: true };
  return { cmd: full, pre: [], verbatim: false, path: full };
}
/** Arguments for cmd.exe /c: one line, each argument quoted, so no metacharacter reaches cmd. */
function winCmdLine(full, args) {
  const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
  return `"${[q(full), ...args.map(q)].join(' ')}"`;
}
function spawnResolved(which, args, opts) {
  if (which.shim) {
    return spawn(which.cmd, ['/d', '/s', '/c', winCmdLine(which.path, args)], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(which.cmd, [...which.pre, ...args], opts);
}

function findAgent(agent, env = process.env) {
  const override = env[`CAPTAINSTACK_${agent.toUpperCase()}_BIN`];
  if (override) return resolveCommand(override, env);
  for (const name of AGENT_COMMANDS[agent] || []) {
    const r = resolveCommand(name, env);
    if (r) return r;
  }
  return null;
}

function agentVersion(which) {
  try {
    const r = which.shim
      ? spawnSync(which.cmd, ['/d', '/s', '/c', winCmdLine(which.path, ['--version'])], { encoding: 'utf8', timeout: 8000, windowsHide: true, windowsVerbatimArguments: true })
      : spawnSync(which.cmd, [...which.pre, '--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return firstLine((r.stdout || '') + (r.stderr || ''), 60);
  } catch {
    return '';
  }
}

function cmdAgents(ctx, pos, flags) {
  return AGENTS.map((a) => {
    const w = findAgent(a);
    return { agent: a, name: AGENT_NAMES[a], installed: !!w, path: w ? w.path : null, version: w && !flags.quick ? agentVersion(w) : '' };
  });
}

/**
 * The headless run for one turn of a thread: the command, its arguments, and how to read the
 * agent's output (its session id for follow-ups and its final message).
 * `prompt` is short and plain: it points at the brief or message file, so no shell ever sees
 * the brief's text (safe on Windows, where long or quoted arguments break).
 */
export function recipe(agent, { prompt, resumeId, model, effort, permission, lastFile, title }) {
  const full = permission === 'full';
  switch (agent) {
    case 'claude': {
      const a = ['-p', '--output-format', 'stream-json', '--verbose'];
      a.push(...(full ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'auto']));
      if (model) a.push('--model', model);
      if (effort) a.push('--effort', effort);
      if (resumeId) a.push('--resume', resumeId);
      a.push(prompt);
      return { args: a, parse: parseClaudeLike };
    }
    case 'codex': {
      const a = ['exec'];
      if (resumeId) a.push('resume');
      a.push('--json', '--skip-git-repo-check', '-o', lastFile);
      // `codex exec resume` takes no --sandbox; it keeps the session's own.
      if (full) a.push('--dangerously-bypass-approvals-and-sandbox');
      else if (!resumeId) a.push('--sandbox', 'workspace-write');
      if (model) a.push('-m', model);
      if (effort) a.push('-c', `model_reasoning_effort="${effort}"`);
      if (resumeId) a.push(resumeId);
      a.push(prompt);
      return { args: a, parse: parseCodex, lastFile };
    }
    case 'cursor': {
      const a = ['-p', '--output-format', 'stream-json', '--force', '--trust'];
      if (model) a.push('--model', model);
      if (resumeId) a.push('--resume', resumeId);
      a.push(prompt);
      return { args: a, parse: parseClaudeLike };
    }
    case 'opencode': {
      const a = ['run', '--format', 'json'];
      let m = model;
      if (m && effort && !m.includes('#')) m = `${m}#${effort}`;
      if (m) a.push('--model', m);
      if (resumeId) a.push('--session', resumeId);
      else if (title) a.push('--title', title);
      if (full) a.push('--dangerously-skip-permissions');
      a.push(prompt);
      return { args: a, parse: parseOpencode };
    }
    case 'copilot': {
      const a = ['-p', prompt, '--allow-all-tools', '--no-ask-user', '-s'];
      if (model) a.push('--model', model);
      if (resumeId) a.push(`--resume=${resumeId}`);
      return { args: a, parse: parsePlain };
    }
    case 'pi': {
      const a = ['-p', '--mode', 'json'];
      if (model) a.push('--model', model);
      if (effort) a.push('--thinking', effort);
      if (resumeId) a.push('--session', resumeId);
      a.push(prompt);
      return { args: a, parse: parsePi };
    }
    default:
      fail(`unknown agent "${agent}" (one of: ${AGENTS.join(', ')})`);
  }
}

function jsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  return out;
}
/** Claude Code and Cursor CLI stream-json: an init event with session_id, a final result event. */
export function parseClaudeLike(stdout) {
  let sessionId = null;
  let final = null;
  let error = null;
  let lastText = null;
  for (const ev of jsonLines(stdout)) {
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      const t = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t.trim()) lastText = t;
    }
    if (ev.type === 'result') {
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) error = ev.result || ev.error || ev.subtype;
      else final = typeof ev.result === 'string' ? ev.result : lastText;
    }
  }
  return { sessionId, final: final ?? (error ? null : lastText), error };
}
export function parseCodex(stdout) {
  let sessionId = null;
  let final = null;
  let error = null;
  for (const ev of jsonLines(stdout)) {
    if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) final = ev.item.text;
    if (ev.type === 'turn.failed') error = (ev.error && ev.error.message) || 'turn failed';
    if (ev.type === 'error' && ev.message) error = ev.message;
  }
  return { sessionId, final, error };
}
export function parseOpencode(stdout) {
  let sessionId = null;
  const texts = new Map();
  let lastMsg = null;
  let error = null;
  for (const ev of jsonLines(stdout)) {
    const sid = ev.sessionID || (ev.part && ev.part.sessionID) || ev.session_id;
    if (sid) sessionId = sid;
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
      const id = ev.part.messageID || 'm';
      texts.set(id, (texts.get(id) || '') + ev.part.text);
      lastMsg = id;
    }
    if (ev.type === 'error') error = (ev.error && (ev.error.data?.message || ev.error.message || ev.error.name)) || 'error';
  }
  return { sessionId, final: lastMsg ? texts.get(lastMsg) : null, error };
}
export function parsePi(stdout) {
  let sessionId = null;
  let final = null;
  let error = null;
  for (const ev of jsonLines(stdout)) {
    if (ev.type === 'session' && ev.id) sessionId = ev.id;
    if (ev.sessionId) sessionId = ev.sessionId;
    const msg = ev.message;
    if ((ev.type === 'message_end' || ev.type === 'turn_end') && msg && msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const t = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t.trim()) final = t;
      if (msg.stopReason === 'error' || msg.errorMessage) error = msg.errorMessage || 'error';
    }
    if (ev.type === 'agent_end' && Array.isArray(ev.messages)) {
      const last = [...ev.messages].reverse().find((m) => m.role === 'assistant');
      if (last) {
        const t = (last.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (t.trim()) final = t;
        if (last.stopReason === 'error' || last.errorMessage) error = last.errorMessage || 'error';
      }
    }
  }
  if (final) error = null;
  return { sessionId, final, error };
}
export function parsePlain(stdout) {
  const t = String(stdout).trim();
  return { sessionId: null, final: t || null, error: null };
}

const LIMIT_RE = /usage limit|rate[ _-]?limit|limit (reached|exceeded)|hit your (usage |weekly |session )?limit|out of (credits|usage)|insufficient (credits|quota)|quota (exceeded|reached)|too many requests|\b429\b|upgrade your plan|buy (more )?credits|not included in your (weekly|monthly|daily) usage|resets? (at|in) \d/i;
export function looksLimited(text) {
  return LIMIT_RE.test(String(text || ''));
}

// ---------------------------------------------------------------------------------------------
// Threads

const REPORT_RULES = (ctx, s, t) => `

---
You are a thread started by a CaptainStack captain (captain session ${s.id}, thread ${t.id}, agent ${t.agent}). The user talks only to the captain.

Your captain's CLI, run from the repo root (${ctx.root}):

    node ${path.join(STATE_DIR_NAME, 'bin', 'captain.mjs')} <verb>

(CAPTAINSTACK_SESSION and CAPTAINSTACK_THREAD are already set for you, so it knows who you are.)

- Work only on the task above. Do not merge, push or delete anything unless the task says so.
- When you are done, end your turn with a final report: what you did, where (files, branch), how you verified it, and anything left or blocked. CaptainStack forwards your final message to the captain by itself: never write it anywhere else.
- Start each section of the report with its marker, only for sections that have something: ✅ Done, 🧪 Untested, ⚠️ Read this, 🛑 Blocked, 💡 Suggestions, ❓ Needs you (always last). Start every bullet with a capital letter.
- A decision you cannot make: ask it in your final message under ❓ Needs you and stop. Give it a title that names its subject and a line on why. The captain answers with a follow-up message.
- Mid-turn news worth a line (a commit landed, a long job started): \`node ${path.join(STATE_DIR_NAME, 'bin', 'captain.mjs')} note "<one line>"\`. It wakes the captain; keep working.
- When you must wait for the captain in the middle of your turn: \`node ${path.join(STATE_DIR_NAME, 'bin', 'captain.mjs')} wait-message --timeout 300\` blocks until the captain sends you a message, prints it, and exits (exit code 2 after the timeout with nothing). Messages sent while you work are also handed to you when your turn ends.
- Never ask the user directly, never open pages for them. Put the path of any page or file you made in your report.
- Never stop mid-task to wait for something you can wait on (a build, a test run). Stop every background command you started before your report.
`;

function threadsDir(s) {
  return s.p('threads');
}
function threadIds(s) {
  try {
    return fs
      .readdirSync(threadsDir(s))
      .filter((d) => exists(path.join(threadsDir(s), d, 'thread.json')))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  } catch {
    return [];
  }
}
class Thread {
  constructor(s, id) {
    this.s = s;
    this.id = id;
    this.dir = path.join(threadsDir(s), id);
  }
  p(...parts) {
    return path.join(this.dir, ...parts);
  }
  get meta() {
    return readJson(this.p('thread.json'), null);
  }
  update(fn) {
    return updateJson(this.p('thread.json'), {}, (m) => {
      fn(m);
      m.updatedAt = nowIso();
      return m;
    });
  }
  messages() {
    return readLines(this.p('messages.jsonl'));
  }
  addMessage(from, kind, text, extra = {}) {
    return updateJson(this.p('messages-counter.json'), { n: 0 }, (c) => {
      c.n += 1;
      const m = { n: c.n, at: nowIso(), from, kind, text, ...extra };
      appendLine(this.p('messages.jsonl'), m);
      return m;
    });
  }
  deliveredUpTo() {
    return readJson(this.p('delivered.json'), { upTo: 0 }).upTo;
  }
  setDelivered(n) {
    updateJson(this.p('delivered.json'), { upTo: 0 }, (d) => {
      d.upTo = Math.max(d.upTo, n);
    });
  }
  pending() {
    const upTo = this.deliveredUpTo();
    return this.messages().filter((m) => m.from === 'captain' && m.n > upTo);
  }
  runnerPid() {
    const pid = Number(readText(this.p('runner.pid')).trim());
    return pidAlive(pid) ? pid : null;
  }
  /** The state a reader cares about, with running checked against the process. */
  view() {
    const m = this.meta;
    if (!m) return null;
    let status = m.status;
    const running = !!this.runnerPid();
    if ((status === 'running' || status === 'starting') && !running) status = 'stopped';
    const logAt = Math.max(mtimeMs(this.p('log.jsonl')), mtimeMs(this.p('stderr.log')));
    const quiet = status === 'running' && logAt && Date.now() - logAt > QUIET_MINUTES * 60000;
    const msgs = this.messages();
    const lastReply = [...msgs].reverse().find((x) => x.from === 'thread' && x.kind === 'report');
    return {
      id: m.id,
      title: m.title,
      agent: m.agent,
      model: m.model || null,
      effort: m.effort || null,
      status,
      quiet: !!quiet,
      turns: m.turns || 0,
      item: m.item || null,
      agentSessionId: m.agentSessionId || null,
      pending: this.pending().length,
      startedAt: m.createdAt,
      lastActivity: logAt ? new Date(logAt).toISOString() : m.updatedAt,
      lastReply: lastReply ? { at: lastReply.at, headline: headline(lastReply.text) } : null,
      error: m.error || null,
    };
  }
}
function findThread(s, ref) {
  if (!ref) fail('which thread? Give its id (t1) or a word of its title');
  const ids = threadIds(s);
  if (ids.includes(ref)) return new Thread(s, ref);
  const hits = ids.filter((id) => (new Thread(s, id).meta?.title || '').toLowerCase().includes(String(ref).toLowerCase()));
  if (hits.length === 1) return new Thread(s, hits[0]);
  if (hits.length > 1) fail(`"${ref}" matches several threads: ${hits.join(', ')}`);
  fail(`no thread "${ref}" in captain session ${s.id}`);
}

function setupFor(s) {
  return readJson(s.p('setup.json'), null);
}

function cmdStartThread(ctx, pos, flags) {
  const s = ctx.s();
  const setup = setupFor(s);
  const kind = flags.kind;
  if (kind && !KINDS.includes(kind)) fail(`--kind is one of ${KINDS.join(', ')}`);
  const pick = kind && setup && setup[kind] ? setup[kind] : {};
  const agent = flags.agent || pick.agent || fail('--agent <claude|codex|cursor|opencode|copilot|pi> (or --kind large|focused|simple once setup is done)');
  if (!AGENTS.includes(agent)) fail(`unknown agent "${agent}" (one of: ${AGENTS.join(', ')})`);
  if (!findAgent(agent)) fail(`${AGENT_NAMES[agent]} is not installed here (no ${AGENT_COMMANDS[agent].join(' or ')} on PATH)`);
  const brief = flags.task || readBody(flags) || pos.join(' ');
  if (!brief || !brief.trim()) fail('the brief: --task "<what to do>" or --body-file <file|->');
  const title = flags.title || firstLine(brief, 50);
  const id = updateJson(s.p('threads-counter.json'), { n: 0 }, (c) => `t${++c.n}`);
  const t = new Thread(s, id);
  fs.mkdirSync(t.dir, { recursive: true });
  const meta = {
    id,
    title,
    agent,
    model: flags.model || (pick.model && pick.model !== 'default' ? pick.model : null),
    effort: flags.effort || (pick.effort && pick.effort !== 'default' ? pick.effort : null),
    permission: flags.permission || (setup && setup.permission) || 'standard',
    cwd: flags.cwd ? path.resolve(flags.cwd) : ctx.root,
    item: flags.item || null,
    status: 'starting',
    turns: 0,
    createdAt: nowIso(),
  };
  writeJson(t.p('thread.json'), meta);
  fs.writeFileSync(t.p('brief.md'), brief.trim() + REPORT_RULES(ctx, s, meta));
  t.addMessage('captain', 'brief', brief.trim());
  if (meta.item) linkThreadToItem(s, meta.item, id);
  const pid = launchRunner(ctx, s, t);
  s.event('started', { thread: id, title, agent });
  return { status: 'started', thread: id, title, agent, model: meta.model, effort: meta.effort, pid, log: path.relative(ctx.root, t.p('log.jsonl')) };
}

function launchRunner(ctx, s, t) {
  const child = spawn(process.execPath, [SCRIPT, '__run', s.id, t.id], {
    cwd: ctx.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CAPTAINSTACK_ROOT: ctx.root },
  });
  child.unref();
  return child.pid;
}

function cleanAgentEnv(ctx, s, t) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // A thread is its own session: drop the parent agent's session markers so a nested CLI
    // does not think it runs inside its parent.
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CODEX_THREAD_ID' || k === 'CODEX_SANDBOX' || k.startsWith('OPENCODE_SESSION')) delete env[k];
  }
  env.CAPTAINSTACK_ROOT = ctx.root;
  env.CAPTAINSTACK_SESSION = s.id;
  env.CAPTAINSTACK_THREAD = t.id;
  return env;
}

/** The background runner: one process per thread while it works. It runs turns until no message waits. */
async function runThread(ctx, sid, tid) {
  const s = ctx.s(sid);
  const t = new Thread(s, tid);
  const pidFile = t.p('runner.pid');
  const acquire = () => {
    try {
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      const other = Number(readText(pidFile).trim());
      if (pidAlive(other) && other !== process.pid) return false;
      fs.writeFileSync(pidFile, String(process.pid));
      return true;
    }
  };
  if (!acquire()) return;
  try {
    for (;;) {
      let pending = t.pending();
      if (!pending.length) {
        fs.rmSync(pidFile, { force: true });
        pending = t.pending();
        if (!pending.length || !acquire()) return;
      }
      const meta = t.meta;
      const turn = (meta.turns || 0) + 1;
      const first = !meta.agentSessionId && turn === 1;
      let promptFile;
      if (first) promptFile = t.p('brief.md');
      else {
        promptFile = t.p(`message-${turn}.md`);
        const body = pending.filter((m) => m.kind !== 'brief').map((m) => m.text.trim()).join('\n\n---\n\n');
        fs.writeFileSync(
          promptFile,
          `A message from your captain:\n\n${body}\n\n(The rules from your brief still apply: end your turn with a final report.)\n`,
        );
      }
      t.setDelivered(pending[pending.length - 1].n);
      const prompt = first
        ? `Read the file ${promptFile} in full and do what it says.`
        : meta.agentSessionId
          ? `Your captain sent you a message: read the file ${promptFile} and act on it.`
          : `Read the file ${t.p('brief.md')} in full (your task), then the captain's follow-up in ${promptFile}, and act on both.`;
      t.update((m) => {
        m.status = 'running';
        m.turns = turn;
        m.turnStartedAt = nowIso();
        m.error = null;
      });
      const result = await runTurn(ctx, s, t, { ...meta, turn }, prompt);
      if (result.sessionId) t.update((m) => (m.agentSessionId = result.sessionId));
      if (result.final && !result.limited) {
        const msg = t.addMessage('thread', 'report', result.final.trim(), { turn });
        fs.writeFileSync(t.p('report.md'), result.final.trim() + '\n');
        t.update((m) => (m.status = 'idle'));
        s.event('report', { thread: t.id, title: meta.title, agent: meta.agent, message: msg.n, headline: headline(result.final) });
        continue;
      }
      const why = result.error || `exit code ${result.code}`;
      if (result.limited) {
        t.update((m) => {
          m.status = 'limited';
          m.error = firstLine(why, 300);
        });
        s.event('limited', { thread: t.id, title: meta.title, agent: meta.agent, headline: firstLine(why, 200) });
      } else {
        t.update((m) => {
          m.status = 'failed';
          m.error = firstLine(why, 300);
        });
        s.event('failed', { thread: t.id, title: meta.title, agent: meta.agent, headline: firstLine(why, 200) });
      }
      return;
    }
  } finally {
    if (Number(readText(pidFile).trim()) === process.pid) fs.rmSync(pidFile, { force: true });
  }
}

function runTurn(ctx, s, t, meta, prompt) {
  return new Promise((resolve) => {
    const which = findAgent(meta.agent);
    if (!which) return resolve({ code: 127, error: `${meta.agent} is not installed` });
    const lastFile = t.p(`last-${meta.turn}.txt`);
    const r = recipe(meta.agent, { prompt, resumeId: meta.agentSessionId, model: meta.model, effort: meta.effort, permission: meta.permission, lastFile, title: meta.title });
    const out = fs.openSync(t.p('log.jsonl'), 'a');
    const err = fs.openSync(t.p('stderr.log'), 'a');
    const marker = JSON.stringify({ captainstack: 'turn', turn: meta.turn, at: nowIso(), agent: meta.agent }) + '\n';
    fs.writeSync(out, marker);
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnResolved(which, r.args, { cwd: meta.cwd || ctx.root, env: cleanAgentEnv(ctx, s, t), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: 127, error: e.message });
    }
    t.update((m) => (m.agentPid = child.pid));
    child.stdout.on('data', (d) => {
      stdout += d;
      fs.writeSync(out, d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      fs.writeSync(err, d);
    });
    child.on('error', (e) => {
      stderr += e.message;
    });
    child.on('close', (code) => {
      fs.closeSync(out);
      fs.closeSync(err);
      const parsed = r.parse(stdout);
      let final = parsed.final;
      if (!final && r.lastFile && exists(r.lastFile)) final = readText(r.lastFile).trim() || null;
      const error = parsed.error || (code !== 0 ? firstLine(stderr.split('\n').filter(Boolean).slice(-3).join(' '), 300) : null);
      const limited = (code !== 0 || parsed.error || !final) && looksLimited(`${parsed.error || ''}\n${stderr.slice(-4000)}`);
      resolve({ code, sessionId: parsed.sessionId, final: code === 0 || final ? final : null, error: final ? null : error || (final ? null : 'no final message'), limited });
    });
  });
}

function cmdSend(ctx, pos, flags) {
  const s = ctx.s();
  const t = findThread(s, pos[0]);
  const text = flags.task || readBody(flags) || pos.slice(1).join(' ');
  if (!text || !text.trim()) fail('captain send <thread> "<message>" (or --body-file -)');
  const m = t.meta;
  if (m.status === 'closed') t.update((x) => (x.status = 'idle'));
  const msg = t.addMessage('captain', 'message', text.trim());
  if (t.runnerPid()) return { status: 'queued', thread: t.id, message: msg.n, note: 'The thread is working: it gets the message when its current turn ends, or sooner if it waits for one.' };
  if (m.status === 'limited' && !flags.force) {
    return { status: 'held', thread: t.id, message: msg.n, note: 'The thread hit a usage limit: the message waits. Start the work on another agent, or pass --force to resume it now.' };
  }
  launchRunner(ctx, s, t);
  return { status: 'delivered', thread: t.id, message: msg.n };
}

function cmdNote(ctx, pos, flags) {
  const s = ctx.s();
  const tid = flags.thread?.[0] || process.env.CAPTAINSTACK_THREAD;
  if (!tid) fail('captain note is for threads (CAPTAINSTACK_THREAD is not set). The captain talks to threads with captain send.');
  const t = findThread(s, tid);
  const text = readBody(flags) || pos.join(' ');
  if (!text.trim()) fail('captain note "<one line for your captain>"');
  const msg = t.addMessage('thread', 'note', text.trim());
  s.event('note', { thread: t.id, title: t.meta.title, headline: firstLine(text, 200), message: msg.n });
  return { ok: true, thread: t.id, message: msg.n };
}

async function cmdWaitMessage(ctx, pos, flags) {
  const s = ctx.s();
  const tid = flags.thread?.[0] || process.env.CAPTAINSTACK_THREAD || pos[0];
  if (!tid) fail('captain wait-message is for threads (CAPTAINSTACK_THREAD is not set)');
  const t = findThread(s, tid);
  const timeout = Number(flags.timeout || 300) * 1000;
  const until = Date.now() + timeout;
  for (;;) {
    const pending = t.pending().filter((m) => m.kind !== 'brief');
    if (pending.length) {
      t.setDelivered(pending[pending.length - 1].n);
      return { text: pending.map((m) => `Message from your captain (${m.at}):\n${m.text}`).join('\n\n'), json: { messages: pending } };
    }
    if (Date.now() > until) throw new CliError('No message from the captain yet.', 2);
    await sleep(700);
  }
}

function cmdThreads(ctx, pos, flags) {
  const s = ctx.s();
  const all = threadIds(s).map((id) => new Thread(s, id).view());
  return flags.all ? all : all.filter((v) => v.status !== 'closed');
}

function cmdRead(ctx, pos, flags) {
  const s = ctx.s();
  const t = findThread(s, pos[0]);
  if (flags.log !== undefined) {
    const n = Number(flags.log) || 40;
    const lines = readText(t.p('log.jsonl')).split('\n').filter(Boolean).slice(-n);
    return { text: lines.map(readableLogLine).join('\n'), json: lines };
  }
  let msgs = t.messages();
  if (flags.role) msgs = msgs.filter((m) => m.from === flags.role);
  const n = Number(flags.last || flags.limit || 0);
  if (n) msgs = msgs.slice(-n);
  const text = msgs.map((m) => `[${m.at.replace('T', ' ').slice(0, 19)}] ${m.from === 'captain' ? 'captain' : t.meta.agent} ${m.kind}:\n${m.text}`).join('\n\n');
  return { text: text || '(no messages)', json: msgs };
}
function readableLogLine(line) {
  try {
    const ev = JSON.parse(line);
    if (ev.captainstack === 'turn') return `--- turn ${ev.turn} (${ev.at})`;
    if (ev.type === 'assistant' && ev.message?.content) {
      return ev.message.content.map((c) => (c.type === 'text' ? `assistant: ${firstLine(c.text, 200)}` : c.type === 'tool_use' ? `tool: ${c.name} ${firstLine(JSON.stringify(c.input), 160)}` : '')).filter(Boolean).join('\n');
    }
    if (ev.type === 'item.completed' && ev.item) return `${ev.item.type}: ${firstLine(ev.item.text || ev.item.command || JSON.stringify(ev.item), 200)}`;
    if (ev.type === 'tool_use' && ev.part) return `tool: ${ev.part.tool} ${firstLine(JSON.stringify(ev.part.state?.input || {}), 160)}`;
    if (ev.type === 'text' && ev.part) return `assistant: ${firstLine(ev.part.text, 200)}`;
    if (ev.type === 'result') return `result: ${firstLine(ev.result, 200)}`;
    return firstLine(`${ev.type || ''} ${ev.subtype || ''}`.trim() || line, 160);
  } catch {
    return firstLine(line, 200);
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    /* already gone */
  }
}

function cmdStop(ctx, pos) {
  const s = ctx.s();
  const t = findThread(s, pos[0]);
  const pid = t.runnerPid();
  const agentPid = t.meta.agentPid;
  if (!pid) return { ok: true, thread: t.id, note: 'not running' };
  killTree(pid);
  if (pidAlive(agentPid)) killTree(agentPid);
  t.setDelivered(Math.max(0, ...t.messages().map((m) => m.n)));
  t.update((m) => {
    m.status = 'idle';
    m.error = 'stopped by the captain';
  });
  fs.rmSync(t.p('runner.pid'), { force: true });
  return { ok: true, thread: t.id, status: 'stopped', note: 'Send it a message ("carry on", with what you saw) to resume the same session.' };
}

function cmdClose(ctx, pos, flags) {
  const s = ctx.s();
  const t = findThread(s, pos[0]);
  if (t.runnerPid()) {
    if (!flags.force) fail(`${t.id} is still working. Wait for its report, or captain stop ${t.id} first (or close --force).`);
    cmdStop(ctx, [t.id]);
  }
  t.update((m) => (m.status = 'closed'));
  return { ok: true, thread: t.id, status: 'closed' };
}

// ---------------------------------------------------------------------------------------------
// Events and watchers

function cursorFile(s, who) {
  return s.p(`cursor-${who}.json`);
}
const WAKE_TYPES = new Set(['report', 'note', 'failed', 'limited', 'answer']);
function unseenEvents(s, who = 'captain') {
  const upTo = readJson(cursorFile(s, who), { n: 0 }).n;
  return s.events().filter((e) => e.n > upTo);
}
function markSeen(s, events, who = 'captain') {
  if (!events.length) return;
  updateJson(cursorFile(s, who), { n: 0 }, (c) => {
    c.n = Math.max(c.n, events[events.length - 1].n);
  });
}
function eventLine(e) {
  switch (e.type) {
    case 'report':
      return `Thread report: ${e.thread} "${e.title}" (${e.agent}) finished its turn: ${e.headline}  [read: captain read ${e.thread} --last 1]`;
    case 'note':
      return `Thread note: ${e.thread} "${e.title}": ${e.headline}`;
    case 'failed':
      return `Thread failed: ${e.thread} "${e.title}" (${e.agent}): ${e.headline}  [heal: captain read ${e.thread} --log 40]`;
    case 'limited':
      return `Thread hit a usage limit: ${e.thread} "${e.title}" (${e.agent}): ${e.headline}  [follow your setup's usage rule: captain setup show]`;
    case 'answer':
      return `Answer from the user: ${e.tag} "${e.title}": ${e.answerText}  [captain answers]`;
    case 'started':
      return `Thread started: ${e.thread} "${e.title}" (${e.agent})`;
    default:
      return `${e.type}: ${JSON.stringify(e)}`;
  }
}

/**
 * The captain's watcher. Blocks until something the captain must see happens (a thread reported,
 * noted, failed or hit a limit, or the user answered), prints one line per event and exits 0.
 * Run it in the background where the agent wakes when a background command ends (Claude Code),
 * or wait on it in the turn elsewhere. --follow keeps streaming lines (Claude Code's Monitor).
 * Exit code 2: the timeout passed with nothing new.
 */
async function cmdWatch(ctx, pos, flags) {
  const s = ctx.s();
  const timeout = flags.timeout !== undefined ? Number(flags.timeout) * 1000 : flags.follow ? Infinity : 540000;
  const until = Date.now() + timeout;
  let printed = 0;
  for (;;) {
    const fresh = unseenEvents(s).filter((e) => WAKE_TYPES.has(e.type) || flags.all);
    if (fresh.length) {
      const all = unseenEvents(s);
      if (!flags.peek) markSeen(s, all);
      for (const e of fresh) {
        process.stdout.write((flags.json ? JSON.stringify(e) : eventLine(e)) + '\n');
        printed++;
      }
      if (!flags.follow) return null;
    } else if (!flags.follow) {
      // Nothing new: also mark boring events (thread started) seen so they never pile up.
    }
    if (Date.now() > until) {
      if (!printed) throw new CliError(`Nothing new after ${Math.round(timeout / 1000)}s. Run captain watch again to keep waiting.`, 2);
      return null;
    }
    await sleep(800);
  }
}

function cmdEvents(ctx, pos, flags) {
  const s = ctx.s();
  let evs = flags.unseen ? unseenEvents(s) : s.events();
  if (flags.since) evs = evs.filter((e) => e.n > Number(flags.since));
  const n = Number(flags.last || 0);
  if (n) evs = evs.slice(-n);
  if (flags.unseen && !flags.peek) markSeen(s, evs);
  return { text: evs.map((e) => `#${e.n} ${e.at.slice(11, 19)} ${eventLine(e)}`).join('\n') || '(nothing new)', json: evs };
}

// ---------------------------------------------------------------------------------------------
// Work items (work.json)

function board(s) {
  return readJson(s.p('work.json'), { next: 1, items: [] });
}
function saveBoardWith(s, fn) {
  const r = updateJson(s.p('work.json'), { next: 1, items: [] }, fn);
  renderBoard(s);
  return r;
}
function findItem(b, ref) {
  const id = String(ref || '').toUpperCase();
  const it = b.items.find((i) => i.id === id);
  if (!it) fail(`no work item ${ref}`);
  return it;
}
function linkThreadToItem(s, ref, tid) {
  saveBoardWith(s, (b) => {
    const it = findItem(b, ref);
    if (!it.threads.includes(tid)) it.threads.push(tid);
    it.updatedAt = nowIso();
  });
}
const STATUS_ORDER = ['Blocked', 'Needs you', 'In progress', 'Waiting', 'Not being worked on', 'Later', 'Done'];
function itemStatus(s, it, inbox = readJson(s.p('inbox.json'), { items: [] }), b = board(s)) {
  if (it.state === 'dropped') return 'Dropped';
  const asks = inbox.items.filter((q) => q.item === it.id && q.status === 'open');
  if (asks.some((q) => q.holds)) return 'Blocked';
  if (asks.length) return 'Needs you';
  if (it.state === 'done') return 'Done';
  if (it.state === 'parked') return 'Later';
  const waits = (it.waits || []).filter((w) => !waitCleared(s, w, inbox, b));
  if (waits.length) return 'Waiting';
  const live = (it.threads || []).some((tid) => {
    const v = exists(path.join(threadsDir(s), tid)) ? new Thread(s, tid).view() : null;
    return v && (v.status === 'running' || v.status === 'starting');
  });
  if (live || it.now) return 'In progress';
  return 'Not being worked on';
}
function waitCleared(s, w, inbox, b) {
  const on = String(w.on);
  if (/^W\d+$/i.test(on)) {
    const other = b.items.find((i) => i.id === on.toUpperCase());
    return !other || other.state === 'done' || other.state === 'dropped';
  }
  if (/^Q\d+$/i.test(on)) {
    const q = inbox.items.find((x) => x.tag === on.toUpperCase());
    return !q || q.status !== 'open';
  }
  return false;
}
function renderBoard(s) {
  const b = board(s);
  const inbox = readJson(s.p('inbox.json'), { items: [] });
  const groups = {};
  for (const it of b.items) {
    const st = itemStatus(s, it, inbox, b);
    if (st === 'Dropped') continue;
    (groups[st] ||= []).push(it);
  }
  let md = `# Work board (captain session ${s.id})\n\nWritten by \`captain item\` from work.json: edit with the CLI, not by hand.\n`;
  for (const st of STATUS_ORDER) {
    if (!groups[st]) continue;
    md += `\n## ${st}\n\n`;
    for (const it of groups[st]) {
      md += `- ${it.id} ${it.title}`;
      if (it.state === 'done' && it.doneLine) md += ` · ${it.doneLine}`;
      else if (it.now) md += ` · now: ${it.now}`;
      md += '\n';
      const waits = (it.waits || []).filter((w) => !waitCleared(s, w, inbox, b));
      if (waits.length && st !== 'Done') md += `  waits on: ${waits.map((w) => w.on).join(', ')}\n`;
      if (it.threads?.length) md += `  threads: ${it.threads.join(', ')}\n`;
      const steps = (it.steps || []).filter((x) => !x.chore);
      if (steps.length) md += `  steps: ${steps.map((x) => (x.done ? `${x.text} ✓` : x.text)).join(', ')}\n`;
      const asks = inbox.items.filter((q) => q.item === it.id && q.status === 'open');
      for (const q of asks) md += `  asks: ${q.tag} ${q.title}${q.holds ? ' (holds the work)' : ''}\n`;
    }
  }
  fs.writeFileSync(s.p('WORK.md'), md);
}
function itemView(s, it, inbox, b) {
  return { ...it, status: itemStatus(s, it, inbox, b) };
}

function cmdItem(ctx, [verb, ...rest], flags) {
  const s = ctx.s();
  switch (verb) {
    case 'add': {
      const title = rest.join(' ').trim() || fail('captain item add "<line of work, as the user would name it>"');
      const it = saveBoardWith(s, (b) => {
        const it = { id: `W${b.next++}`, title, state: 'open', now: null, steps: [], waits: [], threads: [...(flags.thread || [])], createdAt: nowIso(), updatedAt: nowIso() };
        b.items.push(it);
        return it;
      });
      return { ok: true, item: it.id, title };
    }
    case 'now': {
      const [ref, ...words] = rest;
      const line = words.join(' ').trim() || fail('captain item now W<n> "<where it stands>"');
      if (/\b(waiting|wait) (on|for) (you|the user|your)\b|\byour (try|review|answer|call)\b/i.test(line)) {
        fail('A now line never parks the user\'s part: ask instead (captain item ask W<n> "<question>" --detail ...).');
      }
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        it.now = line;
        it.nowAt = nowIso();
        if (it.state === 'done') it.state = 'open';
        it.waits = [];
        it.updatedAt = nowIso();
      });
      return { ok: true, item: ref.toUpperCase(), now: line };
    }
    case 'step': {
      const [ref, ...words] = rest;
      const text = words.join(' ').trim() || fail('captain item step W<n> "<step>" [--done] [--chore]');
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        const old = it.steps.find((x) => x.text === text);
        if (old) old.done = !!flags.done;
        else it.steps.push({ text, done: !!flags.done, chore: !!flags.chore });
        it.updatedAt = nowIso();
      });
      return { ok: true, item: ref.toUpperCase(), step: text, done: !!flags.done };
    }
    case 'wait': {
      const [ref] = rest;
      if (flags.clear) {
        saveBoardWith(s, (b) => {
          findItem(b, ref).waits = [];
        });
        return { ok: true, item: ref.toUpperCase(), waits: [] };
      }
      const on = flags.on || fail('captain item wait W<n> --on <W<m> | Q<n> | "something outside">');
      if (/\b(you|user|your)\b/i.test(on)) fail('Waiting is never on the user: ask instead (captain item ask).');
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        it.waits.push({ on, at: nowIso() });
        it.now = null;
        it.updatedAt = nowIso();
      });
      return { ok: true, item: ref.toUpperCase(), waitsOn: on };
    }
    case 'ask': {
      const [ref, ...words] = rest;
      return cmdAsk(ctx, words, { ...flags, item: ref });
    }
    case 'done': {
      const [ref, ...words] = rest;
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        it.state = 'done';
        it.doneLine = words.join(' ').trim() || it.doneLine || null;
        it.now = null;
        it.waits = [];
        it.doneAt = nowIso();
        it.updatedAt = nowIso();
      });
      return { ok: true, item: ref.toUpperCase(), status: 'done' };
    }
    case 'drop': {
      const [ref] = rest;
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        it.state = 'dropped';
        it.updatedAt = nowIso();
      });
      updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
        for (const q of ib.items) if (q.item === ref.toUpperCase() && q.status === 'open') q.status = 'withdrawn';
      });
      renderBoard(s);
      return { ok: true, item: ref.toUpperCase(), status: 'dropped' };
    }
    case 'edit': {
      const [ref] = rest;
      saveBoardWith(s, (b) => {
        const it = findItem(b, ref);
        if (flags.title) it.title = flags.title;
        if (flags.status) {
          const st = flags.status;
          if (st === 'parked' || st === 'later') it.state = 'parked';
          else if (st === 'open') it.state = 'open';
          else if (st === 'blocked') fail('Blocked comes only from an ask that holds the work: captain item ask W<n> ... --holds');
          else fail('--status parked|open');
        }
        it.updatedAt = nowIso();
      });
      return { ok: true, item: ref.toUpperCase() };
    }
    case 'link': {
      const [ref] = rest;
      for (const tid of flags.thread || []) linkThreadToItem(s, ref, tid);
      return { ok: true, item: ref.toUpperCase(), threads: flags.thread || [] };
    }
    case 'list':
    case undefined: {
      const b = board(s);
      const inbox = readJson(s.p('inbox.json'), { items: [] });
      const items = b.items.map((it) => itemView(s, it, inbox, b)).filter((it) => it.status !== 'Dropped' && (flags.all || it.status !== 'Done' || Date.now() - Date.parse(it.doneAt || 0) < 86400000));
      if (flags.check) return boardCheck(s, items);
      const text = items.length ? items.map((it) => `${it.id} [${it.status}] ${it.title}${it.now ? ` · now: ${it.now}` : ''}${it.threads.length ? ` · threads: ${it.threads.join(', ')}` : ''}`).join('\n') : '(no work items)';
      return { text, json: items };
    }
    case 'show': {
      const b = board(s);
      return itemView(s, findItem(b, rest[0]), readJson(s.p('inbox.json'), { items: [] }), b);
    }
    default:
      fail(`unknown: item ${verb} (add, now, step, wait, ask, done, drop, edit, link, list, show)`);
  }
}

/** What to fix before the captain ends its turn. */
function boardCheck(s, items) {
  const issues = [];
  const views = Object.fromEntries(threadIds(s).map((id) => [id, new Thread(s, id).view()]));
  for (const it of items) {
    if (it.status === 'Done') continue;
    const threads = (it.threads || []).map((id) => views[id]).filter(Boolean);
    const live = threads.filter((v) => v.status === 'running' || v.status === 'starting');
    if (it.status === 'In progress' && !live.length) issues.push(`${it.id} "${it.title}" is In progress with nobody on it: finish it, ask, wait on something, or start a thread.`);
    for (const v of threads) {
      if (v.quiet) issues.push(`${it.id}: thread ${v.id} has been quiet for ${QUIET_MINUTES}+ minutes: read its log (captain read ${v.id} --log 40) and heal it.`);
      if (v.status === 'stopped') issues.push(`${it.id}: thread ${v.id} stopped mid-turn: captain send ${v.id} "carry on".`);
      if (v.status === 'failed' || v.status === 'limited') issues.push(`${it.id}: thread ${v.id} ${v.status}: ${v.error || ''}`);
      if (v.status === 'idle' && v.lastReply && Date.parse(v.lastReply.at) > Date.parse(it.updatedAt || 0)) issues.push(`${it.id}: thread ${v.id} reported after the item last changed: update the item (now, done or ask).`);
    }
    if (it.status === 'Not being worked on') issues.push(`${it.id} "${it.title}" is not being worked on: finish it, park it, ask, or work on it.`);
  }
  for (const v of Object.values(views)) {
    if (v.status !== 'closed' && !items.some((it) => (it.threads || []).includes(v.id)) && v.status !== 'idle') issues.push(`Thread ${v.id} "${v.title}" belongs to no work item: captain item link W<n> --thread ${v.id}.`);
  }
  return { text: issues.length ? issues.map((x) => `- ${x}`).join('\n') : 'Board check: nothing to fix.', json: { ok: !issues.length, issues } };
}

// ---------------------------------------------------------------------------------------------
// The inbox: asks and to-dos for the user, and their answers

const INTERNAL_ID_RE = /\b[WQ]\d+\b|\bt\d+\b|\bc\d+\b|\b[0-9a-f]{7,40}\b/;
const POINTER_RE = /\b(on|see|in) (the )?(live )?(page|form|inbox page)\b|\bpick on\b/i;

function checkAsk({ title, detail, answers }) {
  if (!title || !title.trim()) fail('an ask needs a title');
  if (INTERNAL_ID_RE.test(title)) fail(`The title must not hold internal ids (work items, tags, threads, hashes): "${title}". Name the thing in plain words.`);
  if (POINTER_RE.test(title)) fail('Never a question that points at a page or form: the page asks its own questions.');
  if (/^(it|this|that|them)\b/i.test(title.trim())) fail('The title must name its subject, not "it" or "this".');
  if (!detail || detail.trim().length < 120) fail('--detail is required: at least 120 characters, enough to decide with nothing else on screen (what it is, what each answer does, what you recommend and why, risks, links).');
  if (answers.length > 4) fail('At most 4 answers: put longer choices on a Live page with a card per choice.');
  const long = answers.find((a) => a.length > 40);
  if (long) fail(`Each answer is a few words (about 40 characters): "${long}". Explain each in --detail.`);
}

function cmdAsk(ctx, pos, flags) {
  const s = ctx.s();
  const title = pos.join(' ').trim();
  const detail = flags.detail || readBody(flags, 'detail-file') || '';
  const answers = (flags.answer || []).flatMap((a) => (flags.answer.length === 1 && a.includes(',') && !flags.detail?.includes(a) ? a.split(',') : [a])).map((a) => a.trim()).filter(Boolean);
  if (flags.answers) answers.push(...String(flags.answers).split(',').map((a) => a.trim()).filter(Boolean));
  const todo = !!flags.todo;
  checkAsk({ title, detail, answers });
  if (todo && /^(paste|post|copy|send|reply|run|type|enter|sign in|open)\b/i.test(title) && !/```|https?:\/\/|`[^`]+`/.test(detail)) {
    fail('A to-do to paste, post, run or open needs the exact text, command or link in --detail (in a ``` block for text to copy).');
  }
  const recommended = String(flags.recommended || '').split(',').map((a) => a.trim()).filter(Boolean);
  for (const r of recommended) if (!answers.includes(r)) fail(`--recommended "${r}" is not one of the answers`);
  if (flags.item) findItem(board(s), flags.item);
  const tag = s.nextTag();
  const q = {
    tag,
    kind: todo ? 'todo' : 'ask',
    title,
    detail: detail.trim(),
    answers: todo ? ['Done'] : answers,
    recommended,
    multiple: !!flags.multiple,
    holds: !!flags.holds,
    item: flags.item ? String(flags.item).toUpperCase() : null,
    status: 'open',
    createdAt: nowIso(),
  };
  updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
    ib.items.push(q);
  });
  renderBoard(s);
  return { ok: true, tag, title, item: q.item, inbox: serverUrl(ctx) ? `${serverUrl(ctx)}/s/${s.id}/inbox` : 'start the answer server: captain serve --background' };
}

function normalizeAnswer(q, raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    const letter = /^[A-Da-d]$/.test(t) ? q.answers[t.toUpperCase().charCodeAt(0) - 65] : null;
    return letter || t;
  }
  if (Array.isArray(raw)) return raw.map((x) => normalizeAnswer(q, x));
  return raw;
}
function recordAnswer(ctx, s, tag, answer, note, via) {
  const result = updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
    const q = ib.items.find((x) => x.tag === String(tag).toUpperCase());
    if (!q) fail(`no question ${tag}`);
    if (q.status !== 'open') return { already: true, q };
    q.answer = normalizeAnswer(q, answer);
    q.note = note || null;
    q.status = q.kind === 'page' ? 'answered' : q.kind === 'todo' ? 'done' : 'answered';
    q.answeredAt = nowIso();
    q.via = via;
    q.seen = false;
    return { q };
  });
  if (result.already) return { ok: false, status: 409, error: `${tag} was already ${result.q.status}` };
  const q = result.q;
  writeJson(s.p('answers', `${q.tag}.json`), { tag: q.tag, title: q.title, answer: q.answer, note: q.note, answeredAt: q.answeredAt, via });
  renderBoard(s);
  const answerText = typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer);
  s.event('answer', { tag: q.tag, title: q.title, item: q.item, answerText: firstLine(answerText + (q.note ? ` (note: ${q.note})` : ''), 300) });
  return { ok: true, tag: q.tag, answer: q.answer, answeredAt: q.answeredAt };
}

function cmdAnswer(ctx, pos, flags) {
  const s = ctx.s();
  const [tag, ...words] = pos;
  if (!tag) fail('captain answer Q<n> "<answer>" [--note "..."]: records an answer the user gave in chat');
  const r = recordAnswer(ctx, s, tag, words.join(' '), flags.note, 'chat');
  if (!r.ok) fail(r.error);
  return r;
}

function cmdInbox(ctx, [verb, ...rest], flags) {
  const s = ctx.s();
  if (verb === 'withdraw' || verb === 'done') {
    const tags = rest.map((t) => t.toUpperCase());
    updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
      for (const q of ib.items) if (tags.includes(q.tag) && q.status === 'open') q.status = verb === 'done' ? 'done' : 'withdrawn';
    });
    renderBoard(s);
    return { ok: true, [verb]: tags };
  }
  const ib = readJson(s.p('inbox.json'), { items: [] });
  const open = ib.items.filter((q) => q.status === 'open');
  if (flags.json) return { json: { open, answered: ib.items.filter((q) => q.status === 'answered' || q.status === 'done') } };
  const lines = open.map((q) => `${q.tag} ${q.kind === 'page' ? '[page] ' : q.kind === 'todo' ? '[to-do] ' : ''}${q.title}${q.item ? ` (${q.item})` : ''}${q.answers.length && q.kind === 'ask' ? ` · ${q.answers.map((a) => (q.recommended.includes(a) ? `${a} (recommended)` : a)).join(' / ')}` : ''}`);
  return { text: lines.length ? lines.join('\n') : 'Inbox: nothing open.', json: open };
}

/** New answers since the captain last looked; reading marks them seen. */
function cmdAnswers(ctx, pos, flags) {
  const s = ctx.s();
  const got = updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
    const fresh = ib.items.filter((q) => (q.status === 'answered' || q.status === 'done') && (flags.all || q.seen === false));
    if (!flags.peek) for (const q of fresh) q.seen = true;
    return fresh;
  });
  const text = got
    .map((q) => {
      const a = typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer, null, 2);
      return `${q.tag} ${q.title}${q.item ? ` (${q.item})` : ''}\n  answer: ${a}${q.note ? `\n  note: ${q.note}` : ''}`;
    })
    .join('\n');
  return { text: text || 'No new answers.', json: got };
}

// ---------------------------------------------------------------------------------------------
// Memory and overrides

function memoryLines(file) {
  return readText(file)
    .split('\n')
    .filter((l) => /^\d+\. /.test(l));
}
function cmdRemember(ctx, pos, flags) {
  const s = ctx.s();
  const text = pos.join(' ').trim() || fail('captain remember "<one line the user confirmed>"');
  if (/^setup:/i.test(text)) fail('Setup notes change only through the setup interview (captain setup save).');
  const file = s.p('memory.md');
  return withLock(file, () => {
    const lines = memoryLines(file);
    const n = lines.reduce((m, l) => Math.max(m, Number(l.split('.')[0])), 0) + 1;
    fs.appendFileSync(file, `${n}. ${today()}: ${text}\n`);
    return { ok: true, note: n, text };
  });
}
function cmdForget(ctx, pos) {
  const s = ctx.s();
  const n = Number(pos[0]) || fail('captain forget <number>');
  const file = s.p('memory.md');
  return withLock(file, () => {
    const text = readText(file);
    const kept = text.split('\n').filter((l) => !l.startsWith(`${n}. `));
    if (kept.length === text.split('\n').length) fail(`no memory note ${n}`);
    fs.writeFileSync(file, kept.join('\n'));
    return { ok: true, forgot: n };
  });
}
function cmdMemory(ctx) {
  const s = ctx.s();
  const lines = memoryLines(s.p('memory.md'));
  const overrides = memoryLines(path.join(ctx.home, 'overrides.md'));
  const setup = setupFor(s);
  let text = `Memory (${s.id}):\n${lines.join('\n') || '(none)'}`;
  text += `\n\nOverrides for every captain (${path.join('~', STATE_DIR_NAME, 'overrides.md')}):\n${overrides.join('\n') || '(none)'}`;
  if (setup) text += `\n\nSetup:\n${setupSummary(setup).join('\n')}`;
  return { text, json: { memory: lines, overrides, setup } };
}
function cmdOverride(ctx, [verb = 'list', ...rest]) {
  const file = path.join(ctx.home, 'overrides.md');
  fs.mkdirSync(ctx.home, { recursive: true });
  if (!exists(file)) fs.writeFileSync(file, '# Overrides for every CaptainStack captain\n\n');
  if (verb === 'list') return { text: memoryLines(file).join('\n') || '(no overrides)', json: memoryLines(file) };
  if (verb === 'add') {
    const text = rest.join(' ').trim() || fail('captain override add "<rule for every captain>"');
    return withLock(file, () => {
      const n = memoryLines(file).reduce((m, l) => Math.max(m, Number(l.split('.')[0])), 0) + 1;
      fs.appendFileSync(file, `${n}. ${text}\n`);
      return { ok: true, override: n };
    });
  }
  if (verb === 'remove') {
    const n = Number(rest[0]) || fail('captain override remove <number>');
    return withLock(file, () => {
      fs.writeFileSync(file, readText(file).split('\n').filter((l) => !l.startsWith(`${n}. `)).join('\n'));
      return { ok: true, removed: n };
    });
  }
  fail('captain override list|add|remove');
}

// ---------------------------------------------------------------------------------------------
// Setup interview

const USAGE_RULES = {
  stay: 'Stay on the same agent: a thread that hits a limit waits for the reset; never switch agent.',
  switch: 'Switch when low: when a thread hits a limit, start new work on the fallback agent (its models matched by kind of work) and tell the user in one line.',
  share: 'Share, then switch: spread new threads between the main and the fallback agent; all new work on the fallback once the main one hits a limit.',
  ask: 'Ask each time: on a usage limit, ask the user once in the inbox which agent to use, and wait.',
};
const DEFAULT_MODELS = {
  claude: { large: 'opus', focused: 'opus', simple: 'sonnet' },
  codex: { large: 'default', focused: 'default', simple: 'default' },
  cursor: { large: 'auto', focused: 'auto', simple: 'auto' },
  opencode: { large: 'default', focused: 'default', simple: 'default' },
  copilot: { large: 'default', focused: 'default', simple: 'default' },
  pi: { large: 'default', focused: 'default', simple: 'default' },
};
const MODEL_CHOICES = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['default'],
  cursor: ['auto'],
  opencode: ['default'],
  copilot: ['default'],
  pi: ['default'],
};
const EFFORT = { large: 'high', focused: 'medium', simple: 'low' };

function setupSummary(st) {
  const line = (k) => {
    const p = st[k] || {};
    return `${k}: ${p.agent || '?'}${p.model && p.model !== 'default' ? ` ${p.model}` : ''}${p.effort && p.effort !== 'default' ? ` ${p.effort}` : ''}`;
  };
  const u = st.usageLow || {};
  return [
    `Who does which work: ${KINDS.map(line).join(' · ')}`,
    `When usage runs low: ${u.text || USAGE_RULES[u.mode] || 'ask'}${u.fallback && u.mode !== 'stay' && u.mode !== 'ask' ? ` Fallback agent: ${u.fallback}.` : ''}`,
    `Accounts threads never use: ${(st.neverUse || []).join(', ') || 'none named'}`,
    `Computers: ${st.computers || 'this computer only'}`,
    `Thread permissions: ${st.permission === 'full' ? 'full access (no prompts, no sandbox)' : 'standard (edits and safe commands; Codex in its workspace sandbox)'}`,
  ];
}

function setupPage(ctx, s) {
  const installed = AGENTS.filter((a) => findAgent(a));
  const def = readJson(path.join(ctx.home, 'defaults.json'), null) || readJson(path.join(ctx.state, 'setup.json'), null);
  const self = s.meta.agent && installed.includes(s.meta.agent) ? s.meta.agent : installed[0] || 'claude';
  const other = installed.find((a) => a !== self) || self;
  const pre = (k) => (def && def[k]) || { agent: self, model: (DEFAULT_MODELS[self] || {})[k] || 'default', effort: EFFORT[k] };
  const tag = () => s.nextTag();
  const kindQ = (k, label, help) => {
    const p = pre(k);
    const agents = installed.map((a) => `<option value="${a}"${a === p.agent ? ' selected' : ''}>${escapeHtml(AGENT_NAMES[a])}</option>`).join('');
    const models = installed
      .flatMap((a) => (MODEL_CHOICES[a] || ['default']).map((m) => `<option value="${m}" data-when="agent=${a}"${a === p.agent && m === p.model ? ' selected' : ''}>${m === 'default' ? 'Its default model' : escapeHtml(m)}</option>`))
      .join('');
    const efforts = ['low', 'medium', 'high', 'xhigh'].map((e) => `<option value="${e}"${e === p.effort ? ' selected' : ''}>${e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1)}</option>`).join('');
    return `  <gx-question tag="${tag()}" name="${k}" title="${label}" type="menus">
    <p>${help}</p>
    <select name="agent" data-look="seg">${agents}</select>
    <select name="model">${models}</select>
    <select name="effort" data-look="seg">${efforts}</select>
  </gx-question>`;
  };
  const u = (def && def.usageLow) || { mode: installed.length > 1 ? 'switch' : 'stay', fallback: other };
  const fallbackOpts = installed.map((a) => `<option value="${a}"${a === (u.fallback || other) ? ' selected' : ''}>${escapeHtml(AGENT_NAMES[a])}</option>`).join('');
  const usageChoice = (v, label, small) => `    <gx-choice value="${v}"${v === 'switch' ? ' recommended' : ''}${v === u.mode ? ' picked' : ''}>${label}<small>${small}</small></gx-choice>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>Captain setup: which agents do which work</title>
</head>
<body>
<gx-questions submit="Send to the captain">
  <header>
    <span class="gx-eyebrow">CaptainStack · setup</span>
    <h1>Captain setup: which agents do which work</h1>
    <p class="gx-lede">Filled in with a recommended setup. Change anything, or just send it. Your answers become this captain's setup, this project's copy for later captains, and your default for new projects.</p>
    <div class="gx-chips">
      <span class="gx-chip"><b>${installed.length}</b> agents found here</span>
      ${installed.map((a) => `<span class="gx-chip">${escapeHtml(AGENT_NAMES[a])}</span>`).join('\n      ')}
    </div>
  </header>
  <h2>Who does which work</h2>
${kindQ('large', 'Large, complex work: which agent, model and effort?', 'Features and refactors across many files.')}
${kindQ('focused', 'Hard, focused work: which agent, model and effort?', 'A tricky bug or a careful change in a few files.')}
${kindQ('simple', 'Simple, contained work: which agent, model and effort?', 'A one-file fix, a copy change, a quick look.')}
  <h2>When usage runs low</h2>
  <gx-question tag="${tag()}" name="usageLow" title="What should the captain do when an agent hits its usage limit?">
    <p>No agent CLI shows a usage meter a script can read, so the captain works from the limit itself: when a thread stops on a usage-limit error, it follows this rule. Pick one: the rules exclude each other.</p>
${usageChoice('stay', 'A. Stay on the same agent', 'Threads wait for the reset; the captain never switches agent.')}
${usageChoice('switch', 'B. Switch when low', 'New work moves to the fallback agent below, its models matched by kind of work.')}
${usageChoice('share', 'C. Share, then switch', 'New threads split between both; all on the fallback once the main one is out.')}
${usageChoice('ask', 'D. Ask me each time', 'The captain asks in the inbox before moving any work.')}
  </gx-question>
  <gx-question tag="${tag()}" name="fallback" title="Which agent takes over new work when the main one is out?" type="menus">
    <p>Used by rules B and C. Its main model at high effort for large work, medium for hard and low for simple.</p>
    <select name="agent" data-look="seg">${fallbackOpts}</select>
  </gx-question>
  <h2>Accounts, computers and permissions</h2>
  <gx-question tag="${tag()}" name="neverUse" title="Which accounts or config folders should threads never use?" type="text">
    <p>Other accounts of the same agent work through each CLI's config folder (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex). Name any a thread must never run on, or leave it empty. The captain never spends limit resets and never switches the account you are signed in with.</p>
  </gx-question>
  <gx-question tag="${tag()}" name="computers" title="Where may threads run?">
    <p>Threads run as background CLI runs on this computer. Another computer works over ssh when you name it in the note (its folder, too); the captain copies the report back.</p>
    <gx-choice value="this computer only" recommended${!def || !def.computers || def.computers === 'this computer only' ? ' picked' : ''}>This computer only</gx-choice>
    <gx-choice value="this computer and ssh hosts in the note"${def && def.computers && def.computers !== 'this computer only' ? ' picked' : ''}>Also over ssh<small>Name the hosts and folders in the note.</small></gx-choice>
  </gx-question>
  <gx-question tag="${tag()}" name="permission" title="How much may a thread do without asking?">
    <p>Headless threads cannot answer permission prompts. Standard lets them edit files and run the commands their agent deems safe (Claude Code's auto mode, Codex's workspace sandbox, Cursor's --force inside this repo). Full access skips every prompt and sandbox; use it only in a repo you trust.</p>
    <gx-choice value="standard" recommended${!def || def.permission !== 'full' ? ' picked' : ''}>Standard<small>Edits and safe commands.</small></gx-choice>
    <gx-choice value="full"${def && def.permission === 'full' ? ' picked' : ''}>Full access<small>No prompts, no sandbox.</small></gx-choice>
  </gx-question>
</gx-questions>
</body>
</html>
`;
  return html;
}

function normalizeSetup(raw) {
  const a = raw && raw.answers ? raw.answers : raw || {};
  const pickKind = (k) => {
    const v = a[k] || {};
    if (typeof v === 'string') {
      const [agent, model, effort] = v.split(/\s+/);
      return { agent, model: model || 'default', effort: effort || EFFORT[k] };
    }
    return { agent: v.agent, model: v.model || 'default', effort: v.effort || EFFORT[k] };
  };
  const out = {};
  for (const k of KINDS) {
    out[k] = pickKind(k);
    if (!AGENTS.includes(out[k].agent)) fail(`setup: ${k} needs an agent (${AGENTS.join(', ')}), got "${out[k].agent}"`);
  }
  let mode = String(a.usageLow?.mode || a.usageLow || 'ask').toLowerCase();
  if (!USAGE_RULES[mode]) mode = /stay|wait/.test(mode) ? 'stay' : /share/.test(mode) ? 'share' : /switch/.test(mode) ? 'switch' : 'ask';
  const fb = typeof a.fallback === 'object' ? a.fallback.agent : a.fallback || a.usageLow?.fallback;
  out.usageLow = { mode, fallback: AGENTS.includes(fb) ? fb : null };
  out.usageLow.text = USAGE_RULES[mode] + (out.usageLow.fallback && (mode === 'switch' || mode === 'share') ? ` Fallback agent: ${out.usageLow.fallback}.` : '');
  const nu = a.neverUse;
  out.neverUse = (Array.isArray(nu) ? nu : String(nu && nu !== 'skipped' ? nu : '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
  out.computers = a.computers && a.computers !== 'skipped' ? String(a.computers) : 'this computer only';
  if (a['computers (note)']) out.computers += `: ${a['computers (note)']}`;
  out.permission = a.permission === 'full' ? 'full' : 'standard';
  out.savedAt = nowIso();
  return out;
}

function cmdSetup(ctx, [verb = 'show', ...rest], flags) {
  if (verb === 'check') {
    const why = insideGhostex();
    if (why) fail(`${GHOSTEX_REFUSAL} (detected: ${why})`, 3);
    return { ok: true, insideGhostex: false, agents: cmdAgents(ctx, [], { quick: true }).filter((a) => a.installed).map((a) => a.agent), node: process.version };
  }
  if (verb === 'detect') return cmdAgents(ctx, [], flags);
  const s = ctx.s();
  if (verb === 'page') {
    refuseInsideGhostex();
    const file = s.p('pages', 'setup.html');
    fs.writeFileSync(file, setupPage(ctx, s));
    const shown = showPage(ctx, s, file, { open: !flags['no-open'], kind: 'setup' });
    return { ok: true, page: path.relative(ctx.root, file), ...shown, next: 'Wait for the answer (captain watch), then captain setup save --from-page' };
  }
  if (verb === 'save') {
    let raw;
    if (flags['from-page']) {
      raw = readJson(s.p('answers', 'page-setup.json'), null) || fail('No answers from the setup page yet.');
    } else {
      const body = readBody(flags) || fail('captain setup save --body-file - (answers JSON) or --from-page');
      raw = JSON.parse(body);
    }
    const st = normalizeSetup(raw);
    writeJson(s.p('setup.json'), st);
    writeJson(path.join(ctx.state, 'setup.json'), st);
    if (!flags['no-default']) {
      fs.mkdirSync(ctx.home, { recursive: true });
      writeJson(path.join(ctx.home, 'defaults.json'), st);
    }
    return { text: `Setup saved for ${s.id}, this project and as your default.\n${setupSummary(st).join('\n')}`, json: st };
  }
  if (verb === 'show') {
    const st = setupFor(s);
    if (!st) return { text: 'Setup: not done. Run the interview: captain setup page', json: null };
    return { text: setupSummary(st).join('\n'), json: st };
  }
  if (verb === 'copy') {
    const from = rest[0] || fail('captain setup copy <session id>');
    const st = setupFor(ctx.s(from)) || fail(`${from} has no setup`);
    writeJson(s.p('setup.json'), { ...st, copiedFrom: from });
    return { ok: true, copiedFrom: from };
  }
  fail(`unknown: setup ${verb} (check, detect, page, save, show, copy)`);
}

// ---------------------------------------------------------------------------------------------
// Live pages

function kitHtml(ctx) {
  const p = [path.join(ctx.state, 'kit', 'ghostex-kit.html'), findKit()].find((x) => x && exists(x));
  return p ? readText(p) : '';
}
function pageTitle(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim() : 'Live page';
}
function pageTags(html) {
  return [...html.matchAll(/<gx-question\b[^>]*\btag="(Q\d+)"/gi)].map((m) => m[1]);
}
/** The page with the Ghostex kit and its state in its head, as the answer server serves it. */
export function withKit(ctx, html, state, exported) {
  const kit = kitHtml(ctx);
  if (!kit) return html;
  const stateScript = `<script>window.ghostex&&ghostex.__state(${JSON.stringify(state).replace(/</g, '\\u003c')});</script>`;
  let block = kit.replace('<!--captainstack:state-->', stateScript);
  if (exported) block = `<script>window.__gxExported=${JSON.stringify(exported).replace(/</g, '\\u003c')};</script>\n` + block;
  const charset = /<meta charset[^>]*>/i.exec(html);
  if (charset) return html.slice(0, charset.index + charset[0].length) + '\n' + block + html.slice(charset.index + charset[0].length);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + '\n' + block + html.slice(head.index + head[0].length);
  return block + html;
}

/** Basic checks a page gets before the user sees it (Ghostex's own visual check is richer). */
export function checkPage(html) {
  const errors = [];
  const warnings = [];
  if (!/<meta\s+name="ghostex-page"\s+content="v2"/i.test(html)) errors.push('missing <meta name="ghostex-page" content="v2">');
  if (!/<title>[^<]+<\/title>/i.test(html)) errors.push('missing <title> naming the subject');
  if (html.includes('\u2014')) errors.push('an em dash: rewrite with commas, colons or two sentences');
  const tags = pageTags(html);
  const dup = tags.filter((t, i) => tags.indexOf(t) !== i);
  if (dup.length) errors.push(`question tags used twice: ${[...new Set(dup)].join(', ')}`);
  const qs = [...html.matchAll(/<gx-question\b([^>]*)>([\s\S]*?)<\/gx-question>/gi)];
  if (/<gx-question\b/i.test(html) && !/<gx-questions\b/i.test(html)) errors.push('questions must sit inside one <gx-questions>');
  for (const q of qs) {
    const title = (/\btitle="([^"]*)"/.exec(q[1]) || [])[1] || '';
    if (!title) errors.push('a <gx-question> without a title');
    if (POINTER_RE.test(title)) errors.push(`question points at a page or form: "${title}"`);
    if (/\b[WQ]\d+\b/.test(title)) errors.push(`internal id in a question title: "${title}"`);
    if (!/\btag="Q\d+"/.test(q[1])) warnings.push(`question without a tag: "${title}" (captain next-tag gives one)`);
  }
  if (!qs.length) warnings.push('no question: a report ends with one, usually "What next?"');
  if (/<script\s+src=/i.test(html)) warnings.push('a script loaded from elsewhere: pages should stand alone');
  return { ok: !errors.length, errors, warnings, title: pageTitle(html), tags };
}

function showPage(ctx, s, file, { open = true, kind = 'page' } = {}) {
  const html = readText(file) || fail(`no page at ${file}`);
  const check = checkPage(html);
  if (!check.ok) fail(`Page check failed:\n- ${check.errors.join('\n- ')}`);
  let name = path.basename(file);
  const pagesDir = s.p('pages');
  if (path.resolve(path.dirname(file)) !== path.resolve(pagesDir)) fs.copyFileSync(file, path.join(pagesDir, name));
  const pageKey = `page-${name.replace(/\.html?$/i, '')}`;
  updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
    for (const q of ib.items) if (q.kind === 'page' && q.page === name && q.status === 'open') q.status = 'replaced';
    ib.items.push({ tag: pageKey, kind: 'page', page: name, pageKind: kind, title: check.title, detail: '', answers: [], recommended: [], questions: check.tags, status: 'open', createdAt: nowIso() });
  });
  const url = ensureServer(ctx);
  const pageUrl = `${url}/s/${s.id}/pages/${encodeURIComponent(name)}`;
  if (open) openUrl(pageUrl);
  return { url: pageUrl, title: check.title, questions: check.tags, warnings: check.warnings, opened: open };
}

function cmdPage(ctx, [verb, ...rest], flags) {
  if (verb === 'check') {
    const file = rest[0] || fail('captain page check <file>');
    const r = checkPage(readText(file) || fail(`no page at ${file}`));
    const text = `${r.ok ? 'Page check passed' : 'Page check failed'}: "${r.title}" (questions: ${r.tags.join(', ') || 'none'})${r.errors.map((e) => `\n  error: ${e}`).join('')}${r.warnings.map((w) => `\n  warning: ${w}`).join('')}`;
    if (!r.ok) throw new CliError(text, 1);
    return { text, json: r };
  }
  const s = ctx.s();
  if (verb === 'new') {
    const title = flags.title || rest.join(' ') || fail('captain page new --title "<what the page is about>"');
    const file = s.p('pages', `${slug(flags.name || title)}.html`);
    if (exists(file) && !flags.force) fail(`${path.relative(ctx.root, file)} exists (--force to overwrite)`);
    const tag = s.nextTag();
    fs.writeFileSync(file, pageTemplate(title, tag));
    return { ok: true, page: file, tag };
  }
  if (verb === 'show' || verb === 'open') {
    const file = path.resolve(rest[0] || fail('captain page show <file>'));
    return showPage(ctx, s, file, { open: !flags['no-open'] });
  }
  if (verb === 'export') {
    const file = path.resolve(rest[0] || fail('captain page export <file> [--out <file>]'));
    const html = readText(file);
    const out = flags.out ? path.resolve(flags.out) : file.replace(/\.html?$/i, '') + '.standalone.html';
    fs.writeFileSync(out, withKit(ctx, html, {}, { page: slug(pageTitle(html)), title: pageTitle(html) }));
    return { ok: true, out, note: 'Opens in any browser; Send shows the answers as JSON to copy back (captain page import <file.json>).' };
  }
  if (verb === 'import') {
    const raw = JSON.parse(readText(rest[0]) || fail('captain page import <answers.json>'));
    const name = rest[1] || `${raw.page}.html`;
    return recordPageAnswers(ctx, s, name, raw.answers, 'import');
  }
  if (verb === 'list' || !verb) {
    const ib = readJson(s.p('inbox.json'), { items: [] });
    const files = fs.readdirSync(s.p('pages')).filter((f) => /\.html?$/i.test(f));
    const list = files.map((f) => {
      const entry = [...ib.items].reverse().find((q) => q.kind === 'page' && q.page === f);
      return { page: f, title: pageTitle(readText(s.p('pages', f))), status: entry ? entry.status : 'not shown', url: serverUrl(ctx) ? `${serverUrl(ctx)}/s/${s.id}/pages/${encodeURIComponent(f)}` : null };
    });
    return { text: list.map((p) => `${p.page} [${p.status}] ${p.title}${p.url ? ` ${p.url}` : ''}`).join('\n') || '(no pages)', json: list };
  }
  if (verb === 'retire') {
    const name = path.basename(rest[0] || fail('captain page retire <page>'));
    updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
      for (const q of ib.items) if (q.kind === 'page' && q.page === name && q.status === 'open') q.status = 'retired';
    });
    return { ok: true, retired: name };
  }
  fail(`unknown: page ${verb} (new, check, show, export, import, list, retire)`);
}

function pageTemplate(title, tag) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>${escapeHtml(title)}</title>
<style>
  /* Only the page's own drawing: the kit paints the page, the cards and the questions. */
</style>
</head>
<body>
<gx-questions submit="Send to the captain">
  <header>
    <span class="gx-eyebrow">Captain · report</span>
    <h1>${escapeHtml(title)}</h1>
    <p class="gx-lede">One line on what this page holds.</p>
  </header>

  <h2>What happened</h2>
  <p>The results, findings or plan, with tables and cards where they help.</p>

  <gx-question tag="${tag}" title="What next?">
    <p>What each choice does, and which one the captain recommends and why.</p>
    <gx-choice value="go on" recommended>Go on as planned<small>One line on what that means.</small></gx-choice>
    <gx-choice value="stop">Stop here</gx-choice>
  </gx-question>
</gx-questions>
</body>
</html>
`;
}

function recordPageAnswers(ctx, s, name, answers, via) {
  const key = `page-${name.replace(/\.html?$/i, '')}`;
  const r = updateJson(s.p('inbox.json'), { items: [] }, (ib) => {
    const entry = [...ib.items].reverse().find((q) => q.kind === 'page' && q.page === name && (q.status === 'open' || q.status === 'answered'));
    if (entry && entry.status === 'answered') return { already: true };
    if (entry) {
      entry.status = 'answered';
      entry.answer = answers;
      entry.answeredAt = nowIso();
      entry.seen = false;
      entry.via = via;
    }
    return { entry };
  });
  if (r.already) return { ok: false, status: 409, error: 'This page was already answered.' };
  const answeredAt = nowIso();
  writeJson(s.p('answers', `${key}.json`), { page: name, answers, answeredAt, via });
  const summary = Object.entries(answers || {})
    .filter(([, v]) => v !== 'skipped')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');
  s.event('answer', { tag: key, page: name, title: r.entry ? r.entry.title : name, answerText: firstLine(summary || '(all skipped)', 300) });
  return { ok: true, answeredAt, file: path.relative(ctx.root, s.p('answers', `${key}.json`)) };
}

function openUrl(url) {
  if (process.env.CAPTAINSTACK_NO_OPEN) return;
  try {
    let child;
    if (process.platform === 'darwin') child = spawn('open', [url], { stdio: 'ignore', detached: true });
    else if (IS_WIN) child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true });
    else child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no opener: the URL is printed */
  }
}

// ---------------------------------------------------------------------------------------------
// The answer server: localhost only, a clean JSON API for the Captain window, and the pages.

function serverInfo(ctx) {
  const info = readJson(path.join(ctx.state, 'server.json'), null);
  if (info && pidAlive(info.pid)) return info;
  return null;
}
function serverUrl(ctx) {
  const i = serverInfo(ctx);
  return i ? i.url : null;
}
function ensureServer(ctx) {
  const running = serverUrl(ctx);
  if (running) return running;
  const child = spawn(process.execPath, [SCRIPT, '__serve'], { cwd: ctx.root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CAPTAINSTACK_ROOT: ctx.root } });
  child.unref();
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const u = serverUrl(ctx);
    if (u) return u;
    const end = Date.now() + 100;
    while (Date.now() < end) {
      /* wait for the server to write server.json */
    }
  }
  fail('the answer server did not start (try captain serve in the foreground to see why)');
}

function cmdServe(ctx, pos, flags) {
  if (flags.stop) {
    const i = serverInfo(ctx);
    if (!i) return { ok: true, note: 'not running' };
    killTree(i.pid);
    fs.rmSync(path.join(ctx.state, 'server.json'), { force: true });
    return { ok: true, stopped: i.pid };
  }
  if (flags.background) return { ok: true, url: ensureServer(ctx) };
  return runServer(ctx, flags.port ? Number(flags.port) : 0);
}

function sessionState(ctx, s) {
  const b = board(s);
  const inbox = readJson(s.p('inbox.json'), { items: [] });
  return {
    session: s.meta,
    setup: setupFor(s),
    board: b.items.map((it) => itemView(s, it, inbox, b)).filter((it) => it.status !== 'Dropped'),
    inbox: inbox.items,
    threads: threadIds(s).map((id) => new Thread(s, id).view()),
    pages: fs.existsSync(s.p('pages')) ? fs.readdirSync(s.p('pages')).filter((f) => /\.html?$/i.test(f)).map((f) => ({ page: f, title: pageTitle(readText(s.p('pages', f))), url: `/s/${s.id}/pages/${encodeURIComponent(f)}` })) : [],
    memory: memoryLines(s.p('memory.md')),
    events: s.events().slice(-50),
    needsYou: needsYou(ctx, s),
  };
}

function runServer(ctx, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handle(ctx, req, res).catch((e) => send(res, e.code === 409 ? 409 : 500, { ok: false, error: e.message })));
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const url = `http://127.0.0.1:${actual}`;
      writeJson(path.join(ctx.state, 'server.json'), { pid: process.pid, port: actual, url, root: ctx.root, version: VERSION, startedAt: nowIso() });
      process.stdout.write(`CaptainStack answer server on ${url} (Ctrl+C to stop)\n`);
    });
    const stop = () => {
      const i = readJson(path.join(ctx.state, 'server.json'), null);
      if (i && i.pid === process.pid) fs.rmSync(path.join(ctx.state, 'server.json'), { force: true });
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    server.on('close', resolve);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}
function readReq(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(ctx, req, res) {
  const port = req.socket.localPort;
  // Only this machine, and only pages this server served: a website cannot post answers here.
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { ok: false, error: 'bad host' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { ok: false, error: 'bad origin' });
  }
  const url = new URL(req.url, `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const sessionOf = (id) => {
    if (!ctx.sessionIds().includes(id)) {
      const e = new Error(`no session ${id}`);
      throw e;
    }
    return ctx.s(id);
  };
  if (url.pathname === '/') {
    const id = ctx.sessionId(false) || ctx.sessionIds()[0];
    res.writeHead(302, { location: id ? `/s/${id}/inbox` : '/api/sessions' });
    return res.end();
  }
  if (parts[0] === 'api') {
    if (parts[1] === 'health') return send(res, 200, { ok: true, version: VERSION, stateDir: STATE_DIR_NAME, root: ctx.root });
    if (parts[1] === 'sessions' && parts.length === 2) return send(res, 200, ctx.sessionIds().map((id) => ctx.s(id).meta));
    if (parts[1] === 's' && parts[2]) {
      const s = sessionOf(parts[2]);
      const what = parts[3] || 'state';
      if (req.method === 'GET') {
        if (what === 'state') return send(res, 200, sessionState(ctx, s));
        if (what === 'board') return send(res, 200, sessionState(ctx, s).board);
        if (what === 'inbox') return send(res, 200, readJson(s.p('inbox.json'), { items: [] }).items);
        if (what === 'needs-you') return send(res, 200, needsYou(ctx, s));
        if (what === 'threads' && parts[4]) {
          const t = findThread(s, parts[4]);
          return send(res, 200, { ...t.view(), messages: t.messages() });
        }
        if (what === 'threads') return send(res, 200, threadIds(s).map((id) => new Thread(s, id).view()));
        if (what === 'pages') return send(res, 200, sessionState(ctx, s).pages);
        if (what === 'memory') return send(res, 200, memoryLines(s.p('memory.md')));
        if (what === 'setup') return send(res, 200, setupFor(s));
        if (what === 'events') {
          // Long-poll: ?since=<n>&wait=<seconds> returns as soon as an event after <n> exists.
          const since = Number(url.searchParams.get('since') || 0);
          const wait = Math.min(Number(url.searchParams.get('wait') || 0), 60) * 1000;
          const until = Date.now() + wait;
          for (;;) {
            const evs = s.events().filter((e) => e.n > since);
            if (evs.length || Date.now() >= until) return send(res, 200, evs);
            await sleep(500);
          }
        }
      }
      if (req.method === 'POST' && what === 'answer') {
        const body = JSON.parse((await readReq(req)) || '{}');
        const r = recordAnswer(ctx, s, body.tag, body.answer, body.note, 'server');
        return send(res, r.ok ? 200 : r.status || 400, r);
      }
      if (req.method === 'POST' && what === 'withdraw') {
        const body = JSON.parse((await readReq(req)) || '{}');
        return send(res, 200, cmdInbox(ctx, ['withdraw', body.tag], {}));
      }
    }
    return send(res, 404, { ok: false, error: 'not found' });
  }
  if (parts[0] === 's' && parts[1]) {
    const s = sessionOf(parts[1]);
    if (parts[2] === 'inbox') {
      if (parts.length === 3 && req.method === 'GET') return send(res, 200, withKit(ctx, inboxPage(ctx, s), { answered: false, draft: null, draftEditedAt: null }), 'text/html; charset=utf-8');
      if (parts[3] === 'answers' && req.method === 'POST') {
        const body = JSON.parse((await readReq(req)) || '{}');
        const answers = body.answers || {};
        const done = [];
        for (const [key, value] of Object.entries(answers)) {
          if (!/^Q\d+$/.test(key) || value === 'skipped' || value == null) continue;
          const note = answers[`${key} (note)`] || null;
          const r = recordAnswer(ctx, s, key, value, note, 'inbox page');
          if (r.ok) done.push(key);
        }
        const extra = Object.entries(answers).find(([k]) => !/^Q\d+/.test(k) && typeof answers[k] === 'string' && answers[k].trim());
        if (extra) s.event('answer', { tag: 'inbox', title: 'Inbox note', answerText: firstLine(extra[1], 300) });
        return send(res, 200, { ok: true, answered: done, answeredAt: nowIso() });
      }
      if (parts[3] === 'draft') return send(res, 200, req.method === 'GET' ? { draft: null, editedAt: 0 } : { ok: true });
    }
    if (parts[2] === 'pages' && parts[3]) {
      const name = path.basename(parts[3]);
      const file = s.p('pages', name);
      if (!exists(file)) return send(res, 404, { ok: false, error: 'no such page' });
      const key = `page-${name.replace(/\.html?$/i, '')}`;
      const answerFile = s.p('answers', `${key}.json`);
      const draftFile = s.p('answers', `${key}.draft.json`);
      if (parts.length === 4 && req.method === 'GET') {
        const ans = readJson(answerFile, null);
        const draft = readJson(draftFile, null);
        const state = ans ? { answered: true, answers: ans.answers, answeredAt: ans.answeredAt } : { answered: false, draft: draft ? draft.draft : null, draftEditedAt: draft ? draft.editedAt : null };
        return send(res, 200, withKit(ctx, readText(file), state), 'text/html; charset=utf-8');
      }
      if (parts[4] === 'answers' && req.method === 'POST') {
        const body = JSON.parse((await readReq(req)) || '{}');
        const r = recordPageAnswers(ctx, s, name, body.answers, 'page');
        if (r.ok) fs.rmSync(draftFile, { force: true });
        return send(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[4] === 'draft') {
        if (req.method === 'GET') return send(res, 200, readJson(draftFile, { draft: null, editedAt: 0 }));
        const body = JSON.parse((await readReq(req)) || '{}');
        writeJson(draftFile, { draft: body.draft || {}, editedAt: Number(body.editedAt) || Date.now() });
        return send(res, 200, { ok: true });
      }
      if (parts[4] === 'notice') return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { ok: false, error: 'not found' });
}

/** The inbox page: every open ask as a question, every page waiting on the user as a link. */
function inboxPage(ctx, s) {
  const ib = readJson(s.p('inbox.json'), { items: [] });
  const open = ib.items.filter((q) => q.status === 'open');
  const asks = open.filter((q) => q.kind !== 'page');
  const pages = open.filter((q) => q.kind === 'page');
  const b = board(s);
  const itemTitle = (ref) => (b.items.find((i) => i.id === ref) || {}).title;
  const md = (t) => escapeHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/\n{2,}/g, '</p><p>').replace(/\n- /g, '<br>· ');
  const qs = asks
    .map(
      (q) => `  <gx-question tag="${q.tag}" name="${q.tag}" title="${escapeHtml(q.title)}"${q.multiple ? ' multiple' : ''}>
    ${q.item ? `<p><b>${escapeHtml(itemTitle(q.item) || '')}</b></p>` : ''}<p>${md(q.detail)}</p>
${q.answers.map((a) => `    <gx-choice value="${escapeHtml(a)}"${q.recommended.includes(a) ? ' recommended' : ''}>${escapeHtml(a)}</gx-choice>`).join('\n')}
  </gx-question>`,
    )
    .join('\n');
  const pageRows = pages.map((p) => `    <li><a href="/s/${s.id}/pages/${encodeURIComponent(p.page)}">${escapeHtml(p.title)}</a>${p.questions && p.questions.length ? ` <span class="gx-chip">${p.questions.length} question${p.questions.length > 1 ? 's' : ''}</span>` : ''}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>Needs you: ${open.length ? `${open.length} open` : 'nothing open'} (${escapeHtml(s.meta.title || s.id)})</title>
</head>
<body>
<gx-questions submit="Send to the captain">
  <header>
    <span class="gx-eyebrow">CaptainStack · inbox</span>
    <h1>Needs you</h1>
    <p class="gx-lede">${asks.length ? `${asks.length} question${asks.length > 1 ? 's' : ''}` : 'No questions'}${pages.length ? ` and ${pages.length} page${pages.length > 1 ? 's' : ''} to read` : ''} from your captain, "${escapeHtml(s.meta.title || s.id)}". Your answers go straight back to it.</p>
  </header>
${pages.length ? `  <h2>Pages to read</h2>\n  <ul>\n${pageRows}\n  </ul>` : ''}
${qs || '  <p>Nothing to answer right now.</p>'}
</gx-questions>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Status, the Needs you footer and the status line

function needsYou(ctx, s) {
  const ib = readJson(s.p('inbox.json'), { items: [] });
  return ib.items.filter((q) => q.status === 'open');
}

function cmdFooter(ctx, pos, flags) {
  const s = ctx.s();
  const open = needsYou(ctx, s);
  const base = serverUrl(ctx);
  if (!open.length) return { text: '❓ **Needs you:**\n- Nothing right now.', json: [] };
  const b = board(s);
  const lines = open.map((q) => {
    if (q.kind === 'page') return `- ${q.title}: [open the page](${base ? `${base}/s/${s.id}/pages/${encodeURIComponent(q.page)}` : q.page})${q.questions?.length ? ` (${q.questions.length} question${q.questions.length > 1 ? 's' : ''})` : ''}`;
    const item = q.item ? (b.items.find((i) => i.id === q.item) || {}).title : null;
    if (q.kind === 'todo') return `- ${q.tag} ${q.title}${item ? ` (${item})` : ''}: reply "${q.tag} done" when it is done`;
    const answers = q.answers.map((a, i) => `${String.fromCharCode(65 + i)}. ${a}${q.recommended.includes(a) ? ' (recommended)' : ''}`).join(' · ');
    return `- ${q.tag} ${q.title}${item ? ` (${item})` : ''}${q.holds ? ' [holds the work]' : ''}: ${answers || 'your words'}`;
  });
  let text = `❓ **Needs you:**\n${lines.join('\n')}`;
  const asks = open.filter((q) => q.kind === 'ask');
  if (asks.length) text += `\n- Reply like "${asks[0].tag} A", or answer on the [inbox page](${base ? `${base}/s/${s.id}/inbox` : 'captain serve --background'}).`;
  return { text, json: open };
}

function cmdStatusline(ctx) {
  try {
    if (!ctx.initialized) return { text: '' };
    const id = ctx.sessionId(false);
    if (!id) return { text: 'captain: no session' };
    const s = ctx.s(id);
    const open = needsYou(ctx, s).length;
    const views = threadIds(s).map((t) => new Thread(s, t).view());
    const running = views.filter((v) => v.status === 'running' || v.status === 'starting').length;
    const trouble = views.filter((v) => ['failed', 'limited', 'stopped'].includes(v.status) || v.quiet).length;
    const b = board(s);
    const inbox = readJson(s.p('inbox.json'), { items: [] });
    const inProgress = b.items.filter((it) => itemStatus(s, it, inbox, b) === 'In progress').length;
    const parts = [`captain ${id}`, `${open} need${open === 1 ? 's' : ''} you`, `${running} thread${running === 1 ? '' : 's'} running`];
    if (trouble) parts.push(`${trouble} need healing`);
    parts.push(`${inProgress} in progress`);
    return { text: parts.join(' · ') };
  } catch {
    return { text: 'captain: ?' };
  }
}

function cmdStatus(ctx, [part], flags) {
  if (!ctx.initialized) return { text: `CaptainStack is not set up in ${ctx.root}. Start a captain: captain session new --title "<what it runs>"`, json: { initialized: false } };
  const s = ctx.s();
  if (part === 'threads') return cmdThreads(ctx, [], flags);
  if (part === 'thread') return findThread(s, flags._rest?.[0]).view();
  if (part === 'memory') return cmdMemory(ctx);
  if (part === 'board') return cmdItem(ctx, ['list'], flags);
  if (part === 'usage') return cmdSetup(ctx, ['show'], flags);
  const meta = s.meta;
  const setup = setupFor(s);
  const open = needsYou(ctx, s);
  const unseen = unseenEvents(s).filter((e) => WAKE_TYPES.has(e.type));
  const views = threadIds(s).map((id) => new Thread(s, id).view()).filter((v) => v.status !== 'closed');
  const b = board(s);
  const inbox = readJson(s.p('inbox.json'), { items: [] });
  const counts = {};
  for (const it of b.items) {
    const st = itemStatus(s, it, inbox, b);
    if (st !== 'Dropped') counts[st] = (counts[st] || 0) + 1;
  }
  const lines = [];
  lines.push(`CaptainStack ${VERSION} · captain ${s.id} "${meta.title}" · ${ctx.root}`);
  if (setup) {
    lines.push(`Setup: done. ${setupSummary(setup)[0]}`);
    lines.push(`Usage fallback rule: ${setup.usageLow?.text || USAGE_RULES.ask}`);
  } else lines.push('Setup: not done. Run the setup interview before any work: captain setup page');
  lines.push(`Needs you: ${open.length ? open.map((q) => `${q.kind === 'page' ? 'page' : q.tag} ${firstLine(q.title, 60)}`).join(' · ') : 'nothing'}`);
  if (unseen.length) lines.push(`New since you last looked (${unseen.length}):\n${unseen.map((e) => `  ${eventLine(e)}`).join('\n')}`);
  lines.push(`Threads: ${views.length ? '' : 'none'}`);
  for (const v of views) {
    lines.push(`  ${v.id} ${v.agent}${v.model ? ` ${v.model}` : ''} [${v.status}${v.quiet ? ', quiet' : ''}${v.pending ? `, ${v.pending} message queued` : ''}] "${v.title}" · ${v.lastReply ? `reported ${ago(v.lastReply.at)}: ${firstLine(v.lastReply.headline, 80)}` : `active ${ago(v.lastActivity)}`}${v.error ? ` · ${v.error}` : ''}`);
  }
  lines.push(`Work: ${STATUS_ORDER.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(' · ') || 'no items'}`);
  const memo = memoryLines(s.p('memory.md')).length;
  lines.push(`Memory: ${memo} note${memo === 1 ? '' : 's'} (captain memory) · Answer server: ${serverUrl(ctx) || 'not running (captain serve --background)'}`);
  return { text: lines.join('\n'), json: { session: meta, setup, needsYou: open, unseen, threads: views, work: counts, server: serverUrl(ctx) } };
}

// ---------------------------------------------------------------------------------------------
// Help and main

const HELP = `CaptainStack ${VERSION}: a portable captain (PM) for any agent CLI.
All state lives in ${STATE_DIR_NAME}/ in the repo (git-ignored), one folder per captain session.
Run it as: node ${STATE_DIR_NAME}/bin/captain.mjs <verb>   (below: "captain")

Start
  captain init                                  Make ${STATE_DIR_NAME}/, add it to .gitignore, install this CLI there
  captain session new --title "<what it runs>"  A new captain session (its own board, inbox, memory, threads)
  captain session list | use <id> | show
  captain status [threads|board|memory|usage] [--json]   Start every turn with this
  captain agents                                Which agent CLIs are installed

Setup interview (first turn)
  captain setup check                           Refuses inside Ghostex; lists agents found
  captain setup page [--no-open]                Write and open the interview page
  captain setup save --from-page | --body-file -   Save the answers (this captain, project, your default)
  captain setup show | copy <session>

Threads
  captain start-thread --agent <a> | --kind large|focused|simple  --title "<3 to 6 words>"
                       (--task "<brief>" | --body-file <file|->) [--model m] [--effort e] [--item W1] [--cwd dir]
  captain send <thread> "<message>" | --body-file -     Follow-up; receipt: delivered | queued | held
  captain threads [--all]                       List threads with status and last reply
  captain read <thread> [--last N] [--role captain|thread] [--log N]
  captain stop <thread>                         Stop a stuck turn (send "carry on" to resume)
  captain close <thread> [--force]              Done with it
  captain watch [--timeout 540] [--follow] [--json]   Block until a thread reports or the user answers
  captain events [--unseen] [--last N]
  (threads) captain note "<line>" · captain wait-message [--timeout 300]

Work items (work.json, rendered to WORK.md)
  captain item add "<line of work>" [--thread t1]
  captain item now W1 "<where it stands>" · item step W1 "<step>" [--done] [--chore]
  captain item wait W1 --on <W2|Q3|"something outside"> [--clear]
  captain item ask W1 "<title>" --detail "<120+ chars>" --answer A --answer B --recommended A [--holds] [--multiple]
  captain item done W1 "<the line worth keeping>" · item drop W1 · item edit W1 --status parked|open
  captain item link W1 --thread t2 · item list [--all] [--check] · item show W1

Inbox
  captain ask "<title>" --detail "..." --answer A --answer B --recommended A   (no work item)
  captain ask --todo "<title>" --detail "..."   Something the user must do (answer: Done)
  captain inbox [--json] · inbox withdraw Q3 · inbox done Q3
  captain answer Q3 "<answer>" [--note "..."]   Record an answer the user gave in chat
  captain answers [--all] [--peek]              New answers since you last looked
  captain next-tag                              The next Q tag for a page's question

Live pages
  captain page new --title "<subject>"          A page skeleton in the session's pages/
  captain page check <file> · page show <file> [--no-open] · page list · page retire <page>
  captain page export <file> [--out f]          Standalone copy (Send shows JSON to copy back)
  captain page import <answers.json>

Memory
  captain remember "<one line>" · forget <n> · memory
  captain override add|list|remove              Rules for every captain (in ~/${STATE_DIR_NAME}/overrides.md)

Answer server (for pages, the inbox and the Captain window)
  captain serve [--port N] | --background | --stop
  JSON API: GET /api/health, /api/sessions, /api/s/<id>/state|board|inbox|needs-you|threads|threads/<t>|pages|memory|setup,
            /api/s/<id>/events?since=N&wait=S ; POST /api/s/<id>/answer {tag, answer, note}, /api/s/<id>/withdraw {tag}

Reply
  captain footer                                The Needs you list that ends every captain reply
  captain statusline                            One line for a status bar

Global flags: --session <id> (-s), --root <dir>, --json`;

const COMMANDS = {
  init: (ctx) => cmdInit(ctx),
  session: (ctx, pos, flags) => cmdSession(ctx, pos, flags),
  sessions: (ctx, pos, flags) => cmdSession(ctx, ['list'], flags),
  status: (ctx, pos, flags) => cmdStatus(ctx, pos, { ...flags, _rest: pos.slice(1) }),
  agents: (ctx, pos, flags) => cmdAgents(ctx, pos, flags),
  setup: (ctx, pos, flags) => cmdSetup(ctx, pos, flags),
  'start-thread': (ctx, pos, flags) => cmdStartThread(ctx, pos, flags),
  send: (ctx, pos, flags) => cmdSend(ctx, pos, flags),
  threads: (ctx, pos, flags) => cmdThreads(ctx, pos, flags),
  read: (ctx, pos, flags) => cmdRead(ctx, pos, flags),
  stop: (ctx, pos) => cmdStop(ctx, pos),
  close: (ctx, pos, flags) => cmdClose(ctx, pos, flags),
  note: (ctx, pos, flags) => cmdNote(ctx, pos, flags),
  'wait-message': (ctx, pos, flags) => cmdWaitMessage(ctx, pos, flags),
  watch: (ctx, pos, flags) => cmdWatch(ctx, pos, flags),
  events: (ctx, pos, flags) => cmdEvents(ctx, pos, flags),
  item: (ctx, pos, flags) => cmdItem(ctx, pos, flags),
  ask: (ctx, pos, flags) => cmdAsk(ctx, pos, flags),
  answer: (ctx, pos, flags) => cmdAnswer(ctx, pos, flags),
  answers: (ctx, pos, flags) => cmdAnswers(ctx, pos, flags),
  inbox: (ctx, pos, flags) => cmdInbox(ctx, pos, flags),
  'next-tag': (ctx) => ({ text: ctx.s().nextTag() }),
  remember: (ctx, pos) => cmdRemember(ctx, pos),
  forget: (ctx, pos) => cmdForget(ctx, pos),
  memory: (ctx) => cmdMemory(ctx),
  override: (ctx, pos) => cmdOverride(ctx, pos),
  page: (ctx, pos, flags) => cmdPage(ctx, pos, flags),
  serve: (ctx, pos, flags) => cmdServe(ctx, pos, flags),
  footer: (ctx, pos, flags) => cmdFooter(ctx, pos, flags),
  statusline: (ctx) => cmdStatusline(ctx),
  version: () => ({ text: VERSION }),
  help: () => ({ text: HELP }),
  __run: (ctx, [sid, tid]) => runThread(ctx, sid, tid).then(() => ({ quiet: true })),
  __serve: (ctx) => runServer(ctx, 0),
};

function print(result, flags) {
  if (result === undefined || result === null) return;
  if (result.quiet) return;
  if (flags.json) {
    const v = result.json !== undefined && (result.text !== undefined || Object.keys(result).length <= 2) ? result.json : result;
    process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    return;
  }
  if (typeof result.text === 'string' && (result.json !== undefined || Object.keys(result).length === 1)) {
    if (result.text) process.stdout.write(result.text + '\n');
    return;
  }
  if (Array.isArray(result)) {
    if (!result.length) return process.stdout.write('(none)\n');
    if (result[0] && result[0].status !== undefined && result[0].agent !== undefined && result[0].turns !== undefined) {
      for (const v of result) process.stdout.write(`${v.id} ${v.agent}${v.model ? ` ${v.model}` : ''} [${v.status}${v.quiet ? ', quiet' : ''}] "${v.title}"${v.lastReply ? ` · reported ${ago(v.lastReply.at)}: ${v.lastReply.headline}` : ''}\n`);
      return;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  // Receipts: one line of JSON, so an agent can read the status directly.
  process.stdout.write(JSON.stringify(result) + '\n');
}

export async function main(argv = process.argv.slice(2)) {
  const [verb = 'help', ...rest] = argv;
  if (verb === '--help' || verb === '-h') return print({ text: HELP }, {});
  if (verb === '--version') return print({ text: VERSION }, {});
  const { pos, flags } = parseArgs(rest);
  const fn = COMMANDS[verb];
  if (!fn) fail(`unknown command "${verb}". captain help lists them.`);
  if (flags.help) return print({ text: HELP }, {});
  const ctx = new Ctx(flags);
  const needsInit = !['init', 'help', 'version', 'agents', 'status', 'statusline', 'setup', 'session'].includes(verb) && !(verb === 'page' && pos[0] === 'check');
  if (needsInit && !ctx.initialized) fail(`CaptainStack is not set up in ${ctx.root}. Start a captain first: captain session new --title "<what it runs>"`);
  if (verb === 'setup' && !['check', 'detect'].includes(pos[0]) && !ctx.initialized) fail('No captain session yet: captain session new --title "<what it runs>"');
  const result = await fn(ctx, pos, flags);
  print(result, flags);
}

const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] || '') === SCRIPT || fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SCRIPT);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    if (e instanceof CliError) {
      process.stderr.write(e.message + '\n');
      process.exit(e.code);
    }
    process.stderr.write((e && e.stack) || String(e));
    process.stderr.write('\n');
    process.exit(1);
  });
}
