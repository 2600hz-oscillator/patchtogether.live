// packages/web/src/lib/audio/modules/wavecel.ts
//
// WAVECEL — stereo wavetable VCO with morph + spread + wavefolder. Distinct
// from the existing wavetableVco (more advanced: stereo, spread, fold, runtime
// upload of E352-format WAV files). Card UI provides a 3D wavetable
// visualization mode in addition to the standard scope view.
//
// DSP: packages/dsp/src/wavecel.ts (TS AudioWorklet, no Faust — wavetable
// playback + per-sample interpolation + spread mixing + wavefolder
// composition is cleaner in JS).
//
// Wavetable selection lives in node.data (rides Y.Doc out to every rack-mate
// + persisted by Hocuspocus snapshots). Same shape as the DX7 preset pattern:
// the host polls livePatch.nodes[id].data and reposts via port.postMessage on
// change. Frames are stored as plain JS number[][] — never Yjs proxies —
// because structuredClone over postMessage chokes on Yjs Y.Array proxies
// (DX7 SYX bug from PR-94).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4.
//   fm (audio): audio-rate FM modulator.
//   morph_cv (cv, linear, paramTarget=morph): displaces the wavetable morph position.
//   spread_cv (cv, linear, paramTarget=spread): displaces the stereo spread (detune voices).
//   fold_cv (cv, linear, paramTarget=fold): displaces the wavefold amount.
//   poly (polyPitchGate): 5-voice chord bus from MIDI LANE (mode='poly') /
//     POLYSEQZ. When ANY lane is gated WAVECEL renders one wavetable voice per
//     gated lane at that lane's pitch and SUMS them — polyphonic. The morph /
//     spread / fold timbre is shared across all voices. Unpatched (or no gate) →
//     the mono `pitch` path runs unchanged (back-compat).
//
// Outputs:
//   out_l (audio): left channel of the stereo wavetable.
//   out_r (audio): right channel.
//   scope_out (mono-video): scope-style waveform trace.
//   wave3d_out (video): 3D wavetable surface render (animates with morph).
//
// Params:
//   tune (linear -36..36 st, default 0): coarse tune semitones.
//   fine (linear -100..100 ¢, default 0): fine tune cents.
//   morph (linear 0..1, default 0): wavetable frame morph position.
//   spread (linear 1..5, default 1): stereo voice spread (detune width).
//   fold (linear 0..1, default 0): wavefolder amount.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/wavecel.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  getFactoryTables,
  DEFAULT_FACTORY_TABLE_ID,
  type FactoryTable,
} from '$lib/audio/wavetable-factory-tables';
import { drawWave3D, drawWaveScope } from './wavecel-draw';

const POLL_MS = 200;

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface WavecelData {
  /** Either 'factory:<id>' (bundled synth table) or 'user' (uploaded WAV
   *  whose frames live in `wavetableFrames`). Default = first factory. */
  wavetableSource?: string;
  /** Plain JS arrays so Yjs sync + postMessage structuredClone work
   *  reliably (PR-94 DX7 SYX bug: Yjs proxies fail structuredClone). */
  wavetableFrames?: number[][];
  /** Optional friendly name for an uploaded table — shown in the card. */
  wavetableLabel?: string;
}

interface ResolvedFrames {
  frames: Float32Array[];
  label: string;
  /** Stable signature for cheap change detection in the poll loop. */
  signature: string;
}

function resolveFrames(data: WavecelData | undefined): ResolvedFrames {
  const src = data?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
  if (src === 'user' && Array.isArray(data?.wavetableFrames)) {
    return {
      frames: framesFromPlain(data!.wavetableFrames!),
      label: data?.wavetableLabel ?? 'USER',
      signature: `user:${data!.wavetableFrames!.length}:${data?.wavetableLabel ?? ''}`,
    };
  }
  if (src.startsWith('factory:')) {
    const id = src.slice('factory:'.length);
    const t = getFactoryTable(id) ?? getFactoryTable(DEFAULT_FACTORY_TABLE_ID);
    if (t) {
      return {
        frames: t.frames.map((f) => new Float32Array(f)),
        label: t.label,
        signature: `factory:${t.id}`,
      };
    }
  }
  const fb = getFactoryTables()[0]!;
  return {
    frames: fb.frames.map((f) => new Float32Array(f)),
    label: fb.label,
    signature: `factory:${fb.id}`,
  };
}

