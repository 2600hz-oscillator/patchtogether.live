// e2e/vrt/vrt-lane-tier-probe.spec.ts
//
// PROBE (VRT_PROBE=1) — WHAT DOES A LANE TILE ACTUALLY LAY OUT, PER TIER?
//
// Asserts nothing. Prints, for a module at each of the three LANE tiers
// (mini / compact / full), the tile's body box, the chosen layout, every cell's
// CSS-px geometry, and any pair of cells whose painted boxes INTERSECT.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// The `full` LANE tier has NO pixel baseline — `workflow-shell-faces.spec.ts`
// says so in its own residual-scope list ("the in-lane expanded tile has NO
// pixel scene here (only 'compact' and 'dock')"). marbles shipped to dev with
// its full tile painting three columns of overlapping faders and a `COIN ▾`
// grid chip on top of a fader, and nothing in the suite could see it: the
// compact baseline was correct, the dock baseline was correct, and the tier in
// between had no observer at all.
//
// This is the instrument that found it, and it found a SECOND one on the first
// run (adsr's knob columns over-running their plate track by 13 px, an earned
// readout line the 42 px design row does not budget for). Both were invisible
// to every model-reading gate, because both are disagreements BETWEEN the model
// and the render — which is the one thing a model cannot check about itself.
//
// ── READING IT ──────────────────────────────────────────────────────────────
//
//   PROBE_TYPES=marbles,noise   which modules to walk (default: those two)
//   PROBE_OUT=/tmp/probe        where the per-tier PNGs are written
//
//   flox activate -- \
//     VRT_PROBE=1 npx --workspace e2e playwright test \
//       --config=vrt/vrt.config.ts vrt-lane-tier-probe --workers=1
//
// ⚠ EVERY NUMBER IT PRINTS IS CSS px. The tiles sit under xyflow's viewport
// TRANSFORM, so `getBoundingClientRect` returns SCREEN px — a 96 px cell reads
// as 19.2 at the mini tier's 0.45 zoom. The rects below are divided by the live
// zoom, and `offsetH`/`offsetW` (which the transform does not touch) are
// printed beside them as the cross-check. They agreed on every cell measured
// while this was written; if they ever stop, believe `offsetH`.
//
// ⚠ AND THE CELL HEIGHTS ARE FONT-DEPENDENT. The same marbles fader is 96 CSS
// px under these scenes' PINNED webfonts and 94 in the app's own stack (a 12 px
// label line box becoming 10 px). That is why `LANE_CELL_H` is a CEILING the
// planner reserves against rather than an equality anyone asserts.
import { test } from '@playwright/test';
import { bootWithFace, frameMember, LEGACY_FOLD_VIEWPORT } from './_shell-faces';

const OUT = process.env.PROBE_OUT ?? '/tmp/probe';

/** The three LANE tiers and a zoom inside each LOD band. ('dock' is a separate
 *  VIEW, not a lane tier — `vrt-fold-probe` is the instrument for that one.) */
const TIERS = [
  ['mini', 0.2],
  ['compact', 0.45],
  ['full', 0.7],
] as const;

for (const type of (process.env.PROBE_TYPES ?? 'marbles,noise').split(',')) {
  for (const [tier, zoom] of TIERS) {
    test(`probe-${type}-${tier}`, async ({ page }) => {
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      const memberId = await bootWithFace(page, type);
      await frameMember(page, memberId, zoom, tier);
      const tile = page.locator(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      await tile.screenshot({ path: `${OUT}/${type}-${tier}.png` });

      const geom = await page.evaluate((memberId) => {
        const shell = document.querySelector(
          `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
        ) as HTMLElement;
        const body = shell.querySelector('.tile-body') as HTMLElement;
        // Undo xyflow's zoom so every rect below is CSS px (see the header).
        const z = Number(
          new DOMMatrixReadOnly(
            getComputedStyle(document.querySelector('.svelte-flow__viewport')!).transform,
          ).a.toFixed(6),
        );
        const px = (v: number) => Number((v / z).toFixed(2));
        const cells = [
          ...body.querySelectorAll(':scope > [data-cell-kind], :scope > .tile-glyph'),
        ].map((el) => {
          const e = el as HTMLElement;
          const r = e.getBoundingClientRect();
          const label = e.querySelector('.label, .lab');
          const track = e.querySelector('.track');
          return {
            kind: e.getAttribute('data-cell-control') ?? 'glyph',
            key: e.getAttribute('data-cell-key'),
            x: px(r.x),
            y: px(r.y),
            w: px(r.width),
            h: px(r.height),
            // The zoom-free cross-check — see the header's warning.
            offsetW: e.offsetWidth,
            offsetH: e.offsetHeight,
            labelText: label?.textContent?.trim(),
            labelH: label ? px(label.getBoundingClientRect().height) : null,
            labelFont: label ? getComputedStyle(label).fontSize : null,
            trackH: track ? px(track.getBoundingClientRect().height) : null,
          };
        });
        const br = body.getBoundingClientRect();
        const sr = shell.getBoundingClientRect();
        return {
          zoom: z,
          layout: body.getAttribute('data-body-layout'),
          plateRowH: body.getAttribute('data-plate-row-h'),
          gridAutoRows: getComputedStyle(body).gridAutoRows,
          shell: { w: px(sr.width), h: px(sr.height) },
          body: { w: px(br.width), h: px(br.height) },
          cells,
        };
      }, memberId);

      // The defect, stated as a measurement: which painted boxes intersect, and
      // by how much. An empty list is the property the lane tile is supposed to
      // have at every tier.
      const overlaps: string[] = [];
      for (let i = 0; i < geom.cells.length; i++) {
        for (let j = i + 1; j < geom.cells.length; j++) {
          const a = geom.cells[i];
          const b = geom.cells[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 0.5 && oy > 0.5) {
            overlaps.push(
              `${a.kind}:${a.key} × ${b.kind}:${b.key} — ${ox.toFixed(1)}×${oy.toFixed(1)} CSS px`,
            );
          }
        }
      }
      console.log(`\n===== ${type} / ${tier} =====\n${JSON.stringify({ ...geom, overlaps }, null, 2)}`);
    });
  }
}
