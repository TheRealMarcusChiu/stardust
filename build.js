#!/usr/bin/env node
/*
 * build-garden-data.js
 * ---------------------
 * Builds `garden-data.js` (graph metadata only — no note bodies) plus a
 * `bodies/<id>.js` file per note from the `vault/` directory — the
 * single source of truth for the knowledge garden.
 *
 * Each node in garden-data.js carries a `bodyRef` ("bodies/<id>.js") instead of
 * its markdown body. The app loads that file on demand (hover/click) via a
 * <script> tag (JSONP-style `window.__kgBody(id, markdown)`), which works over
 * http(s) AND file:// — no fetch/server required.
 *
 * Vault layout: every node is a folder PLUS a same-named `.md` note that lives
 * beside that folder. The note's children live inside the folder.
 *
 *   var-log.md                     (a note)
 *   var-log/                       (its children)
 *     Systems & OS.md
 *     Systems & OS/
 *       Linux Kernel.md
 *       Linux Kernel/ ...
 *
 * Each note carries YAML frontmatter:
 *
 *   ---
 *   created: 2019-03-14T23:45:31.550-05:00
 *   modified: 2026-06-05T22:15:20.567-05:00
 *   group: sys
 *   tags:
 *     - systems
 *     - private
 *   ---
 *
 * Any note whose `tags` include `private` is excluded from the build, together
 * with its ENTIRE subtree. Links between notes are written as `[[Note Name]]`
 * wikilinks in the body and resolved to ids here.
 *
 * Usage:  node build-garden-data.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT = path.join(__dirname, 'vault');
const OUT = path.join(__dirname, 'build', 'system', 'garden-data.js');
const BODY_DIR = path.join(__dirname, 'build');

/* ---- recursively collect every .md file under the vault ---- */
function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

/* ---- recursively collect every image file under the vault ---- */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
function walkImages(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walkImages(p, acc);
    else if (IMAGE_RE.test(name)) acc.push(p);
  }
  return acc;
}

/* ---- minimal frontmatter parser (created / modified / group / tags) ---- */
function parseFrontmatter(text) {
  const fm = { tags: [] };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return fm;
  let inTags = false;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      inTags = kv[1] === 'tags';
      if (!inTags && kv[2] !== '') fm[kv[1]] = kv[2].trim();
      continue;
    }
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (inTags && item) fm.tags.push(item[1].trim());
  }
  return fm;
}

/* ---- color theming: convert merge-table cell colors to the site's dark/gold ----
 * theme. Light Atlassian-style pastels (bg) become dark, low-saturation tinted
 * panels; syntax-highlight text colors become brighter so they read on dark.   */
function parseColor(c) {
  if (typeof c !== 'string') return null;
  c = c.trim();
  let m = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (m) return [+m[1], +m[2], +m[3]];
  m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2 = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2(p, q, h + 1 / 3); g = hue2(p, q, h); b = hue2(p, q, h - 1 / 3);
  }
  const hx = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + hx(r) + hx(g) + hx(b);
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function themeBg(c) {
  const rgb = parseColor(c);
  if (!rgb) return c;
  const [h, s] = rgbToHsl(...rgb);
  if (s < 22) return '#241d12';                       // neutral/near-gray header -> warm dark panel
  return hslToHex(h, clamp(s * 0.5, 22, 42), 14);     // pastel -> dark tinted panel
}
function themeText(c) {
  const rgb = parseColor(c);
  if (!rgb) return c;
  const [h, s] = rgbToHsl(...rgb);
  if (s < 12) return '#a9a08d';                        // gray -> muted warm gray
  return hslToHex(h, clamp(s, 50, 85), 70);            // dark accent -> bright readable
}
function convertInlineColors(str) {
  return String(str).replace(
    /(?<![-a-z])color:\s*(rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|#[0-9a-fA-F]{3,6})/gi,
    (m, c) => 'color: ' + themeText(c)
  );
}
function convertTableObj(obj) {
  if (!obj || !Array.isArray(obj.rows)) return;
  for (const row of obj.rows) {
    if (!Array.isArray(row)) continue;
    for (let k = 0; k < row.length; k++) {
      const cell = row[k];
      if (typeof cell === 'string') { row[k] = transformMergeTables(convertInlineColors(cell)); continue; }
      if (cell && typeof cell === 'object') {
        if (typeof cell.bg === 'string') cell.bg = themeBg(cell.bg);
        if (typeof cell.color === 'string') cell.color = themeText(cell.color);
        if (typeof cell.content === 'string') cell.content = transformMergeTables(convertInlineColors(cell.content));
        else if (cell.content && typeof cell.content === 'object') convertTableObj(cell.content);
      }
    }
  }
}
function transformMergeTables(body) {
  const lines = String(body).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*(?:>\s*)*)```merge-table\s*$/);
    if (!m) { out.push(lines[i]); continue; }
    const prefix = m[1];
    const inner = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^(\s*(?:>\s*)*)```\s*$/.test(lines[j])) break;
      inner.push(lines[j]);
    }
    const stripped = inner.map((l) =>
      l.startsWith(prefix) ? l.slice(prefix.length) : l.replace(/^\s*(?:>\s*)*/, '')
    );
    let converted = null;
    try {
      const obj = JSON.parse(stripped.join('\n'));
      convertTableObj(obj);
      converted = JSON.stringify(obj, null, 2);
    } catch (e) { converted = null; }
    out.push(lines[i]);
    if (converted) for (const cl of converted.split('\n')) out.push(prefix + cl);
    else for (const il of inner) out.push(il);
    if (j < lines.length) out.push(lines[j]);
    i = j;
  }
  return out.join('\n');
}

