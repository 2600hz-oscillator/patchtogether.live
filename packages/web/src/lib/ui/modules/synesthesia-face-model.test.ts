// packages/web/src/lib/ui/modules/synesthesia-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the SYNESTHESIA faceplate.
//
// ⚠ THIS FILE EXISTS BECAUSE NO GATE MAKES THIS FACE'S TWO CENTRAL DECISIONS.
//
// 1. THE GLYPH. `a_band1_audio` is a declared `audio` output — the FIRST one on
//    the def — so `glyphBinding` short-circuits to
//    `{ kind: 'live-audio', portId: 'a_band1_audio' }`. The binding is LIVE. The
//    dead-glyph clause is GREEN. `VALID_GLYPHS` is satisfied. Nothing anywhere
//    reddens, and the picture would still be false: that port is copy A's BASS
//    band and nothing else, on a module whose entire product is the comparison
//    ACROSS bands and ACROSS copies. This is dockscope's trap without
//    dockscope's protection — the scope shape.
//
// 2. THE HEADLESS HOST. `synesthesia` is in `CARD_PRODUCER_LANE_TYPES`, and the
//    thing its card produces (the VIDEO-mode `write(node,'video_levels_a'/'_b')`
//    pump) is NOT what its faceplate shows (the VU wall). So it must stay OUT of
//    `FACE_MOUNTS_PRODUCER` — the set whose entries mean "my face mounts the
//    producer, drop the host". Adding it would look like tidying and would kill
//    VIDEO mode the moment the dock opened. Nothing but this file says so.
//
// A third claim is asserted here because the VRT roster leans on it: the VU
// wall needs NO `simPin`, because `drawVuMeters` is a stateless pure function of
// four scalars rather than an analyser window (which is exactly why `scope`,
// three entries above it in that roster, DOES pin).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { synesthesiaDef } from '$lib/audio/modules/synesthesia';
import { drawVuMeters } from '$lib/audio/modules/synesthesia-draw';
import { curatedFace, dockFacePlan, dockPlanControls, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { laneGlyphFor, hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  CARD_PRODUCER_LANE_TYPES,
} from '$lib/ui/workflow/dom-source-modules';
import { NODE_FRAME_PRODUCER_TYPES } from '$lib/ui/media/frame-producers';
import { rearFieldPlan } from '$lib/ui/workflow/rear-card-model';
import { DOCK_TAB_MIN_BANDS } from '$lib/ui/workflow/dock-tabs-model';

const def = synesthesiaDef as unknown as FaceDefLike & { type: string };
const face = synesthesiaDef.face!;

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'synesthesia/SynesthesiaVuBody.svelte');
const EXT_SRC = resolve(HERE, 'synesthesia/shell-extension.ts');
const CARD_SRC = resolve(HERE, 'SynesthesiaCard.svelte');
const WORKLET_SRC = resolve(HERE, '../../../../../dsp/src/synesthesia.ts');

const body = (): string => stripSourceComments(readFileSync(BODY_SRC, 'utf8'));
const ext = (): string => stripSourceComments(readFileSync(EXT_SRC, 'utf8'));
const card = (): string => stripSourceComments(readFileSync(CARD_SRC, 'utf8'));
const worklet = (): string => stripSourceComments(readFileSync(WORKLET_SRC, 'utf8'));

const COPIES = ['a', 'b'] as const;
const BANDS = [1, 2, 3, 4] as const;
const SWITCHES = COPIES.flatMap((c) => [`${c}_mode`, `${c}_bipolar`]);

function param(id: string) {
  const p = synesthesiaDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`synesthesia has no param '${id}'`);
  return p;
}

