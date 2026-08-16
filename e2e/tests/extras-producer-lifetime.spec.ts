// e2e/tests/extras-producer-lifetime.spec.ts
//
// #1720 — "painter / textmarquee / picturebox render a PLACEHOLDER unless the
// card is open." THE REGRESSION GUARD for the EXTRAS-channel producer seam.
//
// These modules keep their picture in the Y.Doc — an op log, a rich-text model,
// a base64 image — and the CARD was the only thing that ever pushed it into the
// engine through `read(id, 'extras')`. Under the faceplate shell an un-migrated
// module's card exists ONLY inside the dock full-view, so in the common case it
// is NEVER MOUNTED and a SAVED rack rendered each module's built-in placeholder
// ON LOAD, before anything was touched. Collapse is not the trigger; the DEFAULT
// state is. The fix is a node-lifetime producer keyed to GRAPH lifetime
// ($lib/ui/media/node-extras-registry), NOT a permanent off-screen card mount —
// see that file for why the sibling seam's answer is wrong for this one.
//
// ── THE INSTRUMENT, AND WHY NOT THE SIBLING'S ────────────────────────────────
// card-producer-lifetime.spec.ts (the #1587 guard) probes through
// `AudioEngine.getVideoSource(nodeId, portId).drawFrame`. That is the right
// probe for ITS subjects — wavesculpt/timelorde/synesthesia are AUDIO-domain
// modules exposing a video out through an analyser tap. It is STRUCTURALLY
// BLIND to these four, which are VIDEO-domain: their picture is a GL FBO, and
// `getVideoSource` returns null for every one of them.
//
// That blindness is not hypothetical — it was the FIRST probe written for this
// issue, and it returned `nonBlack 0/3072, distinct=1` in BOTH phases with
// `reason=no video source for r-painter.out` attached. Two identical readings
// and a PASSING equality assertion, measuring nothing. It only announced itself
// because the probe carried its own `reason` field into the message. Every probe
// below reports `tex` / `fbo` / `samples` for exactly that reason.
//
// This probe reads the MODULE'S OWN output texture — `VideoEngine.outputTexture(
// nodeId)`, the FBO its `draw()` renders into, the same one the render-smoke
// helpers read — into a framebuffer this test owns, and reports PER-CHANNEL
// means. Per-channel, not luma: the failures here are a WHITE page, a BLACK
// placeholder and a dark IDLE FIELD, and each subject's content is a saturated
// colour chosen so the two cannot alias.
//
// ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
//   1. DEFAULT STATE — spawn with the content already in `node.data`, expand
//      NOTHING, click nothing, and require the node's own output to carry that
//      content. This is the owner-visible bug.
//   2. PERMANENT NEGATIVE CONTROL — the SAME probe on a node with NO persisted
//      content must read DIFFERENTLY. Without this, leg 1 passes for a probe
//      that cannot tell a picture from a placeholder, which is precisely how the
//      first instrument here failed.
//   3. POSITIVE CONTROL — the identical probe with the real card mounted in the
//      dock full-view. Leg 1 and leg 3 must AGREE, which is the causal claim in
//      both directions.
//   4. THE EVICTION TRIGGER — expand the subject, then expand a THIRD module,
//      then close. The picture must survive every one of those transitions,
//      including the ones the user never aimed at this node.
//   5. DELETE — the node leaves the graph and the registry sweeps it; no error,
//      and a fresh node of the same id comes back with its content.
//   6. THE PUMP — PICTUREBOX's ASSET GATE / ASSET PITCH cv inputs, driven with
//      NO card anywhere. That poll used to live on the card, so the two jacks
//      were patched, connected and INERT, and the displayed slot LATCHED. It is
//      a different failure from the texture one and needs its own leg.
//
// REGISTRY-DRIVEN: the subjects are DERIVED from EXTRAS_PRODUCERS in the shared
// source, so a fifth producer enrols itself — and its FIXTURE is required, so it
// cannot enrol as an untested row.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';
import { midiToVOct } from '../../packages/web/src/lib/audio/note-entry';
import { ASSET_SLOT_NOTES } from '../../packages/web/src/lib/video/asset-select';
import { PUMP_INTERVAL_MS } from '../../packages/web/src/lib/ui/media/node-extras-registry';

