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
import { FACES, LEGACY_FOLD_VIEWPORT, bootWithFace, frameMember } from './_shell-faces';
import { diffRegion } from './vrt-surface-stats';
import { tryFreezeAudioContext } from './vrt-audio-freeze';
import type { Page } from '@playwright/test';

/** The gate's own per-channel delta (vrt.config `threshold: 0.1` ≈ 26/255), so
 *  the printed pixel counts are directly comparable to COMPACT_MAX_DIFF. */
const CHANNEL_DELTA = 26;
/** Consecutive rAF frames of analyser data to compare. */
const AUDIO_FRAMES = 6;

const EXTRA = (process.env.PROBE_FACES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TYPES = EXTRA.length > 0 ? EXTRA : FACES.map((f) => f.type);
/** Spawn this module into lane 1 ahead of each face, so the face is DOWNSTREAM
 *  of a free-running source (a column is the chain). `PROBE_UPSTREAM=analogVco`
 *  is how the free-running condition is reproduced without a faced VCO. */
const UPSTREAM = process.env.PROBE_UPSTREAM?.trim() || undefined;

interface AudioReading {
  /** ctx.state at the end of the sampling window. */
  state: string;
  /** Did the audio clock advance across the window? seconds. */
  clockAdvance: number;
  /** Was an analyser attachable at all (engine + materialized output node)? */
  tapped: boolean;
  /** The port the tap read. */
  portId: string | null;
  /** max |sample| over every frame — 0 means the module is SILENT. */
  peak: number;
  /** max |f[n][i] - f[n-1][i]| over consecutive frames — 0 means the analyser
   *  window is not advancing, i.e. nothing a live glyph draws can change. */
  moving: number;
  frames: number;
}

/**
 * Attach a private AnalyserNode to `nodeId`'s primary audio output and sample
 * it for `AUDIO_FRAMES` consecutive animation frames, accumulating IN THE PAGE.
 *
 * This is deliberately a SECOND tap rather than a read of the shell's own —
 * the shell's tap is lazy and self-releasing, so reading it would perturb the
 * thing being measured. A passive analyser is a pure sink.
 */
async function readAudio(page: Page, nodeId: string): Promise<AudioReading> {
  return page.evaluate(
    async ({ nodeId, frames }) => {
      const w = globalThis as unknown as {
        __engine?: () => Record<string, unknown> | null;
        __patch?: { nodes: Record<string, { type?: string } | undefined> };
        __listModuleDefs?: () => readonly { type: string; outputs?: readonly { id: string; type: string }[] }[];
      };
      const empty = {
        state: 'n/a',
        clockAdvance: 0,
        tapped: false,
        portId: null as string | null,
        peak: 0,
        moving: 0,
        frames: 0,
      };
      const eng = w.__engine?.();
      if (!eng) return empty;
      const audio = (eng as { getDomain?: (d: string) => unknown }).getDomain?.('audio') as
        | {
            ctx: AudioContext;
            getOutputNode: (n: string, p: string) => { node: AudioNode; output: number } | null;
          }
        | undefined;
      if (!audio?.ctx) return empty;
      const ctx = audio.ctx;
      const t0 = ctx.currentTime;

      const type = w.__patch?.nodes[nodeId]?.type ?? '';
      const def = w.__listModuleDefs?.().find((d) => d.type === type);
      const portId = def?.outputs?.find((o) => o.type === 'audio')?.id ?? null;
      if (!portId) {
        return { ...empty, state: ctx.state as string, portId: null };
      }
      const out = audio.getOutputNode(nodeId, portId);
      if (!out) return { ...empty, state: ctx.state as string, portId };

      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      out.node.connect(an, out.output);

      const buf = new Float32Array(an.fftSize);
      let prev: Float32Array | null = null;
      let peak = 0;
      let moving = 0;
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          an.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i]);
            if (a > peak) peak = a;
            if (prev) {
              const d = Math.abs(buf[i] - prev[i]);
              if (d > moving) moving = d;
            }
          }
          prev = buf.slice();
          n++;
          if (n >= frames) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      try {
        out.node.disconnect(an);
      } catch {
        /* source already gone */
      }
      return {
        state: ctx.state as string,
        clockAdvance: ctx.currentTime - t0,
        tapped: true,
        portId,
        peak,
        moving,
        frames: n,
      };
    },
    { nodeId, frames: AUDIO_FRAMES },
  );
}

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
        const a = await readAudio(page, id);
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
      const edges = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: {
            edges: Record<string, { source: string; sourcePort?: string; target: string; targetPort?: string } | undefined>;
            nodes: Record<string, { type?: string } | undefined>;
          };
        };
        return Object.values(w.__patch.edges)
          .filter((e): e is NonNullable<typeof e> => !!e)
          .map((e) => JSON.stringify(e));
      });
      // eslint-disable-next-line no-console
      console.log(`[face-audio]   edges ${edges.join(' , ')}`);
      for (const m of chainIds) {
        const r = await readAudio(page, m.id);
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
        console.log(`[face-audio] ${type}: NO 'compact' tier — ${JSON.stringify(seen)}`);
        throw e;
      }
      const sel = `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`;

      const liveAudio = await readAudio(page, memberId);
      const livePix = await captureStability(page, sel);

      const verdict = await tryFreezeAudioContext(page);
      const frozenAudio = await readAudio(page, memberId);
      const frozenPix = await captureStability(page, sel);

      // eslint-disable-next-line no-console
      console.log(
        `[face-audio] ${type.padEnd(16)} tile=${livePix.w}x${livePix.h} port=${liveAudio.portId ?? '-'}` +
          `${UPSTREAM ? ` upstream=${UPSTREAM}` : ''}\n` +
          `[face-audio]   RUNNING  state=${liveAudio.state} clock=+${liveAudio.clockAdvance.toFixed(4)}s ` +
          `tapped=${liveAudio.tapped} peak=${liveAudio.peak.toFixed(6)} moving=${liveAudio.moving.toFixed(6)} ` +
          `| capture d12=${livePix.d12}px d23=${livePix.d23}px\n` +
          `[face-audio]   FROZEN   freeze=${verdict.ok ? 'ok' : verdict.reason} state=${frozenAudio.state} ` +
          `clock=+${frozenAudio.clockAdvance.toFixed(4)}s peak=${frozenAudio.peak.toFixed(6)} ` +
          `moving=${frozenAudio.moving.toFixed(6)} | capture d12=${frozenPix.d12}px d23=${frozenPix.d23}px`,
      );
    });
  }
});
