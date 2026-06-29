#!/usr/bin/env node
// scripts/vrt-changeset-gallery.mjs
//
// Per-PR "VRT changeset gallery": render a STATIC HTML page that shows ONLY the
// VRT baseline PNGs this branch changed vs its merge base, each as a
// side-by-side OLD (base) / NEW (this branch) / DIFF triptych.
//
// Why this exists (vs. the existing tools):
//   - e2e/vrt/build_gallery.py (docs/vrt, GitHub Pages) renders ALL ~240
//     baselines — great as a catalog, useless for reviewing a single PR's
//     change set (you can't tell which of the 240 a PR touched, and a PR like
//     the rack-sizing one moves ~165 of them).
//   - The Playwright HTML report only shows expected/actual/diff for tests that
//     FAILED on that run. The moment a PR commits its updated baselines (the
//     normal flow — `vrt-update.yml` commits them onto the branch), the VRT job
//     goes GREEN and the report shows "nothing changed". So the report can't be
//     relied on to review an intentional, already-committed baseline change.
//
// This script is git-diff-driven instead of run-driven, so it works whether or
// not the new baselines are committed:
//   - NEW image = the working-tree file (committed or not).
//   - OLD image = `git show <base>:<path>` (the baseline before this branch).
//   - DIFF      = pixelmatch(old, new) when both decode + sizes match; when the
//                 image is ADDED/DELETED or sizes differ we skip the pixel diff
//                 and label the card accordingly.
//
// LFS-aware: the baseline PNGs are git-LFS-tracked
// (.gitattributes: e2e/vrt/__screenshots__/**/*.png filter=lfs). Both the
// working-tree read AND `git show` must yield REAL png bytes, not the ~130-byte
// pointer file. We detect a pointer file ("version https://git-lfs…") and, for
// the base side, materialize it via `git lfs smudge`. The CI job that runs this
// must `git lfs pull` the baselines first (the workflow does).
//
// Output: a single self-contained directory (default docs/vrt-changeset/) with
// index.html + per-image old/new/diff PNGs, ready to `wrangler pages deploy`.
//
// Deps: sharp (already a repo devDependency — decode→raw RGBA + encode) +
// pixelmatch (added with this change; tiny, the diff kernel). No Pillow/no
// Playwright runtime needed.
//
// Usage:
//   node scripts/vrt-changeset-gallery.mjs                       # base = merge-base(origin/main, HEAD)
//   node scripts/vrt-changeset-gallery.mjs --base origin/main    # explicit base ref
//   node scripts/vrt-changeset-gallery.mjs --out docs/vrt-changeset
//   node scripts/vrt-changeset-gallery.mjs --pr 759 --title "rack sizing"
//   node scripts/vrt-changeset-gallery.mjs --json out.json       # also emit a machine summary

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_GLOB = 'e2e/vrt/__screenshots__';
const LFS_POINTER_MAGIC = 'version https://git-lfs';

// ---- args -----------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    base: null,
    out: 'docs/vrt-changeset',
    pr: process.env.PR_NUMBER || null,
    title: null,
    json: null,
    // --from-results <dir>: build the gallery from a Playwright RUN's output
    // (test-results/**/{*-expected,*-actual,*-diff}.png) instead of git-diff.
    // This is the "fail → see what changed" half: a code change that SHIFTS a
    // render fails the VRT job with the diff in the run output, but commits no
    // PNGs, so the git-diff mode finds nothing. fromResults surfaces it.
    fromResults: null,
    // Platform label for the run-driven cards (the runner's OS). Defaults to the
    // same darwin|linux split vrt.config.ts uses.
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--pr') args.pr = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--from-results') args.fromResults = argv[++i];
    else if (a === '--platform') args.platform = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/vrt-changeset-gallery.mjs [--base <ref>] [--from-results <dir>] [--platform <os>] [--out <dir>] [--pr <n>] [--title <s>] [--json <file>]',
      );
      process.exit(0);
    }
  }
  return args;
}

// ---- git helpers ----------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).trim();
}

