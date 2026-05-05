// e2e/tests/ai-debug.spec.ts
//
// AI-friendly diagnostic. Designed for the AI agent to run via `task ai:debug`
// when something is broken and structured info is needed. Boots the page,
// clicks Spawn demo, dumps a structured snapshot to stdout that the agent can
// grep for what went wrong.
//
// Output sections (printed to stdout):
//   [SHELL]   — page rendered without errors? title? COOP/COEP?
//   [DOM]     — what's actually in the canvas DOM after spawn?
//   [CONSOLE] — every console message + page error captured.
//   [STATE]   — AudioContext state, node count from status bar.
//   [SCREENSHOT] — path to a PNG snapshot.
//   [VERDICT] — one-line summary.

import { test } from '@playwright/test';
import { captureConsole, formatConsole } from './helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ART_DIR = './test-results/ai-debug';

function section(title: string, body: string) {
  console.log(`\n[${title}]`);
  console.log(body);
}

test('AI debug snapshot — Spawn demo flow', async ({ page }) => {
  await mkdir(ART_DIR, { recursive: true });
  const cc = captureConsole(page);

  // ---------- SHELL ----------
  let response;
  try {
    response = await page.goto('/');
  } catch (err) {
    section('SHELL', `goto failed: ${err}`);
    section('VERDICT', 'fail — page never loaded');
    return;
  }
  const status = response?.status();
  const headers = response?.headers() ?? {};
  section(
    'SHELL',
    [
      `http_status=${status}`,
      `coop=${headers['cross-origin-opener-policy'] ?? 'MISSING'}`,
      `coep=${headers['cross-origin-embedder-policy'] ?? 'MISSING'}`,
      `title=${await page.title()}`,
    ].join('\n')
  );

  await page.waitForLoadState('networkidle');

  // ---------- DOM (pre-click) ----------
  const preDom = await page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent ?? null,
    spawnBtn: Array.from(document.querySelectorAll('button')).some(
      (b) => b.textContent?.trim() === 'Spawn demo'
    ),
    allButtons: Array.from(document.querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').trim().slice(0, 40)
    ),
    canvasContainer: !!document.querySelector('.svelte-flow') ||
                     !!document.querySelector('[class*="flow"]'),
    flowNodeCount: document.querySelectorAll('.svelte-flow__node').length,
    bodyLen: document.body.innerHTML.length,
  }));
  section('DOM (pre-click)', JSON.stringify(preDom, null, 2));

  // ---------- Click Spawn demo ----------
  let clickError: string | null = null;
  try {
    await page.getByRole('button', { name: 'Spawn demo' }).click({ timeout: 5000 });
  } catch (err) {
    clickError = String(err);
  }

  // Wait for any work to finish
  await page.waitForTimeout(3000);

  // ---------- DOM (post-click) ----------
  const postDom = await page.evaluate(() => ({
    flowNodeCount: document.querySelectorAll('.svelte-flow__node').length,
    flowNodeIds: Array.from(document.querySelectorAll('.svelte-flow__node')).map(
      (n) => n.getAttribute('data-id') ?? '?'
    ),
    flowNodeTypes: Array.from(document.querySelectorAll('.svelte-flow__node')).map(
      (n) => n.getAttribute('data-node-type') ?? n.className
    ),
    flowEdgeCount: document.querySelectorAll('.svelte-flow__edge').length,
    visibleHandles: document.querySelectorAll('.svelte-flow__handle').length,
    statusBarText: document.querySelector('.bottombar')?.textContent ?? null,
    traceEntries: Array.from(document.querySelectorAll('.log-line')).map(
      (e) => e.textContent ?? ''
    ),
  }));
  section('DOM (post-click)', JSON.stringify(postDom, null, 2));
  if (clickError) section('CLICK ERROR', clickError);

  // ---------- STATE ----------
  const state = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    audioContextStateFromDom:
      document.querySelector('.bottombar')?.textContent?.match(/ctx\s*(\w+)/)?.[1] ?? null,
  }));
  section('STATE', JSON.stringify(state, null, 2));

  // ---------- CONSOLE ----------
  section('CONSOLE', formatConsole(cc, { maxLines: 50 }) || '(no relevant messages)');

  // ---------- SCREENSHOT ----------
  const screenshot = join(ART_DIR, 'spawn-demo.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  section('SCREENSHOT', screenshot);

  // ---------- DOM SNAPSHOT (full HTML on demand) ----------
  const html = await page.content();
  const htmlPath = join(ART_DIR, 'spawn-demo.html');
  await writeFile(htmlPath, html);
  section('HTML', `${htmlPath} (${html.length} bytes)`);

  // ---------- VERDICT ----------
  const ok =
    !clickError &&
    cc.pageErrors.length === 0 &&
    postDom.flowNodeCount === 2 &&
    state.audioContextStateFromDom === 'running';
  section('VERDICT', ok ? 'pass — 2 nodes rendered, audio running' : 'fail — see sections above');
});
