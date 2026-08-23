// shell-glyph-live.test.ts — the LIVE glyph binding gates:
//   1. glyphBinding rules (pure): the six P1 batch-1 face shapes resolve to
//      the right live source (audio tap / env params / wave morph), and the
//      DUAL capability (param-wave + live trace) for shape-identity
//      oscillators (tidyVco's saw↔pulse morph set).
//   2. createShellGlyphTap lifecycle: VISIBLE (reads happening) → the tap
//      attaches a passive analyser to the module's output; HIDDEN (no reads
//      for the idle window) → the tap RELEASES itself; a later read
//      re-attaches; dispose() is terminal. Deterministic via fake timers.
//   3. createLiveWaveSource — the TRANSIENT-READ binding: a change in what
//      the live reader returns (no store commit anywhere) yields a NEW
//      derived buffer; an unchanged tuple returns the SAME buffer identity
//      (the consumer's repaint gate).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  glyphBinding,
  primaryAudioOutPortId,
  createShellGlyphTap,
  createLiveWaveSource,
  GLYPH_TAP_IDLE_RELEASE_MS,
  GLYPH_TAP_FFT_SIZE,
  type GlyphDefLike,
  type GlyphTapEngineLike,
} from './shell-glyph-live';
import { sawPulseMixWaveSamples } from '$lib/ui/controls/scope-screen-model';
import { tidyVcoDef } from '$lib/audio/modules/tidy-vco';
import { kickdrumDef } from '$lib/audio/modules/kickdrum';
import { adsrDef } from '$lib/audio/modules/adsr';
import { vcaDef } from '$lib/audio/modules/vca';
import { lfoDef } from '$lib/audio/modules/lfo';
import { LFO_DEPTH_GAIN } from '$lib/audio/modules/lfo-face-model';
import { cloudseedDef } from '$lib/audio/modules/cloudseed';
import { pongDef } from '$lib/audio/modules/pong';

// ── 1. binding rules ─────────────────────────────────────────────────────────

function faceDef(
  partial: Partial<GlyphDefLike> & {
    glyph: 'scope' | 'meter' | 'envelope' | 'waveform' | 'algorithm' | 'none';
    glyphDepthGain?: number;
    // ⚠ ADDED WITH THE LAYOUT-SOURCE WIDENING. The helper used to DROP this,
    // which meant an extension-fed case could not be expressed at all — the
    // fixture silently built a def without the very field under test.
    extension?: string;
  },
): GlyphDefLike {
  return {
    face: {
      order: [],
      glyph: partial.glyph,
      glyphDepthGain: partial.glyphDepthGain,
      extension: partial.extension,
    },
    outputs: partial.outputs ?? [],
    params: partial.params ?? [],
  };
}