// Buffer (binary) variant — for `git show` / `git cat-file` of PNG/pointer blobs.
function gitBuf(args) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${r.stderr ? r.stderr.toString() : r.status}`,
    );
  }
  return r.stdout; // Buffer
}

// Resolve the base commit to diff against. Prefer an explicit --base; else the
// merge-base with origin/main; else origin/main; else main.
function resolveBase(explicit) {
  const tryRefs = [];
  if (explicit) tryRefs.push(explicit);
  tryRefs.push('origin/main', 'main');
  for (const ref of tryRefs) {
    try {
      const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
      // For a branch base, the merge-base is the honest "what did THIS branch
      // change" anchor (avoids flagging baselines that moved on main since we
      // branched). Fall back to the ref itself if merge-base fails.
      try {
        return { ref, sha: git(['merge-base', sha, 'HEAD']) };
      } catch {
        return { ref, sha };
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Could not resolve a base ref (tried --base, origin/main, main). Pass --base.',
  );
}

// Changed baseline PNGs vs base: handles A(dded)/M(odified)/D(eleted)/R(enamed).
function changedBaselines(baseSha) {
  // --diff-filter excludes pure type-changes; -z for NUL-safe paths.
  const out = git([
    'diff',
    '--name-status',
    '-z',
    '--diff-filter=ACMRD',
    baseSha,
    '--',
    `${BASELINE_GLOB}/**/*.png`,
  ]);
  if (!out) return [];
  const tokens = out.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (status.startsWith('R')) {
      // rename: status, old, new
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      entries.push({ status: 'R', oldPath, path: newPath });
    } else {
      const path = tokens[i++];
      const code = status[0];
      const norm = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
      entries.push({ status: norm, oldPath: path, path });
    }
  }
  return entries;
}

// ---- run-driven collection (--from-results) -------------------------------

// Recursively list every file under `dir` (portable; avoids readdir
// {recursive} Dirent.parentPath version differences).
function walk(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Build entries from a Playwright RUN's output dir. On a screenshot mismatch
// Playwright writes, per failed assertion, a sibling triplet next to the test's
// output folder: `<name>-expected.png` (the baseline = OLD), `<name>-actual.png`
// (this run's render = NEW), and `<name>-diff.png` (its own diff, which we
// ignore — we recompute with pixelmatch for a consistent diff + px stats). A
// brand-new/missing baseline yields only `-actual` (status A). Entries carry the
// decoded buffers directly (no git), so the shared render loop treats them
// uniformly with the git-diff entries. `platform` is the runner OS label.
function collectFromResults(dir, platform) {
  const absDir = isAbsolute(dir) ? dir : join(ROOT, dir);
  if (!existsSync(absDir)) {
    console.error(`[vrt-changeset] --from-results dir not found: ${dir}`);
    return [];
  }
  const actuals = walk(absDir).filter((f) => f.endsWith('-actual.png'));
  const entries = [];
  for (const actualPath of actuals) {
    const stem = actualPath.slice(0, -'-actual.png'.length);
    const expectedPath = `${stem}-expected.png`;
    const card = stem.split('/').pop(); // screenshot name, e.g. mixer-cv-sum
    // The test's output folder name encodes spec + test title + project; strip
    // the trailing project tag for a readable spec/test label.
    const folder = dirname(actualPath).split('/').pop() || 'playwright-run';
    const spec = folder.replace(/-(chromium|webkit|firefox)[-\w]*$/i, '');
    const newBuf = readFileSync(actualPath);
    const oldBuf = existsSync(expectedPath) ? readFileSync(expectedPath) : null;
    // Synthetic baseline path so describe() yields spec/platform/card uniformly.
    const synthetic = `${BASELINE_GLOB}/${spec}/${platform}/${card}.png`;
    entries.push({
      status: oldBuf ? 'M' : 'A',
      path: synthetic,
      oldPath: synthetic,
      oldBuf,
      newBuf,
    });
  }
  // Stable order so the gallery is deterministic across runs.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// ---- LFS-aware blob reads -------------------------------------------------

function isPointer(buf) {
  return (
    buf &&
    buf.length < 1024 &&
    buf.subarray(0, LFS_POINTER_MAGIC.length).toString('utf8') === LFS_POINTER_MAGIC
  );
}

// Real PNG bytes for the WORKING-TREE (new) side.
function readWorkingPng(path) {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return null;
  let buf = readFileSync(abs);
  if (isPointer(buf)) {
    // Working tree still holds a pointer (LFS not pulled) — smudge it.
    buf = smudge(buf);
  }
  return buf;
}

// Real PNG bytes for the BASE side via `git show <sha>:<path>`. The blob is an
// LFS pointer in git; smudge it to the real object.
function readBasePng(baseSha, path) {
  let buf;
  try {
    buf = gitBuf(['show', `${baseSha}:${path}`]);
  } catch {
    return null; // didn't exist at base (added file)
  }
  if (isPointer(buf)) buf = smudge(buf);
  return buf;
}

// Run a pointer file through `git lfs smudge` to get the real object bytes.
function smudge(pointerBuf) {
  const r = spawnSync('git', ['lfs', 'smudge'], {
    cwd: ROOT,
    input: pointerBuf,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(
      'git lfs smudge failed (is git-lfs installed + objects pulled?): ' +
        (r.stderr ? r.stderr.toString() : `status ${r.status}`),
    );
  }
  // Guard: if smudge returned a pointer again, the object isn't available.
  if (isPointer(r.stdout)) {
    throw new Error(
      'LFS object not available locally (smudge returned a pointer). Run `git lfs pull --include "' +
        BASELINE_GLOB +
        '/**"` first.',
    );
  }
  return r.stdout;
}

