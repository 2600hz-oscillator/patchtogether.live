#!/usr/bin/env node
// scripts/build-test-reconciliation-page.mjs
//
// Renders the static "Test Reconciliation" page published to GitHub Pages
// alongside the VRT gallery (docs/test-reconciliation/index.html). It:
//
//   1. reads the committed dated history (docs/test-reconciliation/changelog.json)
//   2. computes a FRESH "live" snapshot from the current working tree via
//      reconcile() (scripts/test-reconciliation.mjs) so the latest row is
//      honest at deploy time — the counts can't silently rot
//   3. emits a single static HTML page styled to match the gallery: a trend
//      table per dated entry + the live snapshot + a header explaining the goal
//      (watch the disabled count fall over time)
//
// The page generation uses a build-time timestamp for the "generated at" strip
// (cosmetic, not on a determinism-critical path). The committed historical
// entries are the source of truth for the trend; the live row is recomputed.
//
// Usage:
//   node scripts/build-test-reconciliation-page.mjs                # default out dir
//   node scripts/build-test-reconciliation-page.mjs --out docs/test-reconciliation
//   node scripts/build-test-reconciliation-page.mjs --no-live      # history only (offline)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reconcile } from './test-reconciliation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_DIR = arg('--out', join(ROOT, 'docs', 'test-reconciliation'));
const NO_LIVE = process.argv.includes('--no-live');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pct(disabled, total) {
  if (!total) return '0.0';
  return ((disabled / total) * 100).toFixed(1);
}

function repoShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Render one block table (rows = blocks). `liveByBlock` (optional) lets us
 *  annotate each row with a delta vs the live snapshot. */