/** SwiftShader (CI, or a local `E2E_SWIFTSHADER=1` flake-check) rasterizes WebGL
 *  in software at roughly an eighth of a real GPU's frame rate. Every budget
 *  below is in FRAMES; only the whole-test wall-clock ceiling needs the scale. */
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Frames waited after a graph change before reading the output texture. The
 *  producer is not rAF-driven (it runs on the graph effect), so this is only
 *  "let the engine draw at least one frame with the new texture". It BOUNDS the
 *  failure — the readings are settled by an `expect.poll` on the real subject. */
const SETTLE_FRAMES = 4;

const PRODUCERS_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/media/extras-producers.ts', import.meta.url),
  ),
  'utf8',
);

/**
 * The producer TYPES, parsed from the shared source.
 *
 * ANCHORED ON THE DECLARATION, not on a bare `type:` — this file also contains
 * `kind: 'image'` fixtures, layer types and prose, and the sibling spec records
 * what a loose regex over a TS literal costs (it matched the first PROSE mention
 * of a set's name and ran on to the wrong array, silently enrolling nine modules
 * nobody asked for). Cross-checked against the EXPORTED array below, so a
 * producer that is declared but never registered — which would run for nobody —
 * fails the parse rather than quietly shrinking the subject list.
 */
function producerTypes(): string[] {
  const declared = new Map<string, string>();
  const declRe = /const\s+(\w+Producer)\s*:\s*ExtrasProducer\s*=\s*\{\s*\n\s*type:\s*'([^']+)'/g;
  for (const m of PRODUCERS_SRC.matchAll(declRe)) declared.set(m[1]!, m[2]!);
  if (declared.size === 0) {
    throw new Error('parsed ZERO producer declarations — has the shape changed?');
  }

  // ⚠ ANCHORED ON `= [`, NOT on the first `[`. The sibling spec's `[^[]*\[`
  // idiom is WRONG here and failed on the first run: the type annotation is
  // `readonly ExtrasProducer[]`, so `[^[]*` stops at the annotation's own
  // bracket pair and the capture comes back EMPTY. It only surfaced as an
  // error rather than as a silently-empty subject list because of the vacuity
  // guard below — which is the entire argument for keeping that guard.
  const arrayRe = /export const EXTRAS_PRODUCERS[^=]*=\s*\[([\s\S]*?)\]/;
  const block = arrayRe.exec(PRODUCERS_SRC);
  if (!block) throw new Error('could not parse EXTRAS_PRODUCERS — has the shape changed?');
  const registered = [...block[1]!.matchAll(/(\w+Producer)\s*,/g)].map((m) => m[1]!);
  if (registered.length === 0) {
    throw new Error('EXTRAS_PRODUCERS parsed EMPTY — refusing to pass vacuously');
  }

  const orphans = [...declared.keys()].filter((n) => !registered.includes(n));
  if (orphans.length > 0) {
    throw new Error(
      `producer(s) declared but not in EXTRAS_PRODUCERS (${orphans.join(', ')}) — ` +
        'they run for nobody, and this spec would not have noticed',
    );
  }
  const missing = registered.filter((n) => !declared.has(n));
  if (missing.length > 0) {
    throw new Error(`EXTRAS_PRODUCERS names undeclared producer(s): ${missing.join(', ')}`);
  }
  return registered.map((n) => declared.get(n)!);
}

/** A subject's persisted content and the reading it must produce. `data` is
 *  written into `node.data`; `expect` names the CHANNEL that must dominate, so
 *  the assertion says what it is looking at rather than pinning a magic RGB. */
interface Fixture {
  /** Node data that a real user's saved rack would carry. */
  data: (blueJpegBase64: string) => Record<string, unknown>;
  /** Which channel the CONTENT saturates. The placeholder for every subject is
   *  white, black, or a dark blue-grey idle field, so a saturated single
   *  channel cannot be confused with any of them. */
  channel: 'r' | 'g' | 'b';
}

/**
 * DENY BY DEFAULT: every producer type must have a fixture here or the spec
 * throws at collection. A new producer cannot enrol as an untested row, and a
 * fixture for a type that no longer has a producer is equally RED (asserted in
 * the derivation test below).
 *
 * These are FIXTURES THE TEST ITSELF BUILDS, not a population count — the
 * assertion is over content this file authored, so the shape is the allowed one.
 */