/* ---- key helpers: a node's key is its vault-relative path without `.md`. ----
 * The parent node is the folder that contains it (that folder is itself a note,
 * so its key is the containing directory path).                                */
const toKey = (p) => path.relative(VAULT, p).split(path.sep).join('/').replace(/\.md$/, '');
const titleOf = (key) => key.slice(key.lastIndexOf('/') + 1);
const parentKeyOf = (key) => {
  const i = key.lastIndexOf('/');
  return i < 0 ? null : key.slice(0, i);
};

/* ---- search corpus: markdown -> clean rendered plaintext (strip syntax) ---- */
function stripInline(s) {
  return String(s)
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, a, b) => b || a)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$\$?([^$]*)\$\$?/g, '$1')
    .replace(/^>\s?\[![a-z]+\][-+]?\s*/i, '')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function tableText(obj, acc) {
  if (!obj || !Array.isArray(obj.rows)) return;
  for (const row of obj.rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (typeof cell === 'string') acc.push(stripInline(cell));
      else if (cell && typeof cell === 'object') {
        if (typeof cell.content === 'string') acc.push(stripInline(cell.content));
        else if (cell.content) tableText(cell.content, acc);
      }
    }
  }
}
function stripToText(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*(?:>\s*)*```\s*([\w-]*)\s*$/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const inner = [];
      let j = i + 1;
      for (; j < lines.length; j++) { if (/^\s*(?:>\s*)*```\s*$/.test(lines[j])) break; inner.push(lines[j]); }
      if (lang === 'merge-table') {
        try { const obj = JSON.parse(inner.join('\n').replace(/^\s*(?:>\s*)*/gm, '')); const acc = []; tableText(obj, acc); out.push(acc.join(' ')); } catch (e) {}
      }
      i = j;
      continue;
    }
    const t = stripInline(lines[i]);
    if (t) out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
function extractHeadings(md) {
  return String(md || '').split(/\r?\n/)
    .map((l) => l.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/))
    .filter(Boolean).map((m) => stripInline(m[1])).filter(Boolean);
}

/* ---- read every note ---- */
const recs = {};
for (const file of walk(VAULT)) {
  const text = fs.readFileSync(file, 'utf8');
  const key = toKey(file);
  recs[key] = {
    key,
    parentKey: parentKeyOf(key),
    title: titleOf(key),
    fm: parseFrontmatter(text),
    body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(),
    links: [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()),
  };
}

/* ---- drop `private` notes and everything beneath them ---- */
const isPrivate = (r) => !!r && r.fm.tags.includes('private');
function excluded(key) {
  let r = recs[key], guard = 0;
  while (r && guard++ < 100) {
    if (isPrivate(r)) return true;
    r = r.parentKey ? recs[r.parentKey] : null;
  }
  return false;
}
const survivors = Object.keys(recs).filter((k) => !excluded(k)).sort();

