// packages/web/src/lib/audio/modules/riotgirls.ts
//
// RIOTGIRLS — 4-voice drum machine. Composition-of-existing-modules:
//   - Voices 1-3: DRUMMERGIRL Faust worklets.
//   - Voice 4:    Wavetable VCO + ADSR + VCA chain.
//   - Per voice:  equal-power-pan Faust worklet (mono in + pan CV -> stereo out).
//   - Master:     stereo sum -> QBRT filter -> (outL, outR).
//
// MVP-B scope: voices + master + UI + a wired aux FX bus. Each voice's
// send-A taps a summing bus → DESTROY (bitcrush) → returnA gain → master sum;
// send-B taps a second bus → Reverb (Faust mono_freeverb) → returnB gain →
// master sum. The wet returns feed BOTH stereo channels (centered mono aux
// return) so the effects land on outL/outR through the master QBRT filter.
//
// Inputs (built programmatically — see buildInputs() / buildParams()):
//   trig{1..4} (gate): one-shot trigger per voice (rising-edge fires).
//   gate{1..4} (gate): held gate per voice (drives voice 4's ADSR; voices 1-3 retrigger on edge).
//   pitch{1..4} (pitch): V/oct pitch per voice.
//   v{1..3}_{tone,shape,volume,decay} (cv, paramTarget=…): per-DRUMMERGIRL voice CV.
//   v4_fm (audio), v4_{wavePos,attack,decay,sustain,release,volume} (cv, paramTarget=…):
//     voice-4 wavetable + ADSR CV.
//   v{1..4}_{pan,sendA,sendB} (cv, paramTarget=…): per-voice mix and aux-send CV.
//   bc_{decimate,bits,wet} (cv, paramTarget=…): master DESTROY CV.
//   rv_{size,damp,mix} (cv, paramTarget=…): master Reverb CV.
//   flt_{cutoff,resonance,mode,pingDecay} (cv, paramTarget=…): master QBRT filter CV.
//   returnA / returnB (cv, paramTarget=…): aux-return level CV.
//
// Outputs:
//   outL (audio): master stereo bus, left.
//   outR (audio): master stereo bus, right.
//
// Params: per-voice voicing knobs, per-voice pan + send-A/B, master DESTROY +
//   reverb + QBRT filter; built programmatically in buildParams().

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef, PortDef } from '$lib/graph/types';

import drummergirlWasm from '@patchtogether.live/dsp/dist/drummergirl.wasm?url';
import drummergirlMeta from '@patchtogether.live/dsp/dist/drummergirl.json?url';
import drummergirlWorklet from '@patchtogether.live/dsp/dist/drummergirl.worklet.js?url';
import adsrWasm from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import adsrMeta from '@patchtogether.live/dsp/dist/adsr.json?url';
import adsrWorklet from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';
import vcaWasm from '@patchtogether.live/dsp/dist/vca.wasm?url';
import vcaMeta from '@patchtogether.live/dsp/dist/vca.json?url';
import vcaWorklet from '@patchtogether.live/dsp/dist/vca.worklet.js?url';
import qbrtWasm from '@patchtogether.live/dsp/dist/qbrt.wasm?url';
import qbrtMeta from '@patchtogether.live/dsp/dist/qbrt.json?url';
import qbrtWorklet from '@patchtogether.live/dsp/dist/qbrt.worklet.js?url';
import panWasm from '@patchtogether.live/dsp/dist/equal-power-pan.wasm?url';
import panMeta from '@patchtogether.live/dsp/dist/equal-power-pan.json?url';
import panWorklet from '@patchtogether.live/dsp/dist/equal-power-pan.worklet.js?url';
import destroyWasm from '@patchtogether.live/dsp/dist/destroy.wasm?url';
import destroyMeta from '@patchtogether.live/dsp/dist/destroy.json?url';
import destroyWorklet from '@patchtogether.live/dsp/dist/destroy.worklet.js?url';
import reverbWasm from '@patchtogether.live/dsp/dist/reverb.wasm?url';
import reverbMeta from '@patchtogether.live/dsp/dist/reverb.json?url';
import reverbWorklet from '@patchtogether.live/dsp/dist/reverb.worklet.js?url';
import wavetableVcoUrl from '@patchtogether.live/dsp/dist/wavetable-vco.js?url';

import { instantiateFaustModule } from '$lib/audio/faust-runtime';

// Re-use the basic-table generator pattern from wavetable-vco.ts.
const WT_FRAME_SIZE = 2048;
const WT_FRAME_COUNT = 16;
const wtLoadedContexts = new WeakSet<BaseAudioContext>();

function generateBasicWavetable(): Float32Array {
  const table = new Float32Array(WT_FRAME_SIZE * WT_FRAME_COUNT);
  for (let f = 0; f < WT_FRAME_COUNT; f++) {
    const t = f / (WT_FRAME_COUNT - 1);
    for (let s = 0; s < WT_FRAME_SIZE; s++) {
      const phase = s / WT_FRAME_SIZE;
      let v: number;
      if (t < 1 / 3) {
        const m = t * 3;
        const saw = phase < 0.5 ? 2 * phase : 2 * phase - 2;
        const sqr = phase < 0.5 ? 1 : -1;
        v = saw * (1 - m) + sqr * m;
      } else if (t < 2 / 3) {
        const m = (t - 1 / 3) * 3;
        const sqr = phase < 0.5 ? 1 : -1;
        const tri =
          phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : -4 + 4 * phase;
        v = sqr * (1 - m) + tri * m;
      } else {
        const m = (t - 2 / 3) * 3;
        const tri =
          phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : -4 + 4 * phase;
        const sn = Math.sin(2 * Math.PI * phase);
        v = tri * (1 - m) + sn * m;
      }
      table[f * WT_FRAME_SIZE + s] = v;
    }
  }
  return table;
}

const VOICE_COUNT = 4;

