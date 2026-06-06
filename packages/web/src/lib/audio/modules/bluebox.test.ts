// packages/web/src/lib/audio/modules/bluebox.test.ts
//
// Two test layers:
//   1. Pure-math helpers — dtmfFreqs, BLUEBOX_TONES, REDBOX_TONES,
//      tonesForButton. The 10-row × 2-col DTMF table is pinned exactly
//      (no fuzziness) per the Bell-System spec.
//   2. Processor smoke — load packages/dsp/src/bluebox.ts via the
//      registerProcessor shim, drive process() with a single button
//      param set to 1, and Goertzel-probe the output buffer at the
//      expected DTMF row + col frequencies (peak amplitude per bin).
//
// Per memory `dsp-worklet-no-top-level-export`: the worklet entry NEVER
// exports its processor class. We capture it via the shim that swaps in
// a registerProcessor() impl which records the registered constructor.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  BLUEBOX_BUTTON_NAMES,
  BLUEBOX_DIGIT_LETTERS,
  BLUEBOX_TONES,
  DTMF_TABLE,
  REDBOX_TONES,
  blueboxDef,
  buttonGateId,
  buttonParamId,
  dtmfFreqs,
  tonesForButton,
} from './bluebox';

const SR = 48000;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ─── Layer 1: pure-math helpers ─────────────────────────────────────────────

describe('bluebox-dsp — DTMF table is pinned exactly to Bell System spec', () => {
  // Row × col table from ITU-T Q.23 — these values are NOT to be
  // "approximated" or "rounded"; they are the standard.
  const TABLE: Record<number, [number, number]> = {
    0: [941, 1336],
    1: [697, 1209],
    2: [697, 1336],
    3: [697, 1477],
    4: [770, 1209],
    5: [770, 1336],
    6: [770, 1477],
    7: [852, 1209],
    8: [852, 1336],
    9: [852, 1477],
  };

  for (let d = 0; d <= 9; d++) {
    it(`digit ${d} → [${TABLE[d]![0]}, ${TABLE[d]![1]}]`, () => {
      expect(dtmfFreqs(d)).toEqual(TABLE[d]);
      expect(DTMF_TABLE[d]).toEqual(TABLE[d]);
      expect(tonesForButton(String(d) as never)).toEqual(TABLE[d]);
    });
  }

  it('dtmfFreqs throws on out-of-range digit', () => {
    expect(() => dtmfFreqs(10)).toThrow();
    expect(() => dtmfFreqs(-1)).toThrow();
  });
});

describe('bluebox-dsp — phreaker button tones', () => {
  it('BLUEBOX = [2600] (single in-band supervisory tone)', () => {
    expect(BLUEBOX_TONES).toEqual([2600]);
    expect(tonesForButton('bluebox')).toEqual([2600]);
  });

  it('REDBOX = [1700, 2200] (coin-acceptance tone pair)', () => {
    expect(REDBOX_TONES).toEqual([1700, 2200]);
    expect(tonesForButton('redbox')).toEqual([1700, 2200]);
  });
});

describe('bluebox-dsp — button id naming convention', () => {
  it('buttonParamId / buttonGateId match the registered shape', () => {
    expect(buttonParamId('5')).toBe('btn_5');
    expect(buttonGateId('5')).toBe('gate_5');
    expect(buttonParamId('bluebox')).toBe('btn_bluebox');
    expect(buttonGateId('bluebox')).toBe('gate_bluebox');
    expect(buttonParamId('redbox')).toBe('btn_redbox');
    expect(buttonGateId('redbox')).toBe('gate_redbox');
  });

  it('BLUEBOX_BUTTON_NAMES enumerates 12 buttons (0-9 + 2 phreaker)', () => {
    expect(BLUEBOX_BUTTON_NAMES.length).toBe(12);
    expect([...BLUEBOX_BUTTON_NAMES]).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'bluebox', 'redbox',
    ]);
  });
});

describe('bluebox-card — phone-keypad letters under each digit', () => {
  // Bell-System standard. Source-of-truth for the BlueboxCard render —
  // if the card's data-testid="bluebox-letters-N" content drifts from
  // this table the visual contract for the dialer is broken.
  const EXPECTED: Record<string, string> = {
    '1': '',
    '2': 'ABC',
    '3': 'DEF',
    '4': 'GHI',
    '5': 'JKL',
    '6': 'MNO',
    '7': 'PQRS',
    '8': 'TUV',
    '9': 'WXYZ',
    '0': '',
  };

  for (const digit of Object.keys(EXPECTED)) {
    it(`digit ${digit} → "${EXPECTED[digit]}"`, () => {
      expect(BLUEBOX_DIGIT_LETTERS[digit]).toBe(EXPECTED[digit]);
    });
  }

  it('"ABC" is the visible label for the 2-button', () => {
    // The card renders <span data-testid="bluebox-letters-2">{BLUEBOX_DIGIT_LETTERS['2']}</span>;
    // this is the unit-level guarantee that text matches Bell.
    expect(BLUEBOX_DIGIT_LETTERS['2']).toBe('ABC');
  });

  it('1 + 0 carry no letters (real phone-keypad convention)', () => {
    expect(BLUEBOX_DIGIT_LETTERS['1']).toBe('');
    expect(BLUEBOX_DIGIT_LETTERS['0']).toBe('');
  });

  it('covers all 10 digits', () => {
    for (let d = 0; d <= 9; d++) {
      expect(BLUEBOX_DIGIT_LETTERS[String(d)]).toBeDefined();
    }
  });
});

