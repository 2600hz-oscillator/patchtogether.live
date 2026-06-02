// packages/web/src/lib/audio/modules/sample-hold.ts
//
// SAMPLE & HOLD / quantizer.
//
// On a RISING EDGE at gate_in, the module samples cv_in and HOLDS it on
// cv_out until the next rising edge; cv_quant is that held value snapped to
// the nearest note of the selected SCALE (1V/oct, root = C / 0V, 12 ET
// semitones/oct). When NOTHING is patched to gate_in, cv_in passes through
// CONTINUOUSLY and cv_quant continuously quantizes the live input — i.e. the
// module becomes a pure QUANTIZER.
//
// UNPATCHED-GATE DETECTION (mirrors the SEQUENCER/SCORE "external clock vs
// internal BPM" pattern, the same unpatched-input technique SKIFREE uses for
// its mouse fallback): the worklet can't see the patch topology, only its
// inputs, so the FACTORY watches the live graph
// (`isInputPortConnected(Object.values(livePatch.edges), nodeId, 'gate_in')`)
// and feeds the result into a k-rate `gateConnected` AudioParam (1 = patched →
// sample & hold; 0 = unpatched → continuous quantizer). A lightweight poll
// re-checks the edge set so plugging/unplugging the gate flips modes live.
//
// DSP lives in packages/dsp/src/sample-hold.ts (the worklet) + the pure
// quantizer/latch math in packages/dsp/src/lib/sample-hold-dsp.ts (shared with
// the unit + ART tests).
//
// Inputs:
//   cv_in (cv): the value to sample / quantize.
//   gate_in (gate): rising edge latches cv_in. Unpatched = continuous quantizer.
//
// Outputs:
//   cv_out (cv): the held (or, ungated, the live passed-through) value.
//   cv_quant (cv): cv_out snapped to the nearest note of the selected scale.
//
// Params:
//   scale (discrete 0..9, default 1=Major): the quantize scale. The card shows
//     the scale NAME above the knob.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
// Pure scale-quantizer math — imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cube.ts /
// bluebox.ts do: worktrees may not symlink the workspace package under
// node_modules, and the TS path-alias rules don't reliably resolve TS source
// out of node_modules/@patchtogether.live/dsp/src. This is the IDENTICAL scale
// table the worklet + node-ART run.
import {
  SAMPLE_HOLD_SCALES,
  SAMPLE_HOLD_MAX_SCALE,
  scaleName,
} from '../../../../../dsp/src/lib/sample-hold-dsp';
import workletUrl from '@patchtogether.live/dsp/dist/sample-hold.js?url';

const PROCESSOR_NAME = 'sample-hold';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Re-export the display names for the card label (single source of truth is
 *  the DSP lib's scale table). */
export const SAMPLE_HOLD_SCALE_NAMES: readonly string[] =
  SAMPLE_HOLD_SCALES.map((s) => s.name);
export { SAMPLE_HOLD_MAX_SCALE, scaleName as sampleHoldScaleName };

// How often the factory re-checks whether gate_in is patched. 120 ms is well
// within human cable-plug cadence and negligible CPU; the actual S&H/quantize
// runs at audio rate in the worklet regardless.
const GATE_POLL_MS = 120;

export const sampleHoldDef: AudioModuleDef = {
  type: 'sampleHold',
  domain: 'audio',
  label: 'SAMPLE & HOLD',
  category: 'utility',
  schemaVersion: 1,
  inputs: [
    { id: 'cv_in',   type: 'cv' },
    { id: 'gate_in', type: 'gate' },
  ],
  outputs: [
    { id: 'cv_out',   type: 'cv' },
    { id: 'cv_quant', type: 'cv' },
  ],
  params: [
    {
      id: 'scale',
      label: 'Scale',
      defaultValue: 1, // Major
      min: 0,
      max: SAMPLE_HOLD_MAX_SCALE,
      curve: 'discrete',
    },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const nodeId = node.id;

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    const initialScale = (node.params ?? {}).scale ?? sampleHoldDef.params[0]!.defaultValue;
    params.get('scale')?.setValueAtTime(initialScale, ctx.currentTime);

    // ── Unpatched-gate detection: poll the live graph, push to a k-rate param ──
    function isGateConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'gate_in');
    }
    const gateConnectedParam = params.get('gateConnected')!;
    let lastGateConnected: boolean | null = null;
    function refreshGateConnected(): void {
      const connected = isGateConnected();
      if (connected !== lastGateConnected) {
        lastGateConnected = connected;
        gateConnectedParam.setValueAtTime(connected ? 1 : 0, ctx.currentTime);
      }
    }
    refreshGateConnected();
    const pollId = setInterval(refreshGateConnected, GATE_POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        ['cv_in',   { node: workletNode, input: 0 }],
        ['gate_in', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['cv_out',   { node: workletNode, output: 0 }],
        ['cv_quant', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        clearInterval(pollId);
        workletNode.disconnect();
      },
    };
  },
};
