// packages/web/src/lib/audio/modules/moog-filterbank-factory.ts
//
// Shared PURE Web Audio factory for the Moog FIXED FILTER BANK family
// (907A + 914). Both modules are identical wiring — a fan GainNode feeding
// one fixed HIGH-PASS biquad, N fixed BANDPASS biquads, and one fixed
// LOW-PASS biquad, each through its own level GainNode into a summing
// GainNode — and differ ONLY in their center-frequency array (907A = the
// 8-band subset, 914 = the full 12-band series). Factoring the wiring here
// guarantees 907A vs 914 "differ only by data".
//
// No worklet: BiquadFilterNode does the filtering, GainNode does the per-band
// level + the summing (Web Audio fan-in is additive). Returns a standard
// AudioDomainNodeHandle:
//   inputs : Map { audio -> { node: fan, input: 0 } }
//   outputs: Map { audio -> { node: summer, output: 0 } }
//   setParam / readParam: target the matching section's GainNode.gain.
//   dispose(): disconnect every node created (fan, every filter + its gain,
//     the summer).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { bandParamId } from '../../../../../dsp/src/lib/moog-filterbank-dsp';

/**
 * Build the fixed-filter-bank audio graph for one module instance.
 *
 *   ctx     — the AudioContext.
 *   node    — the graph node (for initial param values).
 *   def     — the module def (for param defaults — hp/lp + band1..bandN).
 *   centers — the bandpass center frequencies (Hz). N = centers.length.
 *   q       — the bandpass Q for every band.
 */
export function buildFilterBank(
  ctx: AudioContext,
  node: ModuleNode,
  def: AudioModuleDef,
  centers: readonly number[],
  q: number,
  /** Low-pass shelf corner (Hz) — passes the spectrum BELOW the lowest band. */
  lpHz: number,
  /** High-pass shelf corner (Hz) — passes the spectrum ABOVE the highest band. */
  hpHz: number,
): AudioDomainNodeHandle {
  const initial = node.params ?? {};
  const levelOf = (id: string): number =>
    initial[id] ?? def.params.find((p) => p.id === id)!.defaultValue;

  // Input fan: every filter section taps this one node. Unity passthrough.
  const fan = ctx.createGain();
  fan.gain.value = 1;

  // Summing bus: every section's level gain fans IN here (additive).
  const summer = ctx.createGain();
  summer.gain.value = 1;

  // Track every node we make so dispose() can tear it all down.
  const filters: BiquadFilterNode[] = [];
  // Per-param-id level GainNode (hp / lp / band1..bandN) for setParam/readParam.
  const gainByParam: Record<string, GainNode> = {};

  // One filter section: in -> biquad -> level gain -> summer.
  function addSection(
    type: BiquadFilterType,
    freq: number,
    qValue: number,
    paramId: string,
  ): void {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = qValue;

    const level = ctx.createGain();
    level.gain.value = levelOf(paramId);

    fan.connect(filter);
    filter.connect(level);
    level.connect(summer);

    filters.push(filter);
    gainByParam[paramId] = level;
  }

  // Fixed HIGH-PASS shelf above the highest band (914: 7.5 kHz, 907A: 6.6 kHz),
  // so the HP knob controls how much of the TOP of the spectrum the bank passes.
  addSection('highpass', hpHz, q, 'hp');

  // The N fixed BANDPASS sections (low → high), one per center frequency.
  centers.forEach((freq, i) => {
    addSection('bandpass', freq, q, bandParamId(i + 1));
  });

  // Fixed LOW-PASS shelf below the lowest band (914: 100 Hz, 907A: 175 Hz), so
  // the LP knob controls how much of the BOTTOM of the spectrum the bank passes.
  addSection('lowpass', lpHz, q, 'lp');

  return {
    domain: 'audio',
    inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['audio', { node: fan, input: 0 }],
    ]),
    outputs: new Map([
      ['audio', { node: summer, output: 0 }],
    ]),
    setParam(paramId, value) {
      const g = gainByParam[paramId];
      if (!g) return;
      g.gain.setValueAtTime(value, ctx.currentTime);
    },
    readParam(paramId) {
      const g = gainByParam[paramId];
      if (!g) return undefined;
      return g.gain.value;
    },
    dispose() {
      try { fan.disconnect(); } catch { /* */ }
      for (const f of filters) {
        try { f.disconnect(); } catch { /* */ }
      }
      for (const id of Object.keys(gainByParam)) {
        try { gainByParam[id]!.disconnect(); } catch { /* */ }
      }
      try { summer.disconnect(); } catch { /* */ }
    },
  };
}
