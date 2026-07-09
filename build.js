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
 * beside that folder. The note's children live inside the folder. Both halves
 * are optional:
 *   - a `.md` file with NO matching folder is simply a leaf note;
 *   - a folder with NO matching `.md` gets a synthesized note whose body is a
 *     rendered list of all the children underneath it.
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

/* ---- recursively collect every directory under the vault ---- */
function walkDirs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { acc.push(p); walkDirs(p, acc); }
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

/* ---- synthesize notes for directories that have no matching .md ----
 * A folder like `vault/a/b/` normally pairs with `vault/a/b.md`. When that
 * note is missing, the folder still defines a place in the hierarchy, so we
 * create a virtual note for it. Its body is a rendered list of the direct
 * children beneath it (as wikilinks, so they resolve + navigate normally). */
const dirKeys = walkDirs(VAULT).map((p) => path.relative(VAULT, p).split(path.sep).join('/'));
for (const dk of dirKeys) {
  if (recs[dk]) continue;   // folder has its .md twin — nothing to do
  recs[dk] = {
    key: dk,
    parentKey: parentKeyOf(dk),
    title: titleOf(dk),
    fm: { tags: [] },
    body: '',        // filled below, once every rec (incl. nested synthesized dirs) exists
    links: [],
    synthetic: true,
  };
}
/* ---- multiple top-level entries: tie them under one custom root ----
 * The garden expects a single root. When several .md files and/or folders sit
 * directly inside vault/ (top-level recs with no parent), synthesize a root
 * node (named after config.yml's `title`, falling back to "vault") and
 * re-parent every top-level entry beneath it. Like other synthesized notes,
 * its body becomes a rendered list of its children (filled below).          */
const topKeys = Object.keys(recs).filter((k) => recs[k].parentKey === null);
if (topKeys.length > 1) {
  let rootTitle = 'vault';
  try {
    const cfgPath = path.join(__dirname, 'config.yml');
    if (fs.existsSync(cfgPath)) {
      const cfg = parseYaml(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.title) rootTitle = String(cfg.title);
    }
  } catch (e) {}
  const ROOT_KEY = '__vault_root__';   // not a real path, so it can never collide with a note key
  recs[ROOT_KEY] = {
    key: ROOT_KEY,
    parentKey: null,
    title: rootTitle,
    fm: { tags: [] },
    body: '',
    links: [],
    synthetic: true,
  };
  topKeys.forEach((k) => { recs[k].parentKey = ROOT_KEY; });
  console.log(`Multiple top-level entries (${topKeys.length}) — created custom root "${rootTitle}".`);
}

