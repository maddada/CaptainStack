#!/usr/bin/env node
// Repo checks: every skill has name and description frontmatter, the plugin lists every skill,
// and nothing that should stay private (local paths, emails, tokens) or off-style slips in.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const skillsDir = path.join(root, 'skills');
const skills = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
for (const d of skills) {
  const text = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) problems.push(`${d}: no frontmatter`);
  else {
    if (!new RegExp(`^name: ${d}$`, 'm').test(fm[1])) problems.push(`${d}: frontmatter name must be "${d}"`);
    if (!/^description: .{40,}/m.test(fm[1])) problems.push(`${d}: description missing or too short`);
  }
  if (!fs.existsSync(path.join(skillsDir, d, 'agents', 'openai.yaml'))) problems.push(`${d}: no agents/openai.yaml`);
}
const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const listed = plugin.skills.map((s) => path.basename(s));
for (const d of skills) if (!listed.includes(d)) problems.push(`plugin.json does not list ${d}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== plugin.version) problems.push(`package.json ${pkg.version} and plugin.json ${plugin.version} differ`);
const cli = fs.readFileSync(path.join(skillsDir, 'captain', 'scripts', 'captain.mjs'), 'utf8');
const cliVersion = /export const VERSION = '([^']+)'/.exec(cli)[1];
if (cliVersion !== pkg.version) problems.push(`captain.mjs VERSION ${cliVersion} and package.json ${pkg.version} differ`);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const banned = [
  [/\u2014/, 'an em dash'],
  [/maestro|t3code|openusage/i, 'a banned name'],
  [/\/Users\/[a-z0-9_-]+\//i, 'a local macOS path'],
  [/\/home\/[a-z0-9_-]+\//i, 'a local Linux path'],
  [/C:\\Users\\[a-z0-9_-]+\\/i, 'a local Windows path'],
  [/[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud)\.com/i, 'an email address'],
  [/\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})/, 'a token'],
];
for (const f of files) {
  if (/\.(png|jpg|gif|ico)$/i.test(f) || f === 'scripts/check.mjs') continue;
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  for (const [re, what] of banned) if (re.test(text)) problems.push(`${f}: ${what}`);
}

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${skills.length} skills, ${files.length} files checked`);