describe('glyphBinding — pure live-source resolution', () => {
  it('waveform glyph + audio output WITHOUT the full morph set → live-audio on the PRIMARY audio port', () => {
    // shape1 alone (no pw/mix) is not a saw↔pulse osc identity — plain trace.
    const def = faceDef({
      glyph: 'waveform',
      outputs: [
        { id: 'out_l', type: 'audio' },
        { id: 'out_r', type: 'audio' },
      ],
      params: [{ id: 'shape1', min: 0, max: 1 }],
    });
    expect(glyphBinding(def)).toEqual({ kind: 'live-audio', portId: 'out_l' });
  });

  it('waveform glyph + audio output + the saw↔pulse morph set → DUAL (param-wave + live trace)', () => {
    const def = faceDef({
      glyph: 'waveform',
      outputs: [
        { id: 'out_l', type: 'audio' },
        { id: 'out_r', type: 'audio' },
      ],
      params: [
        { id: 'shape1', min: 0, max: 1 },
        { id: 'shape2', min: 0, max: 1 },
        { id: 'pw', min: 0.05, max: 0.5 },
        { id: 'mix', min: 0, max: 1 },
      ],
    });
    expect(glyphBinding(def)).toEqual({
      kind: 'dual',
      portId: 'out_l',
      wave: { law: 'saw-pulse-mix', shape1: 'shape1', shape2: 'shape2', pw: 'pw', mix: 'mix' },
    });
    // shape2 is optional (a single-osc morph voice still gets the dual face)…
    const singleOsc = faceDef({
      glyph: 'waveform',
      outputs: [{ id: 'out', type: 'audio' }],
      params: [
        { id: 'shape1', min: 0, max: 1 },
        { id: 'pw', min: 0.05, max: 0.5 },
        { id: 'mix', min: 0, max: 1 },
      ],
    });
    expect(glyphBinding(singleOsc)).toEqual({
      kind: 'dual',
      portId: 'out',
      wave: { law: 'saw-pulse-mix', shape1: 'shape1', shape2: undefined, pw: 'pw', mix: 'mix' },
    });
    // …but a non-0..1 shape1 (not the saw↔pulse law) stays a plain live trace.
    const wrongLaw = faceDef({
      glyph: 'waveform',
      outputs: [{ id: 'out', type: 'audio' }],
      params: [
        { id: 'shape1', min: 0, max: 2 },
        { id: 'pw', min: 0.05, max: 0.5 },
        { id: 'mix', min: 0, max: 1 },
      ],
    });
    expect(glyphBinding(wrongLaw)).toEqual({ kind: 'live-audio', portId: 'out' });
    // …and a non-'waveform' glyph never goes dual even with the params (scope/meter faces).
    const scopeGlyph = faceDef({
      glyph: 'scope',
      outputs: [{ id: 'out', type: 'audio' }],
      params: [
        { id: 'shape1', min: 0, max: 1 },
        { id: 'pw', min: 0.05, max: 0.5 },
        { id: 'mix', min: 0, max: 1 },
      ],
    });
    expect(glyphBinding(scopeGlyph)).toEqual({ kind: 'live-audio', portId: 'out' });
  });

  it('scope glyph + audio output → live-audio (kickdrum)', () => {
    const def = faceDef({
      glyph: 'scope',
      outputs: [
        { id: 'audio_l', type: 'audio' },
        { id: 'audio_r', type: 'audio' },
      ],
    });
    expect(glyphBinding(def)).toEqual({ kind: 'live-audio', portId: 'audio_l' });
  });

  it('meter glyph + audio output → live-audio RMS (vca / cloudseed)', () => {
    const def = faceDef({
      glyph: 'meter',
      outputs: [
        { id: 'audio', type: 'audio' },
        { id: 'audio_inv', type: 'audio' },
      ],
    });
    expect(glyphBinding(def)).toEqual({ kind: 'live-audio', portId: 'audio' });
  });

  it('envelope glyph + real A/D/S/R params → env-params, even with CV-only outputs (adsr)', () => {
    const def = faceDef({
      glyph: 'envelope',
      outputs: [
        { id: 'env', type: 'cv' },
        { id: 'env_inv', type: 'cv' },
      ],
      params: [
        { id: 'attack', min: 0.001, max: 10 },
        { id: 'decay', min: 0.001, max: 10 },
        { id: 'sustain', min: 0, max: 1 },
        { id: 'release', min: 0.001, max: 10 },
      ],
    });
    expect(glyphBinding(def)).toEqual({
      kind: 'env-params',
      attack: 'attack',
      decay: 'decay',
      sustain: 'sustain',
      release: 'release',
    });
  });

  it('waveform glyph, CV-only outputs, a 0..2 shape morph param → wave-morph + depth swing (lfo)', () => {
    const shapeAndDepth = {
      glyph: 'waveform' as const,
      outputs: [{ id: 'phase0', type: 'cv' }],
      params: [
        { id: 'rate', min: 0.01, max: 100 },
        { id: 'shape', min: 0, max: 2 },
        { id: 'depth', min: 0, max: 1 },
      ],
    };
    // ⚠ THE MULTIPLIER IS THE MODULE'S, NOT THIS RESOLVER'S. It used to be a
    // `depthGain: LFO_DEPTH_GAIN` literal in `glyphBinding`, which meant the
    // SECOND module to declare this glyph shape silently inherited the lfo's
    // ×2 — and a test asserting `LFO_DEPTH_GAIN` on every row (this one did)
    // passes no matter what the number is. So: an UNDECLARED face gets 1, and
    // a face declaring its own law gets that law. Neither fixture is the lfo.
    expect(glyphBinding(faceDef({ ...shapeAndDepth }))).toEqual({
      kind: 'wave-morph',
      shapeParamId: 'shape',
      depthParamId: 'depth',
      depthGain: 1,
    });
    expect(
      glyphBinding(faceDef({ ...shapeAndDepth, glyphDepthGain: 7 })),
    ).toEqual({
      kind: 'wave-morph',
      shapeParamId: 'shape',
      depthParamId: 'depth',
      depthGain: 7,
    });
  });

  it('falls back to static for a glyph with no live seam, and none without a glyph', () => {
    expect(glyphBinding(faceDef({ glyph: 'waveform', outputs: [{ id: 'x', type: 'cv' }] }))).toEqual({ kind: 'static' });
    expect(glyphBinding(faceDef({ glyph: 'envelope' }))).toEqual({ kind: 'static' });
    expect(glyphBinding(faceDef({ glyph: 'none' }))).toEqual({ kind: 'none' });
    expect(glyphBinding(undefined)).toEqual({ kind: 'none' });
    expect(glyphBinding({ outputs: [{ id: 'out', type: 'audio' }] })).toEqual({ kind: 'none' });
  });

  it('locks the REAL P1 batch-1 defs to their intended live bindings', () => {
    expect(glyphBinding(tidyVcoDef)).toEqual({
      kind: 'dual',
      portId: 'out_l',
      wave: { law: 'saw-pulse-mix', shape1: 'shape1', shape2: 'shape2', pw: 'pw', mix: 'mix' },
    });
    expect(glyphBinding(kickdrumDef)).toEqual({ kind: 'live-audio', portId: 'audio_l' });
    expect(glyphBinding(vcaDef)).toEqual({ kind: 'live-audio', portId: 'audio' });
    expect(glyphBinding(cloudseedDef)).toEqual({ kind: 'live-audio', portId: 'out_l' });
    expect(glyphBinding(adsrDef)).toEqual({
      kind: 'env-params',
      attack: 'attack',
      decay: 'decay',
      sustain: 'sustain',
      release: 'release',
    });
    // The DEPTH multiplier rides the binding so the generic shell never types
    // it — but it comes off the LFO'S OWN `face.glyphDepthGain`, so this row
    // is a real wiring check only in combination with the fixture rows above,
    // which prove a def that does NOT declare one gets 1 rather than the lfo's.
    expect(glyphBinding(lfoDef)).toEqual({
      kind: 'wave-morph',
      shapeParamId: 'shape',
      depthParamId: 'depth',
      depthGain: LFO_DEPTH_GAIN,
    });
    expect(lfoDef.face?.glyphDepthGain, 'the lfo declares its own law on its face').toBe(LFO_DEPTH_GAIN);
    expect(LFO_DEPTH_GAIN, 'the worklet law: gain = max(0,depth) * 2').toBe(2);
  });

  it('algorithm glyph + an algorithm param → TOPOLOGY, BEATING the audio-out short-circuit', () => {
    // THE ORDERING IS THE MECHANISM (PF-15). Every topology-bearing module is a
    // sound SOURCE, so it always has a primary audio output — resolve the
    // `if (audioOut) return live-audio` short-circuit first and this branch is
    // dead code that silently paints the very trace it exists to replace: at
    // 64 px an FM trace looks the same for every patch AND flatlines whenever
    // nothing is gated, which is most of the time you are looking at a rack.
    const def = faceDef({
      glyph: 'algorithm',
      outputs: [{ id: 'out_l', type: 'audio' }, { id: 'out_r', type: 'audio' }],
      params: [{ id: 'algorithm', min: 1, max: 32 }, { id: 'feedback', min: 0, max: 7 }],
    });
    // ⚠ THE SHAPE WIDENED (2026-08-23) and this assertion moved WITH it rather
    // than being loosened: the binding now names WHAT FEEDS THE PICTURE. For dx7
    // that is the `algorithm` param itself, so `layoutSource` is 'algorithm' and
    // `paramId` is unchanged — the param is both the topology and the caption.
    expect(glyphBinding(def)).toEqual({
      kind: 'algorithm',
      layoutSource: 'algorithm',
      paramId: 'algorithm',
    });

    // Sanity: the SAME def with any other glyph does take the audio short-circuit,
    // so the assertion above is about the branch order and nothing else.
    expect(glyphBinding({ ...def, face: { order: [], glyph: 'scope' } })).toEqual({
      kind: 'live-audio',
      portId: 'out_l',
    });
  });

  it('algorithm glyph with NEITHER a param NOR an extension still falls back to static', () => {
    // ⚠ THE REFUSAL IS PRESERVED, and that is the half a widening most easily
    // loses. A def that declares the literal but supplies nothing to draw with
    // must still fall to `static` — never to a trace, and never to a topology
    // binding pointing at nothing.
    const def = faceDef({
      glyph: 'algorithm',
      outputs: [{ id: 'out_l', type: 'audio' }],
      params: [{ id: 'level', min: 0, max: 1 }],
    });
    expect(glyphBinding(def)).toEqual({ kind: 'static' });
  });

  it('algorithm glyph + an EXTENSION and no param → topology fed by the extension, caption-less', () => {
    // ⚠ THE POINT OF THE WIDENING, and the case that did not exist before it.
    // A module whose picture is a pure layout function it owns had NO legal glyph
    // literal at all: every other one falls through to a dead `static` and reddens
    // the dead-glyph clause, so such modules were forced to declare 'none' and
    // show nothing. Five modules are in that position today.
    const def = faceDef({
      glyph: 'algorithm',
      extension: 'somemodule',
      outputs: [{ id: 'out_l', type: 'audio' }],
      params: [{ id: 'level', min: 0, max: 1 }],
    });
    expect(glyphBinding(def)).toEqual({
      kind: 'algorithm',
      layoutSource: 'somemodule',
      // ⚠ NULL, DELIBERATELY. There is no param behind the picture, so there is
      // no value to caption it with. Printing one would be inventing a number.
      paramId: null,
    });
  });

  it('a PARAM outranks an extension — dx7 keeps its captioned form', () => {
    // Both present: the param wins, because it carries a value a player reads and
    // a CV sweep visibly tracks. Without this ordering, adding an extension to a
    // captioned module would silently delete its caption.
    const def = faceDef({
      glyph: 'algorithm',
      extension: 'dx7',
      outputs: [{ id: 'out_l', type: 'audio' }],
      params: [{ id: 'algorithm', min: 1, max: 32 }],
    });
    // Narrow before reading — GlyphBinding is a union and the assertion is about
    // WHICH member resolved as much as about its fields.
    const bound = glyphBinding(def);
    expect(bound.kind).toBe('algorithm');
    if (bound.kind !== 'algorithm') throw new Error('expected a topology binding');
    expect(bound.layoutSource).toBe('algorithm');
    expect(bound.paramId).toBe('algorithm');
  });

  it('THE REAL ADOPTER: pongDef resolves the layout-source form, and it is not the dead static', () => {
    // ⚠ THE FIXTURE LEGS ABOVE PROVE THE RESOLVER; THIS ONE PROVES A SHIPPING
    // MODULE REACHES IT. `faceDef({ extension: 'somemodule' })` would keep
    // passing if every real def in the tree still declared `glyph: 'none'` —
    // which is exactly the state #2160 shipped in, by design: it widened the
    // branch and deliberately changed no pixel anywhere, so for one merge window
    // this whole section was green with ZERO real modules bound to it.
    //
    // pong is the first adopter, so this row is what makes the widening load
    // -bearing rather than latent. It is the same shape as the "locks the REAL
    // P1 batch-1 defs" leg above, and it fails if pong's def OR its extension
    // declaration regresses to the placeholder tile.
    expect(glyphBinding(pongDef)).toEqual({
      kind: 'algorithm',
      // The EXTENSION id, not a param — pong's picture is a layout function it
      // owns (`pong/pong-glyph-model.ts`), reached through the `glyph` slot.
      layoutSource: 'pong',
      // No param behind the picture ⇒ no caption. A court has no number.
      paramId: null,
    });

    // ⚠ THE OTHER DIRECTION, and the one a forward-only assertion cannot see: a
    // def that merely STOPS declaring the pair silently returns to a dead
    // binding, and `{kind:'static'}` is what the shell paints as a live-looking
    // readout of nothing. Deny it by name on the real def.
    expect(
      glyphBinding(pongDef).kind,
      'pong resolved the DEAD static binding — the lane tile would paint a fixed trace instead ' +
        'of its court, which is the pre-#2160 behaviour this adopter exists to end',
    ).not.toBe('static');

    // The extension id the binding NAMES must be the one the def DECLARES —
    // anchored to the artifact, so a rename of the directory that missed the def
    // (or vice versa) is red here rather than a blank tile in the rack.
    // ⚠ That the named extension actually EXPORTS a glyph component is asserted
    // by `shell-extensions.test.ts`'s derived sweep over every 'algorithm' def,
    // which pong now enters by declaration rather than by being listed.
    expect(pongDef.face?.extension).toBe('pong');
  });

  it('an EMPTY extension id is not a layout source', () => {
    // Negative control on the guard: a falsy/blank id must not resolve a topology
    // binding that points at nothing to load.
    const def = faceDef({
      glyph: 'algorithm',
      extension: '',
      outputs: [{ id: 'out_l', type: 'audio' }],
      params: [{ id: 'level', min: 0, max: 1 }],
    });
    expect(glyphBinding(def)).toEqual({ kind: 'static' });
  });

  it('primaryAudioOutPortId picks the first AUDIO output, skipping CV', () => {
    expect(
      primaryAudioOutPortId({ outputs: [{ id: 'env', type: 'cv' }, { id: 'out', type: 'audio' }] }),
    ).toBe('out');
    expect(primaryAudioOutPortId({ outputs: [{ id: 'env', type: 'cv' }] })).toBeNull();
    expect(primaryAudioOutPortId(undefined)).toBeNull();
  });
});

