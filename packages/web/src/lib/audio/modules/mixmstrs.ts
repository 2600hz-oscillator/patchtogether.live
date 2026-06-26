// packages/web/src/lib/audio/modules/mixmstrs.ts
//
// MIXMSTRS — 6-channel stereo mixer with EQ, compressor, two stereo aux sends,
// two stereo returns. Multiple instances are allowed (submixes / parallel
// master buses); each instance sums its inputs to the destination additively.
//
// 16 audio inputs (6 ch × stereo + 2 returns × stereo) + 12 worklet audio
// outputs: 6 patchable module ports (master L/R + send1 L/R + send2 L/R) plus
// 6 internal POST-FADER per-channel level taps (NOT module ports) feeding the
// VU read('levels'). 61 AudioParams (55 original + 6 per-channel `comp`
// macro knobs).
//
// Per-channel `comp` macro (added in feat/audio-fidelity-mixmstrs-comp-swolevco):
//
//   The DSP carries a per-channel compressor with three controls (thresh,
//   ratio, compEnable). Tuning all three simultaneously is fiddly. The new
//   `comp{N}` knob (one per channel, 0..1) collapses those into a single
//   "amount" macro:
//
//     * comp = 0       → compEnable=0 (full bypass; identity passthrough)
//     * comp ∈ (0, 1]  → compEnable=1 AND thresh interpolates from 0 dB
//                        (no compression) at comp=ε to -20 dB at comp=1, AND
//                        ratio interpolates from 1.0 (no compression) at
//                        comp=ε to 4.0 at comp=1.
//
//   At comp=1 the channel sees a moderate compression curve (-20dB threshold,
//   4:1 ratio, the existing 5ms attack / 100ms release baked into the Faust
//   DSP) — enough to "isolate" the channel against louder sources in the
//   mix without obvious pumping.
//
//   The original `chN_thresh` / `chN_ratio` / `chN_compEnable` params remain
//   exposed (cv inputs + UI knobs) for power users who want manual control.
//   The `comp` macro just writes ALL three downstream params; if a user
//   patches CV into both `comp1` and `ch1_thresh` simultaneously, the comp
//   macro wins (it overwrites on every setParam call).
//
// Inputs:
//   ch{1..6}L / ch{1..6}R (audio): six stereo channel inputs (6 × stereo = 12 ports).
//   ret1L / ret1R / ret2L / ret2R (audio): two stereo aux returns.
//   ch{N}_{volume,low,mid,high,thresh,ratio,compEnable,send1,send2} (cv, linear or discrete,
//     paramTarget=…): per-channel CV inputs for every param. Linear unless the param is discrete.
//   comp{1..6} (cv, linear, paramTarget=…): per-channel compressor macro CV.
//   master_volume (cv, linear, paramTarget=master_volume): displaces the master volume.
//
// Outputs:
//   masterL / masterR (audio): main stereo mix bus.
//   send1L / send1R (audio): stereo aux-send 1 output.
//   send2L / send2R (audio): stereo aux-send 2 output.
//
// Params (61 total — built programmatically, see buildParams() below):
//   master_volume (linear 0..1, default 0.8): bus output gain.
//   per-channel × 6: volume / low / mid / high (linear ±12 dB) /
//     thresh (-36..0 dB) / ratio (1..10) / compEnable (discrete) /
//     comp (linear 0..1 macro) / send1 / send2 (linear 0..1).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef, PortDef } from '$lib/graph/types';
import wasmUrl from '@patchtogether.live/dsp/dist/mixmstrs.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixmstrs.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixmstrs.worklet.js?url';

const PARAM_PREFIX = '/MIXMSTRS';

// Channel count — single source of truth for the 6-channel layout. The Faust
// process() declares channels in this order, then the two stereo returns.
export const MIXMSTRS_CHANNELS = [1, 2, 3, 4, 5, 6] as const;
const NUM_CHANNELS = MIXMSTRS_CHANNELS.length;

