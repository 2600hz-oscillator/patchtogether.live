// packages/web/src/lib/audio/modules/moog904c.test.ts
//
// Three test layers for the MOOG 904C VOLTAGE CONTROLLED FILTER COUPLER:
//   1. Module-def shape — pins the 904C's I/O surface (audio in + cutoff_cv
//      CONTROL INPUT, the single band-passed output, the literal param array:
//      cutoff / width / mode) so a refactor that silently drops a port/param
//      fails loudly (the per-module-per-port regression class).
//   2. Factory wiring — the 904C wraps an AudioWorkletNode (it's THE worklet
//      of this batch). We drive the factory with a mock AudioContext whose
//      AudioWorkletNode records its parameters + connections, then assert:
//      every declared input/output is exposed at the right node/index, the
//      audio input lands on the worklet, cutoff_cv targets the `cutoff`
//      AudioParam (resofilter's CV→AudioParam fast-path), setParam→readParam
//      round-trips, and dispose() disconnects everything the factory made.
//   3. Real worklet DSP — instantiate the registered processor class (captured
//      via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): the coupler passes a tone INSIDE its band,
//      rejects tones well above + below it (band-pass), WIDTH widens the band,
//      and MODE=1 flips it into a band-reject (notch) that passes the skirts
//      and dips the centre.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog904cDef } from './moog904c';
import type { ModuleNode } from '$lib/graph/types';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog904cDef: module def shape', () => {
  it('declares type=moog904c, label="904C Voltage Controlled Filter Coupler", category=filters, schemaVersion=1', () => {
    expect(moog904cDef.type).toBe('moog904c');
    expect(moog904cDef.label).toBe('904C Voltage Controlled Filter Coupler');
    expect(moog904cDef.category).toBe('filters');
    expect(moog904cDef.schemaVersion).toBe(1);
    expect(moog904cDef.domain).toBe('audio');
  });

  it('lives in the Clones → moogafakkin palette bucket and uses the Moog904cCard', () => {
    expect(moog904cDef.palette).toEqual({ top: 'Clones', sub: 'moogafakkin' });
    expect(moog904cDef.card).toBe('Moog904cCard');
  });

  it('exposes the 904C inputs: audio + cutoff_cv', () => {
    const ids = moog904cDef.inputs.map((p) => p.id);
    expect(ids).toEqual(['audio', 'cutoff_cv']);
  });

  it('audio input is an audio cable', () => {
    expect(moog904cDef.inputs.find((p) => p.id === 'audio')!.type).toBe('audio');
  });

  it('cutoff_cv: cv input, paramTarget=cutoff, cvScale log', () => {
    const port = moog904cDef.inputs.find((p) => p.id === 'cutoff_cv')!;
    expect(port.type).toBe('cv');
    expect(port.paramTarget).toBe('cutoff');
    expect(port.cvScale).toEqual({ mode: 'log' });
  });

  it('exposes a single band-passed audio output', () => {
    const ids = moog904cDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
    expect(moog904cDef.outputs[0].type).toBe('audio');
  });

  it('exposes 3 params (cutoff log 20..20000 @800, width linear 0..1 @0.5, mode linear 0..1 @0)', () => {
    const ids = moog904cDef.params.map((p) => p.id);
    expect(ids).toEqual(['cutoff', 'width', 'mode']);

    const cutoff = moog904cDef.params.find((p) => p.id === 'cutoff')!;
    expect(cutoff.min).toBe(20);
    expect(cutoff.max).toBe(20000);
    expect(cutoff.defaultValue).toBe(800);
    expect(cutoff.curve).toBe('log');
    expect(cutoff.units).toBe('Hz');

    const width = moog904cDef.params.find((p) => p.id === 'width')!;
    expect(width.min).toBe(0);
    expect(width.max).toBe(1);
    expect(width.defaultValue).toBe(0.5);
    expect(width.curve).toBe('linear');

    const mode = moog904cDef.params.find((p) => p.id === 'mode')!;
    expect(mode.min).toBe(0);
    expect(mode.max).toBe(1);
    expect(mode.defaultValue).toBe(0);
    expect(mode.curve).toBe('linear');
  });
});