describe('blueboxDef — registry shape', () => {
  it('exposes 12 gate inputs + 1 audio output + 12 button params', () => {
    expect(blueboxDef.type).toBe('bluebox');
    expect(blueboxDef.domain).toBe('audio');
    expect(blueboxDef.inputs.length).toBe(12);
    expect(blueboxDef.outputs.length).toBe(1);
    expect(blueboxDef.params.length).toBe(12);
    expect(blueboxDef.outputs[0]).toEqual({ id: 'out', type: 'audio' });
  });

  it('every button has matching gate input + button param ids', () => {
    for (const name of BLUEBOX_BUTTON_NAMES) {
      expect(blueboxDef.inputs.find((p) => p.id === `gate_${name}`)).toBeTruthy();
      expect(blueboxDef.params.find((p) => p.id === `btn_${name}`)).toBeTruthy();
    }
  });
});

// ─── Layer 2: processor smoke (FFT on rendered samples) ─────────────────────

type ProcCtor = new (opts?: unknown) => {
  process: (
    i: Float32Array[][],
    o: Float32Array[][],
    p: Record<string, Float32Array>,
  ) => boolean;
};

let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the
  // workspace package symlinked under node_modules. Mirrors resofilter.test.ts.
  await import('../../../../../dsp/src/bluebox');
  g.registerProcessor = prev;
  if (!registered) throw new Error('bluebox processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Goertzel-style band magnitude — measure the energy at one specific
 *  frequency in the buffer. Used in lieu of a full FFT because we know
 *  exactly which bins to probe (the DTMF row + col), and Goertzel is
 *  O(N) per bin vs O(N log N) for the whole spectrum. */
function bandAmp(buf: Float32Array, freqHz: number, sr: number, skipFrames: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0;
  let im = 0;
  const n = buf.length - skipFrames;
  for (let i = skipFrames; i < buf.length; i++) {
    re += (buf[i] ?? 0) * Math.cos(w * (i - skipFrames));
    im += (buf[i] ?? 0) * Math.sin(w * (i - skipFrames));
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

/** Drive the processor with a single button held for `durSec` seconds
 *  and return the concatenated mono output. */
function renderButton(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  buttonIdx: number,
  durSec: number,
): Float32Array {
  const BLOCK = 128;
  const blocks = Math.ceil((durSec * SR) / BLOCK);
  const out = new Float32Array(blocks * BLOCK);

  // Build the params record once. The held button is ones-filled, all
  // others are zero-filled. AudioWorkletProcessor's `parameters` arg is
  // a-rate Float32Array(BLOCK) per param.
  const params: Record<string, Float32Array> = {};
  for (let b = 0; b < BLUEBOX_BUTTON_NAMES.length; b++) {
    const name = BLUEBOX_BUTTON_NAMES[b]!;
    const arr = new Float32Array(BLOCK);
    if (b === buttonIdx) arr.fill(1);
    params[`btn_${name}`] = arr;
  }
  // 12 empty inputs (no gate cables wired in this smoke test).
  const inputs: Float32Array[][] = BLUEBOX_BUTTON_NAMES.map(() => []);

  for (let blk = 0; blk < blocks; blk++) {
    const block = [[new Float32Array(BLOCK)]];
    proc.process(inputs, block, params);
    out.set(block[0]![0]!, blk * BLOCK);
  }
  return out;
}

describe('blueboxProcessor — digit emits DTMF row + col peaks', () => {
  for (let d = 0; d <= 9; d++) {
    it(`digit ${d} → peaks at row=${DTMF_TABLE[d]![0]} Hz + col=${DTMF_TABLE[d]![1]} Hz`, async () => {
      const Proc = await loadProcessor();
      const proc = new Proc();
      const buttonIdx = BLUEBOX_BUTTON_NAMES.indexOf(String(d) as never);
      expect(buttonIdx).toBeGreaterThanOrEqual(0);
      const buf = renderButton(proc, buttonIdx, 0.1);

      // Skip the first 10 ms to let the click-suppression ramp settle.
      const skip = Math.round(0.01 * SR);
      const [rowHz, colHz] = DTMF_TABLE[d]!;
      const ampRow = bandAmp(buf, rowHz, SR, skip);
      const ampCol = bandAmp(buf, colHz, SR, skip);

      // Off-bin probe — pick a frequency that's not a DTMF row/col.
      const ampOff = bandAmp(buf, 500, SR, skip);

      // Both target bins must hold meaningful energy.
      expect(ampRow).toBeGreaterThan(0.05);
      expect(ampCol).toBeGreaterThan(0.05);
      // And both must dominate the off-bin by at least 10x — the DTMF
      // tones are pure sinusoids, so out-of-band leakage is just window
      // smear and should be very small.
      expect(ampRow).toBeGreaterThan(ampOff * 10);
      expect(ampCol).toBeGreaterThan(ampOff * 10);
    });
  }
});

describe('blueboxProcessor — phreaker buttons emit their tones', () => {
  it('BLUEBOX → 2600 Hz dominant peak (single sine)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const idx = BLUEBOX_BUTTON_NAMES.indexOf('bluebox');
    const buf = renderButton(proc, idx, 0.1);
    const skip = Math.round(0.01 * SR);

    const amp2600 = bandAmp(buf, 2600, SR, skip);
    const ampOff = bandAmp(buf, 500, SR, skip);
    const amp1700 = bandAmp(buf, 1700, SR, skip);

    expect(amp2600).toBeGreaterThan(0.05);
    expect(amp2600).toBeGreaterThan(ampOff * 10);
    // BLUEBOX is a SINGLE freq; the REDBOX freqs must be absent.
    expect(amp2600).toBeGreaterThan(amp1700 * 10);
  });

  it('REDBOX → 1700 + 2200 Hz peaks (no 2600 leak)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const idx = BLUEBOX_BUTTON_NAMES.indexOf('redbox');
    const buf = renderButton(proc, idx, 0.1);
    const skip = Math.round(0.01 * SR);

    const amp1700 = bandAmp(buf, 1700, SR, skip);
    const amp2200 = bandAmp(buf, 2200, SR, skip);
    const amp2600 = bandAmp(buf, 2600, SR, skip);
    const ampOff = bandAmp(buf, 500, SR, skip);

    expect(amp1700).toBeGreaterThan(0.05);
    expect(amp2200).toBeGreaterThan(0.05);
    expect(amp1700).toBeGreaterThan(ampOff * 10);
    expect(amp2200).toBeGreaterThan(ampOff * 10);
    // 2600 belongs to BLUEBOX, NOT REDBOX, so it must be quiet.
    expect(amp1700).toBeGreaterThan(amp2600 * 10);
    expect(amp2200).toBeGreaterThan(amp2600 * 10);
  });
});

describe('blueboxProcessor — silence when no button held', () => {
  it('output is silent when all button params + gates are 0', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const BLOCK = 128;
    const params: Record<string, Float32Array> = {};
    for (const name of BLUEBOX_BUTTON_NAMES) {
      params[`btn_${name}`] = new Float32Array(BLOCK); // zeros
    }
    const inputs: Float32Array[][] = BLUEBOX_BUTTON_NAMES.map(() => []);
    // Render ~1024 samples + check peak.
    let maxAbs = 0;
    for (let blk = 0; blk < 8; blk++) {
      const out = [[new Float32Array(BLOCK)]];
      proc.process(inputs, out, params);
      for (const v of out[0]![0]!) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    expect(maxAbs).toBeLessThan(1e-6);
  });
});

describe('blueboxProcessor — gate input drives the button (no param needed)', () => {
  it('a gate cable on gate_5 emits row=770 + col=1336', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const BLOCK = 128;
    const BLOCKS = Math.ceil((0.1 * SR) / BLOCK);
    const out = new Float32Array(BLOCKS * BLOCK);

    // ALL params are zero. The "5" gate input is hot (constant 1.0).
    const params: Record<string, Float32Array> = {};
    for (const name of BLUEBOX_BUTTON_NAMES) {
      params[`btn_${name}`] = new Float32Array(BLOCK);
    }
    const idx5 = BLUEBOX_BUTTON_NAMES.indexOf('5');
    const inputs: Float32Array[][] = BLUEBOX_BUTTON_NAMES.map((_, i) => {
      if (i === idx5) {
        // mono channel, ones-filled — simulates a constant gate-high cable.
        const ch = new Float32Array(BLOCK);
        ch.fill(1);
        return [ch];
      }
      return [];
    });

    for (let blk = 0; blk < BLOCKS; blk++) {
      const o = [[new Float32Array(BLOCK)]];
      proc.process(inputs, o, params);
      out.set(o[0]![0]!, blk * BLOCK);
    }
    const skip = Math.round(0.01 * SR);
    const [rowHz, colHz] = DTMF_TABLE[5]!;
    expect(bandAmp(out, rowHz, SR, skip)).toBeGreaterThan(0.05);
    expect(bandAmp(out, colHz, SR, skip)).toBeGreaterThan(0.05);
  });
});