// ---------------- Comp macro mapping ----------------
//
// Pure helper extracted so the unit test can verify the boundary behavior
// without spinning up Web Audio.
//
// Returns the (compEnable, thresh, ratio) that the macro writes for a
// given comp ∈ [0, 1].
//
//   comp = 0      → { enable: 0, thresh: 0,    ratio: 1 } (bypass)
//   comp = 0.001  → { enable: 1, thresh: ≈0,   ratio: ≈1 } (just barely on)
//   comp = 1      → { enable: 1, thresh: -20,  ratio: 4 }
//
// thresh + ratio interpolate linearly with comp ∈ (0, 1].
export function mapCompMacro(comp: number): {
  enable: 0 | 1;
  thresh: number;
  ratio: number;
} {
  const c = Math.max(0, Math.min(1, comp));
  if (c === 0) return { enable: 0, thresh: 0, ratio: 1 };
  // Lerp thresh: 0 dB → -20 dB; ratio: 1 → 4.
  return {
    enable: 1,
    thresh: 0 + (-20 - 0) * c,
    ratio: 1 + (4 - 1) * c,
  };
}

// ---------------- Post-fader meter helper ----------------
//
// Pure RMS over a time-domain sample window — the same math scope.ts /
// engine RMS use. Extracted so the unit test can assert level ordering/scale
// deterministically (feed known buffers, read the levels) without spinning up
// Web Audio. `read('levels')` runs this over each channel's post-fader tap
// analyser buffer (see the factory below).
export function rmsLevel(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

// Build the 61-param schema programmatically — 9 controls + 1 comp macro per
// channel × 6 channels + 1 master.
function buildParams(): readonly ParamDef[] {
  const params: ParamDef[] = [];
  for (const ch of MIXMSTRS_CHANNELS) {
    params.push({ id: `ch${ch}_volume`,      label: `${ch}V`,   defaultValue: 0.8, min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_low`,         label: `${ch}Lo`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_mid`,         label: `${ch}Md`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_high`,        label: `${ch}Hi`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_thresh`,      label: `${ch}Th`,  defaultValue: -12, min: -36,  max: 0,   curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_ratio`,       label: `${ch}Rt`,  defaultValue: 2,   min: 1,    max: 10,  curve: 'linear' });
    params.push({ id: `ch${ch}_compEnable`,  label: `${ch}Cp`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'discrete' });
    // Per-channel comp macro (added in audio-fidelity PR). Default 0 = bypass —
    // every existing patch keeps its previous compressor behavior unchanged.
    params.push({ id: `comp${ch}`,           label: `${ch}Cm`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_send1`,       label: `${ch}S1`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_send2`,       label: `${ch}S2`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
  }
  params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
  return params;
}

const PARAMS = buildParams();

// Audio input port ids in the exact order the Faust process() declares them:
// 12 channel ports (ch1L..ch6R) then the 4 return ports.
const AUDIO_IN_PORTS: readonly string[] = [
  ...MIXMSTRS_CHANNELS.flatMap((ch) => [`ch${ch}L`, `ch${ch}R`]),
  'ret1L', 'ret1R', 'ret2L', 'ret2R',
];

// Comp-macro ids, derived from the channel list so they never drift apart.
const COMP_MACRO_IDS: readonly string[] = MIXMSTRS_CHANNELS.map((ch) => `comp${ch}`);

// Inputs: 16 audio + 61 paramTarget CV inputs (55 originals + 6 comp macros).
//
// Every CV input gets a `cvScale: linear` hint per
// .myrobots/plans/cv-range-standard.md so an LFO at ±1 sweeps the param's
// full natural range centered on the user's knob position. All MIXMSTRS
// params have linear knob curves (volume, dB EQ bands, dB threshold,
// ratio, send amounts); none use log scaling natively, so linear here is
// the right match.
function buildInputs(): PortDef[] {
  const inputs: PortDef[] = AUDIO_IN_PORTS.map((id) => ({ id, type: 'audio' as const }));
  for (const p of PARAMS) {
    inputs.push({
      id: p.id,
      type: 'cv',
      paramTarget: p.id,
      cvScale: { mode: p.curve === 'discrete' ? 'discrete' : 'linear' },
    });
  }
  return inputs;
}

export const mixmstrsDef: AudioModuleDef = {
  type: 'mixmstrs',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'mixmstrs',
  category: 'utilities',
  schemaVersion: 1,
  stereoPairs: [
    ...MIXMSTRS_CHANNELS.map((ch) => [`ch${ch}L`, `ch${ch}R`] as [string, string]),
    ['ret1L', 'ret1R'],
    ['ret2L', 'ret2R'],
  ],

  inputs: buildInputs(),
  outputs: [
    { id: 'masterL', type: 'audio' },
    { id: 'masterR', type: 'audio' },
    { id: 'send1L',  type: 'audio' },
    { id: 'send1R',  type: 'audio' },
    { id: 'send2L',  type: 'audio' },
    { id: 'send2R',  type: 'audio' },
  ],
  params: PARAMS,

  docs: (() => {
    const inputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    for (const ch of MIXMSTRS_CHANNELS) {
      // Stereo audio inputs.
      inputs[`ch${ch}L`] = `Channel ${ch} left audio input. Pairs with ${`ch${ch}R`} as the stereo source for mixer channel ${ch}.`;
      inputs[`ch${ch}R`] = `Channel ${ch} right audio input, partnering ch${ch}L.`;
      // Per-channel param controls.
      controls[`ch${ch}_volume`] = `Channel ${ch} VOLUME fader (0..1) — the channel's level into the master bus + aux sends. CV via the ch${ch}_volume input.`;
      controls[`ch${ch}_low`] = `Channel ${ch} LOW EQ band (±12 dB) — boost/cut the lows on channel ${ch}. CV via the ch${ch}_low input.`;
      controls[`ch${ch}_mid`] = `Channel ${ch} MID EQ band (±12 dB) — boost/cut the mids on channel ${ch}. CV via the ch${ch}_mid input.`;
      controls[`ch${ch}_high`] = `Channel ${ch} HIGH EQ band (±12 dB) — boost/cut the highs on channel ${ch}. CV via the ch${ch}_high input.`;
      controls[`ch${ch}_thresh`] = `Channel ${ch} compressor THRESHOLD (−36..0 dB) — the level above which channel ${ch}'s compressor starts gain-reduction (only when COMP ENABLE / the COMP macro is on). CV via the ch${ch}_thresh input.`;
      controls[`ch${ch}_ratio`] = `Channel ${ch} compressor RATIO (1..10) — how hard channel ${ch}'s compressor reduces gain above the threshold (1 = none, 10 = strong). CV via the ch${ch}_ratio input.`;
      controls[`ch${ch}_compEnable`] = `Channel ${ch} compressor ENABLE (on/off) — bypasses or engages channel ${ch}'s compressor directly (the manual control under the COMP macro). CV via the ch${ch}_compEnable input.`;
      controls[`comp${ch}`] = `Channel ${ch} COMP macro (0..1) — one knob that collapses the per-channel compressor: 0 = bypass, and (0,1] enables it while interpolating the threshold from 0 dB down to −20 dB and the ratio from 1:1 up to 4:1, for a quick "isolate this channel" amount. Overrides the manual thresh/ratio/enable when moved. CV via the comp${ch} input.`;
      controls[`ch${ch}_send1`] = `Channel ${ch} SEND 1 amount (0..1) — how much of channel ${ch} is tapped to aux-send bus 1 (the send1L/R outputs, e.g. for an external reverb). CV via the ch${ch}_send1 input.`;
      controls[`ch${ch}_send2`] = `Channel ${ch} SEND 2 amount (0..1) — how much of channel ${ch} feeds aux-send bus 2. CV via the ch${ch}_send2 input.`;
      // Per-channel CV inputs (paramTarget = the same id).
      inputs[`ch${ch}_volume`] = `CV that offsets channel ${ch}'s VOLUME fader (±1 CV sweeps the full 0..1 span around the knob).`;
      inputs[`ch${ch}_low`] = `CV that offsets channel ${ch}'s LOW EQ band.`;
      inputs[`ch${ch}_mid`] = `CV that offsets channel ${ch}'s MID EQ band.`;
      inputs[`ch${ch}_high`] = `CV that offsets channel ${ch}'s HIGH EQ band.`;
      inputs[`ch${ch}_thresh`] = `CV that offsets channel ${ch}'s compressor THRESHOLD.`;
      inputs[`ch${ch}_ratio`] = `CV that offsets channel ${ch}'s compressor RATIO.`;
      inputs[`ch${ch}_compEnable`] = `CV (discrete) that toggles channel ${ch}'s compressor ENABLE.`;
      inputs[`comp${ch}`] = `CV that offsets channel ${ch}'s COMP macro amount.`;
      inputs[`ch${ch}_send1`] = `CV that offsets channel ${ch}'s SEND 1 amount.`;
      inputs[`ch${ch}_send2`] = `CV that offsets channel ${ch}'s SEND 2 amount.`;
    }
    // Stereo aux returns.
    inputs.ret1L = 'Aux RETURN 1 left input — the wet signal coming back from the effect on send 1; summed (stereo) into the master bus.';
    inputs.ret1R = 'Aux RETURN 1 right input, partnering ret1L.';
    inputs.ret2L = 'Aux RETURN 2 left input — the wet return for send 2; summed into the master bus.';
    inputs.ret2R = 'Aux RETURN 2 right input, partnering ret2L.';
    // Master CV.
    inputs.master_volume = 'CV that offsets the MASTER volume — modulate the overall output level of the whole mix.';
    return {
      explanation:
        "A 6-channel stereo mixer with a channel strip on every input — the master bus of a patch. Each of the six channels takes a stereo pair, runs it through a 3-band EQ (low/mid/high, ±12 dB), an optional compressor, and a volume fader, then sums into the stereo MASTER output. Two stereo AUX SENDS tap each channel (per-channel SEND 1 / SEND 2 amounts) out to send1L/R and send2L/R — patch an external reverb/delay off a send and bring its wet signal back into the matching stereo RETURN, which sums into the master. The compressor is exposed two ways: manual THRESH / RATIO / ENABLE per channel, OR a single COMP macro knob that collapses all three into one 'amount' (0 = bypass, up to a moderate −20 dB / 4:1 at full). EVERY parameter also has a CV input (so an LFO can ride a fader, EQ band, or send), and the card shows a post-fader VU meter per channel. Multiple MIXMSTRS instances are allowed for submixes / parallel buses — each sums additively into its destination.",
      inputs,
      outputs: {
        masterL: 'MASTER bus left output — all six channels (post EQ/comp/fader) plus the two aux returns, summed. The main stereo mix out.',
        masterR: 'MASTER bus right output, the partner of masterL.',
        send1L: 'AUX SEND 1 left output — the sum of every channel scaled by its SEND 1 amount. Patch it into an external effect, then return the wet to ret1L/R.',
        send1R: 'AUX SEND 1 right output, the partner of send1L.',
        send2L: 'AUX SEND 2 left output — the sum of every channel scaled by its SEND 2 amount. Return its wet to ret2L/R.',
        send2R: 'AUX SEND 2 right output, the partner of send2L.',
      },
      controls: {
        ...controls,
        master_volume: 'MASTER output level (0..1) — the overall gain of the whole mix bus. CV via the master_volume input.',
      },
    };
  })(),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'mixmstrs', wasmUrl, metaUrl, workletUrl });

    // 16 mono audio inputs into the Faust worklet (channel-merger of 16).
    // The Faust process() takes 16 args in the same order our inputs declare.
    const NUM_AUDIO_IN = AUDIO_IN_PORTS.length; // 16
    const merger = ctx.createChannelMerger(NUM_AUDIO_IN);
    merger.connect(f);
    // Silence keeps each channel active even with nothing patched in.
    const silenceSources: ConstantSourceNode[] = [];
    for (let i = 0; i < NUM_AUDIO_IN; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(merger, 0, i);
      silenceSources.push(sil);
    }

    // Output splitter: 12 channels. 0..5 are the patchable module outputs
    // (masterL/R, send1L/R, send2L/R); 6..11 are the per-channel POST-FADER
    // meter taps the DSP now emits (post EQ → comp → fader). The meter taps
    // are NOT exposed as module ports — they only feed the VU analysers below.
    const NUM_OUT = 6 + NUM_CHANNELS; // 12
    const splitter = ctx.createChannelSplitter(NUM_OUT);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    // Track comp macro values JS-side (they don't have a backing Faust param;
    // they fan out to the existing thresh/ratio/compEnable triple via setParam).
    const compMacro: Record<string, number> = {};
    for (const id of COMP_MACRO_IDS) compMacro[id] = 0;
    for (const def of PARAMS) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      if (def.id.startsWith('comp')) {
        // Macro: store JS-side, then apply via the same code path setParam uses.
        compMacro[def.id] = v;
        applyCompMacro(def.id, v);
        continue;
      }
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    function applyCompMacro(macroId: string, value: number) {
      // macroId is one of 'comp1'..'comp6'. The N is the channel number.
      const ch = macroId.slice('comp'.length);
      const m = mapCompMacro(value);
      params.get(`${PARAM_PREFIX}/ch${ch}_compEnable`)?.setValueAtTime(m.enable, ctx.currentTime);
      params.get(`${PARAM_PREFIX}/ch${ch}_thresh`)?.setValueAtTime(m.thresh, ctx.currentTime);
      params.get(`${PARAM_PREFIX}/ch${ch}_ratio`)?.setValueAtTime(m.ratio, ctx.currentTime);
    }

    // ── Per-channel POST-FADER meter taps — read('levels') → number[6] ──
    //
    // ACCURATE VU for the Electra MIXMASTER meter row (and any on-card meter):
    // the Faust DSP emits one mono POST-FADER level per channel (post EQ →
    // comp → volume fader) on worklet outputs 6..11. We split those off and run
    // each through an AnalyserNode; read('levels') returns their RMS. Unlike the
    // prior JS input-tap approximation (input-RMS × live chN_volume, which
    // ignored EQ + comp gain), this reflects exactly what the channel feeds the
    // master bus. (Master VU stays separate via audioOut.read('outputSnapshot').)
    // The analysers are passive sinks — never connected onward — so they add no
    // audible signal and can't alter the mix.
    //
    // splitter channels 6..11 = ch1..ch6 post-fader level taps.
    const meterAnalysers: AnalyserNode[] = [];
    const meterBufs: Float32Array<ArrayBuffer>[] = [];
    const METER_TAP_OFFSET = 6; // outputs 0..5 are master+sends; 6..11 are taps
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const ana = ctx.createAnalyser();
      ana.fftSize = 1024;
      ana.smoothingTimeConstant = 0.3;
      splitter.connect(ana, METER_TAP_OFFSET + ch);
      meterAnalysers.push(ana);
      meterBufs.push(new Float32Array(ana.fftSize));
    }
    function readChannelLevels(): number[] {
      const out: number[] = [];
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        const ana = meterAnalysers[ch]!;
        const buf = meterBufs[ch]!;
        ana.getFloatTimeDomainData(buf);
        out.push(rmsLevel(buf));
      }
      return out;
    }

    // Build inputs map: 16 audio at fixed indices, 61 CV-targets per param
    // (55 Faust-backed + 6 comp macros).
    //
    // For comp macros we still need a backing AudioParam so the engine's
    // CV → AudioParam tap analyser works (motorized fader feedback). We
    // route to a hidden GainNode whose .gain is the macro's "shadow" param;
    // setParam reads the shadow's `.value` and applies the macro mapping
    // each time. This mirrors how wavviz handles its foldAmount macro.
    const compShadow: Record<string, GainNode> = {};
    for (const macroId of COMP_MACRO_IDS) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(compMacro[macroId] ?? 0, ctx.currentTime);
      // Connect to a sink ConstantSource(0) so the shadow stays in the
      // active processing graph. We connect g's output to silence (a
      // no-op merger input) so it doesn't actually contribute to audio.
      const sink = ctx.createConstantSource();
      sink.offset.value = 0;
      sink.start();
      sink.connect(g); // sink → g (silent input, keeps g alive)
      // We DON'T connect g downstream — the cv tap analyser reads g.gain,
      // we periodically read it back from setParam to apply the macro mapping.
      silenceSources.push(sink);
      compShadow[macroId] = g;
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    AUDIO_IN_PORTS.forEach((id, i) => {
      inputsMap.set(id, { node: merger, input: i });
    });
    for (const p of PARAMS) {
      if (p.id.startsWith('comp')) {
        // CV input for the comp macro: route to the shadow AudioParam so the
        // engine's CV-tap analyser sees modulator activity. The actual
        // application of comp → (enable, thresh, ratio) happens in setParam.
        const g = compShadow[p.id];
        if (g) inputsMap.set(p.id, { node: g, input: 0, param: g.gain });
        continue;
      }
      const ap = params.get(`${PARAM_PREFIX}/${p.id}`);
      if (ap) inputsMap.set(p.id, { node: f, input: 0, param: ap });
    }

    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    ['masterL','masterR','send1L','send1R','send2L','send2R'].forEach((id, i) => {
      outputsMap.set(id, { node: splitter, output: i });
    });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        if (paramId.startsWith('comp')) {
          compMacro[paramId] = value;
          // Update the shadow AudioParam so readParam returns the live value.
          compShadow[paramId]?.gain.setValueAtTime(value, ctx.currentTime);
          applyCompMacro(paramId, value);
          return;
        }
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId.startsWith('comp')) return compMacro[paramId];
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        // Per-channel POST-FADER VU for the Electra MIXMASTER meter row + any
        // on-card meters. Returns number[6] of linear RMS levels (~0..1), one
        // per channel, read off the DSP's post-fader taps. See
        // readChannelLevels() above.
        if (key === 'levels') return readChannelLevels();
        return undefined;
      },
      dispose() {
        for (const s of silenceSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const g of Object.values(compShadow)) g.disconnect();
        for (const ana of meterAnalysers) ana.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};