const FIXTURES: Record<string, Fixture> = {
  // A single filled rect covering the whole engine-resolution page. The
  // placeholder is a blank WHITE page, so "red dominates" is unambiguous.
  painter: {
    data: () => ({
      ops: [
        {
          kind: 'shape',
          tool: 'rect',
          color: '#ff0000',
          size: 8,
          fill: '#ff0000',
          x0: 0,
          y0: 0,
          x1: 4000,
          y1: 4000,
        },
      ],
    }),
    channel: 'r',
  },
  // A huge word on a red layer background. The placeholder is the literal word
  // "textmarquee" in white on black — sparse, and with zero red.
  textmarquee: {
    data: () => ({
      richText: {
        paragraphs: [{ runs: [{ text: 'AAAA' }], align: 'left' }],
        fg: '#00ff00',
        bg: '#ff0000',
        fontPx: 420,
        fontFamily: 'sans-serif',
      },
    }),
    channel: 'r',
  },
  // A solid BLUE jpeg. The placeholder is the module's dark idle field.
  picturebox: {
    data: (blue) => ({ imageBytes: blue, imageMime: 'image/jpeg', imageName: 'blue.jpg' }),
    channel: 'b',
  },
  // The same blue jpeg on IMAGE layer 0. The idle pattern the layer shader
  // paints without `hasImage` is not blue-dominant.
  toybox: {
    data: (blue) => ({
      layers: [
        { kind: 'image', contentId: null, params: {}, imageBytes: blue, imageName: 'blue.jpg' },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ],
    }),
    channel: 'b',
  },
};

const SUBJECTS = producerTypes().map((type) => {
  const fixture = FIXTURES[type];
  if (!fixture) {
    throw new Error(
      `'${type}' has a node-lifetime extras producer but no FIXTURE in this spec. ` +
        'Add persisted content that makes a picture the module cannot produce on its own, ' +
        'and the channel that content saturates — a producer nothing exercises is not covered.',
    );
  }
  return { type, fixture };
});

interface Reading {
  r: number;
  g: number;
  b: number;
  /** Pixels sampled — 0 means the probe never looked. */
  samples: number;
  /** Did the node have an output texture at all? */
  hasTexture: boolean;
  /** Was the readback framebuffer complete? */
  fbComplete: boolean;
}

/** IN-PAGE, one evaluate: read the node's own output texture and report
 *  per-channel means. Never a Playwright-side per-pixel loop. */
async function probe(page: Page, nodeId: string): Promise<Reading> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (n: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const empty = { r: 0, g: 0, b: 0, samples: 0, hasTexture: false, fbComplete: false };
    let vid: ReturnType<ReturnType<typeof w.__engine>['getDomain']>;
    try {
      vid = w.__engine().getDomain('video');
    } catch {
      return empty;
    }
    const gl = vid.gl;
    const tex = vid.outputTexture(id);
    if (!tex) return empty;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain the readback (already captured) */
    }
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    // Every 16th pixel — the question is "which channel dominates the frame",
    // and every extra sample is readback cost on the subject's own main thread.
    for (let i = 0; i < px.length; i += 4 * 16) {
      r += px[i]!;
      g += px[i + 1]!;
      b += px[i + 2]!;
      n++;
    }
    return {
      r: n ? Math.round(r / n) : 0,
      g: n ? Math.round(g / n) : 0,
      b: n ? Math.round(b / n) : 0,
      samples: n,
      hasTexture: true,
      fbComplete: complete,
    };
  }, nodeId);
}

function fmt(x: Reading): string {
  return `meanRGB=(${x.r},${x.g},${x.b}) samples=${x.samples} tex=${x.hasTexture} fbo=${x.fbComplete}`;
}

/** Is `channel` clearly the dominant one, and is there anything there at all? */
function dominates(x: Reading, channel: 'r' | 'g' | 'b'): boolean {
  const others = (['r', 'g', 'b'] as const).filter((c) => c !== channel);
  return x.samples > 0 && x[channel] > 64 && others.every((c) => x[channel] > x[c] + 32);
}

/** IN-PAGE, bounded in FRAMES: wait until the node has an output texture. */
async function waitForTexture(page: Page, nodeId: string, capFrames: number): Promise<number> {
  return page.evaluate(
    async ({ id, cap }) => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { outputTexture: (n: string) => unknown } };
      };
      let n = 0;
      while (n < cap) {
        try {
          if (w.__engine().getDomain('video').outputTexture(id)) return n;
        } catch {
          /* engine not up yet */
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        n++;
      }
      return n;
    },
    { id: nodeId, cap: capFrames },
  );
}

