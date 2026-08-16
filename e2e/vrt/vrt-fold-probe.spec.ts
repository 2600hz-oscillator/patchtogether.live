// e2e/vrt/vrt-fold-probe.spec.ts
//
// MEASUREMENT TOOL, not a gate. `VRT_PROBE=1` only (see vrt.config.ts), so it
// costs CI nothing. Sibling of vrt-geom-probe.spec.ts — same question, other
// surface: WHERE DOES THE DOCK CAPTURE BOX END, and how much of the faceplate
// sits underneath it?
//
// WHY IT EXISTS: `workflow-shell-faces.spec.ts`'s dock scene captures
// `[data-testid="dock-full-view"]`, which is `max-height: min(60vh, 680px)`
// (DockFullView + Canvas's `.dock-fullview-drawer`) wrapped around a
// `.faceplate-scroll` overflow container. At the pinned 1280×720 VRT viewport
// that clamp resolves to 432 px, so every face whose content is taller was
// captured TRUNCATED — its lower section bands were not in the image at all,
// and a redesign that moved only those bands left the baseline pixel-identical.
// PF-21 (row packing) re-grouped thirteen faces' bands and five dock baselines
// stayed byte-for-byte the same.
//
// This probe is the instrument that measured that, kept in the tree so the
// numbers can be re-derived instead of re-argued:
//
//   VRT_PROBE=1 npx playwright test --config=vrt/vrt.config.ts vrt-fold-probe
//
// TWO tests, neither asserting anything:
//
//   1. FOLD GEOMETRY — per face, at BOTH the legacy 720 px viewport and the
//      gate's current one: the capture height, the scroll content height, the
//      remainder the capture cannot contain, the scrollbar width and the
//      per-band offsets. "Band N is below the fold" as a number with units.
//   2. EXACT DIFF vs the committed baselines, at threshold 1/255 AND at the
//      26/255 the gate actually applies — the question a green
//      `toHaveScreenshot` structurally cannot answer, because Playwright only
//      rewrites a snapshot whose comparison FAILS. Run it before believing a
//      dispatch that committed nothing.

import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffRegion } from './vrt-surface-stats';
import {
  FACES,
  FOLD_VIEWPORT,
  LEGACY_FOLD_VIEWPORT,
  foldViewportFor,
  bootWithFace,
  frameMember,
  openDock,
  readFoldGeometry,
  settle,
  unfoldDockPane,
  type FoldGeometry,
} from './_shell-faces';

function line(tag: string, g: FoldGeometry): string {
  return (
    `${tag} cap=${String(g.captureH).padStart(3)} content=${String(g.scrollH).padStart(3)} ` +
    `hiddenY=${String(g.hiddenY).padStart(3)} sbW=${g.scrollbarW} ` +
    `bands=${g.renderedBands}/${g.bands.length} tabs=${g.tabs}`
  );
}

test('dock faceplate fold geometry, every curated face', async ({ page }) => {
  test.setTimeout(FACES.length * 25_000);
  const rows: string[] = [];
  for (const { type, pages } of FACES) {
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    const memberId = await bootWithFace(page, type);
    await frameMember(page, memberId, 0.7, 'full');
    await openDock(page, memberId, pages);
    const legacy = await readFoldGeometry(page);

    await page.setViewportSize(foldViewportFor(type));
    await settle(page);
    const now = await readFoldGeometry(page);

    const row =
      `${type.padEnd(14)} ${line(`${LEGACY_FOLD_VIEWPORT.height}px:`, legacy)}\n` +
      `${' '.repeat(15)}${line(`${FOLD_VIEWPORT.height}px:`, now)}\n` +
      `${' '.repeat(15)}bands@${LEGACY_FOLD_VIEWPORT.height} ` +
      legacy.bands
        .map(
          (b) =>
            `${b.id}@${b.top}+${b.h}${b.top + b.h > legacy.captureH ? '*' : ''}${b.rendered ? '' : '(hidden)'}`,
        )
        .join(' ');
    rows.push(row);
    // eslint-disable-next-line no-console
    console.log('[fold] ' + row);
  }
  // eslint-disable-next-line no-console
  console.log(
    '[fold] ================ SUMMARY (CSS px; * = band bottom past the capture box) ================\n' +
      rows.join('\n'),
  );
});