// ── A 2D CONTEXT THAT RECORDS ITS OPS ────────────────────────────────────────
//
// The determinism claim is about the DRAW being a pure function of the levels,
// so the instrument has to be able to see the whole op stream and compare two
// of them — and, crucially, to see them DIFFER when the levels do. A canvas is
// not available in this lane, and would be a weaker probe anyway (it would
// compare pixels after rasterisation rather than the calls themselves).
function recordingCtx2d(w: number, h: number): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = { canvas: { width: w, height: h } };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k as string];
      return (...args: unknown[]) => { ops.push(`${String(k)}(${args.join(',')})`); };
    },
    set(t, k, v) {
      ops.push(`${String(k)}=${String(v)}`);
      return Reflect.set(t, k, v);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function vuOps(levels: number[]): string[] {
  const { ctx, ops } = recordingCtx2d(208, 96);
  drawVuMeters(ctx, levels, 208, 96);
  return ops;
}

describe('synesthesia face — the glyph is LIVE, GREEN, AND FALSE', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('synesthesia')).toBe(true);
  });

  it("HAS a primary audio output — the premise that removes dockscope's protection", () => {
    // dockscope declares `outputs: []`, so `primaryAudioOutPortId` returns null
    // and every glyph literal falls to `{kind:'static'}` for the dead-glyph
    // clause to catch. This module cannot be protected that way.
    expect(primaryAudioOutPortId(def)).toBe('a_band1_audio');
  });

  it('⚠ a declared glyph WOULD resolve LIVE — the trap no gate can see', () => {
    for (const glyph of ['meter', 'scope', 'waveform'] as const) {
      const probe = { ...def, face: { ...face, glyph } } as FaceDefLike;
      const b = glyphBinding(probe);
      // LIVE, not static — so the dead-glyph clause would pass it.
      expect(b.kind, `glyph '${glyph}' must resolve LIVE for this trap to exist`).toBe('live-audio');
      expect(b).toMatchObject({ portId: 'a_band1_audio' });
    }
  });

  it('⚠ and that port is ONE BAND OF ONE COPY — the reason the live picture is false', () => {
    const audioOuts = synesthesiaDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    // The tapped port is one of the module's audio taps…
    expect(audioOuts).toContain('a_band1_audio');
    // …and it is copy A, band 1 — so every OTHER copy/band tap is outside the
    // picture. Derived from the roster, never a typed count.
    const invisible = audioOuts.filter((id) => id !== 'a_band1_audio');
    expect(invisible.length).toBe(audioOuts.length - 1);
    expect(invisible).toEqual(
      COPIES.flatMap((c) => BANDS.map((b) => `${c}_band${b}_audio`)).filter(
        (id) => id !== 'a_band1_audio',
      ),
    );
    // And the env / gate / trigger / raster fans — the outputs a player actually
    // patches this module for — are not audio at all, so no glyph reaches them.
    expect(synesthesiaDef.outputs.length).toBeGreaterThan(audioOuts.length);
  });

  it("so it declares glyph 'none', and paints no lane glyph at all", () => {
    expect(face.glyph).toBe('none');
    // ⚠ `hasVideoSurface` is `domain === 'video'`, and this def is `audio`
    // despite owning video ports — so no live thumbnail arrives through the
    // other seam either, and the compact tier gets THREE cells, not two.
    expect(hasVideoSurface(def)).toBe(false);
    expect(laneGlyphFor(def)).toBe('none');
  });
});