// ── 2. tap lifecycle ─────────────────────────────────────────────────────────

interface FakeSource {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakeEngine(fill = 0.5) {
  const source: FakeSource = { connect: vi.fn(), disconnect: vi.fn() };
  const analysers: Array<{ fftSize: number; smoothingTimeConstant: number }> = [];
  const audio = {
    ctx: {
      createAnalyser() {
        const a = {
          fftSize: 0,
          smoothingTimeConstant: 1,
          getFloatTimeDomainData(b: Float32Array) {
            b.fill(fill);
          },
        };
        analysers.push(a);
        return a as unknown as AnalyserNode;
      },
    } as unknown as BaseAudioContext,
    getOutputNode: vi.fn(
      (): { node: AudioNode; output: number } | null => ({ node: source as unknown as AudioNode, output: 0 }),
    ),
  };
  const engine: GlyphTapEngineLike = {
    hasDomain: (d: string) => d === 'audio',
    getDomain: <T,>() => audio as unknown as T,
  };
  return { engine, source, audio, analysers };
}

describe('createShellGlyphTap — visible→mounted, hidden→released', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches LAZILY on the first read (a passive analyser on the output), not at construction', () => {
    const { engine, source } = makeFakeEngine();
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    expect(tap.attached()).toBe(false);
    expect(source.connect).not.toHaveBeenCalled();

    const samples = tap.getSamples();
    expect(tap.attached()).toBe(true);
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples!.length).toBe(GLYPH_TAP_FFT_SIZE);
    expect(samples![0]).toBeCloseTo(0.5);
    tap.dispose();
  });

  it('releases itself after the idle window with no reads (hidden tile), and re-attaches on the next read', () => {
    const { engine, source } = makeFakeEngine();
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    tap.getSamples();
    expect(tap.attached()).toBe(true);

    // Hidden: the visibility-gated ticker stops reading → idle release.
    vi.advanceTimersByTime(GLYPH_TAP_IDLE_RELEASE_MS * 2);
    expect(tap.attached()).toBe(false);
    expect(source.disconnect).toHaveBeenCalledTimes(1);

    // Visible again: the next read re-attaches a fresh tap.
    tap.getSamples();
    expect(tap.attached()).toBe(true);
    expect(source.connect).toHaveBeenCalledTimes(2);
    tap.dispose();
  });

  it('stays attached while reads keep arriving (visible tile)', () => {
    const { engine, source } = makeFakeEngine();
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    for (let i = 0; i < 8; i++) {
      tap.getLevel();
      vi.advanceTimersByTime(GLYPH_TAP_IDLE_RELEASE_MS / 4);
    }
    expect(tap.attached()).toBe(true);
    expect(source.disconnect).not.toHaveBeenCalled();
    tap.dispose();
  });

  it('getLevel reads the RMS of the analyser window', () => {
    const { engine } = makeFakeEngine(0.5);
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    expect(tap.getLevel()).toBeCloseTo(0.5, 5); // RMS of a constant 0.5 buffer
    tap.dispose();
  });

  it('returns undefined/0 without an engine, then attaches once the engine appears', () => {
    const { engine } = makeFakeEngine();
    let booted: GlyphTapEngineLike | null = null;
    const tap = createShellGlyphTap(() => booted, 'n1', 'out_l');
    expect(tap.getSamples()).toBeUndefined();
    expect(tap.getLevel()).toBe(0);
    expect(tap.attached()).toBe(false);

    booted = engine;
    expect(tap.getSamples()).toBeInstanceOf(Float32Array);
    expect(tap.attached()).toBe(true);
    tap.dispose();
  });

  it('returns undefined while the node is not materialized (getOutputNode null)', () => {
    const { engine, audio } = makeFakeEngine();
    audio.getOutputNode.mockReturnValueOnce(null);
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    expect(tap.getSamples()).toBeUndefined();
    expect(tap.attached()).toBe(false);
    // Materialized on a later reconcile pass → attaches.
    expect(tap.getSamples()).toBeInstanceOf(Float32Array);
    tap.dispose();
  });

  it('re-taps when the node is re-materialized under the same id (output node identity change)', () => {
    const { engine, source, audio } = makeFakeEngine();
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    tap.getSamples();
    expect(source.connect).toHaveBeenCalledTimes(1);

    const source2: FakeSource = { connect: vi.fn(), disconnect: vi.fn() };
    audio.getOutputNode.mockReturnValue({ node: source2 as unknown as AudioNode, output: 0 });
    tap.getSamples();
    expect(source.disconnect).toHaveBeenCalledTimes(1); // old tap released
    expect(source2.connect).toHaveBeenCalledTimes(1); // new node tapped
    tap.dispose();
  });

  it('dispose() releases the analyser + idle timer and is terminal (no re-attach)', () => {
    const { engine, source } = makeFakeEngine();
    const tap = createShellGlyphTap(() => engine, 'n1', 'out_l');
    tap.getSamples();
    tap.dispose();
    expect(tap.attached()).toBe(false);
    expect(source.disconnect).toHaveBeenCalledTimes(1);

    expect(tap.getSamples()).toBeUndefined();
    expect(tap.getLevel()).toBe(0);
    expect(tap.attached()).toBe(false);
    expect(source.connect).toHaveBeenCalledTimes(1); // never re-attached
    expect(vi.getTimerCount()).toBe(0); // idle timer cleared
  });
});