// Fill the synthesized bodies now that the full tree is known.
for (const k of Object.keys(recs)) {
  const r = recs[k];
  if (!r.synthetic) continue;
  const children = Object.values(recs)
    .filter((c) => c.parentKey === k)
    .map((c) => c.title)
    .sort((a, b) => a.localeCompare(b));
  r.body = children.length
    ? children.map((t) => '- [[' + t + ']]').join('\n')
    : '*This section is empty.*';
  r.links = children.slice();
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

const staticFlag = staticBanner();   // runs the layout FIRST so x/y are baked into the JSON below
fs.writeFileSync(OUT, 'window.GARDEN_NODES = ' + JSON.stringify(nodes) + ';\n' + staticFlag);

/* ──── optional precomputed static layout (config.yml → layout.precompute) ────
 * Runs the same force simulation the browser would (charge −55, link distance
 * 34, velocity decay 0.4, centering) once at build time, over the FULL graph
 * (tree edges + wikilinks), and bakes x/y into each node. The app detects
 * window.GARDEN_STATIC and skips the live simulation entirely. Every node —
 * expanded or collapsed — has a permanent home, so expand/collapse stays fully
 * enabled and simply reveals nodes in place. */
function staticBanner() {
  let cfg = {};
  try { cfg = parseYaml(fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8')); } catch (e) {}
  const lay = cfg.layout || {};
  const on = String(lay.precompute) === 'true';
  if (!on) return '';
  const iterations = Math.max(50, parseInt(lay.iterations, 10) || 300);
  const t0 = Date.now();
  computeStaticLayout(nodes, iterations);
  console.log(`Precomputed static layout: ${nodes.length} nodes, ${iterations} ticks in ${Date.now() - t0}ms.`);
  return 'window.GARDEN_STATIC = true;\n';
}

function computeStaticLayout(ns, ticks) {
  const byId = {}; ns.forEach((n) => { byId[n.id] = n; });
  // Same edge set the app renders: child→parent tree links + resolved wikilinks.
  const links = [];
  ns.forEach((n) => {
    if (n.parent != null && byId[n.parent]) links.push([n.id, n.parent]);
    (n.links || []).forEach((t) => { if (byId[t]) links.push([n.id, t]); });
  });
  // Degree counts (d3's default link strength = 1 / min(deg(a), deg(b))).
  const deg = {}; links.forEach(([a, b]) => { deg[a] = (deg[a] || 0) + 1; deg[b] = (deg[b] || 0) + 1; });
  // Phyllotaxis initial placement (d3's default).
  ns.forEach((n, i) => { const r = 12 * Math.sqrt(0.5 + i), a = i * 2.3999632297286533; n.x = r * Math.cos(a); n.y = r * Math.sin(a); n.vx = 0; n.vy = 0; });
  const CHARGE = -55, LINK_DIST = 34, VDECAY = 0.6;   // v *= 0.6 ≡ d3VelocityDecay(0.4)
  let alpha = 1;
  const alphaDecay = 1 - Math.pow(0.001, 1 / ticks);
  for (let t = 0; t < ticks; t++) {
    alpha += (0 - alpha) * alphaDecay;
    // --- charge via Barnes-Hut quadtree (theta = 0.81) ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ns.forEach((n) => { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; });
    const size = Math.max(maxX - minX, maxY - minY) || 1;
    const root = { x0: minX, y0: minY, s: size, mass: 0, cx: 0, cy: 0, node: null, kids: null };
    const insert = (q, n) => {
      while (true) {
        q.mass++; q.cx += (n.x - q.cx) / q.mass; q.cy += (n.y - q.cy) / q.mass;
        if (q.node === null && q.kids === null) { q.node = n; return; }
        if (q.kids === null) {
          const prev = q.node; q.node = null; q.kids = [null, null, null, null];
          const place = (m) => {
            const h = q.s / 2, ix = m.x >= q.x0 + h ? 1 : 0, iy = m.y >= q.y0 + h ? 1 : 0, k = iy * 2 + ix;
            if (!q.kids[k]) q.kids[k] = { x0: q.x0 + ix * h, y0: q.y0 + iy * h, s: h, mass: 0, cx: 0, cy: 0, node: null, kids: null };
            return q.kids[k];
          };
          if (q.s < 1e-6) { q.node = prev; return; }   // coincident points — stop subdividing
          const qp = place(prev); qp.mass++; qp.cx = prev.x; qp.cy = prev.y; qp.node = prev;
          q = place(n); continue;
        }
        const h = q.s / 2, ix = n.x >= q.x0 + h ? 1 : 0, iy = n.y >= q.y0 + h ? 1 : 0, k = iy * 2 + ix;
        if (!q.kids[k]) q.kids[k] = { x0: q.x0 + ix * h, y0: q.y0 + iy * h, s: h, mass: 0, cx: 0, cy: 0, node: null, kids: null };
        q = q.kids[k];
      }
    };
    ns.forEach((n) => insert(root, n));
    const applyCharge = (n) => {
      const stack = [root];
      while (stack.length) {
        const q = stack.pop();
        if (!q || q.mass === 0) continue;
        let dx = q.cx - n.x, dy = q.cy - n.y;
        let d2 = dx * dx + dy * dy;
        if (q.kids && (q.s * q.s) / d2 < 0.81) {
          if (d2 < 1e-4) continue;
          const w = CHARGE * q.mass * alpha / d2;
          n.vx += dx * w; n.vy += dy * w;
        } else if (q.kids) {
          stack.push(q.kids[0], q.kids[1], q.kids[2], q.kids[3]);
        } else if (q.node && q.node !== n) {
          if (d2 < 1e-4) { dx = (Math.random() - 0.5) * 1e-2; dy = (Math.random() - 0.5) * 1e-2; d2 = dx * dx + dy * dy; }
          const w = CHARGE * alpha / d2;
          n.vx += dx * w; n.vy += dy * w;
        }
      }
    };
    ns.forEach(applyCharge);
    // --- link springs (d3 defaults: strength 1/min(deg), bias by degree) ---
    links.forEach(([ai, bi]) => {
      const a = byId[ai], b = byId[bi];
      let dx = (b.x + b.vx) - (a.x + a.vx), dy = (b.y + b.vy) - (a.y + a.vy);
      let l = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const strength = 1 / Math.min(deg[ai] || 1, deg[bi] || 1);
      const k = (l - LINK_DIST) / l * alpha * strength;
      const bias = (deg[ai] || 1) / (((deg[ai] || 1)) + ((deg[bi] || 1)));
      b.vx -= dx * k * bias; b.vy -= dy * k * bias;
      a.vx += dx * k * (1 - bias); a.vy += dy * k * (1 - bias);
    });
    // --- centering (translate mean to 0,0) + integrate ---
    let mx = 0, my = 0;
    ns.forEach((n) => { mx += n.x; my += n.y; });
    mx /= ns.length; my /= ns.length;
    ns.forEach((n) => {
      n.x -= mx; n.y -= my;
      n.vx *= VDECAY; n.vy *= VDECAY;
      n.x += n.vx; n.y += n.vy;
    });
  }
  ns.forEach((n) => { n.x = Math.round(n.x * 10) / 10; n.y = Math.round(n.y * 10) / 10; delete n.vx; delete n.vy; });
}

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

/* ─────────────────────────────────────────────────────────────────────────────
 *  Inject config.yml into index.html
 *  ---------------------------------
 *  Reads config.yml (the only file holding personal values) and bakes those
 *  values into index.html between marker comments, so the published page ships
 *  with real literals (fast paint, no runtime config fetch). Re-runnable: each
 *  run replaces the marked regions in place.
 * ───────────────────────────────────────────────────────────────────────── */

/* ---- minimal YAML reader: scalars, booleans, and one level of nested maps ---- */
function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // strip trailing inline comment on unquoted values
    if (val && !/^["']/.test(val)) val = val.replace(/\s+#.*$/, '').trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = parseScalar(val);
    }
  }
  return root;
}
function parseScalar(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/* ---- escapers ---- */
const htmlEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jsStr = (s) => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";

function injectConfig() {
  const CFG_PATH = path.join(__dirname, 'config.yml');
  const HTML_PATH = path.join(__dirname, 'index.html');
  if (!fs.existsSync(CFG_PATH)) { console.log('No config.yml — skipping config injection.'); return; }
  const cfg = parseYaml(fs.readFileSync(CFG_PATH, 'utf8'));
  const sig = cfg.signature || {};
  const g = cfg.giscus || {};
  const ogMeta = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="' + htmlEsc(cfg.title) + '">',
    '<meta property="og:title" content="' + htmlEsc(cfg.title) + '">',
    '<meta property="og:description" content="' + htmlEsc(cfg.subtitle) + '">',
    (cfg.site_url ? '<meta property="og:url" content="' + htmlEsc(cfg.site_url) + '">' : ''),
    '<meta name="twitter:card" content="summary">',
    '<meta name="twitter:title" content="' + htmlEsc(cfg.title) + '">',
    '<meta name="twitter:description" content="' + htmlEsc(cfg.subtitle) + '">',
  ].filter(Boolean).join('\n');

  const giscusObj =
    '{\n' +
    '    enabled: ' + (g.enabled === false ? 'false' : 'true') + ',\n' +
    '    repo: ' + jsStr(g.repo || '') + ',\n' +
    '    repoId: ' + jsStr(g.repo_id || '') + ',\n' +
    '    category: ' + jsStr(g.category || '') + ',\n' +
    '    categoryId: ' + jsStr(g.category_id || '') + ',\n' +
    '    theme: ' + jsStr(g.theme || 'transparent_dark') + ',\n' +
    '  }';

  // key -> replacement string for the region between markers
  const repl = {
    title: { type: 'html', val: '<title>' + htmlEsc(cfg.title) + '</title>' },
    og: { type: 'html', val: ogMeta },
    brand: { type: 'html', val: htmlEsc(cfg.brand) },
    subtitle: { type: 'html', val: htmlEsc(cfg.subtitle) },
    sig_text: { type: 'html', val: htmlEsc(sig.text) },
    sig_url: { type: 'html', val: htmlEsc(sig.url) },
    site_url: { type: 'js', val: jsStr(cfg.site_url || '') },
    trigger: { type: 'js', val: jsStr(sig.trigger || '') },
    giscus: { type: 'js', val: giscusObj },
  };

  let html = fs.readFileSync(HTML_PATH, 'utf8');
  const missing = [];
  for (const [key, { type, val }] of Object.entries(repl)) {
    const re = type === 'html'
      ? new RegExp('(<!--KG:' + key + '-->)[\\s\\S]*?(<!--/KG:' + key + '-->)')
      : new RegExp('(/\\*KG:' + key + '\\*/)[\\s\\S]*?(/\\*/KG:' + key + '\\*/)');
    if (!re.test(html)) { missing.push(key); continue; }
    html = html.replace(re, (mm, open, close) => open + val + close);
  }
  fs.writeFileSync(HTML_PATH, html);
  console.log(`Injected config.yml into index.html (${Object.keys(repl).length - missing.length}/${Object.keys(repl).length} markers).`);
  if (missing.length) console.warn('⚠  Markers not found for: ' + missing.join(', '));
}

injectConfig();

/* ─────────────────────────────────────────────────────────────────────────────
 *  SEO: per-note Open-Graph share pages + sitemap.xml + rss.xml
 *  Each note gets share/<slug>.html carrying OG/Twitter meta and an instant
 *  redirect into the app (#node=Title), so shared links preview correctly while
 *  still opening the live graph. sitemap.xml / rss.xml index those share pages.
 * ───────────────────────────────────────────────────────────────────────── */
function generateSeo() {
  const cfg = fs.existsSync(path.join(__dirname, 'config.yml')) ? parseYaml(fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8')) : {};
  const base = String(cfg.site_url || '').replace(/\/+$/, '');
  const siteTitle = cfg.title || 'Knowledge Garden';
  const SHARE_DIR = path.join(__dirname, 'share');
  fs.mkdirSync(SHARE_DIR, { recursive: true });
  const slugify = (s) => (String(s || '').toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'note');
  const seen = {};
  const pages = survivors.map((k) => {
    const r = recs[k];
    let slug = slugify(r.title);
    if (seen[slug]) slug = slug + '-' + String(idByKey[k] || '').slice(0, 6);
    seen[slug] = true;
    const desc = (stripToText(r.body || '').slice(0, 155) || siteTitle).replace(/\s+/g, ' ').trim();
    const appRel = '../index.html#node=' + encodeURIComponent(r.title);
    const appAbs = base ? (base + '/#node=' + encodeURIComponent(r.title)) : appRel;
    const shareAbs = base ? (base + '/share/' + slug + '.html') : ('share/' + slug + '.html');
    return { title: r.title, slug, desc, modified: r.fm.modified || r.fm.created || '', appRel, appAbs, shareAbs };
  });
  pages.forEach((p) => {
    const h = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + htmlEsc(p.title) + ' \u00b7 ' + htmlEsc(siteTitle) + '</title>\n'
      + '<meta name="description" content="' + htmlEsc(p.desc) + '">\n'
      + '<link rel="canonical" href="' + htmlEsc(p.appAbs) + '">\n'
      + '<meta property="og:type" content="article">\n'
      + '<meta property="og:site_name" content="' + htmlEsc(siteTitle) + '">\n'
      + '<meta property="og:title" content="' + htmlEsc(p.title) + '">\n'
      + '<meta property="og:description" content="' + htmlEsc(p.desc) + '">\n'
      + '<meta property="og:url" content="' + htmlEsc(p.shareAbs) + '">\n'
      + '<meta name="twitter:card" content="summary">\n'
      + '<meta name="twitter:title" content="' + htmlEsc(p.title) + '">\n'
      + '<meta name="twitter:description" content="' + htmlEsc(p.desc) + '">\n'
      + '<meta http-equiv="refresh" content="0; url=' + htmlEsc(p.appRel) + '">\n'
      + '<script>location.replace(' + jsStr(p.appRel) + ');</script>\n'
      + '</head>\n<body style="font-family:system-ui,sans-serif;background:#0f0c09;color:#ece1cf;padding:40px;">\n'
      + 'Redirecting to <a style="color:#d8a942" href="' + htmlEsc(p.appRel) + '">' + htmlEsc(p.title) + '</a>\u2026\n'
      + '</body>\n</html>\n';
    fs.writeFileSync(path.join(SHARE_DIR, p.slug + '.html'), h);
  });
  console.log('Wrote ' + pages.length + ' OG share page(s) to share/.');
  if (!base) { console.warn('\u26a0  site_url is blank \u2014 skipping sitemap.xml / rss.xml (need an absolute base URL).'); return; }
  const isoDate = (d) => { const t = Date.parse(d); return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
  const sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  sm.push('  <url><loc>' + htmlEsc(base + '/') + '</loc></url>');
  pages.forEach((p) => { const lm = isoDate(p.modified); sm.push('  <url><loc>' + htmlEsc(p.shareAbs) + '</loc>' + (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '</url>'); });
  sm.push('</urlset>\n');
  fs.writeFileSync(path.join(__dirname, 'sitemap.xml'), sm.join('\n'));
  const recent = pages.filter((p) => !isNaN(Date.parse(p.modified))).sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).slice(0, 40);
  const rfc = (d) => { const t = Date.parse(d); return isNaN(t) ? '' : new Date(t).toUTCString(); };
  const rss = ['<?xml version="1.0" encoding="UTF-8"?>', '<rss version="2.0"><channel>',
    '<title>' + htmlEsc(siteTitle) + '</title>', '<link>' + htmlEsc(base + '/') + '</link>',
    '<description>' + htmlEsc(cfg.subtitle || siteTitle) + '</description>'];
  recent.forEach((p) => { rss.push('<item><title>' + htmlEsc(p.title) + '</title><link>' + htmlEsc(p.shareAbs) + '</link><guid isPermaLink="true">' + htmlEsc(p.shareAbs) + '</guid>' + (rfc(p.modified) ? '<pubDate>' + rfc(p.modified) + '</pubDate>' : '') + '<description>' + htmlEsc(p.desc) + '</description></item>'); });
  rss.push('</channel></rss>\n');
  fs.writeFileSync(path.join(__dirname, 'rss.xml'), rss.join('\n'));
  console.log('Wrote sitemap.xml (' + (pages.length + 1) + ' urls) and rss.xml (' + recent.length + ' items).');
}
generateSeo();