describe('synesthesia face — the VU wall is the picture, and it is a READER', () => {
  it('routes the wall through a fullViewBody — the only seam that reaches read()', () => {
    expect(face.extension).toBe('synesthesia');
    const src = ext();
    expect(src).toContain('fullViewBody');
    // No glyph slot: the refusal above is the whole point of this extension.
    expect(src).not.toMatch(/\bglyph\s*:/);
  });

  it("the body draws through the MODULE's own pure function, not a second plot", () => {
    const src = body();
    expect(src).toContain('drawVuMeters');
    expect(src).toContain("read(n, 'snapshot')");
  });

  it('and it repaints through onMeterFrame, NOT a raw rAF', () => {
    const src = body();
    expect(src).toContain('onMeterFrame');
    expect(src).not.toContain('requestAnimationFrame');
  });

  it('⚠ NEITHER SURFACE pushes video levels — one writer, and it is not a surface', () => {
    // ⚠ THIS USED TO BE ABOUT THE BODY ALONE, and it was a real hazard: the card
    // owned the pump, the headless host kept the card alive, and a second writer
    // in this body would have posted two `video` messages per frame for one
    // node. The pump is the NODE's now
    // (`$lib/ui/media/frame-producers` — SYNESTHESIA_FRAME_PRODUCER), so the
    // same claim covers BOTH surfaces and is stronger for it.
    for (const [name, src] of [['body', body()], ['card', card()]] as const) {
      expect(src, `${name} must not push video levels`).not.toContain('video_levels');
      expect(src, `${name} must not write to the engine at all`).not.toMatch(/\beng\??\.write\(/);
    }
  });

  it('⚠ synesthesia has left the CARD-PRODUCER half entirely (legacy-removal S1)', () => {
    // ⚠ THE INVERSION OF WHAT THIS LEG USED TO ASSERT. It read "IN the producer
    // set (so the host exists at all) and NOT in the exemption, because this
    // face only VIEWS the meters" — true while a CARD was the only writer, and
    // the reason the headless host had to survive a dock open.
    //
    // The pixel path is node-lifetime now, so BOTH halves of that argument are
    // retired at once: there is no host to keep, and no exemption to withhold.
    expect(CARD_PRODUCER_LANE_TYPES.has('synesthesia')).toBe(false);
    // ANCHOR: something took ownership. Without this the assertion above is
    // also satisfied by the pump having been DELETED.
    expect(NODE_FRAME_PRODUCER_TYPES.has('synesthesia')).toBe(true);
    // ⚠ The per-lane-kind `needsHeadlessSourceMount` enumeration and its
    // permanent negative control STOOD HERE and retired with the decision and
    // `<HeadlessSourceHost>` themselves (legacy-removal S1.5): the producer
    // population emptied, so there is no card-owned subject left to control
    // with, and NO module gets an off-screen card on ANY lane kind — the
    // structural form of what the enumeration asserted. The set-emptiness that
    // structure rests on is pinned in dom-source-modules.test.ts and in
    // node-hls-source-registry.test.ts.
  });

  it('carries a SCREEN toggle whose state lives on the NODE, never in $state', () => {
    const src = body();
    expect(src).toContain('synesthesia-face-screen-toggle');
    expect(src).toContain('previewCollapsed');
    expect(src).toContain('mutateNode');
    // A `$state` here would die with the component on dock collapse / LRU
    // eviction, so the switch would forget itself on every tab switch — below
    // the owner's stated floor.
    expect(src).not.toMatch(/let\s+previewCollapsed\s*=\s*\$state/);
  });

  it('⚠ keeps READING while OFF — it skips the PAINT, never the loop', () => {
    const src = body();
    const guard = src.indexOf('if (previewCollapsed) return');
    const read = src.indexOf("read(n, 'snapshot')");
    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    // The read comes FIRST, so the accessible names keep tracking the graph
    // while the meters are collapsed.
    expect(read).toBeLessThan(guard);
  });

  it('⚠ the LEVELS live on aria-label and are painted NOWHERE', () => {
    const src = body();
    expect(src).toContain('aria-label={labelA}');
    expect(src).toContain('aria-label={labelB}');
    // The formatter's output must not also reach the markup as text.
    expect(src).not.toMatch(/>\s*\{labelA\}/);
    expect(src).not.toMatch(/\{levelLabel\(/);
  });
});

describe('synesthesia face — NO card gesture needs a CLICK the host cannot deliver', () => {
  // ⚠ THE SECOND HALF OF STOP 2, AND IT IS NOT THE OBVIOUS ONE.
  //
  // "Every affordance has a shell cell" is the half everyone checks. The half
  // that bit `cameraInput` is different: `synesthesia` is in
  // `CARD_PRODUCER_LANE_TYPES`, so after promotion its real card is still
  // MOUNTED — off-screen, in `HeadlessSourceHost`, which parks at
  // `left:-9999px` with `pointer-events: none` (HeadlessSourceHost.svelte:103).
  // So anything on that card that must merely KEEP RUNNING is fine, and
  // anything that must be PRESSED is unreachable. cameraInput's "Request
  // access" button was the only path to `getUserMedia` for a first-time
  // visitor, and its promotion had to BUILD a registry seam rather than argue
  // the point.
  //
  // SYNESTHESIA NEEDS NO SEAM, and the reason is structural rather than lucky:
  // this card has no non-param state at all. Asserted here, at the source,
  // because no runtime gate looks at a card that is no longer rendered.

  it('the card owns NO node.data, NO file input and NO device roster', () => {
    const src = card();
    // The samsloop shape (a `node.data`-backed loader), the cameraInput shape
    // (a service the card acquires), and the writeData shape — none present.
    expect(src).not.toMatch(/writeData|mutateNode|\bnode\.data\b|data\?\.\w+\s*=/);
    expect(src).not.toMatch(/<input\b|<select\b|accept=/);
  });

  it('⚠ every CLICKABLE thing on the card is a PARAM write, and every one is RANKED', () => {
    const src = card();
    // Every `onclick` on this card routes through one of these two handlers…
    const handlers = [...src.matchAll(/onclick=\{\(\)\s*=>\s*(\w+)\(/g)].map((m) => m[1]!);
    expect(new Set(handlers)).toEqual(new Set(['toggleMode', 'togglePolarity']));
    // …and both write a param through the ordinary graph seam, which is exactly
    // what a face cell does. No third gesture exists.
    expect(src).toMatch(/function toggleMode[\s\S]{0,220}set\(`\$\{c\}_mode`\)/);
    expect(src).toMatch(/function togglePolarity[\s\S]{0,220}set\(`\$\{c\}_bipolar`\)/);
    expect(src).toMatch(/const set = \(id_: string\) => \(v: number\) => setNodeParam\(/);
    // The four params those two handlers reach are all ranked, so the face
    // renders an interactive cell for each and the click has somewhere to go.
    for (const id of SWITCHES) expect(face.order).toContain(id);
  });

  it('⚠ the card work that had to SURVIVE has LEFT the card (legacy-removal S1)', () => {
    // ⚠ THIS LEG USED TO CONCLUDE THAT THE HOST WAS ENOUGH, and the reasoning
    // was sound for what it was answering: the video-levels pump is a LOOP, not
    // a gesture, so `pointer-events: none` is irrelevant to it — which is why an
    // off-screen card mount sufficed here and did not for cameraInput.
    //
    // "A loop that needs no gesture" is also the precise description of
    // something that never needed a card. The pump is
    // `$lib/ui/media/frame-producers` now, on the NODE, so the question the leg
    // was answering no longer arises — and the card is one step closer to being
    // deletable, which the host answer could never deliver.
    const src = card();
    expect(src, 'the pump is gone from the card entirely').not.toContain('video_levels');
    expect(NODE_FRAME_PRODUCER_TYPES.has('synesthesia'), 'and it went somewhere').toBe(true);
    // What REMAINS on the card is a repaint of levels the worklet already posts
    // — a view, and one the faceplate body duplicates by design.
    expect(src).toContain('requestAnimationFrame');
    expect(src).toContain("read(node, 'snapshot')");
    // NEGATIVE CONTROL on the instrument: the grep really can find a click, so
    // "no third gesture" above is a reading rather than an empty match.
    expect(src.match(/onclick=/g)?.length).toBeGreaterThan(0);
  });
});

describe('synesthesia face — the VU wall needs NO VRT seed, and that is derived', () => {
  it('drawVuMeters is a PURE function of its levels — same input, same ops', () => {
    const a = vuOps([0.2, 0.5, 0.9, 0.1]);
    const b = vuOps([0.2, 0.5, 0.9, 0.1]);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('⚠ NEGATIVE CONTROL: different levels DO move the ops', () => {
    // Without this, the equality above would pass on an instrument that records
    // nothing — "deterministic" and "blind" look identical from one comparison.
    expect(vuOps([0.2, 0.5, 0.9, 0.1])).not.toEqual(vuOps([0.9, 0.1, 0.2, 0.5]));
  });

  it('carries no clock, no peak hold and no decay — twice in a row is once', () => {
    // A second call with the SAME levels must not drift, which is what rules out
    // the hidden accumulator a meter usually has.
    const { ctx, ops } = recordingCtx2d(208, 96);
    drawVuMeters(ctx, [0.4, 0.4, 0.4, 0.4], 208, 96);
    const first = ops.length;
    drawVuMeters(ctx, [0.4, 0.4, 0.4, 0.4], 208, 96);
    expect(ops.slice(first)).toEqual(ops.slice(0, first));
  });

  it('the IDLE picture is what the VRT scene pins — silence lights nothing', () => {
    // The face harness suspends audio and nothing is patched, so the worklet
    // posts no levels and the factory's `[0,0,0,0]` stands. Every segment must
    // then be an OFF colour: that is the frame linux CI baselines.
    const ops = vuOps([0, 0, 0, 0]);
    const fills = ops.filter((o) => o.startsWith('fillStyle='));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((o) => o.includes('rgba('))).toBe(true);
    // NEGATIVE CONTROL — a lit meter really does use the solid hues, so the
    // "every fill is an OFF colour" test above can fail.
    expect(vuOps([1, 1, 1, 1]).some((o) => o === 'fillStyle=#22c55e')).toBe(true);
  });
});

describe('synesthesia face — the ranking is COPY-GROUPED, the bands are SIGNAL-ORDERED', () => {
  it('ranks every param exactly once', () => {
    const ids = synesthesiaDef.params.map((p) => p.id);
    expect([...face.order].sort()).toEqual([...ids].sort());
    expect(new Set(face.order).size).toBe(face.order.length);
  });

  it("⚠ copy A's block precedes copy B's ENTIRELY — the rank worth defending", () => {
    // The alternative (`a_master, b_master, a_gain1, b_gain1, …`) reads better
    // as a table and worse as an instrument. Asserted as a PROPERTY so the
    // argument in the def cannot quietly stop being true.
    const lastA = Math.max(...face.order.flatMap((k, i) => (k.startsWith('a_') ? [i] : [])));
    const firstB = Math.min(...face.order.flatMap((k, i) => (k.startsWith('b_') ? [i] : [])));
    expect(lastA).toBeLessThan(firstB);
  });

  it('within a copy, MASTER outranks MODE outranks the gains outranks the depths', () => {
    for (const c of COPIES) {
      const at = (id: string) => face.order.indexOf(id);
      expect(at(`${c}_master`)).toBeLessThan(at(`${c}_mode`));
      expect(at(`${c}_mode`)).toBeLessThan(at(`${c}_gain1`));
      expect(at(`${c}_gain4`)).toBeLessThan(at(`${c}_envdepth1`));
      expect(at(`${c}_envdepth4`)).toBeLessThan(at(`${c}_bipolar`));
    }
  });

  it('⚠ the lane tile paints CELLS even though there is no glyph', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const c = curatedFace(def, tier);
      expect(c!.controls.length, `${tier} must paint something`).toBeGreaterThan(0);
      // Each tier is a PREFIX of the ranking — no second list anywhere.
      expect(c!.controls.map((x) => x.key)).toEqual(face.order.slice(0, c!.controls.length));
    }
  });

  it('the DOCK shows all of them', () => {
    const plan = dockFacePlan(def)!;
    const keys = dockPlanControls(plan).map((c) => c.key);
    expect([...keys].sort()).toEqual([...face.order].sort());
  });

  it('declares FOUR bands, the copies as CLUSTERS in a ROW — not eight pages', () => {
    const plan = dockFacePlan(def)!;
    expect(plan.map((b) => b.id)).toEqual(['input', 'bands', 'env', 'polarity']);
    for (const band of plan) {
      // Two clusters per band, one per copy, side by side — the ~14 px
      // sub-header, not a ~81 px band each.
      expect(band.clusters.map((c) => c.label)).toEqual(['copy a', 'copy b']);
      expect(band.clusterFlow).toBe('row');
      // Everything is claimed by a cluster, so no cell floats loose beside them.
      expect(band.controls).toEqual([]);
    }
  });

  it('⚠ POLARITY IS ITS OWN BAND — a MEASUREMENT overturned the first authoring', () => {
    // It was first authored inside the `env out` clusters, on scope's `ch1Range`
    // argument: it shapes the same two cables DEPTH scales. The dock scene's
    // width assertion falsified the ARRANGEMENT, not the argument — a segmented
    // cell sitting in a cluster of four knobs reserved 149 CSS px of plate while
    // drawing 70, ablated in the live DOM one element at a time (hiding just
    // those two cells dropped `.faceplate-body` from 686 to 537, the identical
    // value as hiding the whole band). Pinned here so the split reads as
    // derived rather than as taste, and so re-merging them goes red in the unit
    // lane instead of only in a capture.
    const plan = dockFacePlan(def)!;
    const env = plan.find((b) => b.id === 'env')!;
    const pol = plan.find((b) => b.id === 'polarity')!;
    for (const c of COPIES) {
      const envCluster = env.clusters.find((x) => x.label === `copy ${c}`)!;
      expect(envCluster.controls.map((x) => x.key)).toEqual(
        BANDS.map((b) => `${c}_envdepth${b}`),
      );
      const polCluster = pol.clusters.find((x) => x.label === `copy ${c}`)!;
      expect(polCluster.controls.map((x) => x.key)).toEqual([`${c}_bipolar`]);
    }
    // The shape that made the difference: `env out` is now UNIFORM — every cell
    // in it is a plain knob, the same shape as `band gain`, which measured 537.
    const envKeys = env.clusters.flatMap((x) => x.controls.map((y) => y.key));
    expect(envKeys.every((k) => k.includes('_envdepth'))).toBe(true);
    expect(envKeys.some((k) => SWITCHES.includes(k))).toBe(false);
  });

  it('declares NO tab rail — and the count is not why', () => {
    expect(face.tabbed).toBeUndefined();
    // Three bands cannot reach the threshold anyway; the ARGUMENT is that 22
    // params here are four types in perfect A/B symmetry (control-REPETITIVE,
    // the mixmstrs shape), not many controls of DIFFERENT types.
    expect(dockFacePlan(def)!.length).toBeLessThan(DOCK_TAB_MIN_BANDS);
  });

  it('declares NO hero, NO momentary params, NO paramCells and NO bareCells', () => {
    expect(face.hero).toBeUndefined();
    expect(face.momentary).toBeUndefined();
    expect(face.paramCells).toBeUndefined();
    // The digit is the only thing separating four identical dials inside a
    // cluster — the tidyVco side of the ruling, not the mixmstrs side.
    expect(face.bareCells).toBeUndefined();
  });
});

describe('synesthesia face — the four switches are NAMED, and they LATCH', () => {
  it('mode and polarity carry the card\'s own words, verbatim', () => {
    for (const c of COPIES) {
      expect(param(`${c}_mode`).options?.map((o) => o.label)).toEqual(['AUDIO', 'VIDEO']);
      expect(param(`${c}_bipolar`).options?.map((o) => o.label)).toEqual(['UNI', 'BI']);
    }
  });

  it('every roster is DENSE, so `optionsExhaustive` is refused rather than omitted', () => {
    for (const id of SWITCHES) {
      const p = param(id);
      const steps = Math.round(p.max - p.min) + 1;
      expect(p.options?.length).toBe(steps);
      expect((p as { optionsExhaustive?: boolean }).optionsExhaustive).toBeUndefined();
      // The default must be a real option value, else the cell opens on a state
      // it cannot name.
      expect(p.options?.some((o) => o.value === p.defaultValue)).toBe(true);
    }
  });

  it('⚠ the READ SITE compares all four as LEVELS, with no edge detection anywhere', () => {
    const src = worklet();
    for (const id of SWITCHES) {
      expect(src).toContain(`this.kval(parameters, '${id}', 0) >= 0.5`);
    }
    // The classification is made at the read site, not from the 0/1 shape — so
    // the absence of an edge detector is the assertion, not a vibe.
    expect(src).not.toMatch(/createEdgeCounter|risingEdge|prevGate/);
  });

  it('the module declares no gate INPUT that could make any of them momentary', () => {
    expect(synesthesiaDef.inputs.some((i) => i.type === 'gate')).toBe(false);
  });
});

describe('synesthesia face — the rear rail groups 48 jacks by COPY', () => {
  it('declares one OUTPUT group per copy, each with an explicit direction', () => {
    const groups = face.rear?.groups ?? [];
    expect(groups.map((g) => g.id)).toEqual(['copy-a', 'copy-b']);
    // ⚠ `direction` DEFAULTS to 'input'; an output group that forgets it
    // resolves to no port and silently never renders.
    expect(groups.every((g) => g.direction === 'output')).toBe(true);
  });

  it('the two groups claim EVERY output between them, exactly once', () => {
    const claimed = (face.rear?.groups ?? []).flatMap((g) => [...g.ports]);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual(synesthesiaDef.outputs.map((o) => o.id).sort());
  });

  it('the INPUTS are left DERIVED — four jacks in the leading signal band', () => {
    expect((face.rear?.groups ?? []).every((g) => g.direction === 'output')).toBe(true);
    const { inputs } = rearFieldPlan(def as never);
    expect(inputs.map((s) => s.id)).toEqual(['signal']);
    expect(inputs[0]!.holes.map((h) => h.portId).sort()).toEqual(
      synesthesiaDef.inputs.map((i) => i.id).sort(),
    );
  });

  it('no output section label is a PREFIX of another on the same rail', () => {
    const labels = rearFieldPlan(def as never).outputs.map((s) => s.label.toLowerCase());
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        expect(b.startsWith(a), `'${b}' starts with '${a}'`).toBe(false);
      }
    }
  });
});