// ── THE EXACT-DIFF AUDIT ────────────────────────────────────────────────────
//
// Answers the ONE question a green `toHaveScreenshot` cannot: is that baseline
// IDENTICAL, or merely inside the budget? Playwright only rewrites a snapshot
// whose comparison FAILS, so a sub-tolerance change is invisible to the gate AND
// unfixable by `--update-snapshots` — the A2/#1213 hole. This prints the diff at
// BOTH thresholds so a "green dispatch that committed nothing" can be
// classified instead of shrugged at.
//
//   threshold  1/255 — any difference whatsoever
//   threshold 26/255 — what vrt.config's `threshold: 0.1` actually counts
//
// `AUDIT_LEGACY=1` reruns it against the PRE-unfold scene (720 px viewport,
// clamp left on), which is the audit's own negative control: it separates "this
// change moved the pixels" from "the baseline had already drifted".
// ONE baseline set — no `{platform}` segment (vrt.config.ts). This used to
// append `process.platform === 'darwin' ? 'darwin' : 'linux'`, which after the
// collapse resolves to a directory that does not exist, so the probe would
// have reported every committed baseline as absent.
const BASELINE_DIR = join(
  import.meta.dirname,
  '__screenshots__/workflow-shell-faces.spec.ts',
);

test('exact diff of every committed dock baseline', async ({ page }) => {
  test.setTimeout(FACES.length * 25_000);
  const legacy = process.env.AUDIT_LEGACY === '1';
  // `AUDIT_NO_FREEZE=1` runs the SAME instrument with `bootWithFace`'s audio
  // freeze off — the audit's second control, matching the compact sibling in
  // vrt-face-audio-probe. It separates "the freeze moved this pixel" from "the
  // baseline had already drifted", which print identically otherwise.
  const noFreeze = process.env.AUDIT_NO_FREEZE === '1';
  const rows: string[] = [];
  for (const { type, pages } of FACES) {
    await page.setViewportSize(legacy ? LEGACY_FOLD_VIEWPORT : foldViewportFor(type));
    const memberId = await bootWithFace(page, type, { freezeAudio: !noFreeze });
    await frameMember(page, memberId, 0.7, 'full');
    const faceplate = await openDock(page, memberId, pages);
    if (!legacy) await unfoldDockPane(page);
    const g = await readFoldGeometry(page);
    const shot = await faceplate.screenshot({ animations: 'disabled' });

    let baseline: Buffer;
    try {
      baseline = readFileSync(join(BASELINE_DIR, `face-${type}-dock.png`));
    } catch {
      rows.push(`${type.padEnd(14)} NO BASELINE on ${process.platform} (capture ${g.captureH} px)`);
      // eslint-disable-next-line no-console
      console.log('[audit] ' + rows[rows.length - 1]);
      continue;
    }
    const b64 = baseline.toString('base64');
    const s64 = shot.toString('base64');
    // SELF-DIFF is the instrument's own negative control: the same PNG through
    // the same in-page decode must come back at 0, or every number is noise.
    const self = await diffRegion(page, b64, b64, 1);
    const d1 = await diffRegion(page, b64, s64, 1);
    const d26 = await diffRegion(page, b64, s64, 26);
    rows.push(
      `${type.padEnd(14)} baseline ${baseline.readUInt32BE(16)}x${baseline.readUInt32BE(20)} ` +
        `capture ${g.captureH} px  self=${self.diffPixels} ` +
        (d1.diffPixels < 0
          ? 'DIMENSION MISMATCH → hard fail → --update-snapshots rewrites it'
          : `diff@1=${d1.diffPixels}px diff@26=${d26.diffPixels}px box@26=${JSON.stringify(d26.box)}`),
    );
    // eslint-disable-next-line no-console
    console.log('[audit] ' + rows[rows.length - 1]);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[audit] ========= ${legacy ? 'LEGACY (pre-unfold)' : 'CURRENT'} SCENE ` +
      `(${noFreeze ? 'AUDIO RUNNING — the control' : 'AUDIO FROZEN'}) vs COMMITTED BASELINES =========\n` +
      rows.join('\n'),
  );
});
