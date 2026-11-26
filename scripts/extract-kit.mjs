#!/usr/bin/env node
// Maintainers only: refresh skills/captain/kit/ghostex-kit.html from a page exported by Ghostex.
//
//   ghostex visual guide example > example.html
//   ghostex visual export example.html --out exported.html
//   node scripts/extract-kit.mjs exported.html
//
// It keeps the theme, the page API, the question kit and the fit script Ghostex inlines into an
// exported page, drops the export marker, the content policy and the page's own state, and puts a
// `<!--captainstack:state-->` marker where the answer server adds each page's state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [input] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/extract-kit.mjs <exported.html>');
  process.exit(1);
}
const html = fs.readFileSync(input, 'utf8');
const blocks = [];
const re = /<(script|style)([^>]*)>([\s\S]*?)<\/\1>/g;
let m;
while ((m = re.exec(html))) blocks.push({ tag: m[1], attrs: m[2], body: m[3], text: m[0] });

const themeAt = blocks.findIndex((b) => b.tag === 'style' && /id="ghostex-theme"/.test(b.attrs));
const fitAt = blocks.findIndex((b) => b.tag === 'style' && /id="ghostex-fit"/.test(b.attrs));
if (themeAt < 0 || fitAt < 0) {
  console.error('not an exported Ghostex page: no ghostex-theme or ghostex-fit block');
  process.exit(1);
}
const kit = blocks.slice(themeAt, fitAt + 2);
const parts = [];
for (const b of kit) {
  if (b.tag === 'script' && /ghostex\.__state\(/.test(b.body) && b.body.length < 400) {
    parts.push('<!--captainstack:state-->');
    continue;
  }
  parts.push(b.text);
}
if (!parts.includes('<!--captainstack:state-->')) {
  console.error('no page state script found between the page API and the kit');
  process.exit(1);
}
const header =
  '<!-- Ghostex page kit (theme, page API, question kit, fit), from Ghostex (https://github.com/maddada/Ghostex), MIT License, Copyright 2026 Mohamad Yahia (maddada). See kit/NOTICE.md. -->';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'skills', 'captain', 'kit', 'ghostex-kit.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, header + '\n' + parts.join('\n') + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
