// Builds the project site (site/dist) from docs/ROADMAP.md. No dependencies: it renders the small Markdown subset
// the roadmap uses (headings, paragraphs, lists, tables, bold, code, links). Run: node scripts/build-site.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(root, 'docs', 'ROADMAP.md'), 'utf8');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  // Code spans first, so nothing inside them is formatted.
  return esc(s)
    .split(/(`[^`]+`)/)
    .map((part) => part.startsWith('`') && part.endsWith('`')
      ? `<code>${part.slice(1, -1)}</code>`
      : part
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>'))
    .join('');
}
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function render(text) {
  const lines = text.split('\n');
  const out = [];
  let title = 'Yardmaster';
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      const level = h[1].length;
      if (level === 1) title = h[2];
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      out.push(`<div class="table-wrap"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^(\d+\.|-) /);
    if (list) {
      const ordered = list[1] !== '-';
      const items = [];
      while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) items.push(lines[i++].replace(/^(\d+\.|-) /, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |\||\d+\. |- )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { title, body: out.join('\n') };
}

const { title, body } = render(md);
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="What Yardmaster fixes, speeds up and builds next, ranked by speed and cost.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono&display=swap">
<style>
:root { color-scheme: light; --paper:#F4F6F9; --surface:#FFFFFF; --ink:#17202C; --muted:#586474; --rule:#D7DDE6; --accent:#2A4DBF;
  --display:"Barlow Semi Condensed","Arial Narrow",sans-serif; --body:"IBM Plex Sans",-apple-system,system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --paper:#10151C; --surface:#161D27; --ink:#E5EAF1; --muted:#9AA6B6; --rule:#2A3340; --accent:#87A2FF; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.6 var(--body);
  padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 64px max(16px, env(safe-area-inset-left)); }
main { max-width: 50rem; margin: 0 auto; }
h1, h2, h3 { font-family: var(--display); line-height: 1.15; text-wrap: balance; }
h1 { font-size: 2.4rem; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.6rem; margin: 2.5rem 0 0.75rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
p, li { max-width: 65ch; }
li { margin: 0.35rem 0; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 0.88em; }
.table-wrap { overflow-x: auto; border: 1px solid var(--rule); background: var(--surface); margin: 1rem 0; }
table { border-collapse: collapse; width: 100%; min-width: 36rem; font-size: 0.92rem; }
th, td { text-align: left; vertical-align: top; padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--rule); }
th { font: 500 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
.meta { font: 0.8rem var(--mono); color: var(--muted); }
</style>
</head>
<body>
<main>
<div class="meta">Yardmaster v${esc(version)} · <a href="https://github.com/g4m35/yardmaster">github.com/g4m35/yardmaster</a></div>
${body}
</main>
</body>
</html>
`;
const outDir = join(root, 'site', 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
console.log(`built ${join('site', 'dist', 'index.html')} (${(html.length / 1024).toFixed(1)} KB)`);
