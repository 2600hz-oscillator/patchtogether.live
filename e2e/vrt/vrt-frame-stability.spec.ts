// e2e/vrt/vrt-frame-stability.spec.ts
//
// MEASUREMENT TOOL, not a gate — the instrument that decides whether a card
// belongs in e2e/vrt/vrt-live-surfaces.ts. Opt-in via `VRT_PROBE=1` (see the
// testMatch switch in vrt.config.ts), so it never costs CI a second.
//
//   VRT_PROBE=1 STAB_MODULES=scope,toybox \
//     npx --workspace e2e playwright test --config=vrt/vrt.config.ts vrt-frame-stability
//
// ─────────────────────────────────────────────────────────────────────────
// THE QUESTION IT ANSWERS, AND WHY THE OBVIOUS ONE IS WRONG
//
// `toHaveScreenshot` does not screenshot once and compare. It screenshots
// REPEATEDLY until TWO CONSECUTIVE captures agree, and only then diffs the
// settled image against the baseline. So the property a VRT scene actually
// needs is INTER-FRAME STABILITY — and a card can be perfectly reproducible
// COLD LOAD TO COLD LOAD (same settle, same phase, byte-identical PNG every
// time you re-run it) while still repainting different pixels every frame. It
// will then fail as "Failed to take two consecutive stable screenshots",
// having never reached the comparison at all.
//
// A "byte-identical across N cold loads" check is blind to exactly that, and
// believing it is how nine surfaces ended up masked on false justifications
// (and how four genuinely-animating ones were nearly UNmasked). This spec
// measures the thing the gate actually asks for: it spawns the card the way
// vrt.spec.ts does, takes 6 element screenshots 200 ms apart, and prints the
// count + bounding box of the pixels that change BETWEEN CONSECUTIVE FRAMES.
//
//   IDENTICAL x5              → the card settles. No mask. Strict everywhere.
//   diff=N px, bbox=<region>  → that region is live. Register it, or fix it.
//
// The bounding box is the useful half: it names WHICH element is moving, so
// the mask lands on the 151x113 preview instead of on all seven canvases.
//
// It deliberately prints rather than asserts — a probe that fails is a probe
// you cannot read. Every measured number quoted in vrt-live-surfaces.ts came
// from here and can be re-derived with one command.
import { test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPatch, canvasNode } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import { applyVrtScene, VRT_SCENES } from './vrt-scenes';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { diffRegion } from './vrt-surface-stats';

const TARGETS = (process.env.STAB_MODULES ?? 'scope')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Number of captures; N-1 consecutive comparisons are printed. */
const FRAMES = Number(process.env.STAB_FRAMES ?? 6);
/** Gap between captures, ms. Wall-clock is fine HERE — this is a measurement
 *  tool, not a gate, and the question is "does it ever settle", which more
 *  elapsed time can only make easier to answer, never harder. */
const GAP_MS = Number(process.env.STAB_GAP_MS ?? 200);

async function diffbox(page: Page, a: Buffer, b: Buffer): Promise<string> {
  const d = await diffRegion(page, a.toString('base64'), b.toString('base64'));
  if (d.diffPixels < 0) return `SIZE MISMATCH (${d.width}x${d.height})`;
  if (d.diffPixels === 0) return `IDENTICAL (${d.width}x${d.height})`;
  const b0 = d.box!;
  return (
    `diff=${d.diffPixels}px bbox=(${b0.x0},${b0.y0})-(${b0.x1},${b0.y1}) ` +
    `${b0.x1 - b0.x0 + 1}x${b0.y1 - b0.y0 + 1}`
  );
}

test.describe.configure({ mode: 'default' });

for (const type of TARGETS) {
  test(`stability ${type}`, async ({ page }) => {
    test.setTimeout(90_000);
    const mod = REGISTRY.find((m) => m.type === type)!;
    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await page.addStyleTag({
      content: '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
    });
    const used = await applyVrtScene(page, type);
    if (!used) {
      await spawnPatch(page, [
        { id: 'vrt-1', type, position: { x: 80, y: 80 }, domain: mod.domain },
      ]);
    }
    // ⚠ BY NODE ID, NOT NODE TYPE. xyflow tags a lane node with its NODE TYPE
    // and every lane node is `moduleShell`, so a per-module class matches
    // nothing (the mechanism `e2e/tests/ptzcam.spec.ts` records).
    const card = canvasNode(page, 'vrt-1');
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    await card.evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          let lastH = -1;
          let stable = 0;
          const tick = (): void => {
            const h = Math.round(el.getBoundingClientRect().height);
            if (h === lastH) {
              if (++stable >= 3) return resolve();
            } else {
              stable = 0;
              lastH = h;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const shots: Buffer[] = [];
    for (let i = 0; i < FRAMES; i++) {
      shots.push(await card.screenshot({ animations: 'disabled' }));
      await page.waitForTimeout(GAP_MS);
    }
    for (let i = 1; i < shots.length; i++) {
      const verdict = await diffbox(page, shots[i - 1]!, shots[i]!);
      // eslint-disable-next-line no-console
      console.log(
        `[stab] ${type} scene=${type in VRT_SCENES} f${i - 1}→f${i}: ${verdict}`,
      );
    }
    // First + last frame on disk so a reader can SEE what moved, not just how
    // much. STAB_OUT overrides the directory (default: the OS temp dir).
    const outDir = process.env.STAB_OUT ?? tmpdir();
    writeFileSync(join(outDir, `stab-${type}-f0.png`), shots[0]!);
    writeFileSync(join(outDir, `stab-${type}-f${FRAMES - 1}.png`), shots[FRAMES - 1]!);
  });
}