function renderTable(blocks) {
  const rows = blocks
    .map((b) => {
      const p = pct(b.disabled, b.total);
      const hot = b.disabled > 0 ? ' class="has-disabled"' : '';
      return `      <tr${hot}>
        <td class="block">${esc(b.block)}</td>
        <td class="kind">${esc(b.kind)}</td>
        <td class="num">${b.total}</td>
        <td class="num">${b.disabled}</td>
        <td class="num">${p}%</td>
      </tr>`;
    })
    .join('\n');
  return `    <table class="recon">
      <thead><tr><th>block</th><th>kind</th><th>total</th><th>disabled</th><th>%disabled</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
}

function renderEntry(entry, isLive) {
  const heading = isLive
    ? `${esc(entry.date)} <span class="live-tag">LIVE (recomputed at deploy)</span>`
    : esc(entry.date);
  const note = entry.note ? `<p class="entry-note">${esc(entry.note)}</p>` : '';
  return `  <section class="entry${isLive ? ' entry-live' : ''}">
    <h3>${heading}</h3>
    ${note}
${renderTable(entry.blocks)}
  </section>`;
}

function renderAlerts(alerts) {
  if (!alerts || alerts.length === 0) {
    return `  <p class="ok">No focused (<code>.only</code>) tests — good (<code>forbidOnly: true</code> would hard-fail CI).</p>`;
  }
  const items = alerts.map((a) => `<li><code>${esc(a)}</code></li>`).join('\n      ');
  return `  <div class="alert">
    <strong>ALERT — ${alerts.length} focused test(s) (<code>.only</code>):</strong>
    <code>forbidOnly: true</code> hard-fails CI. Un-focus these:
    <ul>
      ${items}
    </ul>
  </div>`;
}

function main() {
  const changelogPath = join(OUT_DIR, 'changelog.json');
  if (!existsSync(changelogPath)) {
    console.error(`build-test-reconciliation-page: missing ${changelogPath}`);
    process.exit(1);
  }
  const history = JSON.parse(readFileSync(changelogPath, 'utf8'));
  const entries = Array.isArray(history.entries) ? history.entries.slice() : [];

  // Newest first for display.
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  let live = null;
  let alerts = [];
  let manifestWarn = '';
  if (!NO_LIVE) {
    const r = reconcile();
    live = {
      date: history.entries.length ? history.entries[history.entries.length - 1].date : 'now',
      blocks: r.blocks.map((b) => ({ block: b.block, kind: b.kind, total: b.total, disabled: b.disabled })),
    };
    // Use the latest committed date for the live row label only if it differs;
    // otherwise mark it explicitly as a recompute of the current tree.
    live.date = 'current tree';
    alerts = r.alerts;
    if (!r.manifestPresent) {
      manifestWarn =
        '<p class="warn">Registry manifest absent at build time — parametrized (vrt/behavioral) live counts are 0. Run <code>task test:emit-manifest</code> before the page build.</p>';
    }
  }

  const liveHtml = live ? renderEntry(live, true) : '';
  const historyHtml = entries.map((e) => renderEntry(e, false)).join('\n');
  const sha = repoShortSha();
  const builtAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>patchtogether.live — Test Reconciliation</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #1a1a1a; color: #e0e0e0; font-family: 'Courier New', monospace; }
    .banner { display: block; width: 100%; height: auto; }
    .banner-header { margin-bottom: 1.5rem; }
    .banner-footer { margin-top: 2rem; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 20px 40px; }
    h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: 2px; }
    .subtitle { color: #9aa; margin: 0 0 1.25rem; }
    a { color: #66bbff; }
    .nav { margin: 0 0 1.5rem; }
    .lead { background: #222; border-left: 3px solid #66bbff; padding: .9rem 1.1rem; border-radius: 4px; line-height: 1.5; }
    .lead code { color: #ffd479; }
    .legend { font-size: .85rem; color: #aab; margin: 1rem 0 2rem; line-height: 1.5; }
    .legend b { color: #cde; }
    .commit-strip { color: #778; font-size: .8rem; margin: 0 0 1.5rem; }
    section.entry { margin: 0 0 2.25rem; }
    section.entry h3 { font-size: 1.15rem; border-bottom: 1px solid #333; padding-bottom: .35rem; }
    .live-tag { font-size: .7rem; color: #1a1a1a; background: #6c6; padding: 2px 7px; border-radius: 3px; vertical-align: middle; }
    .entry-live { background: #1e241e; border: 1px solid #2c402c; border-radius: 6px; padding: .5rem 1rem 1rem; }
    .entry-note { color: #9aa; font-size: .9rem; margin: .25rem 0 .75rem; }
    table.recon { border-collapse: collapse; width: 100%; font-size: .92rem; }
    table.recon th, table.recon td { text-align: left; padding: .4rem .7rem; border-bottom: 1px solid #2a2a2a; }
    table.recon th { color: #9cf; font-weight: normal; border-bottom: 1px solid #444; }
    table.recon td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.recon td.block { color: #ffd479; }
    table.recon td.kind { color: #889; font-size: .82rem; }
    tr.has-disabled td.num:nth-child(4) { color: #f88; font-weight: bold; }
    .ok { color: #8d8; }
    .alert { background: #2a1818; border-left: 3px solid #f55; padding: .9rem 1.1rem; border-radius: 4px; }
    .warn { color: #ec8; }
    footer { margin-top: 2.5rem; color: #778; font-size: .85rem; border-top: 1px solid #333; padding-top: 1rem; }
  </style>
</head>
<body>
  <img class="banner banner-header" src="../assets/header.png" alt="patchtogether.live header banner">
  <div class="container">
    <h1>TEST RECONCILIATION</h1>
    <p class="subtitle">Per-block total / disabled test counts — watch the disabled count fall over time</p>
    <nav class="nav"><a href="../vrt/">&laquo; VRT gallery</a> &middot; <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a></nav>
    <div class="lead">
      The goal of this report is simple: <b>drive the disabled test count down.</b>
      Each dated entry is a snapshot of how many tests exist per block and how
      many are turned off; the <em>trend</em> across entries is the signal. The
      <span class="live-tag">LIVE</span> row at the top is recomputed from the
      current tree at deploy time, so it never silently rots.
    </div>
    <p class="legend">
      <b>Disabled</b> = a static, declaration-level disable
      (<code>test.skip('name', …)</code>, <code>test.fixme('name', …)</code>,
      <code>describe.skip</code>, <code>test.todo</code>) — the actionable backlog.
      In-body <b>runtime guards</b> (<code>test.skip(cond, 'reason')</code>) are
      environment gates (DB/WAD/ROM/relay present?), <b>not</b> disabled.
      Loop-generated <code>test.fixme</code> placeholders from the registry sweeps
      are counted in the <b>parametrized</b> blocks (vrt/behavioral), not the raw
      e2e block. <code>.only</code> is an <b>alert</b> — it hard-fails CI.
      Parametrized blocks count <b>enrolled units</b> (registry modules minus
      exemptions), not raw <code>test()</code> calls.
    </p>
    <p class="commit-strip">commit <code>${esc(sha)}</code> &middot; page built ${esc(builtAt)}</p>
    ${manifestWarn}
    <h2>Alerts</h2>
${renderAlerts(alerts)}
    <h2>Snapshots</h2>
${liveHtml}
${historyHtml}
    <footer>
      <p><a href="../">&laquo; back</a> &middot; source: <code>scripts/test-reconciliation.mjs</code> +
      <code>docs/test-reconciliation/changelog.json</code> &middot;
      reproduce: <code>flox activate -- task test:recon</code></p>
    </footer>
  </div>
  <img class="banner banner-footer" src="../assets/footer.png" alt="patchtogether.live footer banner" loading="lazy">
</body>
</html>
`;

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, 'index.html');
  writeFileSync(outPath, html);
  const liveDisabled = live ? live.blocks.reduce((s, b) => s + b.disabled, 0) : '—';
  console.log(
    `  wrote ${outPath} (history entries=${entries.length}, live=${live ? 'yes' : 'no'}, live disabled total=${liveDisabled}, alerts=${alerts.length})`,
  );
}

main();