// ───────────────────── Layer 2: factory wiring (mock ctx) ─────────────────────
//
// Minimal Web Audio mock for a worklet-backed module. The AudioWorkletNode
// records its declared parameters (one mock AudioParam each) + the nodes that
// connect into it; the ConstantSourceNode records start/stop + its connect
// target so we can assert the silence keepalive + dispose().
interface MockAudioParam {
  value: number;
  setValueAtTime: (v: number, _t: number) => void;
}
interface MockWorkletNode {
  parameters: Map<string, MockAudioParam>;
  disconnectCount: number;
  connect: () => void;
  disconnect: () => void;
}
interface MockConstSource {
  offset: { value: number };
  started: boolean;
  stopped: boolean;
  disconnectCount: number;
  start: () => void;
  stop: () => void;
  connect: () => void;
  disconnect: () => void;
}

function makeMockCtx(): {
  ctx: AudioContext;
  addedModules: string[];
  worklet: () => MockWorkletNode;
  constSources: MockConstSource[];
} {
  const addedModules: string[] = [];
  const constSources: MockConstSource[] = [];
  let lastWorklet: MockWorkletNode | null = null;

  function makeParam(initial: number): MockAudioParam {
    return {
      value: initial,
      setValueAtTime(v: number) {
        this.value = v;
      },
    };
  }

  // Expose the global the factory constructs (`new AudioWorkletNode(...)`).
  const g = globalThis as unknown as { AudioWorkletNode?: unknown };
  const prevWorkletCtor = g.AudioWorkletNode;
  g.AudioWorkletNode = class {
    parameters: Map<string, MockAudioParam>;
    disconnectCount = 0;
    constructor() {
      // Seed one mock AudioParam per declared param so params.get(id) works.
      this.parameters = new Map<string, MockAudioParam>();
      for (const def of moog904cDef.params) {
        this.parameters.set(def.id, makeParam(def.defaultValue));
      }
      lastWorklet = this as unknown as MockWorkletNode;
    }
    connect() {}
    disconnect() {
      this.disconnectCount++;
    }
  } as unknown as typeof AudioWorkletNode;

  const ctx = {
    currentTime: 0,
    audioWorklet: {
      addModule(url: string) {
        addedModules.push(url);
        return Promise.resolve();
      },
    },
    createConstantSource(): MockConstSource {
      const s: MockConstSource = {
        offset: { value: 0 },
        started: false,
        stopped: false,
        disconnectCount: 0,
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
        connect() {},
        disconnect() {
          this.disconnectCount++;
        },
      };
      constSources.push(s);
      return s;
    },
    // Restore the global ctor when the test's ctx goes away (best-effort; the
    // shim is idempotent across tests since each makeMockCtx re-installs it).
    __restore() {
      g.AudioWorkletNode = prevWorkletCtor;
    },
  } as unknown as AudioContext & { __restore: () => void };

  return {
    ctx,
    addedModules,
    worklet: () => {
      if (!lastWorklet) throw new Error('no worklet node constructed');
      return lastWorklet;
    },
    constSources,
  };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog904c-test',
    type: 'moog904c',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog904c factory: wiring + params', () => {
  it('loads the worklet module then constructs the worklet node', async () => {
    const m = makeMockCtx();
    await moog904cDef.factory(m.ctx, makeNode());
    expect(m.addedModules.length).toBe(1);
    expect(() => m.worklet()).not.toThrow();
  });

  it('exposes the audio input at input index 0 of the worklet node', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    const audio = handle.inputs.get('audio');
    expect(audio).toBeDefined();
    expect(audio!.input).toBe(0);
    expect(audio!.node).toBe(m.worklet() as unknown as AudioNode);
    // Audio is a plain node connection, NOT a CV→AudioParam routing.
    expect(audio!.param).toBeUndefined();
  });

  it('routes cutoff_cv into the worklet `cutoff` AudioParam (resofilter fast-path)', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    const cv = handle.inputs.get('cutoff_cv');
    expect(cv).toBeDefined();
    expect(cv!.input).toBe(0);
    // The CV terminates on the `cutoff` AudioParam, not a bare node input.
    expect(cv!.param).toBe(m.worklet().parameters.get('cutoff') as unknown as AudioParam);
  });

  it('exposes the single band-passed audio output at output index 0', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    const out = handle.outputs.get('audio');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
    expect(out!.node).toBe(m.worklet() as unknown as AudioNode);
  });

  it('seeds the worklet AudioParams from defaults at mount', async () => {
    const m = makeMockCtx();
    await moog904cDef.factory(m.ctx, makeNode());
    const p = m.worklet().parameters;
    expect(p.get('cutoff')!.value).toBeCloseTo(800, 6);
    expect(p.get('width')!.value).toBeCloseTo(0.5, 6);
    expect(p.get('mode')!.value).toBeCloseTo(0, 6);
  });

  it('honors initial node.params at mount', async () => {
    const m = makeMockCtx();
    await moog904cDef.factory(m.ctx, makeNode({ cutoff: 1200, width: 0.2, mode: 1 }));
    const p = m.worklet().parameters;
    expect(p.get('cutoff')!.value).toBeCloseTo(1200, 6);
    expect(p.get('width')!.value).toBeCloseTo(0.2, 6);
    expect(p.get('mode')!.value).toBeCloseTo(1, 6);
  });

  it('setParam then readParam round-trips for each param', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    handle.setParam('cutoff', 2500);
    handle.setParam('width', 0.9);
    handle.setParam('mode', 0.4);
    expect(handle.readParam('cutoff')).toBeCloseTo(2500, 6);
    expect(handle.readParam('width')).toBeCloseTo(0.9, 6);
    expect(handle.readParam('mode')).toBeCloseTo(0.4, 6);
  });

  it('setParam ignores unknown param ids without throwing; readParam returns undefined', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('starts a silence keepalive feeding the worklet input', async () => {
    const m = makeMockCtx();
    await moog904cDef.factory(m.ctx, makeNode());
    expect(m.constSources.length).toBe(1);
    expect(m.constSources[0].started).toBe(true);
    expect(m.constSources[0].offset.value).toBe(0);
  });

  it('dispose() stops + disconnects the silence source and disconnects the worklet', async () => {
    const m = makeMockCtx();
    const handle = await moog904cDef.factory(m.ctx, makeNode());
    handle.dispose();
    expect(m.constSources[0].stopped).toBe(true);
    expect(m.constSources[0].disconnectCount).toBeGreaterThanOrEqual(1);
    expect(m.worklet().disconnectCount).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────── Layer 3: real worklet DSP ─────────────────────
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog904c');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog904c processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog904cDef.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function makeOutput(): Float32Array[][] {
  return [[new Float32Array(BLOCK)]];
}

/** Single audio input port. */
function makeInputs(audioFill?: Float32Array): Float32Array[][] {
  return [[audioFill ?? new Float32Array(BLOCK)]];
}

/** Run a sine of `freq` Hz through the coupler and return the steady-state
 *  RMS gain (measured after the filter transient settles). */
async function sineGain(
  Proc: ProcCtor,
  freq: number,
  params: Record<string, number>,
): Promise<number> {
  const proc = new Proc();
  const p = makeParams(params);
  let phase = 0;
  const inc = (2 * Math.PI * freq) / SR;
  let inSumSq = 0;
  let outSumSq = 0;
  let n = 0;
  const totalBlocks = 120; // ~0.32 s
  for (let b = 0; b < totalBlocks; b++) {
    const inBlk = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      inBlk[i] = 0.3 * Math.sin(phase);
      phase += inc;
    }
    const out = makeOutput();
    proc.process(makeInputs(inBlk), out, p);
    if (b >= totalBlocks / 2) {
      for (let i = 0; i < BLOCK; i++) {
        inSumSq += inBlk[i] * inBlk[i];
        outSumSq += out[0][0][i] * out[0][0][i];
        n++;
      }
    }
  }
  const inRms = Math.sqrt(inSumSq / n);
  const outRms = Math.sqrt(outSumSq / n);
  return outRms / inRms;
}

describe('moog904c worklet DSP', () => {
  it('band-passes: passes a tone inside the band, rejects tones well above + below', async () => {
    const Proc = await loadProcessor();
    // cutoff=800, width=0.5 → band roughly centred on 800 Hz. 800 Hz should
    // survive; 60 Hz (well below the HP corner) + 8 kHz (well above the LP
    // corner) should be deeply attenuated.
    const inBand = await sineGain(Proc, 800, { cutoff: 800, width: 0.5, mode: 0 });
    const below = await sineGain(Proc, 60, { cutoff: 800, width: 0.5, mode: 0 });
    const above = await sineGain(Proc, 8000, { cutoff: 800, width: 0.5, mode: 0 });
    expect(inBand).toBeGreaterThan(below * 3);
    expect(inBand).toBeGreaterThan(above * 3);
  });

  it('WIDTH widens the passband (a tone above the centre passes more at high width)', async () => {
    const Proc = await loadProcessor();
    // 2.5 kHz sits above the narrow band but inside the wide band.
    const narrow = await sineGain(Proc, 2500, { cutoff: 800, width: 0.1, mode: 0 });
    const wide = await sineGain(Proc, 2500, { cutoff: 800, width: 1.0, mode: 0 });
    expect(wide).toBeGreaterThan(narrow * 1.5);
  });

  it('MODE=1 is a notch: the centre is dipped relative to its own skirts (band-reject)', async () => {
    const Proc = await loadProcessor();
    // In band-reject mode the centre tone (800 Hz) is dipped while the skirts
    // pass ~unchanged (out = input − bandpass ≈ input away from the band).
    const centre = await sineGain(Proc, 800, { cutoff: 800, width: 0.5, mode: 1 });
    const skirt = await sineGain(Proc, 60, { cutoff: 800, width: 0.5, mode: 1 });
    expect(centre).toBeLessThan(skirt); // the notch dips the centre
    expect(centre).toBeLessThan(0.9); // measurable dip at the centre
  });

  it('MODE=1 (band-reject) passes the skirts: a far-below tone survives the notch ~unchanged', async () => {
    const Proc = await loadProcessor();
    // 60 Hz is on the low skirt: deeply attenuated in band-pass mode, but
    // PASSED by the band-reject complement (input − bandpass ≈ input there).
    const bp = await sineGain(Proc, 60, { cutoff: 800, width: 0.5, mode: 0 });
    const br = await sineGain(Proc, 60, { cutoff: 800, width: 0.5, mode: 1 });
    expect(br).toBeGreaterThan(bp);
    expect(br).toBeGreaterThan(0.8); // most of the low tone survives the notch
  });

  it('stays finite (no NaN/Inf) under an audio-rate cutoff sweep at full width', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    let phase = 0;
    const inc = (2 * Math.PI * 440) / SR;
    for (let b = 0; b < 60; b++) {
      const audio = new Float32Array(BLOCK);
      const cutoff = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        audio[i] = Math.sin(phase);
        phase += inc;
        // Sweep cutoff between 100 Hz and 8 kHz at audio rate (a-rate param
        // buffer of full block length).
        const lfo = 0.5 + 0.5 * Math.sin((2 * Math.PI * 1500 * (b * BLOCK + i)) / SR);
        cutoff[i] = 100 + lfo * 7900;
      }
      const out = makeOutput();
      proc.process([[audio]], out, { cutoff, width: new Float32Array([1]), mode: new Float32Array([0]) });
      for (const v of out[0][0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