// ---- image decode + diff --------------------------------------------------

async function decodeRGBA(buf) {
  const img = sharp(buf, { unlimited: true }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function encodePngFromRGBA(rgba, width, height) {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

// ---- naming ---------------------------------------------------------------

// Derive a friendly title from a baseline path.
//   e2e/vrt/__screenshots__/vrt.spec.ts/linux/adsr.png
//     spec=vrt.spec.ts platform=linux card=adsr
function describe(path) {
  const rel = path.startsWith(`${BASELINE_GLOB}/`)
    ? path.slice(BASELINE_GLOB.length + 1)
    : path;
  const parts = rel.split('/');
  const file = parts.pop();
  const card = file.replace(/\.png$/i, '');
  const platform = parts.pop() || '?';
  const spec = parts.join('/') || '?';
  return { spec, platform, card };
}

function slugify(path) {
  return path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

// ---- HTML -----------------------------------------------------------------

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function renderHtml({ cards, meta }) {
  const byPlatform = {};
  for (const c of cards) (byPlatform[c.platform] ??= []).push(c);
  const platforms = Object.keys(byPlatform).sort();

  const summaryBits = [
    `<strong>${cards.length}</strong> changed baseline${cards.length === 1 ? '' : 's'}`,
    meta.added ? `${meta.added} added` : null,
    meta.modified ? `${meta.modified} modified` : null,
    meta.deleted ? `${meta.deleted} deleted` : null,
    meta.renamed ? `${meta.renamed} renamed` : null,
  ].filter(Boolean);

  const cardHtml = platforms
    .map((plat) => {
      const items = byPlatform[plat]
        .map((c) => {
          const badge =
            c.status === 'A'
              ? '<span class="badge add">ADDED</span>'
              : c.status === 'D'
                ? '<span class="badge del">DELETED</span>'
                : c.status === 'R'
                  ? '<span class="badge ren">RENAMED</span>'
                  : '<span class="badge mod">MODIFIED</span>';
          const diffNote = c.diffPixels != null
            ? `<span class="diffstat">${c.diffPixels.toLocaleString()} px (${(c.diffRatio * 100).toFixed(2)}%)</span>`
            : `<span class="diffstat na">${esc(c.diffNote || 'no pixel diff')}</span>`;
          const cell = (label, src, cls = '') =>
            src
              ? `<figure class="${cls}"><figcaption>${label}</figcaption><a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(src)}" alt="${esc(label)} ${esc(c.card)}"></a></figure>`
              : `<figure class="${cls} empty"><figcaption>${label}</figcaption><div class="ph">—</div></figure>`;
          return `
        <section class="card" id="${esc(c.id)}">
          <header>
            <h3>${esc(c.card)}</h3>
            ${badge}${diffNote}
            <div class="path">${esc(c.spec)} · ${esc(c.platform)}</div>
          </header>
          <div class="triptych">
            ${cell('OLD (base)', c.oldSrc, 'old')}
            ${cell('NEW (this PR)', c.newSrc, 'new')}
            ${cell('DIFF', c.diffSrc, 'diff')}
          </div>${
            c.oldSrc && c.newSrc
              ? `
          <details class="cmp">
            <summary>↔ slider / onion-skin compare</summary>
            <div class="compare" style="--split:50%">
              <div class="cmp-stage">
                <img class="cmp-old" src="${esc(c.oldSrc)}" alt="old ${esc(c.card)}">
                <img class="cmp-new" src="${esc(c.newSrc)}" alt="new ${esc(c.card)}">
                <div class="cmp-divider"></div>
              </div>
              <div class="cmp-ctl">
                <label>swipe <input type="range" class="cmp-swipe" min="0" max="100" value="50"></label>
                <label>onion <input type="range" class="cmp-onion" min="0" max="100" value="100"></label>
              </div>
            </div>
          </details>`
              : ''
          }
        </section>`;
        })
        .join('\n');
      return `<h2 class="plat">${esc(plat)} <span class="count">(${byPlatform[plat].length})</span></h2>\n${items}`;
    })
    .join('\n');

  const title = meta.pr
    ? `VRT changeset — PR #${esc(meta.pr)}`
    : 'VRT changeset gallery';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#161618; color:#e7e7ea; font:14px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace; }
  header.top { padding:20px 24px; border-bottom:1px solid #2a2a2e; position:sticky; top:0; background:#161618ee; backdrop-filter:blur(6px); z-index:5; }
  header.top h1 { margin:0 0 6px; font-size:18px; letter-spacing:.5px; }
  .meta { color:#9aa0a6; font-size:12.5px; }
  .meta strong { color:#e7e7ea; }
  main { max-width:1500px; margin:0 auto; padding:8px 24px 64px; }
  h2.plat { margin:28px 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:1.5px; color:#8ab4f8; border-bottom:1px solid #2a2a2e; padding-bottom:6px; }
  h2.plat .count { color:#6b7178; }
  .card { background:#1d1d20; border:1px solid #2a2a2e; border-radius:10px; padding:14px 16px; margin:14px 0; }
  .card header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
  .card h3 { margin:0; font-size:15px; }
  .card .path { color:#7a8089; font-size:11.5px; flex-basis:100%; }
  .badge { font-size:10px; font-weight:700; letter-spacing:.5px; padding:2px 7px; border-radius:20px; }
  .badge.mod { background:#3b2f0b; color:#f3c33b; }
  .badge.add { background:#0c3320; color:#56d196; }
  .badge.del { background:#3a1414; color:#f08a8a; }
  .badge.ren { background:#102a3a; color:#6ab7e0; }
  .diffstat { font-size:11.5px; color:#f3c33b; }
  .diffstat.na { color:#7a8089; }
  .triptych { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  figure { margin:0; background:#111114; border:1px solid #2a2a2e; border-radius:8px; padding:8px; }
  figcaption { font-size:10.5px; text-transform:uppercase; letter-spacing:1px; color:#8a9099; margin-bottom:6px; }
  figure img { width:100%; height:auto; display:block; image-rendering:pixelated; background:repeating-conic-gradient(#1a1a1d 0% 25%,#202024 0% 50%) 0/16px 16px; border-radius:4px; }
  figure.diff img { background:#000; }
  figure.empty .ph { display:flex; align-items:center; justify-content:center; min-height:80px; color:#4a4f57; font-size:24px; }
  @media (max-width:900px){ .triptych{ grid-template-columns:1fr; } }
  /* slider / onion-skin compare (OLD under, NEW clipped over) */
  details.cmp { margin-top:12px; }
  details.cmp summary { cursor:pointer; color:#8ab4f8; font-size:11px; text-transform:uppercase; letter-spacing:1px; user-select:none; }
  details.cmp[open] summary { margin-bottom:10px; }
  .compare { max-width:560px; }
  .cmp-stage { position:relative; width:100%; touch-action:none; border:1px solid #2a2a2e; border-radius:6px; overflow:hidden; cursor:ew-resize; background:repeating-conic-gradient(#1a1a1d 0% 25%,#202024 0% 50%) 0/16px 16px; }
  .cmp-stage img { display:block; width:100%; height:auto; image-rendering:pixelated; }
  .cmp-new { position:absolute; inset:0; clip-path:inset(0 calc(100% - var(--split)) 0 0); }
  .cmp-divider { position:absolute; top:0; bottom:0; left:var(--split); width:2px; margin-left:-1px; background:#8ab4f8; box-shadow:0 0 0 1px #000; pointer-events:none; }
  .cmp-ctl { display:flex; gap:20px; margin-top:8px; font-size:11px; color:#9aa0a6; align-items:center; }
  .cmp-ctl input[type=range] { vertical-align:middle; width:120px; }
</style>
</head>
<body>
<header class="top">
  <h1>${title}</h1>
  <div class="meta">${summaryBits.join(' · ')} · base <code>${esc(meta.baseRef)}</code> @ <code>${esc(meta.baseShaShort)}</code> · head <code>${esc(meta.headShaShort)}</code> · generated ${esc(meta.generatedAt)}</div>
</header>
<main>
${cards.length ? cardHtml : '<p style="color:#9aa0a6;padding:40px 0">No VRT baseline changes vs base. (Nothing to review.)</p>'}
</main>
<script>
// Wire each compare widget: range "swipe" + pointer-drag move the clip divider
// (OLD under, NEW clipped over); "onion" sets NEW opacity for an overlay blink.
for (const cmp of document.querySelectorAll('.compare')) {
  const stage = cmp.querySelector('.cmp-stage');
  const neu = cmp.querySelector('.cmp-new');
  const swipe = cmp.querySelector('.cmp-swipe');
  const onion = cmp.querySelector('.cmp-onion');
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const setSplit = (v) => cmp.style.setProperty('--split', clamp(v) + '%');
  if (swipe) swipe.addEventListener('input', () => setSplit(+swipe.value));
  if (onion) onion.addEventListener('input', () => { neu.style.opacity = (+onion.value) / 100; });
  let dragging = false;
  const moveTo = (clientX) => {
    const r = stage.getBoundingClientRect();
    const pct = clamp(((clientX - r.left) / r.width) * 100);
    setSplit(pct);
    if (swipe) swipe.value = String(pct);
  };
  stage.addEventListener('pointerdown', (e) => { dragging = true; try { stage.setPointerCapture(e.pointerId); } catch {} moveTo(e.clientX); });
  stage.addEventListener('pointermove', (e) => { if (dragging) moveTo(e.clientX); });
  stage.addEventListener('pointerup', () => { dragging = false; });
  stage.addEventListener('pointercancel', () => { dragging = false; });
}
</script>
</body>
</html>
`;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let baseRef, baseSha, headSha, entries;
  if (args.fromResults) {
    // Run-driven: diff = expected (OLD) vs actual (NEW) from the Playwright run.
    baseRef = 'playwright-run';
    baseSha = null;
    try {
      headSha = git(['rev-parse', 'HEAD']);
    } catch {
      headSha = 'unknown';
    }
    entries = collectFromResults(args.fromResults, args.platform);
    console.error(
      `[vrt-changeset] from-results=${args.fromResults} platform=${args.platform} — ${entries.length} mismatch(es)`,
    );
  } else {
    // Git-driven: diff = base ref (OLD) vs working tree (NEW).
    ({ ref: baseRef, sha: baseSha } = resolveBase(args.base));
    headSha = git(['rev-parse', 'HEAD']);
    entries = changedBaselines(baseSha);
    console.error(
      `[vrt-changeset] base=${baseRef}@${baseSha.slice(0, 8)} head=${headSha.slice(0, 8)} — ${entries.length} changed baseline(s)`,
    );
  }

  const outDir = isAbsolute(args.out) ? args.out : join(ROOT, args.out);
  const imgDir = join(outDir, 'img');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(imgDir, { recursive: true });

  const cards = [];
  const meta = { added: 0, modified: 0, deleted: 0, renamed: 0 };

  for (const e of entries) {
    if (e.status === 'A') meta.added++;
    else if (e.status === 'D') meta.deleted++;
    else if (e.status === 'R') meta.renamed++;
    else meta.modified++;

    const { spec, platform, card } = describe(e.path);
    const id = slugify(e.path);

    // Run-driven entries carry decoded buffers already; git-driven entries read
    // OLD from the base ref + NEW from the working tree.
    const oldBuf =
      e.oldBuf !== undefined
        ? e.oldBuf
        : e.status === 'A'
          ? null
          : readBasePng(baseSha, e.oldPath || e.path);
    const newBuf =
      e.newBuf !== undefined
        ? e.newBuf
        : e.status === 'D'
          ? null
          : readWorkingPng(e.path);

    let oldSrc = null,
      newSrc = null,
      diffSrc = null,
      diffPixels = null,
      diffRatio = null,
      diffNote = null;

    if (oldBuf) {
      const f = `img/${id}__old.png`;
      writeFileSync(join(outDir, f), oldBuf);
      oldSrc = f;
    }
    if (newBuf) {
      const f = `img/${id}__new.png`;
      writeFileSync(join(outDir, f), newBuf);
      newSrc = f;
    }

    if (oldBuf && newBuf) {
      try {
        const a = await decodeRGBA(oldBuf);
        const b = await decodeRGBA(newBuf);
        if (a.width !== b.width || a.height !== b.height) {
          diffNote = `size ${a.width}×${a.height} → ${b.width}×${b.height}`;
        } else {
          const out = Buffer.alloc(a.width * a.height * 4);
          diffPixels = pixelmatch(a.data, b.data, out, a.width, a.height, {
            threshold: 0.1,
            includeAA: false,
            diffColor: [255, 0, 0],
          });
          diffRatio = diffPixels / (a.width * a.height);
          const png = await encodePngFromRGBA(out, a.width, a.height);
          const f = `img/${id}__diff.png`;
          writeFileSync(join(outDir, f), png);
          diffSrc = f;
        }
      } catch (err) {
        diffNote = `diff failed: ${err.message}`;
      }
    } else if (e.status === 'A') {
      diffNote = 'new baseline (no prior)';
    } else if (e.status === 'D') {
      diffNote = 'baseline removed';
    }

    cards.push({
      id,
      spec,
      platform,
      card,
      status: e.status,
      oldSrc,
      newSrc,
      diffSrc,
      diffPixels,
      diffRatio,
      diffNote,
    });
  }

  // Sort: biggest visual change first within each platform, then by card name.
  cards.sort(
    (x, y) =>
      (y.diffRatio ?? -1) - (x.diffRatio ?? -1) || x.card.localeCompare(y.card),
  );

  const html = renderHtml({
    cards,
    meta: {
      ...meta,
      pr: args.pr,
      baseRef,
      baseShaShort: baseSha ? baseSha.slice(0, 8) : '—',
      headShaShort: headSha ? headSha.slice(0, 8) : '—',
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z',
    },
  });
  writeFileSync(join(outDir, 'index.html'), html);

  const summary = {
    base: { ref: baseRef, sha: baseSha },
    head: headSha,
    count: cards.length,
    ...meta,
    outDir: relative(ROOT, outDir),
    cards: cards.map((c) => ({
      path: `${BASELINE_GLOB}/${c.spec}/${c.platform}/${c.card}.png`,
      status: c.status,
      diffPixels: c.diffPixels,
      diffRatio: c.diffRatio,
    })),
  };
  if (args.json) {
    const jsonPath = isAbsolute(args.json) ? args.json : join(ROOT, args.json);
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  }

  console.error(
    `[vrt-changeset] wrote ${cards.length} card(s) → ${relative(ROOT, outDir)}/index.html` +
      ` (added ${meta.added}, modified ${meta.modified}, deleted ${meta.deleted}, renamed ${meta.renamed})`,
  );
  // stdout = the count, for shell capture in CI ("0" → skip deploy/comment).
  process.stdout.write(String(cards.length));
}

main().catch((err) => {
  console.error('[vrt-changeset] ERROR:', err.stack || err.message);
  process.exit(1);
});