// Module-grouping Phase 3A: `vizPassthrough` is available on AudioModuleDef
// for WAVECEL's 3D wavetable visualization canvas. Left UNSET until the
// card adopts the `data-viz-passthrough` <canvas> contract used by
// ScopeCard for GroupCard portal-hoisting.
export const wavecelDef: AudioModuleDef = {
  type: 'wavecel',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'wavecel',
  category: 'sources',
  stereoPairs: [['out_l', 'out_r']],

  // Chain-role (Design-D declarative override): a DECLARED source. Its lone
  // audio input (fm) is MODULATION, not a signal-chain insert — WITHOUT this the
  // port inference reads that single audio-in as a "main in" and mis-bins the
  // oscillator as an FX. Declare 'source' so it is a head-eligible SOURCE
  // (it also takes poly/trigger for clip note control).
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'pitch',     type: 'pitch' },
    { id: 'fm',        type: 'audio' },
    // CV → AudioParam routings per .myrobots/plans/cv-range-standard.md:
    //   morph (0..1) + fold (0..1) are linear; spread (1..5) is also linear
    //   so fractional CV smoothly cross-fades adjacent taps (discrete would
    //   click at integer crossings).
    { id: 'morph_cv',  type: 'cv',    paramTarget: 'morph',  cvScale: { mode: 'linear' } },
    { id: 'spread_cv', type: 'cv',    paramTarget: 'spread', cvScale: { mode: 'linear' } },
    { id: 'fold_cv',   type: 'cv',    paramTarget: 'fold',   cvScale: { mode: 'linear' } },
    // Polyphonic chord bus (5 voice pairs of pitch+gate over 10 channels). When
    // gated, WAVECEL renders one wavetable voice per lane → polyphonic; mono
    // `pitch` is the fallback when nothing is patched here. Engine routes this
    // 10-channel cable to ONE worklet input (index 5) — same shape as DX7.poly.
    { id: 'poly',      type: 'polyPitchGate' },
    // Mono TRIGGER gate for the per-voice amplitude ADSR (input 6). A level gate
    // so note-off→release is expressible. The FIRST rising edge turns WAVECEL
    // into a gated voice (lane-0 envelope); before any note (and when unpatched)
    // it free-runs as a drone.
    { id: 'trigger',   type: 'gate' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
    // Cross-domain video outputs. The on-card visualizer toggle picks
    // between scope/3D for preview only — the two video ports below
    // ALWAYS render their respective views regardless of the card
    // toggle. See packages/web/src/lib/audio/modules/wavecel-draw.ts
    // (shared with the card) + the videoSources bridge below.
    //   - scope_out: single-color trace on a dark background (mono-video).
    //   - wave3d_out: orange polylines + white active frame (RGB video).
    { id: 'scope_out',  type: 'mono-video' },
    { id: 'wave3d_out', type: 'video' },
  ],
  params: [
    { id: 'tune',   label: 'Tune',  defaultValue: 0, min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',   label: 'Fine',  defaultValue: 0, min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph',  label: 'Morph', defaultValue: 0, min: 0,    max: 1,   curve: 'linear' },
    { id: 'spread', label: 'Sprd',  defaultValue: 1, min: 1,    max: 5,   curve: 'linear' },
    { id: 'fold',   label: 'Fold',  defaultValue: 0, min: 0,    max: 1,   curve: 'linear' },
    // Per-voice amplitude ADSR (per-voice-ADSR feature). A single A/D/S/R set
    // feeds all 5 lane envelopes (poly) + lane-0 (mono TRIGGER). Defaults
    // ~pass-through so an untouched ADSR + an ungated/unpatched TRIGGER keeps
    // WAVECEL's legacy mono drone byte-identical; the env only shapes amplitude
    // once a poly lane or the TRIGGER fires.
    { id: 'attack',  label: 'A', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
    // BASE VOL — per-voice VCA FLOOR the ADSR rides on top of: gain =
    // base + (1-base)*env per ACTIVE voice. Sits next to the ADSR. Default 1 →
    // gain=1, the env does nothing → the raw-VCO drone (nothing patched) is
    // byte-identical (back-compat / unchanged ART+VRT baselines). 0 → pure ADSR
    // (silent between notes); 0.5 → floors at 0.5, rises to 1.0 as the env peaks.
    { id: 'base_vol', label: 'Base', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  // DYNAMIC, DOM-only controls (no ParamDef): the wavetable selector cluster +
  // the visualizer mode toggle. Each is a SINGLE stable-testid control on the
  // card (not an indexed grid), declared here as a one-member 'other' family so
  // the living-docs layer can SEE + document it (the unit guard greps the card
  // source for each `testidPrefix`, so a declared control can't drift off the
  // card). Documented via the `<id>-{n}` templates in docs.controls below.
  controlFamilies: [
    { id: 'wavecel-source-select', label: 'Factory wavetable selector', kind: 'other', testidPrefix: 'wavecel-source-select' },
    { id: 'wavecel-preset-select', label: 'Built-in preset loader',      kind: 'other', testidPrefix: 'wavecel-preset-select' },
    { id: 'wavecel-wav-input',     label: 'WAV upload',                  kind: 'other', testidPrefix: 'wavecel-wav-input' },
    { id: 'wavecel-viz-toggle',    label: 'Scope / 3D view toggle',      kind: 'other', testidPrefix: 'wavecel-viz-toggle' },
  ],

  docs: {
    explanation:
      "A stereo WAVETABLE oscillator: it scans through a stack of single-cycle waveforms (a wavetable) and plays back the one MORPH points at, smoothly cross-fading between adjacent frames so turning MORPH sweeps the timbre. SPREAD layers several detuned copies of the voice across the stereo field for a wide, chorused image, and FOLD runs the result through a wavefolder to fold the peaks back on themselves and add bright harmonics. It is polyphonic: patch a poly chord bus into POLY and it renders one wavetable voice per gated lane at that lane's pitch and sums them (the morph/spread/fold timbre is shared across all voices); with nothing in POLY it plays the single mono PITCH. A per-voice amplitude ADSR (A/D/S/R) rides on top of a BASE-volume floor and shapes each note once a poly lane or the TRIG gate fires — at the default BASE of 1 the envelope does nothing and WAVECEL is a continuous drone. Load one of the factory wavetables, pick a built-in preset, or upload your own WAV, and watch the on-card screen as either an oscilloscope trace or an animated 3D view of the whole table.",
    inputs: {
      pitch:
        "1V/octave pitch CV setting the oscillator's frequency (0V = C4), summed with the Tune and Fine knobs. This is the MONO voice and is used whenever nothing is gating the POLY input.",
      fm:
        "Audio-rate frequency-modulation input: the incoming signal modulates the oscillator's pitch for FM/cross-mod timbres (patch another oscillator here for classic FM sidebands).",
      morph_cv:
        "CV that offsets the Morph control, sliding the wavetable scan position up or down so an LFO or envelope can sweep the timbre hands-free (added to the knob, then clamped to 0..1).",
      spread_cv:
        "CV that offsets the Spread control, widening or narrowing the detuned stereo spread under modulation (added to the knob, then clamped to the 1..5 range).",
      fold_cv:
        "CV that offsets the Fold control, driving the wavefolder harder or softer over time for evolving brightness (added to the knob, then clamped to 0..1).",
      poly:
        "The polyphonic chord bus from a poly source (MIDI LANE in poly mode / POLYSEQZ): each lane carries a pitch plus a note-on/off gate, and while a lane's gate is high WAVECEL renders one wavetable voice at that lane's pitch and sums all the gated voices into the stereo output — so a held chord plays a chord. The per-voice ADSR opens on each lane's note-on and releases on its note-off. When nothing is patched here (or no lane is gated) WAVECEL falls back to the single mono PITCH path unchanged.",
      trigger:
        "A mono note GATE for the per-voice amplitude envelope: while the level is high the note is held — a rising edge starts the ADSR attack (note-on) and the falling edge starts its release (note-off) — so it is level-sensitive, not just a one-shot. The first rising edge turns WAVECEL into a gated voice (it tracks the gate from then on); before any gate, and when this input is unpatched, the amplitude env is bypassed and WAVECEL free-runs as a continuous drone.",
    },
    outputs: {
      out_l:
        "Left channel of the stereo wavetable output (the lower-detuned half of the spread voices); pair it with OUT R for the full wide stereo image.",
      out_r:
        "Right channel of the stereo wavetable output (the upper-detuned half of the spread voices); the L/R pair widens as Spread increases.",
      scope_out:
        "A mono-video oscilloscope trace of the currently-morphed waveform (single-color line on a dark background). It ALWAYS renders this scope view regardless of which mode the on-card preview toggle is showing — patch it into a video destination to see the wave even while the card shows the 3D view.",
      wave3d_out:
        "A video output rendering the whole wavetable as a 3D stack of frames in perspective, with the active frame highlighted; the surface animates as Morph (and its CV) scans across the table. Like SCOPE VIDEO it ALWAYS renders its own (3D) view regardless of the card's preview toggle.",
    },
    controls: {
      tune:
        "Coarse tuning in semitones (-36 to +36, three octaves each way), added to the incoming pitch CV. Zero is unity; use it to transpose the oscillator in musical steps.",
      fine:
        "Fine tuning in cents (-100 to +100, one semitone each way) for detuning and beating against other voices; stacks on top of Tune and the pitch CV.",
      morph:
        "The wavetable scan position from 0 to 1: it picks which single-cycle frame plays and smoothly cross-fades between adjacent frames, so sweeping it morphs the timbre across the loaded table (the active frame is highlighted in the visualizer). Morph CV adds to this knob.",
      spread:
        "Stereo spread / detune width from 1 (a single centered voice, no spread) to 5 (several voices detuned and panned hard across L/R) for a wide, chorused image. Spread CV adds to this knob.",
      fold:
        "Wavefolder amount from 0 (clean, no folding) to 1 (heavy folding): it folds the waveform's peaks back on themselves to add bright upper harmonics, getting more aggressive as you turn it up. Fold CV adds to this knob.",
      attack:
        "Attack time of the per-voice amplitude ADSR (1 ms to 5 s, log): how long each note takes to ramp up to full after its gate opens (a poly lane note-on or a TRIG rising edge). The same A/D/S/R feeds every poly voice and the mono trigger.",
      decay:
        "Decay time of the amplitude ADSR (1 ms to 5 s, log): how long the note takes to fall from the attack peak down to the Sustain level after attack completes.",
      sustain:
        "Sustain level of the amplitude ADSR (0 to 1): the held amplitude a note stays at while its gate remains high, after the decay stage. At 1 the note holds at full; at 0 it decays to silence even while held.",
      release:
        "Release time of the amplitude ADSR (1 ms to 5 s, log): how long the note takes to fade to silence after its gate closes (a poly lane note-off or the TRIG falling edge).",
      base_vol:
        "The per-voice VCA floor the amplitude ADSR rides on top of (gain = base + (1-base)×env): at 1 (default) gain is always full so the envelope does nothing and WAVECEL is a raw, continuous drone; at 0 the envelope has full control (silent between notes); 0.5 floors each voice at half and the env swells it up to full on note-on.",
      "wavecel-source-select-{n}":
        "Factory wavetable picker — a dropdown of the bundled tables (BASIC SHAPES, HARMONIC SWEEP, …); choosing one loads it as the oscillator's wavetable. If you've uploaded a WAV or loaded a preset it also shows a USER entry for the current custom table. The choice is saved with the patch and synced to everyone in the rack.",
      "wavecel-preset-select-{n}":
        "Built-in preset loader — a dropdown of baked-in wavetable presets; picking one fetches and parses that table and loads it as a USER table (it resets itself afterward so re-picking the same preset reloads it). A quick way to try fancier tables without uploading a file.",
      "wavecel-wav-input-{n}":
        "Load WAV — uploads your own wavetable from an E352-format WAV file (single-cycle frames concatenated); the parsed frames become the active USER table and persist with the patch. A status line confirms the frame count, or shows a parse error if the file isn't valid.",
      "wavecel-viz-toggle-{n}":
        "Toggles the on-card preview screen between the SCOPE oscilloscope trace and the 3D wavetable view (the button shows the current mode). This only changes what the card displays — the SCOPE VIDEO and 3D VIDEO output ports always emit their own respective views regardless of this toggle.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'wavecel', {
      // 7 inputs: pitch, fm, morph_cv, spread_cv, fold_cv, poly (10-channel
      // polyPitchGate at index 5), trigger (mono gate at index 6). poly STAYS at
      // 5 — the new trigger is APPENDED so #664 routing is unchanged.
      // channelCountMode defaults to 'max', so the 10-channel poly source passes
      // through to the worklet intact.
      numberOfInputs: 7,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Per-voice-ADSR: a 0-offset keep-alive on the TRIGGER input (input 6) so it
    // schedules when unpatched (0 gate = "no note"). Feeds ONLY the trigger input.
    // NOTE: because this ConstantSource is always connected, the worklet CANNOT
    // tell from bus presence whether the TRIGGER is actually patched — so
    // connectedness is pushed explicitly via the params below.
    const trigSilence = ctx.createConstantSource();
    trigSilence.offset.value = 0;
    trigSilence.start();
    trigSilence.connect(workletNode, 0, 6);

    const initialData = (node.data ?? {}) as WavecelData;
    let resolved = resolveFrames(initialData);
    workletNode.port.postMessage({
      type: 'loadWavetable',
      frames: framesToPlain(resolved.frames),
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of wavecelDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pMorph = params.get('morph')!;
    const pSpread = params.get('spread')!;
    const pFold = params.get('fold')!;

    // ── CONNECTEDNESS (no-stray-drone fix) ──
    // The GATING MODE (gated vs. continuous raw VCO) is decided by whether the
    // `poly` / `trigger` ports are PATCHED — read from the live patch EDGES (the
    // engine's source of truth), NOT from bus presence (the trigger keep-alive
    // above masks it). Push the two flags as k-rate worklet params; refreshed on
    // init + every poll so connecting / disconnecting a cable flips the mode.
    const pPolyConn = params.get('poly_connected');
    const pTrigConn = params.get('trigger_connected');
    let lastPolyConn = -1;
    let lastTrigConn = -1;
    function pushConnectedness(): void {
      let poly = 0;
      let trig = 0;
      for (const id in livePatch.edges) {
        const e = livePatch.edges[id];
        if (!e || e.target.nodeId !== node.id) continue;
        if (e.target.portId === 'poly') poly = 1;
        else if (e.target.portId === 'trigger') trig = 1;
      }
      if (poly !== lastPolyConn) { lastPolyConn = poly; pPolyConn?.setValueAtTime(poly, ctx.currentTime); }
      if (trig !== lastTrigConn) { lastTrigConn = trig; pTrigConn?.setValueAtTime(trig, ctx.currentTime); }
    }
    pushConnectedness();

    // Cross-domain video bridge sink. The bridge expects an AnalyserNode
    // even when drawFrame is set (legacy contract — see
    // AudioDomainNodeHandle.videoSources docs in engine.ts). It is
    // ignored when drawFrame is present, but we still need a real node
    // to satisfy `getVideoSource`. Tap from the worklet's left output
    // so the analyser sees something live (cheap, no DSP impact).
    const vizAnalyser = ctx.createAnalyser();
    vizAnalyser.fftSize = 256;
    vizAnalyser.smoothingTimeConstant = 0;
    workletNode.connect(vizAnalyser, 0);

    function readActiveFrame(): number {
      const fc = resolved.frames.length;
      if (fc <= 1) return 0;
      const morphVal = pMorph.value;
      return Math.max(0, Math.min(fc - 1, Math.round(morphVal * (fc - 1))));
    }

    function drawScopeFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const ctx2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx2d) return;
      drawWaveScope(ctx2d, resolved.frames, canvas.width, canvas.height, {
        activeFrame: readActiveFrame(),
      });
    }

    function drawWave3DFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const ctx2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx2d) return;
      drawWave3D(ctx2d, resolved.frames, canvas.width, canvas.height, {
        activeFrame: readActiveFrame(),
      });
    }

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      const live = livePatch.nodes[node.id];
      if (live) {
        const next = resolveFrames(live.data as WavecelData | undefined);
        if (next.signature !== resolved.signature) {
          resolved = next;
          workletNode.port.postMessage({
            type: 'loadWavetable',
            frames: framesToPlain(next.frames),
          });
        }
      }
      pushConnectedness();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',     { node: workletNode, input: 0 }],
        ['fm',        { node: workletNode, input: 1 }],
        ['morph_cv',  { node: workletNode, input: 2, param: pMorph }],
        ['spread_cv', { node: workletNode, input: 3, param: pSpread }],
        ['fold_cv',   { node: workletNode, input: 4, param: pFold }],
        // Poly bus → worklet input 5 (a node connection, not an AudioParam).
        ['poly',      { node: workletNode, input: 5 }],
        // Mono TRIGGER gate → worklet input 6 (a node connection).
        ['trigger',   { node: workletNode, input: 6 }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      videoSources: new Map([
        ['scope_out',  { analyser: vizAnalyser, sampleRate: ctx.sampleRate, drawFrame: drawScopeFrame }],
        ['wave3d_out', { analyser: vizAnalyser, sampleRate: ctx.sampleRate, drawFrame: drawWave3DFrame }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'wavetableFrames') return resolved.frames;
        if (key === 'wavetableLabel') return resolved.label;
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { trigSilence.stop(); } catch { /* */ }
        try { trigSilence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(vizAnalyser); } catch { /* */ }
        try { vizAnalyser.disconnect(); } catch { /* */ }
        workletNode.disconnect();
      },
    };
  },
};

export type { FactoryTable };
