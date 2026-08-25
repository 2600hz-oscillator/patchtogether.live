// e2e/vrt/vrt-face-audio-probe.spec.ts
//
// MEASUREMENT PROBE (VRT_PROBE=1 only — not in FULL_MATCH, costs CI nothing).
//
// THE QUESTION: does a curated face's compact lane tile SETTLE, and is the
// AudioContext running while it is captured?
//
// `bootWithFace` never suspended the AudioContext, so `workflow-shell-faces`
// captured every face off a LIVE audio graph. It got away with it because the
// whole roster is struck or silent — the live `scope` glyph draws the flat
// centreline an analyser full of zeros produces. A FREE-RUNNING voice
// (analogVco, macrooscillator) draws a genuinely moving trace instead, so
// `toHaveScreenshot` never gets the two consecutive identical captures it needs
// before it will even compare, and the tile cannot baseline at all.
//
// This probe measures BOTH halves of that sentence, per module:
//
//   • THE SOURCE — an AnalyserNode on the module's primary audio output, read
//     for N consecutive rAF frames INSIDE the page (never a Playwright poll
//     loop — CLAUDE.md's "never sample a page-side quantity with a
//     Playwright-side poll loop"). Prints peak amplitude and the largest
//     sample-wise change between consecutive frames. `moving > 0` IS the
//     free-running condition, measured at its cause rather than inferred from
//     pixels.
//   • THE PIXELS — three consecutive captures of the same tile, diffed at the
//     26/255 per-channel delta the gate applies. Two zeros = the tile settles.
//
// Both are measured with the graph RUNNING and again with it FROZEN, on the
// same page, so the pair is a within-subject comparison rather than two
// separate boots.
//
// Usage:
//   VRT_PROBE=1 npm run vrt -w e2e -- --grep "face-audio"
//   PROBE_FACES=analogVco,macrooscillator  … to point it at modules that are
//   NOT in the FACES roster (a free-running voice has no face yet — that is the
//   defect this probe exists for).

import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FACES,
  LEGACY_FOLD_VIEWPORT,
  bootWithFace,
  frameMember,
  readFaceAudio,
} from './_shell-faces';
import { diffRegion } from './vrt-surface-stats';
import { tryFreezeAudioContext } from './vrt-audio-freeze';
import type { Page } from '@playwright/test';

/** The per-channel delta this probe counts a pixel as different at.
 *
 *  ⚠ IT NO LONGER MIRRORS THE GATE, and saying so is the point. It used to read
 *  "the gate's own per-channel delta (vrt.config `threshold: 0.1` ≈ 26/255), so
 *  the printed pixel counts are directly comparable to COMPACT_MAX_DIFF" — and
 *  as of 2026-08-25 the gate's `threshold` is 0 and both per-scene budgets are
 *  0, so a row this probe prints as `0 px` can still be a REAL gate failure.
 *  Kept at 26 deliberately: this is a MEASUREMENT tool for "is the audio graph
 *  running under this scene", and a coarse delta separates a live analyser
 *  trace from last-significant-bit shimmer. Use `vrt-determinism-probe` when
 *  the question is the gate's own bar. */
const CHANNEL_DELTA = 26;

