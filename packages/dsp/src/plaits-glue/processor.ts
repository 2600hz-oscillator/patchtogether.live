// packages/dsp/src/plaits-glue/processor.ts
//
// AudioWorkletProcessor that drives one Plaits engine voice via a WebAssembly
// instance compiled from the vendored Plaits source (see worklet.cc).
//
// Plaits' inner block size is 12 frames; Web Audio gives us 128 per process()
// call.  We keep a 12-frame stash buffer to handle the leftover (128 % 12 = 8)
// across calls so the engine sees its native cadence end-to-end.
//
// processorOptions.engineId selects which engine to instantiate
// (ENGINE_FM = 9 today; Modal/Granular/etc. follow on by wiring more cases
// in worklet.cc).
//
// Two outputs:
//   outputs[0][0] — `out` from Plaits (carrier, FM)
//   outputs[1][0] — `aux` from Plaits (sub-octave for FM; engine-specific)

import { PLAITS_WASM_B64 } from '@plaits-wasm-bytes';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

const PARAMS_BYTES = 4 * 6 + 4; // 6 floats + 1 int32
const INNER_BLOCK = 12;
const PARAM_NOTE_OFFSET = 0;
const PARAM_HARMONICS_OFFSET = 1;
const PARAM_TIMBRE_OFFSET = 2;
const PARAM_MORPH_OFFSET = 3;
const PARAM_ACCENT_OFFSET = 4;
const PARAM_LEVEL_OFFSET = 5;
// Trigger int32 follows the 6 floats — at byte offset 24, integer index 6.
const PARAM_TRIGGER_INT_OFFSET = 6;

interface PlaitsExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  plaits_create(engineId: number): number;
  plaits_destroy(handle: number): void;
  plaits_render(handle: number, paramsPtr: number, outPtr: number, auxPtr: number, size: number): void;
  plaits_reset(handle: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

// Pure-JS base64 decoder. Chrome's AudioWorkletGlobalScope does not expose
// `atob` (Firefox does). 22 bytes per 16-byte output keeps this hot loop
// well under a millisecond for the ~12 KB wasm we ship.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int8Array(128);
  for (let i = 0; i < 128; i++) t[i] = -1;
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();
function decodeBase64(b64: string): Uint8Array {
  // Strip padding & any whitespace/newlines.
  let len = b64.length;
  while (len > 0 && (b64.charCodeAt(len - 1) === 61 /* = */ || b64.charCodeAt(len - 1) <= 32)) len--;
  // Output bytes = floor(len * 6 / 8).
  const outLen = (len * 6) >> 3;
  const out = new Uint8Array(outLen);
  let bits = 0;
  let acc = 0;
  let oi = 0;
  for (let i = 0; i < len; i++) {
    const c = b64.charCodeAt(i);
    if (c < 32) continue;
    const v = B64_LOOKUP[c];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (acc >> bits) & 0xff;
    }
  }
  return oi === outLen ? out : out.subarray(0, oi);
}

class PlaitsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // MIDI semitones; 60 = middle C. Note CV in V/oct sums via the pitch
      // input port at audio rate.
      { name: 'note',      defaultValue: 60, minValue: 0,  maxValue: 127, automationRate: 'a-rate' as const },
      { name: 'harmonics', defaultValue: 0.5, minValue: 0, maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'timbre',    defaultValue: 0.5, minValue: 0, maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'morph',     defaultValue: 0.5, minValue: 0, maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'level',     defaultValue: 1,   minValue: 0, maxValue: 1,  automationRate: 'a-rate' as const },
    ];
  }

  // Lazy wasm instance + per-voice handle. Synchronous compile via
  // WebAssembly.Module(bytes) is allowed inside AudioWorkletGlobalScope
  // (host docs are ambiguous but Chrome/Firefox/Safari all permit it; we
  // fall back to silence + console.error if the boot fails).
  private exp: PlaitsExports | null = null;
  private voice = 0;
  private paramsPtr = 0;
  private outPtr = 0;
  private auxPtr = 0;
  private engineId: number;

  // Stash for the 0..11 leftover frames between Web Audio's 128 and Plaits'
  // 12. We render in 12-frame chunks; whatever doesn't fit goes here and is
  // emitted at the start of the next process() call.
  private stashOut = new Float32Array(INNER_BLOCK);
  private stashAux = new Float32Array(INNER_BLOCK);
  private stashLen = 0;

  // Last-seen gate level — used to feed Plaits' rising-edge detector via the
  // trigger field. The gate input port also drives this; a gate >= 0.5 sets
  // trigger=high, which the C side maps to TRIGGER_HIGH | TRIGGER_RISING_EDGE
  // on the leading sample of each 12-frame chunk.
  private prevGate = 0;

  constructor(options?: { processorOptions?: { engineId?: number } }) {
    super(options);
    this.engineId = options?.processorOptions?.engineId ?? 9; // default: ENGINE_FM
    this.boot();
  }

  private boot(): void {
    try {
      const bytes = decodeBase64(PLAITS_WASM_B64);
      const mod = new WebAssembly.Module(bytes);
      // The wasm produced by build-plaits.mjs has its own internal memory
      // (exported); the only env import is the memory-growth hook from
      // ALLOW_MEMORY_GROWTH=1, which we no-op.
      const env = {
        emscripten_notify_memory_growth: () => {},
        emscripten_resize_heap: () => 0,
        abort: () => {
          throw new Error('plaits wasm aborted');
        },
      };
      const inst = new WebAssembly.Instance(mod, {
        env,
        wasi_snapshot_preview1: {
          fd_close: () => 0,
          fd_seek: () => 0,
          fd_write: () => 0,
          proc_exit: () => {},
        },
      });
      const exp = inst.exports as unknown as PlaitsExports;
      // Run C++ global constructors. Without this the static LUTs in
      // resources.cc are accessed at uninitialized addresses and Plaits
      // OOBs on first render.
      exp.__wasm_call_ctors();
      this.exp = exp;
      this.voice = exp.plaits_create(this.engineId);
      if (!this.voice) {
        // eslint-disable-next-line no-console
        console.error(`[plaits] plaits_create(${this.engineId}) returned 0`);
        this.exp = null;
        return;
      }
      this.paramsPtr = exp.malloc(PARAMS_BYTES);
      this.outPtr = exp.malloc(INNER_BLOCK * 4);
      this.auxPtr = exp.malloc(INNER_BLOCK * 4);
    } catch (err) {
      // Surface failures to the main thread — `console` isn't reliable
      // inside AudioWorkletGlobalScope (Chrome eats it).
      this.port.postMessage({ type: 'plaits-error', error: String((err as Error)?.stack || err) });
      this.exp = null;
    }
  }

  private writeParams(
    note: number,
    harmonics: number,
    timbre: number,
    morph: number,
    level: number,
    trigger: boolean,
  ): void {
    if (!this.exp) return;
    const heapF32 = new Float32Array(this.exp.memory.buffer, this.paramsPtr, 6);
    const heapI32 = new Int32Array(this.exp.memory.buffer, this.paramsPtr, 7);
    heapF32[PARAM_NOTE_OFFSET] = note;
    heapF32[PARAM_HARMONICS_OFFSET] = Math.max(0, Math.min(1, harmonics));
    heapF32[PARAM_TIMBRE_OFFSET] = Math.max(0, Math.min(1, timbre));
    heapF32[PARAM_MORPH_OFFSET] = Math.max(0, Math.min(1, morph));
    heapF32[PARAM_ACCENT_OFFSET] = 0.5;
    heapF32[PARAM_LEVEL_OFFSET] = Math.max(0, Math.min(1, level));
    heapI32[PARAM_TRIGGER_INT_OFFSET] = trigger ? 1 : 0;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    const aux = outputs[1]?.[0];
    if (!out) return true;

    const exp = this.exp;
    if (!exp || !this.voice) {
      out.fill(0);
      if (aux) aux.fill(0);
      return true;
    }

    const blockLen = out.length;
    const pitchIn = inputs[0]?.[0]; // pitch CV, 1V/oct, sums into note
    const gateIn = inputs[1]?.[0];  // gate input, 0/1

    // 1. Emit any stash from the previous call.
    let written = 0;
    if (this.stashLen > 0) {
      const n = Math.min(this.stashLen, blockLen);
      out.set(this.stashOut.subarray(0, n), 0);
      if (aux) aux.set(this.stashAux.subarray(0, n), 0);
      // Compact remaining stash to the front.
      const remain = this.stashLen - n;
      if (remain > 0) {
        this.stashOut.copyWithin(0, n, this.stashLen);
        this.stashAux.copyWithin(0, n, this.stashLen);
      }
      this.stashLen = remain;
      written = n;
    }

    // 2. Render full 12-frame inner blocks until we'd overflow `out`.
    while (written + INNER_BLOCK <= blockLen) {
      this.renderInnerBlock(parameters, pitchIn, gateIn, written);
      // Copy from wasm out/aux pointers to the worklet block.
      const outView = new Float32Array(exp.memory.buffer, this.outPtr, INNER_BLOCK);
      const auxView = new Float32Array(exp.memory.buffer, this.auxPtr, INNER_BLOCK);
      out.set(outView, written);
      if (aux) aux.set(auxView, written);
      written += INNER_BLOCK;
    }

    // 3. If there's tail < INNER_BLOCK left, render one more inner block but
    //    keep the residual in the stash for next call.
    if (written < blockLen) {
      this.renderInnerBlock(parameters, pitchIn, gateIn, written);
      const outView = new Float32Array(exp.memory.buffer, this.outPtr, INNER_BLOCK);
      const auxView = new Float32Array(exp.memory.buffer, this.auxPtr, INNER_BLOCK);
      const need = blockLen - written;
      out.set(outView.subarray(0, need), written);
      if (aux) aux.set(auxView.subarray(0, need), written);
      // Stash the rest.
      this.stashOut.set(outView.subarray(need));
      this.stashAux.set(auxView.subarray(need));
      this.stashLen = INNER_BLOCK - need;
    }

    return true;
  }

  // Read a representative param value for the inner block at sample offset
  // `frame`. AudioParam arrays are either length-1 (k-rate value) or
  // length-128 (a-rate per-frame).
  private paramAt(arr: Float32Array, frame: number): number {
    return arr.length > 1 ? (arr[frame] ?? arr[0] ?? 0) : (arr[0] ?? 0);
  }

  private renderInnerBlock(
    parameters: Record<string, Float32Array>,
    pitchIn: Float32Array | undefined,
    gateIn: Float32Array | undefined,
    frame: number,
  ): void {
    const exp = this.exp;
    if (!exp) return;

    // Sample params at the chunk's first frame; k-rate accuracy is fine for
    // 12-frame blocks (250 us at 48 kHz).
    const noteKnob = this.paramAt(parameters.note, frame);
    const pitchCv = pitchIn ? (pitchIn[frame] ?? 0) : 0;
    const note = noteKnob + pitchCv * 12;
    const harmonics = this.paramAt(parameters.harmonics, frame);
    const timbre = this.paramAt(parameters.timbre, frame);
    const morph = this.paramAt(parameters.morph, frame);
    const level = this.paramAt(parameters.level, frame);

    const gateRaw = gateIn ? (gateIn[frame] ?? 0) : 0;
    const gateHigh = gateRaw >= 0.5;
    this.prevGate = gateRaw;

    this.writeParams(note, harmonics, timbre, morph, level, gateHigh);
    exp.plaits_render(this.voice, this.paramsPtr, this.outPtr, this.auxPtr, INNER_BLOCK);
  }
}

registerProcessor('plaits', PlaitsProcessor);
