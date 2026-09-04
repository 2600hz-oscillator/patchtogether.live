// packages/web/src/lib/ui/modules/scope-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the SCOPE faceplate.
//
// ⚠ THIS FILE EXISTS BECAUSE NO GATE MAKES THIS FACE'S CENTRAL DECISION, and
// that is the exact inverse of its sibling. `dockscope-face-model.test.ts`
// records a refusal the PLATFORM enforces: with `outputs: []` a declared glyph
// falls to `{kind:'static'}` and the unconditional dead-glyph clause catches
// it, so an author who never thought about it still ships the right thing.
//
// SCOPE HAS NO SUCH PROTECTION. `ch1_out` is a declared `audio` output, so
// `glyphBinding` short-circuits to `{ kind: 'live-audio', portId: 'ch1_out' }`.
// The binding is LIVE. The dead-glyph clause is GREEN. `VALID_GLYPHS` is
// satisfied. Nothing anywhere reddens — and the trace would still be wrong,
// because `ch1_out` IS the CH1 input gain and nothing ever writes it, so the
// picture is invariant to all nine of this module's controls.
//
// So the first describe below asserts BOTH halves at the mechanism: that the
// binding really does resolve live (the thing that makes the trap possible),
// and that the passthrough identity really holds at the handle (the thing that
// makes it blind). If a later change broke either — an output removed, a gain
// written — the glyph decision gets re-made deliberately instead of left stale.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { scopeDef } from '$lib/audio/modules/scope';
import {
  drawScope,
  isInTune,
  tuningPixelX,
  TUNING_CENTS_SPAN,
  TUNING_IN_TUNE_CENTS,
  type ScopeDrawParams,
  type ScopeSnapshot,
} from '$lib/audio/modules/scope-draw';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { declaredParamCells, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { laneGlyphFor, hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { RAW_WRITE_LEDGER } from '$lib/graph/raw-write-ledger';
import { NODE_FRAME_PRODUCER_TYPES } from '$lib/ui/media/frame-producers';
import { CARD_PRODUCER_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import {
  resolvePushCardControls,
  pushCardParams,
} from '$lib/control/push2/push-card-schema';
import type { ModuleNode } from '$lib/graph/types';

const def = scopeDef as unknown as FaceDefLike & { type: string };

function param(id: string) {
  const p = scopeDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`scope has no param '${id}'`);
  return p;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'scope/ScopeScreenBody.svelte');
const DRAW_SRC = resolve(HERE, '../../audio/modules/scope-draw.ts');
/** THE trace — one renderer for the card, this body and `GroupCard`'s
 *  viz-passthrough mount (legacy-removal S1). */
const SURFACE = readFileSync(resolve(HERE, 'scope/ScopeTraceSurface.svelte'), 'utf8');
/** The node-lifetime owner of the cvCombined push the surfaces used to run. */
const PRODUCERS_SRC = readFileSync(resolve(HERE, '../media/frame-producers.ts'), 'utf8');

const ALL_PARAM_IDS = scopeDef.params.map((p) => p.id);

// ── A FAKE CONTEXT THAT RECORDS EVERY GAIN WRITE ─────────────────────────────
//
// The passthrough claim is about IDENTITY and about ABSENCE — `ch1_out` is the
// same node as `ch1`, and its `.gain` is never written — so the instrument has
// to be able to observe a write that does not happen. A plain stub cannot; this
// one traps the setter.
function makeRecordingCtx() {
  const gainWrites: string[] = [];
  let gainIndex = 0;
  function gainNode(): unknown {
    const name = `gain${++gainIndex}`;
    const g = {
      value: 1,
      setValueAtTime(v: number) { gainWrites.push(`${name}.setValueAtTime(${v})`); },
      linearRampToValueAtTime(v: number) { gainWrites.push(`${name}.ramp(${v})`); },
    };
    return {
      __name: name,
      gain: new Proxy(g, {
        set(t, k, v) {
          if (k === 'value') gainWrites.push(`${name}.gain.value=${String(v)}`);
          return Reflect.set(t, k, v);
        },
      }),
      connect() {}, disconnect() {},
    };
  }
  function analyser(): unknown {
    return {
      fftSize: 2048, smoothingTimeConstant: 0,
      connect() {}, disconnect() {},
      getFloatTimeDomainData(buf: Float32Array) { buf.fill(0); },
    };
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => gainNode(),
    createAnalyser: () => analyser(),
    createConstantSource: () => ({
      offset: { value: 0 }, start() {}, stop() {}, connect() {}, disconnect() {},
    }),
  } as unknown as AudioContext;
  return { ctx, gainWrites };
}

async function handleWith(params: Record<string, number> = {}) {
  const { ctx, gainWrites } = makeRecordingCtx();
  const node = { id: 'sc', type: 'scope', domain: 'audio', params } as unknown as ModuleNode;
  return { handle: await scopeDef.factory(ctx, node), gainWrites };
}

// ── A 2D CONTEXT THAT RECORDS ITS OPS ────────────────────────────────────────
//
// Used to prove the tuning graticule only ever APPENDS to the render — the
// property that keeps the card, the video bridge and every committed baseline
// pixel-identical.
function recordingCtx2d(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = {
    canvas: { width: 480, height: 360 },
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k as string];
      if (k === 'save' || k === 'restore' || k === 'beginPath' || k === 'stroke'
        || k === 'fill' || k === 'closePath') {
        return () => { ops.push(String(k)); };
      }
      if (k === 'setLineDash') return (a: number[]) => { ops.push(`setLineDash(${a.join(',')})`); };
      return (...args: unknown[]) => { ops.push(`${String(k)}(${args.join(',')})`); };
    },
    set(t, k, v) {
      ops.push(`${String(k)}=${String(v)}`);
      return Reflect.set(t, k, v);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function snapshot(): ScopeSnapshot {
  const n = 2048;
  const ch1 = new Float32Array(n);
  const ch2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ch1[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
    ch2[i] = Math.sin((2 * Math.PI * 330 * i) / 48000);
  }
  return { ch1, ch2, sampleRate: 48000 };
}

function baseParams(over: Partial<ScopeDrawParams> = {}): ScopeDrawParams {
  return {
    timeMs: 20, ch1Scale: 1, ch1Offset: 0, ch1Range: 0,
    ch2Scale: 1, ch2Offset: 0, ch2Range: 0, mode: 0, intensity: 0.5,
    ...over,
  };
}

describe('scope face — the glyph is LIVE, GREEN, AND FALSE', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('scope')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it('HAS a primary audio output — the premise that removes dockscope\'s protection', () => {
    // Asserted first and on its own, because everything below depends on it.
    // The moment this stops being true, scope inherits the mechanical refusal
    // and this whole file's argument changes shape.
    expect(primaryAudioOutPortId(scopeDef as Parameters<typeof primaryAudioOutPortId>[0]))
      .toBe('ch1_out');
  });

  it("⚠ a declared 'scope' glyph WOULD resolve LIVE — the trap no gate can see", () => {
    // ⚠ THE PERMANENT NEGATIVE CONTROL, and the inverse of dockscope's. Take
    // the real def, give it the glyph the migration inventory once recommended,
    // and ask the real resolver what it produces. `live-audio` — not `static`,
    // so the unconditional dead-glyph clause has nothing to catch, and the face
    // would have shipped green with a picture that is not this module's trace.
    const withScopeGlyph = {
      ...scopeDef,
      face: { ...(scopeDef.face ?? {}), glyph: 'scope' },
    } as unknown as Parameters<typeof glyphBinding>[0];
    const b = glyphBinding(withScopeGlyph);
    expect(b.kind, 'a live binding is exactly what makes this dangerous').toBe('live-audio');
    expect(b.kind, 'and NOT the static placeholder dockscope falls to').not.toBe('static');
    expect((b as { portId?: string }).portId).toBe('ch1_out');
  });

  it('⚠ and that port is BIT-EXACTLY the CH1 INPUT — measured at the handle', () => {
    // The other half of the trap: the binding is live, and what it is live ON
    // is the module's own input. Same node object, so the glyph would tap the
    // signal BEFORE any of this module's display maths — which is why the
    // picture would be invariant to every control.
    return handleWith().then(({ handle }) => {
      const inNode = handle.inputs?.get('ch1')?.node;
      const outNode = handle.outputs?.get('ch1_out')?.node;
      expect(inNode, 'ch1 in and ch1_out are ONE GainNode').toBe(outNode);
      const in2 = handle.inputs?.get('ch2')?.node;
      const out2 = handle.outputs?.get('ch2_out')?.node;
      expect(in2).toBe(out2);
      // And the passthrough gain is never one of the CV shadows' nodes, so a
      // cable cannot land on it either.
      for (const id of ALL_PARAM_IDS) {
        expect(handle.inputs?.get(id)?.node, `shadow '${id}' is not the passthrough`)
          .not.toBe(outNode);
      }
    });
  });

  it('⚠ and NO param write touches that gain — swept across all nine', () => {
    // The absence half, negative-controlled: write every param at both ends of
    // its range and confirm the recorder saw no write to the two passthrough
    // gains. `setParam` writes the CV shadows instead, which is what makes this
    // module display-only BY CONSTRUCTION rather than by discipline.
    return handleWith().then(({ handle, gainWrites }) => {
      const before = gainWrites.length;
      for (const p of scopeDef.params) {
        handle.setParam?.(p.id, p.min);
        handle.setParam?.(p.id, p.max);
      }
      const passthroughWrites = gainWrites
        .slice(before)
        .filter((w) => w.startsWith('gain1.') || w.startsWith('gain2.'));
      expect(passthroughWrites, 'a param write must never reach the audio path')
        .toEqual([]);
    });
  });

  it("so it declares glyph 'none', and paints no lane glyph at all", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def), 'an audio def gets no video thumb either').toBe(false);
    expect(laneGlyphFor(def as Parameters<typeof laneGlyphFor>[0])).toBe('none');
  });

  it('routes the trace through a fullViewBody — the only seam that reaches it', () => {
    expect(def.face?.extension).toBe('scope');
    const body = readFileSync(BODY_SRC, 'utf8');
    // ⚠ THE BODY MOUNTS THE TRACE, IT DOES NOT DRAW IT (legacy-removal S1). The
    // read/paint pair moved to `scope/ScopeTraceSurface.svelte`, so asserting
    // `read(n,'snapshot')` here would now be asserting a re-implementation.
    expect(body).toMatch(/<ScopeTraceSurface/);
    expect(body).toMatch(/import ScopeTraceSurface from '\.\/ScopeTraceSurface\.svelte'/);
  });

  it("the trace draws through the MODULE's own pure function, not a second plot", () => {
    // ⚠ FOUR SURFACES SHARED `drawScope` AND NOW ONE FILE CALLS IT. The legacy
    // card, this body and `GroupCard`'s viz-passthrough mount each carried their
    // own copy of the seed/snapshot/paint trio — one pasted from the next,
    // agreeing exactly because of that. `ScopeTraceSurface` is the only caller
    // outside the module's own cross-domain `drawFrame` now, so the "how would
    // they drift" question has one fewer way to be answered.
    expect(SURFACE).toMatch(/import \{ drawScope/);
    expect(SURFACE).toMatch(/drawScope\(/);
    // ...and the two former call sites really did stop drawing.
    expect(readFileSync(BODY_SRC, 'utf8')).not.toMatch(/drawScope\(/);
  });

  it('the trace honours the VRT seed — one surface, so the card and face CANNOT diverge', () => {
    // ⚠ THIS LEG USED TO COMPARE TWO IMPLEMENTATIONS AND NOW ANCHORS ONE. It
    // asserted the body and the card read the SAME global with the SAME
    // defaults, because a body that seeded differently would paint a different
    // figure from the card under the identical harness — and `_shell-faces.ts`
    // pins `simPin: __scopeVrtSeed` on both. With a single renderer that class
    // of divergence is structurally gone; what still has to be true is that the
    // renderer honours the seed at all, or every scope baseline — card AND face
    // — goes nondeterministic on an unlocked Lissajous.
    expect(SURFACE).toMatch(/__scopeVrtSeed/);
    for (const frag of ['ch1Freq ?? 220', 'ch2Freq ?? 330', 'ch2Phase ?? 0']) {
      expect(SURFACE, `surface seed default '${frag}'`).toContain(frag);
    }
  });

  it('⚠ NOTHING ON THE FACE PATH PUSHES cvCombined — the NODE owns it now', () => {
    // ⚠ THE INVERSION OF WHAT THIS LEG USED TO ASSERT, and the reason is worth
    // reading rather than diffing. It required the body to PUSH the combined
    // (knob + CV) params before reading them back, because a param that was
    // under CV when the pump stopped LATCHES at its last modulated value — so a
    // docked scope with a patched TIME cable would draw on a stale timebase.
    //
    // That was correct while the push was a SURFACE's job, and it made the body
    // the SECOND writer of one engine channel (the card was the first). The push
    // is `$lib/ui/media/frame-producers`' `SCOPE_FRAME_PRODUCER` now, running on
    // GRAPH lifetime, so there is exactly one writer and no surface can stop it.
    // Two writers agreeing is not a property; one writer is.
    const body = stripSourceComments(readFileSync(BODY_SRC, 'utf8'));
    for (const [name, src] of [['body', body], ['surface', stripSourceComments(SURFACE)]] as const) {
      expect(src, `${name} must not write cvCombined — the node producer owns it`)
        .not.toMatch(/cvCombined/);
    }
    // ANCHOR: the owner really exists and really is registered, so this leg
    // cannot pass by the push having been DELETED rather than MOVED.
    expect(NODE_FRAME_PRODUCER_TYPES.has('scope'), 'scope has a node-lifetime producer').toBe(true);
    expect(
      CARD_PRODUCER_LANE_TYPES.has('scope'),
      'and it therefore left the card-producer set — the two halves are one change',
    ).toBe(false);
    expect(PRODUCERS_SRC, 'the producer pushes the combined record it reads')
      .toMatch(/write\(node, 'cvCombined', combined\)/);
    expect(PRODUCERS_SRC, 'from `readParam`, which is knob PLUS the engine CV tap')
      .toMatch(/readParam\(node, p\.id\)/);
  });

  it('and the trace repaints through onMeterFrame, NOT a raw rAF', () => {
    // `RasterizeOutputBody`'s ungated loop is exempt because its painter is
    // advanced INSIDE the engine read. Scope has no such inversion — reading a
    // snapshot mutates nothing — so copying that exemption would ship an
    // ungated full-canvas redraw on a collapsed dock.
    //
    // ⚠ AND THE GATE IS RIGHT *HERE* WHILE BEING WRONG FOR THE PRODUCER, which
    // is the distinction the extraction turns on. `onMeterFrame` skips a
    // subscriber whose element is off-screen: correct for a PAINT, and fatal for
    // a push that feeds a downstream chain. That is why the surface keeps the
    // gate and the node producer runs on an ungated shared ticker.
    const surface = stripSourceComments(SURFACE);
    expect(surface).toMatch(/onMeterFrame\(/);
    expect(surface).not.toMatch(/requestAnimationFrame/);
  });
});

describe('scope face — the rank, and the lane it implies', () => {
  it('ranks every param exactly once', () => {
    expect(def.face?.order).toEqual([
      'timeMs',
      'ch1Scale', 'ch1Offset', 'ch1Range',
      'ch2Scale', 'ch2Offset', 'ch2Range',
      'mode',
      'intensity',
    ]);
    expect([...(def.face?.order ?? [])].sort()).toEqual([...ALL_PARAM_IDS].sort());
  });

  it('the DOCK shows all of them, and each lane tier is a PREFIX of the ranking', () => {
    const ranked = [...(def.face?.order ?? [])];
    expect(curatedFace(def, 'dock')!.controls.map((c) => c.key)).toEqual(ranked);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const shown = curatedFace(def, tier)!.controls.map((c) => c.key);
      expect(shown, `lane tier '${tier}' is a prefix of the ranking`)
        .toEqual(ranked.slice(0, shown.length));
      expect(shown.length, `lane tier '${tier}' shows at least the top control`)
        .toBeGreaterThan(0);
    }
  });

  it('⚠ the lane tile paints CELLS even though there is no glyph', () => {
    // The shape `module-face-lint` denies is a tile with neither. scope ranks
    // nine ordinary scalars, so the tile paints.
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(curatedFace(def, tier)!.controls.length, `lane tier '${tier}'`).toBeGreaterThan(0);
    }
  });

  it('declares THREE bands, channels as CLUSTERS in a ROW — not pages', () => {
    const pages = def.face?.pages ?? [];
    expect(pages.map((p) => p.id)).toEqual(['timebase', 'channels', 'beam']);
    expect(dockFacePlan(def)!).toHaveLength(3);
    const channels = pages.find((p) => p.id === 'channels')!;
    expect(channels.clusters?.map((c) => c.label)).toEqual(['CH 1', 'CH 2']);
    expect(channels.clusterFlow).toBe('row');
    // Cluster membership is a HINT over keys the band already claims — never a
    // second place to add controls.
    const claimed = new Set(channels.controls);
    for (const c of channels.clusters ?? []) {
      for (const k of c.controls) expect(claimed.has(k), `${k} is in the band`).toBe(true);
    }
  });

  it('⚠ `mode` sits in TIMEBASE, beside the other control that defines the X axis', () => {
    const pages = def.face?.pages ?? [];
    expect(pages.find((p) => p.id === 'timebase')!.controls).toEqual(['timeMs', 'mode']);
    expect(pages.find((p) => p.id === 'channels')!.controls).not.toContain('mode');
  });

  it('declares NO tab rail — three bands cannot reach DOCK_TAB_MIN_BANDS anyway', () => {
    expect((def.face as { tabbed?: boolean } | undefined)?.tabbed).toBeUndefined();
  });

  it('declares the six CONTINUOUS controls as FADERS and the three switches as neither', () => {
    // Nothing in a ParamDef separates "a throw" from any other continuous
    // scalar, so an undeclared face silently swaps every one for a dial.
    const cells = declaredParamCells(def);
    expect([...cells.keys()].sort()).toEqual(
      ['ch1Offset', 'ch1Scale', 'ch2Offset', 'ch2Scale', 'intensity', 'timeMs'],
    );
    for (const [, kind] of cells) expect(kind).toBe('fader');
    for (const id of ['ch1Range', 'ch2Range', 'mode']) {
      expect(cells.has(id), `${id} keeps its two-state shape`).toBe(false);
    }
  });

  it('declares NO momentary params and NO bareCells', () => {
    expect([...momentaryParamIds(def)]).toEqual([]);
    expect((def.face as { bareCells?: readonly string[] } | undefined)?.bareCells)
      .toBeUndefined();
  });
});

describe('scope face — three NAMED MODE switches, and all three LATCH', () => {
  it('both range switches carry the AUDIO/CV roster, word for word with dockscope', () => {
    for (const id of ['ch1Range', 'ch2Range']) {
      const p = param(id);
      expect(p.options?.map((o) => o.label), id).toEqual(['AUDIO', 'CV']);
      expect(p.options?.map((o) => o.value), id).toEqual([0, 1]);
    }
  });

  it('`mode` carries SPLIT/XY, and its LABEL no longer collides with its own state', () => {
    const p = param('mode');
    expect(p.options?.map((o) => o.label)).toEqual(['SPLIT', 'XY']);
    expect(p.label, 'a cell captioned XY whose position reads XY says nothing').not.toBe('XY');
    expect(p.label).toBe('Mode');
  });

  it('all three keep the two-state shape the toggle primitive resolves from', () => {
    for (const id of ['ch1Range', 'ch2Range', 'mode']) {
      const p = param(id);
      expect(p.min, id).toBe(0);
      expect(p.max, id).toBe(1);
      expect(p.curve, id).toBe('discrete');
    }
  });

  it('⚠ the READ SITE compares all three as LEVELS, with no edge detection anywhere', () => {
    // The classification is made where the value is consumed, not from its
    // shape. Asserted against the source so that adding an edge detector later
    // reddens the classification instead of silently invalidating it.
    const draw = readFileSync(DRAW_SRC, 'utf8');
    expect(draw, 'mode is a level').toMatch(/params\.mode\s*\?\?\s*0\)\s*>=\s*0\.5/);
    expect(draw, 'ch1Range is a level').toMatch(/params\.ch1Range\s*\?\?\s*0\)\s*>=\s*0\.5/);
    expect(draw, 'ch2Range is a level').toMatch(/params\.ch2Range\s*\?\?\s*0\)\s*>=\s*0\.5/);
    expect(draw, 'no rising-edge machinery in the trace path')
      .not.toMatch(/lastTrig|edgeCount|createEdgeCounter/);
  });

  it('the module declares no gate input that could make any of them momentary', () => {
    expect(scopeDef.inputs.every((p) => p.type !== 'gate')).toBe(true);
  });
});

