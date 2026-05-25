// packages/dsp/src/fourplexer.ts
//
// 4PLEXER — 4-in / 4-out discrete signal router worklet.
//
// Each OUTPUT carries EXACTLY ONE of the four signal inputs at a time
// (never a blend). A per-output selector index (0..3) chooses which input.
// Each output also has its own GATE input: on each rising edge the
// selector advances to the next input (0→1→2→3→0, wrapping). Selectors
// are also directly settable from the UI via the sel1..sel4 k-rate params
// (the worklet snaps its internal index to the param whenever the param
// changes underneath it, so UI clicks + gate-advances stay in sync and
// persist in node params).
//
// Routing is the discrete "gain matrix" approach lowered to a single
// per-sample select: out[i] = signal[sel[i]]. To avoid hard clicks when a
// selection flips on an audio-rate input, the switch is declicked with a
// very short (DECLICK_S) linear crossfade from the previous input to the
// new one — still effectively instant/discrete, just no zipper click.
// Audio and CV both flow through the same Web Audio substrate, so the same
// code routes either identically.
//
// Inputs (0..7):
//   0  in1   (signal — audio OR cv)
//   1  in2   (signal)
//   2  in3   (signal)
//   3  in4   (signal)
//   4  gate1 (gate — advances out1's selector on rising edge)
//   5  gate2 (gate — advances out2's selector)
//   6  gate3 (gate — advances out3's selector)
//   7  gate4 (gate — advances out4's selector)
//
// Outputs (0..3):
//   0  out1  (carries signal[sel1])
//   1  out2  (carries signal[sel2])
//   2  out3  (carries signal[sel3])
//   3  out4  (carries signal[sel4])
//
// Gates are read from input channel 0 (the same audio-rate gate convention
// the rest of the codebase uses — see slewswitch.ts).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

// Declick crossfade length on a selector flip. ~4 ms — short enough to be
// perceptually instant (discrete) but long enough to kill the zipper click
// on an audio-rate input.
const DECLICK_S = 0.004;

/** Advance a selector index to the next input, wrapping 3 → 0. Pure +
 *  exported-shape mirror of the web-side fourplexerNextSelector() so the
 *  worklet and the unit test agree on the wrap rule. */
function nextSelector(cur: number): number {
  return (((cur | 0) % 4) + 4 + 1) % 4;
}

class FourPlexerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // sel1..sel4: the per-output selector index (0..3). k-rate — the UI
    // writes these directly, and the gate-advance writes them back so the
    // selection persists in node params + survives reload.
    return [
      { name: 'sel1', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
      { name: 'sel2', defaultValue: 1, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
      { name: 'sel3', defaultValue: 2, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
      { name: 'sel4', defaultValue: 3, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
    ];
  }

  // Current + previous selected input per output (drive the declick xfade).
  private cur = [0, 1, 2, 3];
  private prev = [0, 1, 2, 3];
  // 0..1 fade progress prev→cur (1 = settled on cur).
  private fade = [1, 1, 1, 1];
  // Last param value we OBSERVED (per output). We snap the internal index
  // only when the observed param actually CHANGES from the previous block —
  // i.e. the UI moved a knob. Tracking the observed value (not the value we
  // set) is what stops a stale param read from reverting a gate-advance:
  // after a gate advance the worklet's index leads the param by one
  // store-roundtrip, but since the observed param value hasn't changed yet,
  // there's no observed-delta and we leave the gate-advanced index alone.
  private lastParam = [0, 1, 2, 3];
  // Per-output gate rising-edge detector state.
  private prevGate = [0, 0, 0, 0];
  // How much to step `fade` per sample.
  private readonly fadeStep = (1 / sampleRate) / DECLICK_S;

  /** Apply a new selection to output `o`, starting a declick crossfade
   *  from the currently-selected input. */
  private setSelection(o: number, idx: number): void {
    const clamped = ((idx | 0) % 4 + 4) % 4;
    if (clamped === this.cur[o]!) return;
    this.prev[o] = this.cur[o]!;
    this.cur[o] = clamped;
    this.fade[o] = 0;
  }

  /** Inform the host (and, indirectly, the saved node params) of the new
   *  selector index so a gate-advanced selection persists like a UI click.
   *  Posted to the main thread, which writes it into the patch store. */
  private announce(o: number, idx: number): void {
    this.port.postMessage({ type: 'sel', out: o, idx });
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const sig = [inputs[0]?.[0], inputs[1]?.[0], inputs[2]?.[0], inputs[3]?.[0]];
    const gate = [inputs[4]?.[0], inputs[5]?.[0], inputs[6]?.[0], inputs[7]?.[0]];
    const out = [outputs[0]?.[0], outputs[1]?.[0], outputs[2]?.[0], outputs[3]?.[0]];
    if (!out[0] || !out[1] || !out[2] || !out[3]) return true;

    const N = out[0].length;
    const selParam = [
      Math.round(parameters.sel1?.[0] ?? 0),
      Math.round(parameters.sel2?.[0] ?? 1),
      Math.round(parameters.sel3?.[0] ?? 2),
      Math.round(parameters.sel4?.[0] ?? 3),
    ];

    // A UI-driven param change (observed param differs from the previous
    // block's observed value) snaps the selection. Done once per block
    // (k-rate) before the sample loop. We always update lastParam to the
    // current observed value so a gate-advance (which leads the param by a
    // store-roundtrip) is never reverted by the stale pre-roundtrip read.
    for (let o = 0; o < 4; o++) {
      const p = selParam[o]!;
      if (p !== this.lastParam[o]) {
        this.lastParam[o] = p;
        this.setSelection(o, p);
      }
    }

    for (let i = 0; i < N; i++) {
      for (let o = 0; o < 4; o++) {
        // Rising-edge gate advance for this output's selector.
        const g = gate[o] ? gate[o]![i]! : 0;
        if (g > 0.5 && this.prevGate[o]! <= 0.5) {
          const next = nextSelector(this.cur[o]!);
          this.setSelection(o, next);
          // NOTE: deliberately do NOT touch this.lastParam here. lastParam
          // tracks the OBSERVED param value; the param won't reflect `next`
          // until the announce() store-roundtrip completes. Leaving
          // lastParam at the pre-advance observed value means the next few
          // blocks (still reading the old param) produce no observed-delta,
          // so the param-snap loop won't revert this gate-advance.
          this.announce(o, next);
        }
        this.prevGate[o] = g;

        // Progress declick crossfade.
        if (this.fade[o]! < 1) {
          this.fade[o] = Math.min(1, this.fade[o]! + this.fadeStep);
        }
        const f = this.fade[o]!;
        const curSig = sig[this.cur[o]!] ? sig[this.cur[o]!]![i]! : 0;
        const prevSig = sig[this.prev[o]!] ? sig[this.prev[o]!]![i]! : 0;
        // Linear declick crossfade. Discrete selection — once f reaches 1
        // the output is EXACTLY the selected input.
        out[o]![i] = f >= 1 ? curSig : (prevSig * (1 - f) + curSig * f);
      }
    }
    return true;
  }
}

registerProcessor('fourplexer', FourPlexerProcessor);
