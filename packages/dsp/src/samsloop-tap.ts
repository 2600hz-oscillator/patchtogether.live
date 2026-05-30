// packages/dsp/src/samsloop-tap.ts
//
// SAMSLOOP-TAP — input recorder worklet.
//
// Sits in front of the SAMSLOOP record path. Two audio inputs (`l` + `r`,
// matching the stereovca normalling pattern: when `r` is unpatched it
// normalizes to `l` for a mono → stereo passthrough). On every 128-sample
// processing block it forwards the captured L+R blocks to the main thread
// via the worklet port as a `{ type: 'chunk', l, r, channels }` message.
//
// The main thread owns the actual storage / quantize / downsample / commit;
// this worklet is just the capture seam. Output is silent (0 channels);
// the tap doesn't route audio downstream — it's a sink that records.
//
// The host enables / disables the tap by posting `{ type: 'enable',
// enabled: bool }` so we don't spam the main thread with chunks when no
// recording is active. Default state is `enabled = false`.

declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

interface EnableMessage {
  type: 'enable';
  enabled: boolean;
}
type TapMessage = EnableMessage;

class SamsloopTapProcessor extends AudioWorkletProcessor {
  private enabled = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as TapMessage | null | undefined;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'enable') {
        this.enabled = !!msg.enabled;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.enabled) return true;

    // L on input[0], R on input[1]. Web Audio reports unpatched inputs
    // as a zero-length channel array (inputs[i] = []), so inputs[i]?.[0]
    // is undefined — that's the signal we use to trigger the L→R fallback.
    // Matches the stereovca / cocoadelay normalling pattern.
    const lRaw = inputs[0]?.[0];
    const rRaw = inputs[1]?.[0];
    if (!lRaw) return true; // no audio in at all — nothing to record this frame.
    const rNorm = rRaw ?? lRaw;

    // Copy out of the worklet-owned buffers (which get overwritten next
    // block) into transferable ArrayBuffers. The main thread receives the
    // buffers via structuredClone (no transfer list — keeping it simple;
    // 128-sample blocks are cheap to clone). One message per block ≈ every
    // 2.7 ms at 48 kHz; the main thread drains them into a Float32Array
    // accumulator and decides when to stop.
    const lOut = new Float32Array(lRaw.length);
    lOut.set(lRaw);
    const rOut = new Float32Array(rNorm.length);
    rOut.set(rNorm);

    // Mark stereo iff the user actually patched a distinct R input. The
    // host uses this to decide whether to store mono-mixed or stereo
    // samples when the CHAN switch is set to Stereo (no patched R + mono
    // setting = mono store; no patched R + stereo setting = duplicate L).
    const channels = rRaw ? 2 : 1;
    this.port.postMessage({ type: 'chunk', l: lOut, r: rOut, channels });
    return true;
  }
}

registerProcessor('samsloop-tap', SamsloopTapProcessor);
