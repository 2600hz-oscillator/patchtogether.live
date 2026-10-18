// PHASES AudioWorklet shell. Keep this entry free of top-level exports so its
// bundled form works in the app and the ART classic-script harness.
// Inputs: 0 Trigger, 1 Phase Trigger, 2 Loop toggle, 3 Reverse toggle, 4 Length CV.
// Output: 0 Phase CV, normalized 0..1 or bipolar -1..1.

import {
  PhasesDSP,
  PHASES_LENGTH_DEFAULT,
  PHASES_LENGTH_MIN,
  PHASES_LENGTH_MAX,
} from './lib/phases-dsp';

class PhasesProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'length', defaultValue: PHASES_LENGTH_DEFAULT, minValue: PHASES_LENGTH_MIN, maxValue: PHASES_LENGTH_MAX, automationRate: 'k-rate' as const },
      { name: 'loop', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'polarity', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'reverse', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  private engine = new PhasesDSP(sampleRate);
  private previousLoopParam = false;
  private previousReverseParam = false;
  private samplesSinceState = 0;
  private forceState = true;
  private disposed = false;
  private modeRevision = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; vertices?: unknown; name?: string; value?: unknown; revision?: unknown } | null;
      if (event.data === 'dispose' || message?.type === 'dispose') {
        this.disposed = true;
        return;
      }
      if (this.disposed || !message) return;
      if (message.type === 'vertices') this.engine.setVertices(message.vertices);
      else if (message.type === 'trigger') this.engine.requestTrigger();
      else if (message.type === 'phase-trigger') this.engine.requestTrigger(true);
      else if (message.type === 'mode' && typeof message.value === 'boolean') {
        // A manual request can repeat the SAME AudioParam value after a gate
        // has toggled the effective mode. The message preserves that intent.
        if (message.name !== 'loop' && message.name !== 'reverse') return;
        const revision = message.revision;
        if (revision !== undefined) {
          if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= this.modeRevision) return;
          this.modeRevision = revision;
        }
        if (message.name === 'loop') this.engine.setLoop(message.value);
        else this.engine.setReverse(message.value);
      }
      this.forceState = true;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const output = outputs[0]?.[0];
    if (this.disposed) {
      output?.fill(0);
      return false;
    }
    if (!output) return true;

    const engine = this.engine;
    engine.setLength(parameters.length?.[0] ?? PHASES_LENGTH_DEFAULT);
    engine.setPolarity((parameters.polarity?.[0] ?? 0) >= 0.5);
    const reverseParam = (parameters.reverse?.[0] ?? 0) >= 0.5;
    const loopParam = (parameters.loop?.[0] ?? 0) >= 0.5;
    // Unchanged manual parameters must not reset modes toggled by gate edges.
    if (reverseParam !== this.previousReverseParam) engine.setReverse(reverseParam);
    if (loopParam !== this.previousLoopParam) engine.setLoop(loopParam);
    this.previousReverseParam = reverseParam;
    this.previousLoopParam = loopParam;
    const trigger = inputs[0]?.[0];
    const phaseTrigger = inputs[1]?.[0];
    const loopGate = inputs[2]?.[0];
    const reverseGate = inputs[3]?.[0];
    // An unconnected worklet input has no channel. A connected zero-valued
    // channel IS an override, so no truthiness or amplitude test belongs here.
    const lengthCv = inputs[4]?.[0];
    for (let i = 0; i < output.length; i++) {
      output[i] = engine.step(trigger?.[i] ?? 0, phaseTrigger?.[i] ?? 0, loopGate?.[i] ?? 0, reverseGate?.[i] ?? 0, lengthCv ? lengthCv[i] ?? 0 : undefined);
    }

    this.samplesSinceState += output.length;
    if (this.forceState || this.samplesSinceState >= sampleRate / 30) {
      this.port.postMessage({
        type: 'state',
        position: engine.position,
        playing: engine.playing,
        loop: engine.loop,
        reverse: engine.reverse,
        // Lets the factory distinguish an acknowledgement from telemetry
        // already in flight before a more recent manual button press.
        modeRevision: this.modeRevision,
        effectiveLength: engine.effectiveLength,
        lengthCvPatched: engine.lengthCvPatched,
      });
      this.samplesSinceState = 0;
      this.forceState = false;
    }
    return true;
  }
}

registerProcessor('phases', PhasesProcessor);
