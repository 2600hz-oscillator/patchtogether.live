// packages/dsp/src/warrensspectrum.ts
//
// WARREN'S SPECTRUM — AudioWorkletProcessor wrapper.
//
// The engine lives in ./lib/warrensspectrum-dsp.ts (ONE implementation,
// shared by the worklet, the unit gates and the ART profile). This file is
// only the AudioWorklet shell: parameter descriptors, the three audio-rate
// inputs, and the per-sample loop.
//
// I/O (must stay in this order — the def's factory maps by input index):
//   input 0  audio_in  mono audio under analysis
//   input 1  pitch     V/oct → multiplicative transposition on the bank
//   input 2  gate      FREEZE while high (level, not edge — see below)
//   output 0 out       STEREO (2 ch) — see below
//
// ── WHY THE OUTPUT IS STEREO EVEN THOUGH THE ENGINE IS MONO (phase 2) ─────
// `resynthBuf_` upstream is one channel and so is ours: the spectral engine
// is mono end to end. Stereo is created in the FILTERBANK, by its per-band
// equal-power pan — so the output has to be two channels for the bank to
// have anywhere to put an image. With the bank out of circuit (WET 0, the
// shipped default) the engine writes the SAME sample to both channels, so a
// default rack is bit-identical to phase 1's mono output and a downstream
// stereo→mono downmix (0.5·(L+R) with L == R) returns it exactly.
//
// ── THE BAND TABLE DOES NOT TRAVEL AS AudioParams ─────────────────────────
// 8 bands x 5 values would be 40 more AudioParams, 40 more ParamDefs and 40
// more authored doc blobs — and the plan (§5.3) is explicit that the bank
// has to be ONE control-family panel, not 56 cells. So the table rides
// `port.postMessage` and lives in `node.data`, exactly as DX7's per-operator
// table does. The cost of leaving AudioParam behind is that NOTHING clamps
// for us any more, which is why every message goes through
// `wsNormalizeBands` before it can reach `Math.tan`.
//
// FREEZE is LEVEL-SENSITIVE, not an edge toggle. The VST's `engineFreeze` is
// a held boolean (`PluginParams.h:141-142`), and CLAUDE.md's gate/trigger
// rule says a level-sensitive consumer declares `edge: 'gate'` and READS THE
// LEVEL. So the port is a true gate: frozen while high, thawed when it falls.
// The FREEZE control and the gate input OR together.

import { WarrensSpectrumEngine } from './lib/warrensspectrum-dsp';
import { wsNormalizeBands } from './lib/warrensspectrum-filterbank';

/** GATE_HI mirrors $lib/audio/gate-trigger — a gate is "high" at >= 0.5. */
const GATE_HI = 0.5;

class WarrensSpectrumProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Every descriptor's min/max/default MUST equal the ParamDef in
      // packages/web/src/lib/audio/modules/warrensspectrum.ts — a card or a
      // CV path that writes past an AudioParam's range is silently clamped,
      // which is the "control lies about its own range" failure class.
      { name: 'spectralPartials', defaultValue: 64, minValue: 1, maxValue: 256, automationRate: 'k-rate' as const },
      { name: 'spectralFloor', defaultValue: -42, minValue: -90, maxValue: -20, automationRate: 'k-rate' as const },
      { name: 'spectralStab', defaultValue: 3, minValue: 1, maxValue: 16, automationRate: 'k-rate' as const },
      { name: 'spectralLock', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'spectralResidual', defaultValue: 0.5, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'spectralShape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'spectralSlew', defaultValue: 0.6, minValue: 0.02, maxValue: 4, automationRate: 'k-rate' as const },
      { name: 'spectralSlice', defaultValue: 10, minValue: 2, maxValue: 200, automationRate: 'k-rate' as const },
      { name: 'spectralCenter', defaultValue: 0, minValue: -3600, maxValue: 3600, automationRate: 'k-rate' as const },
      { name: 'engineFreeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // ENGINE MODE (phase 4). 0 = SPECTRAL, 1 = MASSPASS. Indices append in
      // IMPLEMENTATION order, deliberately NOT the VST's (where MASSPASS is
      // 2) — see WS_ENGINE_MASSPASS for why a reachable-but-unimplemented
      // index 1 was rejected.
      { name: 'engineMode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // MASSPASS BAND COUNT, as an INDEX into WS_MASSPASS_BAND_COUNTS
      // (0→16, 1→24, 2→33, 3→48, 4→66, 5→99). Ignored in SPECTRAL.
      { name: 'spectralBandCount', defaultValue: 1, minValue: 0, maxValue: 5, automationRate: 'k-rate' as const },
      // FILTERBANK WET. ⚠ DEFAULT 0 — a deliberate divergence from the VST's
      // 1.0, so phase 2 cannot re-voice a rack saved under phase 1. The
      // reason lives on the engine field; the gate that holds it is
      // warrensspectrum-filterbank.test.ts's "the DEFAULT is untouched".
      { name: 'resynthLevel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'inputMix', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'gain', defaultValue: 0, minValue: -60, maxValue: 12, automationRate: 'k-rate' as const },
    ];
  }

  private engine = new WarrensSpectrumEngine(sampleRate);
  /** Scratch for the stereo pair — allocated ONCE, never in `process`. */
  private pair = new Float32Array(2);

  constructor() {
    super();
    // The band table arrives here, never as an AudioParam. `wsNormalizeBands`
    // is the ONLY range check on it (see the header note), so it runs on
    // every message rather than trusting the sender — the sender is a saved
    // rack, which may predate any field the table has today.
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; bands?: unknown } | null;
      if (msg?.type === 'bands') this.engine.setBands(wsNormalizeBands(msg.bands));
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    if (!outL) return true;
    // `outR` is absent only if a host handed us a mono output despite the
    // node's `outputChannelCount: [2]`. Fall back to writing LEFT twice
    // rather than dropping the bank's right bus on the floor silently.
    const outR = outputs[0]?.[1] ?? outL;

    const audioIn = inputs[0]?.[0] ?? null;
    const pitchIn = inputs[1]?.[0] ?? null;
    const gateIn = inputs[2]?.[0] ?? null;

    const e = this.engine;
    // Once per quantum, BEFORE the sample loop: re-runs MASSPASS's
    // loudest-band selection, mirroring the C++'s once-per-block selection
    // (`MassPass.cpp:236-247`). No-op cost in SPECTRAL.
    e.beginBlock();
    // k-rate: one pull per render quantum. The analyser commits at most once
    // every 96 samples (SLICE's 2 ms floor), so a per-quantum parameter pull
    // cannot skip a commit's worth of change.
    //
    // ⚠ BAND COUNT before ENGINE MODE and PARTIALS before both: the band
    // count re-clamps the active-band limit, so the bank must be sized
    // before PARTIALS is re-applied to it.
    e.setBandCountIndex(parameters.spectralBandCount![0]!);
    e.setEngineMode(parameters.engineMode![0]!);
    e.setPartials(parameters.spectralPartials![0]!);
    e.setFloorDb(parameters.spectralFloor![0]!);
    e.setStabilityFrames(parameters.spectralStab![0]!);
    e.setLock(parameters.spectralLock![0]!);
    e.setResidual(parameters.spectralResidual![0]!);
    e.setShape(parameters.spectralShape![0]!);
    e.setSlewSeconds(parameters.spectralSlew![0]!);
    e.setSliceMs(parameters.spectralSlice![0]!);
    e.setCenterCents(parameters.spectralCenter![0]!);
    e.setFilterbankWet(parameters.resynthLevel![0]!);
    e.setInputMix(parameters.inputMix![0]!);
    e.setGainLinear(Math.pow(10, parameters.gain![0]! / 20));

    const freezeParam = parameters.engineFreeze![0]! >= 0.5;
    const pair = this.pair;

    for (let i = 0; i < outL.length; i++) {
      // FREEZE: the control OR the gate level. Read per sample so a gate
      // that opens mid-quantum freezes on the sample it opened.
      const gateHigh = gateIn ? gateIn[i]! >= GATE_HI : false;
      e.setFrozen(freezeParam || gateHigh);
      // V/oct: 1 volt = 1 octave, applied post-analysis to the whole bank.
      const volts = pitchIn ? pitchIn[i]! : 0;
      const transpose = volts === 0 ? 1 : Math.pow(2, volts);
      e.processSampleStereo(pair, audioIn ? audioIn[i]! : 0, transpose);
      outL[i] = pair[0]!;
      outR[i] = pair[1]!;
    }

    return true;
  }
}

registerProcessor('warrensspectrum', WarrensSpectrumProcessor);