describe('scope face — the SCREEN switch: required by the ruling, invisible to its gate', () => {
  const body = stripSourceComments(readFileSync(BODY_SRC, 'utf8'));

  it('⚠ NO GATE CAN SEE THIS SWITCH — recorded so the hole is known, not discovered', () => {
    // `video-face-screen-source.test.ts` builds its subject as
    // `listVideoModuleDefs() ∩ STRICT_FACES`. This is an AUDIO def, so it is out
    // of that subject BY CONSTRUCTION and owes no exemption entry — and a
    // future edit deleting the switch would go green everywhere. The assertions
    // below are the only thing that would not.
    expect(scopeDef.domain).toBe('audio');
  });

  it('carries a SCREEN toggle whose state lives on the NODE, never in $state', () => {
    // This component unmounts on dock collapse and LRU eviction, so component
    // state would not survive the very gesture the ruling says must persist
    // across tabs (#1531 / #1574 / #1583).
    expect(body).toMatch(/previewCollapsed/);
    expect(body).toMatch(/SCREEN/);
    expect(body).toMatch(/aria-pressed=\{!previewCollapsed\}/);
    expect(body).toMatch(/mutateNode\(/);
    expect(body, 'the collapse state is derived from node.data, not held locally')
      .toMatch(/\$derived<boolean>\(\s*\(patch\.nodes\[nodeId\]\?\.data\?\.previewCollapsed/);
    expect(body).not.toMatch(/previewCollapsed\s*=\s*\$state/);
  });

  it('⚠ keeps RENDERING while OFF — and it is now STRUCTURAL, not an ordering', () => {
    // The owner's floor, satisfied a different way (legacy-removal S1) and the
    // change is worth reading rather than diffing.
    //
    // WHAT THIS ASSERTED BEFORE: the body ran the cvCombined push and the
    // module's own `drawFrame` reads the same shadows that push fills — so
    // stopping the loop on collapse would have desynced the `out` texture from
    // the controls, a preview toggle acting as a producer kill switch. The only
    // way to state that in source was an ORDER: push, then bail, then paint.
    //
    // WHAT IT ASSERTS NOW: the body cannot reach `out` at all. The producer is
    // `$lib/ui/media/frame-producers` on GRAPH lifetime, so SCREEN OFF may
    // unmount the whole trace and the texture is unaffected by construction. An
    // ordering assertion over code that no longer writes anything would be a
    // gate with nothing behind it.
    expect(body, 'the collapse really does remove the picture')
      .toMatch(/\{#if !previewCollapsed\}/);
    expect(body, 'and the body writes NOTHING to the engine — no push to order')
      .not.toMatch(/\.write\(/);
    // ANCHOR: the producer that took it over exists and is registered, so this
    // leg cannot pass because the push was DELETED rather than MOVED.
    expect(NODE_FRAME_PRODUCER_TYPES.has('scope')).toBe(true);
  });

  it('and carries no watch mark, because there is no pull set to fall out of', () => {
    expect(body).not.toMatch(/markWatched/);
    expect(body).not.toMatch(/blitOutputForPreview/);
  });
});

describe('scope face — the TUNER moved INTO the instrument', () => {
  it('⚠ the graticule only ever APPENDS — the card and the video bridge are untouched', () => {
    // The load-bearing property. `ScopeCard` and the cross-domain `drawFrame`
    // both call `drawScope` WITHOUT `tuning`, so every committed card and
    // composite baseline stays valid — and the INTENSITY default's
    // pixel-identical legacy short-circuit is preserved. Proven by op-log
    // prefix rather than claimed: adding the strip may only add ops at the end.
    const without = recordingCtx2d();
    drawScope(without.ctx, snapshot(), baseParams(), 480, 360);
    const withStrip = recordingCtx2d();
    drawScope(
      withStrip.ctx, snapshot(),
      baseParams({ tuning: { note: 'A4', cents: 3 } }),
      480, 360,
    );
    expect(withStrip.ops.slice(0, without.ops.length)).toEqual(without.ops);
    expect(withStrip.ops.length, 'the strip really did draw something')
      .toBeGreaterThan(without.ops.length);
  });

  it('⚠ NEGATIVE CONTROL: the same holds on the PHOSPHOR path, not just the legacy one', () => {
    // One call site after the dispatch is what makes this true for both. A
    // graticule wired into only one branch would pass the leg above and paint
    // nothing off the default intensity.
    const without = recordingCtx2d();
    drawScope(without.ctx, snapshot(), baseParams({ intensity: 1 }), 480, 360);
    const withStrip = recordingCtx2d();
    drawScope(
      withStrip.ctx, snapshot(),
      baseParams({ intensity: 1, tuning: { note: 'A4', cents: 3 } }),
      480, 360,
    );
    expect(withStrip.ops.slice(0, without.ops.length)).toEqual(without.ops);
    expect(withStrip.ops.length).toBeGreaterThan(without.ops.length);
  });

  it('the IDLE state is DRAWN, not skipped — silence is a picture, not an absence', () => {
    // If the strip vanished on silence, "the tuner found nothing" and "the
    // tuner is not on this surface" would be the same picture, and the state
    // matrix's row-8 negative control would be unobservable.
    const without = recordingCtx2d();
    drawScope(without.ctx, snapshot(), baseParams(), 480, 360);
    const idle = recordingCtx2d();
    drawScope(
      idle.ctx, snapshot(),
      baseParams({ tuning: { note: null, cents: null } }),
      480, 360,
    );
    expect(idle.ops.length).toBeGreaterThan(without.ops.length);
    expect(idle.ops.join('|'), 'the em-dash placeholder names the condition')
      .toContain('fillText(—');
  });

  it('the marker geometry pins its endpoints, and CLAMPS beyond them', () => {
    expect(tuningPixelX(0, 480)).toBe(240);
    expect(tuningPixelX(-TUNING_CENTS_SPAN, 480)).toBe(0);
    expect(tuningPixelX(TUNING_CENTS_SPAN, 480)).toBe(480);
    // A marker drawn off-canvas is indistinguishable from no marker at all.
    expect(tuningPixelX(-500, 480)).toBe(0);
    expect(tuningPixelX(500, 480)).toBe(480);
  });

  it('the in-tune window is the card\'s own, and NULL is idle rather than in tune', () => {
    expect(isInTune(0)).toBe(true);
    expect(isInTune(TUNING_IN_TUNE_CENTS)).toBe(true);
    expect(isInTune(TUNING_IN_TUNE_CENTS + 0.1)).toBe(false);
    expect(isInTune(-TUNING_IN_TUNE_CENTS)).toBe(true);
    expect(isInTune(null), 'no pitch is not "in tune"').toBe(false);
  });

  it('⚠ the NUMBERS live on aria-label and are painted NOWHERE', () => {
    // The card's `PITCH 440.0 Hz | NOTE A4` row is the HERO READOUT STRIP shape
    // deleted fleet-wide. It is not carried, not hidden, and not made opt-in:
    // the Hz / cents / confidence survive only as an accessible name, which is
    // speakable and assertable and unpainted.
    const body = stripSourceComments(readFileSync(BODY_SRC, 'utf8'));
    expect(body).toMatch(/aria-label=\{tuningLabel\}/);
    expect(body).toMatch(/Hz/);
    expect(body).toMatch(/cents/);
    // The only markup text nodes on this surface are the SCREEN caption. A
    // template that interpolated the pitch into the DOM would trip this.
    expect(body, 'no Hz text node in the markup')
      .not.toMatch(/>\s*\{[^}]*pitch\.hz[^}]*\}/);
    expect(body, 'the strip element paints nothing itself')
      .toMatch(/class="tuning-a11y"[\s\S]*?><\/div>/);
  });

  it('the strip draws only the NOTE letter — a name, never a measurement', () => {
    const withStrip = recordingCtx2d();
    drawScope(
      withStrip.ctx, snapshot(),
      baseParams({ tuning: { note: 'A4', cents: 3 } }),
      480, 360,
    );
    const texts = withStrip.ops.filter((o) => o.startsWith('fillText('));
    // `±1.0` twice (the two channels' corner scale labels, which name the
    // ch{1,2}Range control's own position) plus the note letter. No Hz, no
    // cents, no confidence.
    expect(texts.some((t) => t.includes('A4'))).toBe(true);
    for (const t of texts) {
      expect(t, `'${t}' must not print a measurement`).not.toMatch(/Hz|cents|conf/i);
    }
  });
});

describe('scope face — the RAW-WRITE DEBT stays paid', () => {
  // ⚠ 'the XY toggle now writes through setNodeParam' STOOD HERE, reading the
  // card for `function toggleXY() { setNodeParam(id, 'mode'` and denying a bare
  // `.params.mode =` beside it. A bare proxy assignment runs with origin
  // `null`; the UndoManager tracks only LOCAL_ORIGIN, so that write was neither
  // undoable nor tagged for collaborators, while `toggleRange` three lines down
  // always was. The surface that carried it is gone, and the shell writes every
  // param through `shellParamWrite` — so the untracked write has no
  // module-local place to come back to, and `mutate.guard.test.ts` holds the
  // rule tree-wide.
  //
  // The LEDGER half is kept, because a ledger entry naming a paid debt is the
  // thing that rots. It is asserted below, and it is worth noting WHY #2025's
  // argument was wrong at the time and is right now: it claimed a face paid
  // this debt by construction, and `raw-write-ledger.ts` refuted that by name,
  // because promotion did not delete the card. The fleet deletion does.
  it('⚠ the ledger names no scope card entry', () => {
    expect(Object.keys(RAW_WRITE_LEDGER)).not.toContain('ui/modules/ScopeCard.svelte');
  });
});

describe('scope face — the PUSH CARD it silently re-ranks', () => {
  it('⚠ OBSERVED, NOT DISCOVERED: authoring the face moves scope to the FACE tier', () => {
    // `push-card-config.ts` resolves tier 2 from `face.order` absent an
    // override, so authoring a face CHANGES this module's Push 2 card. scope
    // has no `PUSH_CARD_CONTROLS` entry and needs none — the ranking gives a
    // sensible eight — but the change is pinned here rather than left to be
    // found on the hardware. `intensity` (rank 9, display feel only) is the one
    // control that falls off; `mode` is the one that arrives.
    const spec = resolvePushCardControls(
      scopeDef as unknown as Parameters<typeof resolvePushCardControls>[0], {},
    );
    expect(spec.source).toBe('face');
    expect(pushCardParams(spec).map((p) => p.id)).toEqual([
      'timeMs',
      'ch1Scale', 'ch1Offset', 'ch1Range',
      'ch2Scale', 'ch2Offset', 'ch2Range',
      'mode',
    ]);
  });
});