// ── 3. the transient-read wave source (live-while-twisting) ────────────────

describe('createLiveWaveSource — the dual glyph’s TRANSIENT-READ binding', () => {
  it('a transient value change re-derives the samples WITHOUT any commit', () => {
    // The "engine" here is a bare mutable value — the live seam the reader
    // polls. Nothing ever writes a store/node.params: the changed READ alone
    // must re-render (a knob mid-gesture streams transients exactly like this).
    const live = { shape1: 0, shape2: 0, pw: 0.5, mix: 0 };
    const get = createLiveWaveSource(
      () => [live.shape1, live.shape2, live.pw, live.mix],
      (v) => sawPulseMixWaveSamples(v[0] ?? 0, v[1], v[2], v[3]),
    );

    const before = get();
    expect(Array.from(before)).toEqual(
      Array.from(sawPulseMixWaveSamples(0, 0, 0.5, 0)),
    );

    live.shape1 = 0.8; // transient twist — no commit anywhere
    const during = get();
    expect(during).not.toBe(before);
    expect(Array.from(during)).not.toEqual(Array.from(before));
    expect(Array.from(during)).toEqual(
      Array.from(sawPulseMixWaveSamples(0.8, 0, 0.5, 0)),
    );
  });

  it('an unchanged tuple returns the SAME buffer identity (the repaint gate)', () => {
    const live = { shape1: 0.3, depth: 0.5 };
    const compute = vi.fn((v: readonly number[]) => sawPulseMixWaveSamples(v[0] ?? 0));
    const get = createLiveWaveSource(() => [live.shape1, live.depth], compute);

    const a = get();
    const b = get();
    const c = get();
    expect(b).toBe(a); // identity-stable → the polled consumer skips the repaint
    expect(c).toBe(a);
    expect(compute).toHaveBeenCalledTimes(1); // memoized — one derivation

    live.depth = 0.9; // ANY tuple member moving re-derives
    expect(get()).not.toBe(a);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