// -------------------- Param schema --------------------
//
// Built programmatically — mirrors the union of the underlying modules' params
// plus per-voice pan/sendA/sendB and master returnA/returnB knobs.
// `vN_<param>` for voice N (1..4); `bc_*` bitcrusher; `rv_*` reverb; `flt_*`
// QBRT filter master. All routes through setParam dispatcher by prefix.

function buildParams(): readonly ParamDef[] {
  const params: ParamDef[] = [];

  // Voices 1-3: full DRUMMERGIRL surface.
  for (const v of [1, 2, 3]) {
    params.push({ id: `v${v}_pitch`,  label: `${v}P`,  defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'st' });
    params.push({ id: `v${v}_tone`,   label: `${v}T`,  defaultValue: 0.3,  min: 0,     max: 1,   curve: 'linear' });
    params.push({ id: `v${v}_shape`,  label: `${v}S`,  defaultValue: 0.3,  min: 0,     max: 1,   curve: 'linear' });
    params.push({ id: `v${v}_volume`, label: `${v}V`,  defaultValue: 1.0,  min: 0,     max: 2.0, curve: 'linear' });
    params.push({ id: `v${v}_decay`,  label: `${v}D`,  defaultValue: 0.15, min: 0.001, max: 0.5, curve: 'log',    units: 's' });
  }

  // Voice 4: Wavetable VCO + ADSR + VCA. Envelope max ranges are stretched
  // beyond the ADSR module's defaults (drum-snap range) so V4 can sustain
  // longer pad/bass tones — per the plan §3.
  params.push({ id: 'v4_tune',     label: '4T',  defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'st' });
  params.push({ id: 'v4_fine',     label: '4F',  defaultValue: 0,    min: -100,  max: 100, curve: 'linear', units: '¢' });
  params.push({ id: 'v4_wavePos',  label: '4W',  defaultValue: 0,    min: 0,     max: 1,   curve: 'linear' });
  params.push({ id: 'v4_fmAmount', label: '4FM', defaultValue: 0,    min: 0,     max: 1,   curve: 'linear' });
  params.push({ id: 'v4_attack',   label: '4A',  defaultValue: 0.005, min: 0.001, max: 2.0, curve: 'log', units: 's' });
  params.push({ id: 'v4_decay',    label: '4D',  defaultValue: 0.1,   min: 0.001, max: 4.0, curve: 'log', units: 's' });
  params.push({ id: 'v4_sustain',  label: '4S',  defaultValue: 0.7,   min: 0,     max: 1,   curve: 'linear' });
  params.push({ id: 'v4_release',  label: '4R',  defaultValue: 0.3,   min: 0.001, max: 8.0, curve: 'log', units: 's' });
  params.push({ id: 'v4_volume',   label: '4V',  defaultValue: 0.8,   min: 0,     max: 2.0, curve: 'linear' });

  // Per-voice pan + sends.
  for (const v of [1, 2, 3, 4]) {
    params.push({ id: `v${v}_pan`,   label: `${v}Pn`, defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    params.push({ id: `v${v}_sendA`, label: `${v}sA`, defaultValue: 0, min:  0, max: 1, curve: 'linear' });
    params.push({ id: `v${v}_sendB`, label: `${v}sB`, defaultValue: 0, min:  0, max: 1, curve: 'linear' });
  }

  // Internal bitcrusher (DESTROY) — instantiated in MVP-B.
  params.push({ id: 'bc_decimate', label: 'bcDec',  defaultValue: 1,  min: 1, max: 64, curve: 'linear' });
  params.push({ id: 'bc_bits',     label: 'bcBits', defaultValue: 16, min: 1, max: 16, curve: 'linear' });
  params.push({ id: 'bc_wet',      label: 'bcWet',  defaultValue: 1,  min: 0, max: 1,  curve: 'linear' });

  // Internal reverb — instantiated in MVP-B.
  params.push({ id: 'rv_size', label: 'rvSize', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });
  params.push({ id: 'rv_damp', label: 'rvDamp', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' });
  params.push({ id: 'rv_mix',  label: 'rvMix',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' });

  // Master QBRT filter.
  params.push({ id: 'flt_cutoff',    label: 'fCut',  defaultValue: 18000, min: 20,    max: 20000, curve: 'log',    units: 'Hz' });
  params.push({ id: 'flt_resonance', label: 'fRes',  defaultValue: 0.4,   min: 0,     max: 0.99,  curve: 'linear' });
  params.push({ id: 'flt_mode',      label: 'fMod',  defaultValue: 0,     min: 0,     max: 1,     curve: 'linear' });
  params.push({ id: 'flt_pingDecay', label: 'fPng',  defaultValue: 0.15,  min: 0.005, max: 0.5,   curve: 'log',    units: 's' });

  // Master return amounts (MVP-B wires these to the wet returns).
  params.push({ id: 'returnA', label: 'retA', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });
  params.push({ id: 'returnB', label: 'retB', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });

  return params;
}

const PARAMS = buildParams();

// -------------------- Port schema --------------------
//
// 55 inputs:
//   4 trig + 4 gate + 4 pitch
// + 12 voice 1-3 CVs (tone, shape, volume, decay × 3)
// + 7 voice 4 CVs (fm, wavePos, attack, decay, sustain, release, volume)
// + 12 per-voice (pan, sendA, sendB × 4)
// + 12 effect CVs (3 bc, 3 rv, 4 flt, 2 returns)
// 2 outputs: outL, outR
//
// gate1..gate4 share the same gate-input nodes as trig1..trig4 — Web Audio
// sums multiple sources into the same input, so a Sequencer gate cable can
// land on either port. Useful when patching alongside an external trigger
// source (e.g. drum machine triggers + sequencer gates).

// Per .myrobots/plans/cv-range-standard.md, every CV input gets a cvScale
// hint inferred from the param's natural curve so an LFO at ±1 sweeps the
// param's full natural range. Pure helper so the test can pin the mapping.
function cvScaleFor(paramId: string): { mode: 'linear' | 'log' | 'discrete' } {
  const p = PARAMS.find((q) => q.id === paramId);
  if (!p) return { mode: 'linear' };
  if (p.curve === 'discrete') return { mode: 'discrete' };
  if (p.curve === 'log') return { mode: 'log' };
  return { mode: 'linear' };
}

function cvIn(id: string, paramTarget: string): PortDef {
  return { id, type: 'cv', paramTarget, cvScale: cvScaleFor(paramTarget) };
}

function buildInputs(): PortDef[] {
  const inputs: PortDef[] = [];
  for (let v = 1; v <= 4; v++) inputs.push({ id: `trig${v}`,  type: 'gate' });
  for (let v = 1; v <= 4; v++) inputs.push({ id: `gate${v}`,  type: 'gate' });
  for (let v = 1; v <= 4; v++) inputs.push({ id: `pitch${v}`, type: 'pitch' });

  for (const v of [1, 2, 3]) {
    inputs.push(cvIn(`v${v}_tone`,   `v${v}_tone`));
    inputs.push(cvIn(`v${v}_shape`,  `v${v}_shape`));
    inputs.push(cvIn(`v${v}_volume`, `v${v}_volume`));
    inputs.push(cvIn(`v${v}_decay`,  `v${v}_decay`));
  }

  inputs.push({ id: 'v4_fm',      type: 'audio' });
  inputs.push(cvIn('v4_wavePos', 'v4_wavePos'));
  inputs.push(cvIn('v4_attack',  'v4_attack'));
  inputs.push(cvIn('v4_decay',   'v4_decay'));
  inputs.push(cvIn('v4_sustain', 'v4_sustain'));
  inputs.push(cvIn('v4_release', 'v4_release'));
  inputs.push(cvIn('v4_volume',  'v4_volume'));

  for (let v = 1; v <= 4; v++) {
    inputs.push(cvIn(`v${v}_pan`,   `v${v}_pan`));
    inputs.push(cvIn(`v${v}_sendA`, `v${v}_sendA`));
    inputs.push(cvIn(`v${v}_sendB`, `v${v}_sendB`));
  }

  inputs.push(cvIn('bc_decimate', 'bc_decimate'));
  inputs.push(cvIn('bc_bits',     'bc_bits'));
  inputs.push(cvIn('bc_wet',      'bc_wet'));
  inputs.push(cvIn('rv_size',     'rv_size'));
  inputs.push(cvIn('rv_damp',     'rv_damp'));
  inputs.push(cvIn('rv_mix',      'rv_mix'));
  inputs.push(cvIn('flt_cutoff',    'flt_cutoff'));
  inputs.push(cvIn('flt_resonance', 'flt_resonance'));
  inputs.push(cvIn('flt_mode',      'flt_mode'));
  inputs.push(cvIn('flt_pingDecay', 'flt_pingDecay'));
  inputs.push(cvIn('returnA', 'returnA'));
  inputs.push(cvIn('returnB', 'returnB'));

  return inputs;
}

const INPUTS = buildInputs();

// -------------------- setParam dispatcher --------------------
//
// `vN_<param>` -> voices[N-1].<param>; `bc_<param>` -> destroy.<param>;
// `rv_<param>` -> reverb.<param>; `flt_<param>` -> qbrt.<param>; sends/pan
// + returns are owned by RIOTGIRLS itself (gain nodes / pan worklets).
//
// Pure function so the unit test can verify it without instantiating Web Audio.

export interface SetParamSink {
  voices: Array<{ setParam: (id: string, v: number) => void }>;
  bc?: { setParam: (id: string, v: number) => void };
  rv?: { setParam: (id: string, v: number) => void };
  flt?: { setParam: (id: string, v: number) => void };
  /** Owned-knob dispatcher for pan/send/return etc. */
  ownKnob: (id: string, v: number) => void;
}

export function dispatchParam(sink: SetParamSink, paramId: string, value: number): void {
  // Voice 4 chain spans WT (tune/fine/wavePos/fmAmount), ADSR (attack/decay/
  // sustain/release), VCA (volume → vca.base, mapped). Route by suffix.
  if (paramId.startsWith('v4_')) {
    const suffix = paramId.slice(3);
    const v4 = sink.voices[3];
    if (!v4) return;
    // The voice-4 chain is a synthetic composite — its setParam is wired in
    // the factory to dispatch suffix -> the underlying WT/ADSR/VCA node.
    v4.setParam(suffix, value);
    return;
  }
  const vMatch = paramId.match(/^v([123])_(.+)$/);
  if (vMatch) {
    const idx = parseInt(vMatch[1]!, 10) - 1;
    const sub = vMatch[2]!;
    // Pan/sendA/sendB are owned by RIOTGIRLS, not the DRUMMERGIRL sub-voice.
    if (sub === 'pan' || sub === 'sendA' || sub === 'sendB') {
      sink.ownKnob(paramId, value);
      return;
    }
    sink.voices[idx]?.setParam(sub, value);
    return;
  }
  if (paramId.startsWith('bc_')) {
    sink.bc?.setParam(paramId.slice(3), value);
    return;
  }
  if (paramId.startsWith('rv_')) {
    sink.rv?.setParam(paramId.slice(3), value);
    return;
  }
  if (paramId.startsWith('flt_')) {
    sink.flt?.setParam(paramId.slice(4), value);
    return;
  }
  if (paramId === 'returnA' || paramId === 'returnB') {
    sink.ownKnob(paramId, value);
    return;
  }
  // Fallthrough — owned (or unknown). Let the owned-knob handler decide.
  sink.ownKnob(paramId, value);
}

// -------------------- Equal-power pan math --------------------
//
// Pure function for unit tests. Faust DSP implements the same with smoothing.
// Convention:
//   pan = -1  -> (1, 0)         hard left
//   pan =  0  -> (sqrt(2)/2 each) -3 dB center
//   pan = +1  -> (0, 1)         hard right

export function equalPowerPan(pan: number): { l: number; r: number } {
  const p = Math.max(-1, Math.min(1, pan));
  const theta = (p + 1) * (Math.PI / 4);
  return { l: Math.cos(theta), r: Math.sin(theta) };
}

// -------------------- Module def --------------------

export const riotgirlsDef: AudioModuleDef = {
  type: 'riotgirls',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'RIOTGIRLS',
  category: 'sources',
  schemaVersion: 1,

  inputs: INPUTS,
  outputs: [
    { id: 'outL', type: 'audio' },
    { id: 'outR', type: 'audio' },
  ],
  params: PARAMS,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = (key: string, fb: number): number => {
      const v = (node.params ?? {})[key];
      return typeof v === 'number' ? v : fb;
    };

    // ---- Voices 1-3: DRUMMERGIRL ----
    const v1 = await instantiateFaustModule(ctx, {
      name: 'drummergirl', wasmUrl: drummergirlWasm, metaUrl: drummergirlMeta, workletUrl: drummergirlWorklet,
    });
    const v2 = await instantiateFaustModule(ctx, {
      name: 'drummergirl', wasmUrl: drummergirlWasm, metaUrl: drummergirlMeta, workletUrl: drummergirlWorklet,
    });
    const v3 = await instantiateFaustModule(ctx, {
      name: 'drummergirl', wasmUrl: drummergirlWasm, metaUrl: drummergirlMeta, workletUrl: drummergirlWorklet,
    });
    const drummergirlNodes = [v1, v2, v3];
    const drummergirlParams: Array<Map<string, AudioParam>> = drummergirlNodes.map(
      (n) => n.parameters as unknown as Map<string, AudioParam>,
    );

    // Per-voice DRUMMERGIRL silence-sources for the gate input (so the worklet
    // stays in the active graph even with no trigN cable patched).
    const drummergirlSilences: ConstantSourceNode[] = [];
    for (const n of drummergirlNodes) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(n, 0, 0);
      drummergirlSilences.push(sil);
    }

    // Apply initial DRUMMERGIRL params from saved node.params.
    for (const v of [1, 2, 3]) {
      const m = drummergirlParams[v - 1]!;
      m.get('/DRUMMERGIRL/pitch') ?.setValueAtTime(initial(`v${v}_pitch`, 0),    ctx.currentTime);
      m.get('/DRUMMERGIRL/tone')  ?.setValueAtTime(initial(`v${v}_tone`, 0.3),   ctx.currentTime);
      m.get('/DRUMMERGIRL/shape') ?.setValueAtTime(initial(`v${v}_shape`, 0.3),  ctx.currentTime);
      m.get('/DRUMMERGIRL/volume')?.setValueAtTime(initial(`v${v}_volume`, 1.0), ctx.currentTime);
      m.get('/DRUMMERGIRL/decay') ?.setValueAtTime(initial(`v${v}_decay`, 0.15), ctx.currentTime);
    }

    // ---- Voice 4: Wavetable VCO + ADSR + VCA ----
    if (!wtLoadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(wavetableVcoUrl);
      wtLoadedContexts.add(ctx);
    }
    const v4Wt = new AudioWorkletNode(ctx, 'wavetable-vco', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const wtTable = generateBasicWavetable();
    const wtBuf = wtTable.buffer;
    v4Wt.port.postMessage(
      { type: 'load', table: wtBuf, frameSize: WT_FRAME_SIZE, frameCount: WT_FRAME_COUNT },
      [wtBuf],
    );
    const v4WtParams = v4Wt.parameters as unknown as Map<string, AudioParam>;
    v4WtParams.get('tune')    ?.setValueAtTime(initial('v4_tune', 0),     ctx.currentTime);
    v4WtParams.get('fine')    ?.setValueAtTime(initial('v4_fine', 0),     ctx.currentTime);
    v4WtParams.get('wavePos') ?.setValueAtTime(initial('v4_wavePos', 0),  ctx.currentTime);
    v4WtParams.get('fmAmount')?.setValueAtTime(initial('v4_fmAmount', 0), ctx.currentTime);

    const v4Adsr = await instantiateFaustModule(ctx, {
      name: 'adsr', wasmUrl: adsrWasm, metaUrl: adsrMeta, workletUrl: adsrWorklet,
    });
    const v4AdsrSilence = ctx.createConstantSource();
    v4AdsrSilence.offset.value = 0;
    v4AdsrSilence.start();
    v4AdsrSilence.connect(v4Adsr);
    const v4AdsrParams = v4Adsr.parameters as unknown as Map<string, AudioParam>;
    v4AdsrParams.get('/ADSR/attack') ?.setValueAtTime(initial('v4_attack', 0.005), ctx.currentTime);
    v4AdsrParams.get('/ADSR/decay')  ?.setValueAtTime(initial('v4_decay', 0.1),    ctx.currentTime);
    v4AdsrParams.get('/ADSR/sustain')?.setValueAtTime(initial('v4_sustain', 0.7),  ctx.currentTime);
    v4AdsrParams.get('/ADSR/release')?.setValueAtTime(initial('v4_release', 0.3),  ctx.currentTime);

    const v4Vca = await instantiateFaustModule(ctx, {
      name: 'vca', wasmUrl: vcaWasm, metaUrl: vcaMeta, workletUrl: vcaWorklet,
    });
    const v4VcaMerger = ctx.createChannelMerger(2);
    v4VcaMerger.connect(v4Vca);
    const v4VcaParams = v4Vca.parameters as unknown as Map<string, AudioParam>;
    v4VcaParams.get('/VCA/base')    ?.setValueAtTime(0, ctx.currentTime);
    v4VcaParams.get('/VCA/cvAmount')?.setValueAtTime(initial('v4_volume', 0.8), ctx.currentTime);

    // Wire voice 4 chain: WT.audio -> VCA.audio (input 0) ; ADSR.env -> VCA.cv (input 1).
    v4Wt.connect(v4VcaMerger, 0, 0);
    v4Adsr.connect(v4VcaMerger, 0, 1);

    // ---- 4× equal-power pan worklets ----
    const pans: AudioWorkletNode[] = [];
    const panParamsList: Array<Map<string, AudioParam>> = [];
    const panMergers: ChannelMergerNode[] = [];
    for (let i = 0; i < VOICE_COUNT; i++) {
      const p = await instantiateFaustModule(ctx, {
        name: 'equal-power-pan', wasmUrl: panWasm, metaUrl: panMeta, workletUrl: panWorklet,
      });
      // Pan worklet has 2 inputs (audio, panCv). Use a 2-channel merger.
      const merger = ctx.createChannelMerger(2);
      merger.connect(p);
      // Silence on pan-CV so worklet stays alive even with no panN cable.
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(merger, 0, 1);
      // Track the silence source for disposal.
      drummergirlSilences.push(sil);
      pans.push(p);
      panMergers.push(merger);
      const pp = p.parameters as unknown as Map<string, AudioParam>;
      panParamsList.push(pp);
      pp.get('/EqualPowerPan/pan')?.setValueAtTime(initial(`v${i + 1}_pan`, 0), ctx.currentTime);
    }

    // Wire voices into pan-worklet audio inputs.
    // pan inputs: 0 = audio (mono in), 1 = panCv. The Faust worklet exposes a
    // single AudioWorkletNode input (input 0) with channelInterpretation
    // 'discrete'. We use a 2-channel merger so audio lands on ch0 and pan-CV
    // on ch1.
    v1.connect(panMergers[0]!, 0, 0);
    v2.connect(panMergers[1]!, 0, 0);
    v3.connect(panMergers[2]!, 0, 0);
    v4Vca.connect(panMergers[3]!, 0, 0);

    // ---- Master sum (stereo) ----
    // Each pan worklet emits 2 outputs (L, R). We split each, sum L into
    // sumL gain, R into sumR gain, then route to QBRT.
    const sumL = ctx.createGain();
    const sumR = ctx.createGain();
    sumL.gain.value = 1;
    sumR.gain.value = 1;
    const panSplitters: ChannelSplitterNode[] = [];
    for (const p of pans) {
      const sp = ctx.createChannelSplitter(2);
      p.connect(sp);
      sp.connect(sumL, 0);
      sp.connect(sumR, 1);
      panSplitters.push(sp);
    }

    // ---- Master QBRT filter ----
    const flt = await instantiateFaustModule(ctx, {
      name: 'qbrt', wasmUrl: qbrtWasm, metaUrl: qbrtMeta, workletUrl: qbrtWorklet,
    });
    const fltMerger = ctx.createChannelMerger(3);
    fltMerger.connect(flt);
    // Silence ping input so QBRT processes.
    const fltSilence = ctx.createConstantSource();
    fltSilence.offset.value = 0;
    fltSilence.start();
    fltSilence.connect(fltMerger, 0, 2);
    sumL.connect(fltMerger, 0, 0);
    sumR.connect(fltMerger, 0, 1);
    const fltSplitter = ctx.createChannelSplitter(2);
    flt.connect(fltSplitter);
    const fltParams = flt.parameters as unknown as Map<string, AudioParam>;
    fltParams.get('/QBRT/cutoff')   ?.setValueAtTime(initial('flt_cutoff', 18000), ctx.currentTime);
    fltParams.get('/QBRT/resonance')?.setValueAtTime(initial('flt_resonance', 0.4), ctx.currentTime);
    fltParams.get('/QBRT/mode')     ?.setValueAtTime(initial('flt_mode', 0),       ctx.currentTime);
    fltParams.get('/QBRT/pingDecay')?.setValueAtTime(initial('flt_pingDecay', 0.15), ctx.currentTime);

    // ---- Per-voice send gains (FX-bus taps, wired in MVP-B) ----
    // Each voice's mono signal taps a sendA GainNode (DESTROY aux) and a sendB
    // GainNode (Reverb aux). The gain values are owned-knobs (set via the
    // setParam dispatcher / vN_sendA·sendB CV). Outputs are summed onto the two
    // aux-send buses below.
    const sendAGains: GainNode[] = [];
    const sendBGains: GainNode[] = [];
    for (let i = 0; i < VOICE_COUNT; i++) {
      const ga = ctx.createGain();
      const gb = ctx.createGain();
      ga.gain.value = initial(`v${i + 1}_sendA`, 0);
      gb.gain.value = initial(`v${i + 1}_sendB`, 0);
      sendAGains.push(ga);
      sendBGains.push(gb);
    }
    v1.connect(sendAGains[0]!);
    v1.connect(sendBGains[0]!);
    v2.connect(sendAGains[1]!);
    v2.connect(sendBGains[1]!);
    v3.connect(sendAGains[2]!);
    v3.connect(sendBGains[2]!);
    v4Vca.connect(sendAGains[3]!);
    v4Vca.connect(sendBGains[3]!);

    // ---- Aux-send summing buses (mono) ----
    // sendBusA collects all four sendA taps → DESTROY. sendBusB collects the
    // sendB taps → Reverb. Both effect worklets are mono (1-in / 1-out).
    const sendBusA = ctx.createGain();
    const sendBusB = ctx.createGain();
    sendBusA.gain.value = 1;
    sendBusB.gain.value = 1;
    for (const g of sendAGains) g.connect(sendBusA);
    for (const g of sendBGains) g.connect(sendBusB);

    // ---- DESTROY (bitcrush) effect on aux A ----
    const bc = await instantiateFaustModule(ctx, {
      name: 'destroy', wasmUrl: destroyWasm, metaUrl: destroyMeta, workletUrl: destroyWorklet,
    });
    const bcParams = bc.parameters as unknown as Map<string, AudioParam>;
    bcParams.get('/DESTROY/decimate')?.setValueAtTime(initial('bc_decimate', 1),  ctx.currentTime);
    bcParams.get('/DESTROY/bits')    ?.setValueAtTime(initial('bc_bits', 16),     ctx.currentTime);
    bcParams.get('/DESTROY/wet')     ?.setValueAtTime(initial('bc_wet', 1),       ctx.currentTime);
    sendBusA.connect(bc);

    // ---- Reverb effect on aux B (Faust mono freeverb) ----
    const rv = await instantiateFaustModule(ctx, {
      name: 'reverb', wasmUrl: reverbWasm, metaUrl: reverbMeta, workletUrl: reverbWorklet,
    });
    const rvParams = rv.parameters as unknown as Map<string, AudioParam>;
    rvParams.get('/Reverb/size')?.setValueAtTime(initial('rv_size', 0.5), ctx.currentTime);
    rvParams.get('/Reverb/damp')?.setValueAtTime(initial('rv_damp', 0.3), ctx.currentTime);
    rvParams.get('/Reverb/mix') ?.setValueAtTime(initial('rv_mix', 0.3),  ctx.currentTime);
    sendBusB.connect(rv);

    // ---- Master return gains (wet returns → master sum) ----
    // Each effect's mono wet output passes through its return gain, then feeds
    // BOTH stereo sum buses (centered mono aux return). The return level is an
    // owned-knob modulated by the returnA / returnB CV inputs.
    const returnAGain = ctx.createGain();
    returnAGain.gain.value = initial('returnA', 0.5);
    const returnBGain = ctx.createGain();
    returnBGain.gain.value = initial('returnB', 0.5);
    bc.connect(returnAGain);
    rv.connect(returnBGain);
    returnAGain.connect(sumL);
    returnAGain.connect(sumR);
    returnBGain.connect(sumL);
    returnBGain.connect(sumR);

    // ---- Build inputs map ----
    // Trigs route to the corresponding DRUMMERGIRL voice input 0 (the gate),
    // except trig4 which routes to v4 ADSR input 0. Pitches route to params:
    // pitch1..3 -> drummergirl pitch param; pitch4 -> wavetable VCO input 0
    // (V/oct pitch).
    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();

    inputsMap.set('trig1', { node: v1, input: 0 });
    inputsMap.set('trig2', { node: v2, input: 0 });
    inputsMap.set('trig3', { node: v3, input: 0 });
    inputsMap.set('trig4', { node: v4Adsr, input: 0 });

    // gate1..gate4 are alternate names for the same gate-input target node.
    // Web Audio sums multiple sources into the same input, so a Sequencer's
    // gate cable can land on either trigN or gateN.
    inputsMap.set('gate1', { node: v1, input: 0 });
    inputsMap.set('gate2', { node: v2, input: 0 });
    inputsMap.set('gate3', { node: v3, input: 0 });
    inputsMap.set('gate4', { node: v4Adsr, input: 0 });

    // pitch1..3 route to DRUMMERGIRL pitch AudioParam. pitch4 routes to
    // wavetable VCO's pitch input (input 0, audio-rate V/oct).
    inputsMap.set('pitch1', { node: v1, input: 0, param: drummergirlParams[0]!.get('/DRUMMERGIRL/pitch')! });
    inputsMap.set('pitch2', { node: v2, input: 0, param: drummergirlParams[1]!.get('/DRUMMERGIRL/pitch')! });
    inputsMap.set('pitch3', { node: v3, input: 0, param: drummergirlParams[2]!.get('/DRUMMERGIRL/pitch')! });
    inputsMap.set('pitch4', { node: v4Wt, input: 0 });

    // Voice 1-3 CV inputs.
    for (const v of [1, 2, 3]) {
      const m = drummergirlParams[v - 1]!;
      const dn = drummergirlNodes[v - 1]!;
      inputsMap.set(`v${v}_tone`,   { node: dn, input: 0, param: m.get('/DRUMMERGIRL/tone')! });
      inputsMap.set(`v${v}_shape`,  { node: dn, input: 0, param: m.get('/DRUMMERGIRL/shape')! });
      inputsMap.set(`v${v}_volume`, { node: dn, input: 0, param: m.get('/DRUMMERGIRL/volume')! });
      inputsMap.set(`v${v}_decay`,  { node: dn, input: 0, param: m.get('/DRUMMERGIRL/decay')! });
    }

    // Voice 4 CV inputs. fm is audio-rate to wavetable VCO input 1; wavePos
    // routes to the AudioParam. ADSR + VCA params route to their AudioParams.
    inputsMap.set('v4_fm',      { node: v4Wt, input: 1 });
    inputsMap.set('v4_wavePos', { node: v4Wt, input: 0, param: v4WtParams.get('wavePos')! });
    inputsMap.set('v4_attack',  { node: v4Adsr, input: 0, param: v4AdsrParams.get('/ADSR/attack')! });
    inputsMap.set('v4_decay',   { node: v4Adsr, input: 0, param: v4AdsrParams.get('/ADSR/decay')! });
    inputsMap.set('v4_sustain', { node: v4Adsr, input: 0, param: v4AdsrParams.get('/ADSR/sustain')! });
    inputsMap.set('v4_release', { node: v4Adsr, input: 0, param: v4AdsrParams.get('/ADSR/release')! });
    inputsMap.set('v4_volume',  { node: v4Vca, input: 0, param: v4VcaParams.get('/VCA/cvAmount')! });

    // Per-voice pan/sendA/sendB CV inputs.
    for (let i = 0; i < VOICE_COUNT; i++) {
      const v = i + 1;
      // panN CV routes to the pan worklet's AudioParam (`/EqualPowerPan/pan`).
      inputsMap.set(`v${v}_pan`,   { node: pans[i]!, input: 0, param: panParamsList[i]!.get('/EqualPowerPan/pan')! });
      // sendA/sendB CVs modulate the GainNode's gain AudioParam.
      inputsMap.set(`v${v}_sendA`, { node: sendAGains[i]!, input: 0, param: sendAGains[i]!.gain });
      inputsMap.set(`v${v}_sendB`, { node: sendBGains[i]!, input: 0, param: sendBGains[i]!.gain });
    }

    // FX CVs — modulate the effect-worklet AudioParams directly (MVP-B).
    inputsMap.set('bc_decimate', { node: bc, input: 0, param: bcParams.get('/DESTROY/decimate')! });
    inputsMap.set('bc_bits',     { node: bc, input: 0, param: bcParams.get('/DESTROY/bits')! });
    inputsMap.set('bc_wet',      { node: bc, input: 0, param: bcParams.get('/DESTROY/wet')! });
    inputsMap.set('rv_size',     { node: rv, input: 0, param: rvParams.get('/Reverb/size')! });
    inputsMap.set('rv_damp',     { node: rv, input: 0, param: rvParams.get('/Reverb/damp')! });
    inputsMap.set('rv_mix',      { node: rv, input: 0, param: rvParams.get('/Reverb/mix')! });
    inputsMap.set('flt_cutoff',    { node: flt, input: 0, param: fltParams.get('/QBRT/cutoff')! });
    inputsMap.set('flt_resonance', { node: flt, input: 0, param: fltParams.get('/QBRT/resonance')! });
    inputsMap.set('flt_mode',      { node: flt, input: 0, param: fltParams.get('/QBRT/mode')! });
    inputsMap.set('flt_pingDecay', { node: flt, input: 0, param: fltParams.get('/QBRT/pingDecay')! });
    inputsMap.set('returnA', { node: returnAGain, input: 0, param: returnAGain.gain });
    inputsMap.set('returnB', { node: returnBGain, input: 0, param: returnBGain.gain });

    // ---- Outputs ----
    const outputsMap = new Map<string, { node: AudioNode; output: number }>([
      ['outL', { node: fltSplitter, output: 0 }],
      ['outR', { node: fltSplitter, output: 1 }],
    ]);

    // ---- Voice-4 composite handle (wraps WT/ADSR/VCA suffix dispatch) ----
    const voice4Handle = {
      setParam(suffix: string, value: number) {
        switch (suffix) {
          case 'tune':     v4WtParams.get('tune')   ?.setValueAtTime(value, ctx.currentTime); break;
          case 'fine':     v4WtParams.get('fine')   ?.setValueAtTime(value, ctx.currentTime); break;
          case 'wavePos':  v4WtParams.get('wavePos')?.setValueAtTime(value, ctx.currentTime); break;
          case 'fmAmount': v4WtParams.get('fmAmount')?.setValueAtTime(value, ctx.currentTime); break;
          case 'attack':   v4AdsrParams.get('/ADSR/attack') ?.setValueAtTime(value, ctx.currentTime); break;
          case 'decay':    v4AdsrParams.get('/ADSR/decay')  ?.setValueAtTime(value, ctx.currentTime); break;
          case 'sustain':  v4AdsrParams.get('/ADSR/sustain')?.setValueAtTime(value, ctx.currentTime); break;
          case 'release':  v4AdsrParams.get('/ADSR/release')?.setValueAtTime(value, ctx.currentTime); break;
          case 'volume':   v4VcaParams.get('/VCA/cvAmount') ?.setValueAtTime(value, ctx.currentTime); break;
        }
      },
      readParam(suffix: string): number | undefined {
        switch (suffix) {
          case 'tune':     return v4WtParams.get('tune')?.value;
          case 'fine':     return v4WtParams.get('fine')?.value;
          case 'wavePos':  return v4WtParams.get('wavePos')?.value;
          case 'fmAmount': return v4WtParams.get('fmAmount')?.value;
          case 'attack':   return v4AdsrParams.get('/ADSR/attack')?.value;
          case 'decay':    return v4AdsrParams.get('/ADSR/decay')?.value;
          case 'sustain':  return v4AdsrParams.get('/ADSR/sustain')?.value;
          case 'release':  return v4AdsrParams.get('/ADSR/release')?.value;
          case 'volume':   return v4VcaParams.get('/VCA/cvAmount')?.value;
        }
        return undefined;
      },
    };

    // Voice handles for the dispatcher. v1..v3 wrap their DRUMMERGIRL params.
    const voiceHandles = [
      ...drummergirlParams.map((m) => ({
        setParam(suffix: string, value: number) {
          m.get(`/DRUMMERGIRL/${suffix}`)?.setValueAtTime(value, ctx.currentTime);
        },
        readParam(suffix: string): number | undefined {
          return m.get(`/DRUMMERGIRL/${suffix}`)?.value;
        },
      })),
      voice4Handle,
    ];

    // FX handles.
    const fltHandle = {
      setParam(suffix: string, value: number) {
        fltParams.get(`/QBRT/${suffix}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(suffix: string): number | undefined {
        return fltParams.get(`/QBRT/${suffix}`)?.value;
      },
    };
    const bcHandle = {
      setParam(suffix: string, value: number) {
        bcParams.get(`/DESTROY/${suffix}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(suffix: string): number | undefined {
        return bcParams.get(`/DESTROY/${suffix}`)?.value;
      },
    };
    const rvHandle = {
      setParam(suffix: string, value: number) {
        rvParams.get(`/Reverb/${suffix}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(suffix: string): number | undefined {
        return rvParams.get(`/Reverb/${suffix}`)?.value;
      },
    };

    // ---- Owned-knob dispatcher (pan / send / return levels) ----
    const ownedReadCache: Record<string, number> = {};
    function ownKnob(paramId: string, value: number): void {
      ownedReadCache[paramId] = value;
      // Pan -> pan worklet's `/EqualPowerPan/pan` AudioParam.
      const panMatch = paramId.match(/^v([1-4])_pan$/);
      if (panMatch) {
        const idx = parseInt(panMatch[1]!, 10) - 1;
        panParamsList[idx]?.get('/EqualPowerPan/pan')?.setValueAtTime(value, ctx.currentTime);
        return;
      }
      const sendMatch = paramId.match(/^v([1-4])_(sendA|sendB)$/);
      if (sendMatch) {
        const idx = parseInt(sendMatch[1]!, 10) - 1;
        const which = sendMatch[2]!;
        const gain = (which === 'sendA' ? sendAGains[idx] : sendBGains[idx]) as GainNode | undefined;
        gain?.gain.setValueAtTime(value, ctx.currentTime);
        return;
      }
      if (paramId === 'returnA') {
        returnAGain.gain.setValueAtTime(value, ctx.currentTime);
        return;
      }
      if (paramId === 'returnB') {
        returnBGain.gain.setValueAtTime(value, ctx.currentTime);
        return;
      }
      // bc_*/rv_* are routed via sink.bc / sink.rv (the effect worklets), not
      // ownKnob — they never reach here.
    }

    const sink: SetParamSink = {
      voices: voiceHandles,
      bc: bcHandle,
      rv: rvHandle,
      flt: fltHandle,
      ownKnob,
    };

    // Initial param application — walk through PARAMS once, dispatching each.
    for (const def of PARAMS) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      dispatchParam(sink, def.id, v);
    }

    // Tear-down list.
    const allSilences: ConstantSourceNode[] = [...drummergirlSilences, v4AdsrSilence, fltSilence];

    // ---- Test hook registration ----
    // Per-instance registration keyed by node.id so the window global can
    // dispatch trig pulses to the right RIOTGIRLS even with multiple in
    // the rack. Unregistered in dispose() below.
    registerRiotgirlsTriggerSink(node.id, {
      ctx,
      voices: [v1, v2, v3, v4Adsr],
    });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        dispatchParam(sink, paramId, value);
      },
      readParam(paramId) {
        // v1..v3 prefix: read from underlying voice handle.
        if (paramId.startsWith('v4_')) {
          return voice4Handle.readParam(paramId.slice(3));
        }
        const m = paramId.match(/^v([123])_(.+)$/);
        if (m) {
          const sub = m[2]!;
          if (sub === 'pan' || sub === 'sendA' || sub === 'sendB') {
            return ownedReadCache[paramId];
          }
          return voiceHandles[parseInt(m[1]!, 10) - 1]?.readParam(sub);
        }
        if (paramId.startsWith('bc_')) {
          return bcHandle.readParam(paramId.slice(3));
        }
        if (paramId.startsWith('rv_')) {
          return rvHandle.readParam(paramId.slice(3));
        }
        if (paramId.startsWith('flt_')) {
          return fltHandle.readParam(paramId.slice(4));
        }
        if (paramId === 'returnA') return returnAGain.gain.value;
        if (paramId === 'returnB') return returnBGain.gain.value;
        return ownedReadCache[paramId];
      },
      read(key) {
        if (key === 'voiceCount') return VOICE_COUNT;
        return undefined;
      },
      dispose() {
        unregisterRiotgirlsTriggerSink(node.id);
        for (const s of allSilences) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const n of [...drummergirlNodes, v4Wt, v4Adsr, v4Vca, ...pans, flt, bc, rv]) {
          try { n.disconnect(); } catch { /* */ }
        }
        for (const m of [...panMergers, fltMerger, v4VcaMerger]) {
          try { m.disconnect(); } catch { /* */ }
        }
        for (const sp of panSplitters) {
          try { sp.disconnect(); } catch { /* */ }
        }
        try { fltSplitter.disconnect(); } catch { /* */ }
        try { sumL.disconnect(); } catch { /* */ }
        try { sumR.disconnect(); } catch { /* */ }
        for (const g of [...sendAGains, ...sendBGains, sendBusA, sendBusB, returnAGain, returnBGain]) {
          try { g.disconnect(); } catch { /* */ }
        }
      },
    };
  },
};

// -------------------- Test hook registry --------------------
//
// `__riotgirlsTriggerVoice(nodeId, voiceIdx)` fires a synthetic 10 ms gate
// pulse on the requested voice's trig input. Used by Playwright E2E to drive
// audio activity without needing a Sequencer + cabling.
//
// Per the brief: gated on testHooksEnabled() (VITE_E2E_HOOKS=1 in autotest +
// dev). The actual window registration is performed in modules/index.ts,
// which lives at a single boot-time entry point.

export interface RiotgirlsTriggerSink {
  ctx: AudioContext;
  voices: AudioNode[]; // [v1, v2, v3, v4Adsr-input]
}

const triggerRegistry = new Map<string, RiotgirlsTriggerSink>();

export function registerRiotgirlsTriggerSink(nodeId: string, sink: RiotgirlsTriggerSink): void {
  triggerRegistry.set(nodeId, sink);
}

export function unregisterRiotgirlsTriggerSink(nodeId: string): void {
  triggerRegistry.delete(nodeId);
}

export function triggerVoice(nodeId: string, voiceIdx: number, durationMs = 50): boolean {
  const sink = triggerRegistry.get(nodeId);
  if (!sink) return false;
  const target = sink.voices[voiceIdx];
  if (!target) return false;
  // Modulate offset with setValueAtTime: 0 -> 1 (rising edge) -> 0 (falling).
  // This is more reliable than start()/stop() for short pulses because the
  // worklet sees the full 0->1->0 ramp in its audio-rate input regardless of
  // when the connection is materialized in the next render quantum.
  const pulse = sink.ctx.createConstantSource();
  const now = sink.ctx.currentTime;
  pulse.offset.setValueAtTime(0, now);
  pulse.offset.setValueAtTime(1, now + 0.001);
  pulse.offset.setValueAtTime(0, now + (durationMs + 1) / 1000);
  pulse.connect(target);
  pulse.start();
  // Keep the source alive long enough for the DRUMMERGIRL release envelope
  // to play out, then dispose to avoid graph leaks.
  pulse.stop(now + 1.0);
  pulse.onended = () => {
    try { pulse.disconnect(); } catch { /* */ }
  };
  return true;
}
