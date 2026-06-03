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
  label: 'WAVECEL',
  category: 'sources',
  schemaVersion: 1,
  stereoPairs: [['out_l', 'out_r']],

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
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'wavecel', {
      numberOfInputs: 5,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

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
        try { workletNode.disconnect(vizAnalyser); } catch { /* */ }
        try { vizAnalyser.disconnect(); } catch { /* */ }
        workletNode.disconnect();
      },
    };
  },
};

export type { FactoryTable };