/* ---- assign ids and resolve wikilinks by note title ---- */
// A node's id is a stable, deterministic hash of its note TITLE: the same title
// always yields the same id (so bodies/<id>.js and bodies/<id>/ filenames are
// reproducible across builds and independent of note ordering). SHA-1 truncated
// to 12 hex chars — ample to avoid collisions for a personal vault.
const hashTitle = (title) => crypto.createHash('sha1').update(String(title), 'utf8').digest('hex').slice(0, 12);
const idByKey = {};
const keyById = {};
survivors.forEach((k) => {
  const id = hashTitle(recs[k].title);
  if (keyById[id] && keyById[id] !== k) {
    console.warn(`⚠  Title-hash collision: "${recs[k].title}" (${k}) and "${recs[keyById[id]].title}" (${keyById[id]}) both hash to ${id}. The latter wins; rename one note to disambiguate.`);
  }
  idByKey[k] = id;
  keyById[id] = k;
});
const idByTitle = {};
survivors.forEach((k) => { idByTitle[recs[k].title] = idByKey[k]; });

/* ---- write per-note body files and metadata-only nodes ---- */
if (!fs.existsSync(BODY_DIR)) fs.mkdirSync(BODY_DIR, { recursive: true });
const SYS_DIR = path.join(BODY_DIR, 'system');
if (!fs.existsSync(SYS_DIR)) fs.mkdirSync(SYS_DIR, { recursive: true });
// Clean stale body scripts AND per-note image folders (bodies/<id>/).
for (const f of fs.readdirSync(BODY_DIR)) {
  const p = path.join(BODY_DIR, f);
  if (/\.js$/.test(f)) fs.unlinkSync(p);
  else if (fs.statSync(p).isDirectory() && /^[0-9a-f]{6,}$/.test(f)) fs.rmSync(p, { recursive: true, force: true });
}

/* ---- copy vault images into a flattened bodies/<id>/ folder per note ----
 * An image at vault/<notePath>/<file> belongs to the note whose key is its
 * containing directory (notePath). It is copied to bodies/<id>/<file>, so the
 * app can resolve `![[notePath/file]]` to `bodies/<id>/<file>` regardless of
 * how deep the vault folder structure is.                                     */
let imagesCopied = 0;
for (const img of walkImages(VAULT)) {
  const noteKey = path.relative(VAULT, path.dirname(img)).split(path.sep).join('/');
  const id = idByKey[noteKey];
  if (!id) continue; // image's note is private/excluded or not a note folder
  const destDir = path.join(BODY_DIR, id);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(img, path.join(destDir, path.basename(img)));
  imagesCopied++;
}

const nodes = survivors.map((k) => {
  const r = recs[k];
  const id = idByKey[k];
  const body = transformMergeTables(r.body || '');
  const ref = 'build/' + id + '.js';
  // JSONP-style: registers the body whether or not the callback is ready yet.
  const fileJs = '(function(){var b=' + JSON.stringify(id) + ',m=' + JSON.stringify(body) +
    ';if(window.__kgBody){window.__kgBody(b,m);}else{(window.__kgBodyQ=window.__kgBodyQ||[]).push([b,m]);}})();\n';
  fs.writeFileSync(path.join(__dirname, ref), fileJs);
  return {
    id,
    parent: (r.parentKey && idByKey[r.parentKey]) ? idByKey[r.parentKey] : null,
    title: r.title,
    group: r.fm.group || 'root',
    tags: (r.fm.tags || []).filter((t) => t !== 'private'),
    links: r.links.map((t) => idByTitle[t]).filter((x) => x && x !== id),
    bodyRef: ref,
    created: r.fm.created || '',
    modified: r.fm.modified || '',
  };
});

fs.writeFileSync(OUT, 'window.GARDEN_NODES = ' + JSON.stringify(nodes) + ';\n');

/* ---- build-time search corpus: rendered plaintext + headings per note ---- */
const searchDocs = survivors.map((k) => {
  const r = recs[k];
  return {
    id: idByKey[k],
    title: r.title,
    tags: (r.fm.tags || []).filter((t) => t !== 'private'),
    headings: extractHeadings(r.body || ''),
    text: stripToText(r.body || ''),
  };
});
fs.writeFileSync(path.join(__dirname, 'build', 'system', 'search-data.js'), 'window.GARDEN_SEARCH = ' + JSON.stringify(searchDocs) + ';\n');
console.log(`Wrote search-data.js: ${searchDocs.length} notes indexed.`);

const hidden = Object.keys(recs).length - survivors.length;
console.log(`Built ${path.basename(OUT)}: ${nodes.length} notes kept, ${hidden} hidden by private subtrees.`);
console.log(`Wrote ${nodes.length} body files to bodies/.`);
console.log(`Copied ${imagesCopied} image(s) into bodies/<id>/.`);