const EXTRA = (process.env.PROBE_FACES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TYPES = EXTRA.length > 0 ? EXTRA : FACES.map((f) => f.type);
/** Spawn this module into lane 1 ahead of each face, so the face is DOWNSTREAM
 *  of a free-running source (a column is the chain). `PROBE_UPSTREAM=analogVco`
 *  is how the free-running condition is reproduced without a faced VCO. */
const UPSTREAM = process.env.PROBE_UPSTREAM?.trim() || undefined;

/** Three consecutive captures of the same locator → the two consecutive diffs
 *  Playwright itself needs to be zero before it will compare to a baseline. */
async function captureStability(
  page: Page,
  selector: string,
): Promise<{ d12: number; d23: number; w: number; h: number }> {
  const el = page.locator(selector);
  const a = await el.screenshot({ animations: 'disabled' });
  const b = await el.screenshot({ animations: 'disabled' });
  const c = await el.screenshot({ animations: 'disabled' });
  const b64 = (x: Buffer): string => x.toString('base64');
  const ab = await diffRegion(page, b64(a), b64(b), CHANNEL_DELTA);
  const bc = await diffRegion(page, b64(b), b64(c), CHANNEL_DELTA);
  return { d12: ab.diffPixels, d23: bc.diffPixels, w: ab.width, h: ab.height };
}

// ── THE EXACT-DIFF AUDIT (compact tiles) ────────────────────────────────────
//
// The dock half of this already exists in vrt-fold-probe ("exact diff of every
// committed dock baseline"); this is its COMPACT sibling, and together they
// cover all 42 committed face baselines.
//
// It answered the one question a green `toHaveScreenshot` could not: is the
// baseline IDENTICAL, or merely inside COMPACT_MAX_DIFF (then 150 px of a
// ~7 200 px tile — 2 % of the image)? ⚠ THAT GAP IS CLOSED AS OF 2026-08-25:
// COMPACT_MAX_DIFF, DOCK_MAX_DIFF, `threshold` and `maxDiffPixelRatio` are all
// ZERO, so "passes" and "identical" now mean the same thing and this audit is
// history rather than a live blind spot. Playwright only rewrites a snapshot whose
// comparison FAILS, so a sub-tolerance change is invisible to the gate AND
// unfixable by `--update-snapshots` (the A2/#1213 hole). "43 scenes passed" is
// therefore NOT the evidence that adding the audio freeze moved nothing; this
// is.
// ONE baseline set — no `{platform}` segment (vrt.config.ts). See the sibling
// note in vrt-fold-probe.spec.ts: the old per-platform join resolves to a
// directory that no longer exists.
const BASELINE_DIR = join(
  import.meta.dirname,
  '__screenshots__/workflow-shell-faces.spec.ts',
);

test('exact diff of every committed compact baseline', async ({ page }) => {
  test.setTimeout(FACES.length * 25_000);
  // `AUDIT_NO_FREEZE=1` runs the SAME instrument with the audio freeze off —
  // the audit's own control. Without it a non-zero row cannot be attributed:
  // "the freeze moved this pixel" and "this baseline was already stale" print
  // identically. Within-subject (same machine, same session, same decode path).
  const noFreeze = process.env.AUDIT_NO_FREEZE === '1';
  const rows: string[] = [];
  for (const { type } of FACES) {
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    const memberId = await bootWithFace(page, type, { freezeAudio: !noFreeze });
    await frameMember(page, memberId, 0.45, 'compact');
    const shot = await page
      .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
      .screenshot({ animations: 'disabled' });

    let baseline: Buffer;
    try {
      baseline = readFileSync(join(BASELINE_DIR, `face-${type}-compact.png`));
    } catch {
      rows.push(`${type.padEnd(14)} NO BASELINE on ${process.platform}`);
      // eslint-disable-next-line no-console
      console.log('[compact-audit] ' + rows[rows.length - 1]);
      continue;
    }
    const b64 = baseline.toString('base64');
    const s64 = shot.toString('base64');
    // SELF-DIFF: the instrument's own negative control. The same PNG through
    // the same in-page decode must come back 0, or every number below is noise.
    const self = await diffRegion(page, b64, b64, 1);
    const d1 = await diffRegion(page, b64, s64, 1);
    const d26 = await diffRegion(page, b64, s64, 26);
    rows.push(
      `${type.padEnd(14)} baseline ${baseline.readUInt32BE(16)}x${baseline.readUInt32BE(20)} ` +
        `self=${self.diffPixels} ` +
        (d1.diffPixels < 0
          ? 'DIMENSION MISMATCH → hard fail → --update-snapshots rewrites it'
          : `diff@1=${d1.diffPixels}px diff@26=${d26.diffPixels}px box@26=${JSON.stringify(d26.box)}`),
    );
    // eslint-disable-next-line no-console
    console.log('[compact-audit] ' + rows[rows.length - 1]);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[compact-audit] ========= COMPACT TILES vs COMMITTED BASELINES ` +
      `(${noFreeze ? 'AUDIO RUNNING — the control' : 'AUDIO FROZEN'}) =========\n` +
      rows.join('\n'),
  );
});

test.describe('VRT PROBE: face-audio-reboot — is the FROZEN tile the same across two INDEPENDENT boots?', () => {
  test.describe.configure({ mode: 'default', timeout: 180_000 });

  // WITHIN-RUN stability is necessary but NOT sufficient. `toHaveScreenshot`
  // needs two consecutive identical captures before it compares, and THEN it
  // compares to a baseline captured in a different process on a different day.
  //
  // A suspend pins the analyser's window WHEREVER IT HAPPENED TO BE, so if the
  // shell's glyph tap had already pulled real audio before the freeze, each boot
  // would freeze on a different phase of the same saw — perfectly stable within
  // the run and different every run. That failure is invisible to the within-run
  // measurement above and would be indistinguishable from a fix.
  for (const type of TYPES) {
    test(`face-audio-reboot ${type}`, async ({ page }) => {
      // PROBE_FREEZE_LATE=1 moves the suspend to AFTER the tile is framed, i.e.
      // after the shell's glyph tap has already pulled real audio. That is the
      // ordering hypothesis under test: a late freeze pins the analyser at
      // whatever phase it reached, which is stable within the run and different
      // every run.
      const late = process.env.PROBE_FREEZE_LATE === '1';
      const shot = async (): Promise<{ png: Buffer; peak: number }> => {
        await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
        const id = await bootWithFace(page, type, { upstream: UPSTREAM, freezeAudio: !late });
        await frameMember(page, id, 0.45, 'compact');
        if (late) {
          await tryFreezeAudioContext(page);
          await frameMember(page, id, 0.45, 'compact');
        }
        const a = await readFaceAudio(page, id);
        const png = await page
          .locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`)
          .screenshot({ animations: 'disabled' });
        return { png, peak: a.peak };
      };
      const one = await shot();
      const two = await shot();
      const d = await diffRegion(
        page,
        one.png.toString('base64'),
        two.png.toString('base64'),
        CHANNEL_DELTA,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[face-reboot] ${type.padEnd(16)}${UPSTREAM ? ` upstream=${UPSTREAM}` : ''} ` +
          `${d.width}x${d.height} bootA-vs-bootB=${d.diffPixels}px box=${JSON.stringify(d.box)}`,
      );
    });
  }
});

test.describe('VRT PROBE: face-audio — does the compact tile settle, and is audio running?', () => {
  test.describe.configure({ mode: 'default', timeout: 180_000 });

  for (const type of TYPES) {
    test(`face-audio ${type}`, async ({ page }) => {
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      // Deliberately UNFROZEN: this probe measures what the freeze changes.
      const memberId = await bootWithFace(page, type, { freezeAudio: false, upstream: UPSTREAM });
      // Every member of the chain, so a silent face can be told apart from a
      // chain that never carried signal in the first place.
      const chainIds = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: {
            nodes: Record<
              string,
              { type?: string; data?: { columns?: Record<string, string[]> } } | undefined
            >;
          };
        };
        const ids = w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [];
        return ids.map((id) => ({ id, type: w.__patch.nodes[id]?.type ?? '?' }));
      });
      // Only the edges BETWEEN chain members — the column's own wiring. A face
      // reading silence and a chain that never wired look identical from a peak
      // of 0, and the difference decides whether the reading means anything.
      // (`__patch` edge endpoints are `{nodeId, portId}` objects, not strings.)
      const edges = await page.evaluate((ids: string[]) => {
        const w = globalThis as unknown as {
          __patch: {
            edges: Record<
              string,
              | {
                  source: { nodeId: string; portId: string };
                  target: { nodeId: string; portId: string };
                }
              | undefined
            >;
            nodes: Record<string, { type?: string } | undefined>;
          };
        };
        const set = new Set(ids);
        return Object.values(w.__patch.edges)
          .filter((e) => !!e && (set.has(e.source.nodeId) || set.has(e.target.nodeId)))
          .map((e) => {
            const t = (id: string): string => w.__patch.nodes[id]?.type ?? id;
            return `${t(e!.source.nodeId)}:${e!.source.portId}→${t(e!.target.nodeId)}:${e!.target.portId}`;
          });
      }, chainIds.map((m) => m.id));
      // eslint-disable-next-line no-console
      console.log(`[face-audio]   chain edges: ${edges.join('  ') || '(NONE)'}`);
      for (const m of chainIds) {
        const r = await readFaceAudio(page, m.id);
        // eslint-disable-next-line no-console
        console.log(
          `[face-audio]   chain ${m.type.padEnd(16)} port=${r.portId ?? '-'} tapped=${r.tapped} ` +
            `peak=${r.peak.toFixed(6)} moving=${r.moving.toFixed(6)}`,
        );
      }
      try {
        await frameMember(page, memberId, 0.45, 'compact');
      } catch (e) {
        // A module OUTSIDE the FACES roster may never reach the 'compact' face
        // tier. Print what it DID render rather than dying with a bare timeout
        // — the probe's job is to report, not to gate.
        const seen = await page.evaluate((id) => {
          const node = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
          return {
            node: !!node,
            shells: Array.from(node?.querySelectorAll('[data-testid="module-shell"]') ?? []).map(
              (el) => el.getAttribute('data-shell-tier'),
            ),
            testids: Array.from(node?.querySelectorAll('[data-testid]') ?? [])
              .map((el) => el.getAttribute('data-testid'))
              .slice(0, 24),
          };
        }, memberId);
        // eslint-disable-next-line no-console
        console.log(
          `[face-audio] ${type}: NO 'compact' face tier, so there are no tile pixels to ` +
            `measure — the module has no \`face\` and renders ModuleShellPlaceholder. The ` +
            `chain audio above is still the finding. ${JSON.stringify(seen)} (${String(e).slice(0, 80)})`,
        );
        return;
      }
      const sel = `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`;

      const liveAudio = await readFaceAudio(page, memberId);
      const livePix = await captureStability(page, sel);

      const verdict = await tryFreezeAudioContext(page);
      const frozenAudio = await readFaceAudio(page, memberId);
      const frozenPix = await captureStability(page, sel);

      // eslint-disable-next-line no-console
      console.log(
        `[face-audio] ${type.padEnd(16)} tile=${livePix.w}x${livePix.h} port=${liveAudio.portId ?? '-'}` +
          `${UPSTREAM ? ` upstream=${UPSTREAM}` : ''}\n` +
          `[face-audio]   RUNNING  state=${liveAudio.state} tapped=${liveAudio.tapped} ` +
          `peak=${liveAudio.peak.toFixed(6)} moving=${liveAudio.moving.toFixed(6)} ` +
          `| capture d12=${livePix.d12}px d23=${livePix.d23}px\n` +
          `[face-audio]   FROZEN   freeze=${verdict.ok ? 'ok' : verdict.reason} state=${frozenAudio.state} ` +
          `peak=${frozenAudio.peak.toFixed(6)} moving=${frozenAudio.moving.toFixed(6)} ` +
          `| capture d12=${frozenPix.d12}px d23=${frozenPix.d23}px`,
      );
    });
  }
});