/** Write persisted state onto a node, exactly as a loaded rack would carry it. */
async function seedData(
  page: Page,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ id, d }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (f: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id]!;
        if (!n.data) n.data = {};
        for (const [k, v] of Object.entries(d)) n.data[k] = v;
      });
    },
    { id: nodeId, d: data },
  );
}

/** A real solid-blue JPEG, encoded in the page — no binary fixture to keep. */
async function blueJpeg(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const x = c.getContext('2d')!;
    x.fillStyle = '#0000ff';
    x.fillRect(0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  });
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT faceplate shell, which is the whole point: under
  // `?shell=legacy` the real card renders in the lane and the bug is invisible.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

/** Settle to a reading, retrying on the real subject rather than on a clock. */
async function readSettled(page: Page, nodeId: string): Promise<Reading> {
  await waitFrames(page, SETTLE_FRAMES);
  return probe(page, nodeId);
}

test.describe('EXTRAS-channel producers are NODE-lifetime (#1720)', () => {
  test('the derivation is anchored in BOTH directions', () => {
    // A FIXTURE for a type that no longer has a producer reads as coverage while
    // covering nothing. (The other direction — a producer with no fixture —
    // throws at collection, above, which is why it is not asserted here.)
    const live = new Set(SUBJECTS.map((s) => s.type));
    const stale = Object.keys(FIXTURES).filter((t) => !live.has(t));
    expect(stale, `FIXTURE(s) for type(s) with no extras producer: ${stale.join(', ')}`).toEqual(
      [],
    );
    expect(SUBJECTS.length, 'the subject set must not silently empty').toBeGreaterThan(0);
  });

  for (const { type, fixture } of SUBJECTS) {
    test(`${type}: renders its PERSISTED content with the card never mounted`, async ({
      page,
    }) => {
      test.setTimeout(SLOW_RENDER ? 180_000 : 90_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const seeded = `extras-${type}`;
      const bare = `extras-${type}-bare`;
      // Two cheap extra occupants, so opening them EVICTS the subject's pane:
      // the dock holds MAX_FULLVIEW_PANES (2) and drops from the front.
      // acidwarp is a pure-GPU generator with no card-owned state of its own.
      const evictA = 'extras-evict-a';
      const evictB = 'extras-evict-b';
      await boot(page);

      // The owner's rack: the module patched straight into the video monitor,
      // plus a BARE sibling of the same type carrying no content — the permanent
      // negative control, spawned in the same page so it is the same instrument
      // under the same load.
      await spawnPatch(
        page,
        [
          { id: seeded, type, domain: 'video' },
          { id: bare, type, domain: 'video' },
          { id: evictA, type: 'acidwarp', domain: 'video' },
          { id: evictB, type: 'acidwarp', domain: 'video' },
          { id: 'extras-out', type: 'videoOut', domain: 'video' },
        ],
        [
          {
            id: 'extras-edge',
            from: { nodeId: seeded, portId: 'out' },
            to: { nodeId: 'extras-out', portId: 'in' },
            sourceType: 'video',
            targetType: 'video',
          },
        ],
        { mountTimeout: 30_000 },
      );

      const blue = await blueJpeg(page);
      await seedData(page, seeded, fixture.data(blue));

      // ── 1. DEFAULT STATE. Nothing expanded, clicked or docked. ────────────
      // The lane really is showing the uniform tile — i.e. no card is in it.
      await expect(
        page.locator(`.svelte-flow__node[data-id="${seeded}"] [data-testid="module-shell-placeholder"]`),
        `${type} must be un-migrated and swapped to a tile, or this test proves nothing`,
      ).toHaveCount(1, { timeout: 20_000 });
      // ...and no headless host is holding it either. That distinction is the
      // whole point: this fix is NOT a hidden card mount.
      expect(
        await page.evaluate(
          (id) =>
            document.querySelectorAll(
              `[data-testid="headless-source-host"][data-node-id="${id}"]`,
            ).length,
          seeded,
        ),
        `${type} must NOT be kept alive by a headless card mount — the producer is node-lifetime`,
      ).toBe(0);

      const waited = await waitForTexture(page, seeded, 600);
      await expect
        .poll(async () => dominates(await readSettled(page, seeded), fixture.channel), {
          message:
            `#1720: ${type} must render its PERSISTED content with NO card mounted. ` +
            `Waited ${waited} frames for an output texture.`,
          timeout: SLOW_RENDER ? 60_000 : 30_000,
        })
        .toBe(true);
      const never = await probe(page, seeded);

      // ── 2. PERMANENT NEGATIVE CONTROL ────────────────────────────────────
      // The same probe on the BARE sibling. If this also reads as content, the
      // probe cannot tell a picture from a placeholder and leg 1 measured
      // nothing — which is exactly how the first instrument for this issue
      // failed (two identical readings and a passing equality).
      await waitForTexture(page, bare, 600);
      const placeholder = await readSettled(page, bare);
      expect(
        dominates(placeholder, fixture.channel),
        `NEGATIVE CONTROL: a ${type} node with NO persisted content must NOT read as content. ` +
          `It did, so the probe cannot distinguish the two and every other leg here is vacuous.` +
          `\n  seeded:      ${fmt(never)}\n  bare (empty): ${fmt(placeholder)}`,
      ).toBe(false);

      // ── 3. POSITIVE CONTROL — the identical probe, card mounted ──────────
      await page.evaluate((id) => {
        (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(
          id,
        );
      }, seeded);
      await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect
        .poll(async () => dominates(await readSettled(page, seeded), fixture.channel), {
          message: `${type} must still carry its content with the card MOUNTED`,
          timeout: SLOW_RENDER ? 60_000 : 30_000,
        })
        .toBe(true);
      const mounted = await probe(page, seeded);

      // ── 4. THE EVICTION TRIGGER — the silent one ─────────────────────────
      // The dock holds MAX_FULLVIEW_PANES(2) and drops from the FRONT, so
      // expanding two OTHER modules evicts the subject's pane with no user
      // action against this node at all. That is the trigger #1583 names as the
      // one nobody notices, and it is the one a collapse-shaped test misses.
      for (const other of [evictA, evictB]) {
        await page.evaluate((id) => {
          (
            globalThis as unknown as { __openDockFullView: (i: string) => void }
          ).__openDockFullView(id);
        }, other);
      }
      await expect(
        page.locator(`[data-testid="dock-full-view"] [data-node-id="${seeded}"]`),
        `${type}'s pane must actually have been EVICTED, or this leg proves nothing`,
      ).toHaveCount(0, { timeout: 20_000 });
      await expect
        .poll(async () => dominates(await readSettled(page, seeded), fixture.channel), {
          message:
            `${type} lost its picture when TWO OTHER nodes were expanded and evicted its ` +
            'pane — no user action touched this node at all',
          timeout: SLOW_RENDER ? 60_000 : 30_000,
        })
        .toBe(true);

      // ...and closing the whole full-view must not lose it either.
      const collapse = page.getByTestId('faceplate-collapse');
      while ((await collapse.count()) > 0) await collapse.first().click();
      await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect
        .poll(async () => dominates(await readSettled(page, seeded), fixture.channel), {
          message: `${type} must still carry its content after the full-view closes`,
          timeout: SLOW_RENDER ? 60_000 : 30_000,
        })
        .toBe(true);

      // ── 5. DELETE — the registry is swept by the GRAPH ────────────────────
      await page.evaluate((id) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          for (const [eid, e] of Object.entries(w.__patch.edges)) {
            const edge = e as { source?: { nodeId?: string }; target?: { nodeId?: string } };
            if (edge?.source?.nodeId === id || edge?.target?.nodeId === id) {
              delete w.__patch.edges[eid];
            }
          }
          delete w.__patch.nodes[id];
        });
      }, seeded);
      await expect(page.locator(`.svelte-flow__node[data-id="${seeded}"]`)).toHaveCount(0, {
        timeout: 20_000,
      });

      expect(
        errors,
        `page error(s) during the ${type} extras-producer lifecycle: ${errors.join(' | ')}`,
      ).toEqual([]);

      // One digest for the log, so a future reader sees the numbers rather than
      // just a green tick.
      console.log(
        `#1720 ${type}: never-mounted ${fmt(never)} | card-mounted ${fmt(mounted)} | ` +
          `bare placeholder ${fmt(placeholder)}`,
      );
    });
  }

  test('picturebox: ASSET GATE + ASSET PITCH drive the slot with NO card mounted', async ({
    page,
  }) => {
    // THE SECOND DEFECT ON THIS CHANNEL, and it is not the placeholder shape.
    // The 33 ms poll that reads these two cv inputs used to live on the CARD, so
    // with no card the jacks were patched, visibly connected and INERT — and the
    // displayed slot LATCHED at its last selection rather than going dark. A fix
    // that only restores the texture leaves this broken, so it gets its own leg.
    //
    // THE CONTROL IS THE ROUND TRIP: bright -> dark -> bright. A latched value
    // cannot produce both transitions, and neither can a probe that is reading
    // something other than the displayed slot.
    test.setTimeout(SLOW_RENDER ? 180_000 : 90_000);
    const id = 'extras-gate';
    await boot(page);
    await spawnPatch(
      page,
      [
        { id, type: 'picturebox', domain: 'video' },
        { id: 'extras-gate-out', type: 'videoOut', domain: 'video' },
      ],
      [
        {
          id: 'extras-gate-edge',
          from: { nodeId: id, portId: 'out' },
          to: { nodeId: 'extras-gate-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
      { mountTimeout: 30_000 },
    );

    const solid = async (gray: number): Promise<string> =>
      page.evaluate(async (g) => {
        const c = new OffscreenCanvas(640, 480);
        const x = c.getContext('2d')!;
        x.fillStyle = `rgb(${g},${g},${g})`;
        x.fillRect(0, 0, c.width, c.height);
        const buf = new Uint8Array(
          await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
        );
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
        }
        return btoa(bin);
      }, gray);

    // Slot 0 = BRIGHT, slot 1 = DARK. Both pre-decoded by the producer, so a
    // gate switch is an index flip and the reading cannot be a decode race.
    await seedData(page, id, { assets: [await solid(240), await solid(8), null, null, null, null, null] });

    // The lane is a tile and nothing is expanded — no card exists anywhere.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
    ).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0);

    const luma = async (): Promise<number> => {
      const x = await readSettled(page, id);
      return (x.r + x.g + x.b) / 3;
    };

    /** Fire a rising edge at `voct` and HOLD it until the output responds — the
     *  pump ticks on its own cadence, so the wait is on the real subject and
     *  never on a clock. Released afterwards so the edge detector re-arms. */
    const gateTo = async (slot: number, want: (m: number) => boolean, label: string) => {
      const voct = midiToVOct(ASSET_SLOT_NOTES[slot]!);
      await page.evaluate(
        ({ n, v }) => {
          const w = globalThis as unknown as {
            __engine?: () => {
              getDomain?: (d: string) => { setParam?: (i: string, p: string, x: number) => void };
            };
          };
          const ve = w.__engine?.()?.getDomain?.('video');
          ve?.setParam?.(n, 'asset_pitch', v);
          ve?.setParam?.(n, 'asset_gate', 1);
        },
        { n: id, v: voct },
      );
      await expect
        .poll(async () => want(await luma()), {
          message:
            `#1720: ASSET GATE must select slot ${slot} (${label}) with NO card mounted — ` +
            'the poll that reads these jacks is the node-lifetime pump, not a card interval',
          timeout: SLOW_RENDER ? 60_000 : 30_000,
        })
        .toBe(true);
      await page.evaluate((n) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => { setParam?: (i: string, p: string, x: number) => void };
          };
        };
        w.__engine?.()?.getDomain?.('video')?.setParam?.(n, 'asset_gate', 0);
      }, id);
      // pacing: an edge detector re-arms only once it has OBSERVED the low, and
      // this one samples on the node-lifetime pump's own interval —
      // PUMP_INTERVAL_MS, defined by the product in
      // $lib/ui/media/node-extras-registry and imported here rather than
      // re-typed. This is a real GATE WIDTH, not a renderer budget: no number of
      // rAF frames expresses "one setInterval tick", and without it the release
      // and the next rise land inside a single tick, the pump reads high-then-
      // high, and a perfectly live detector reads as dead. Three ticks so a
      // loaded runner cannot starve the single sample this needs.
      await page.waitForTimeout(PUMP_INTERVAL_MS * 3);
    };

    await gateTo(0, (m) => m > 150, 'bright');
    await gateTo(1, (m) => m < 80, 'dark');
    // ...and BACK, which a latched value cannot do.
    await gateTo(0, (m) => m > 150, 'bright again');
  });
});
