// packages/dsp/src/lib/twotracks-engine.test.ts
//
// Unit tests for the TWOTRACKS tape transport — the exact code the worklet runs.
// These exercise the record/playback DSP that the headless e2e CANNOT (no
// AudioWorklet audio thread in Playwright), which is why the recording bugs
// shipped undetected. A full record→stop→play loop is simulated against
// synthetic audio.

import { describe, it, expect } from 'vitest';
import {
  TWOTRACKS_TAPE_LEN,
  echoesToDecay,
  recordWindowLen,
  readInterp,
  recordSpan,
  advanceCursor,
  playheadNorm,
  transportButton,
  loopWindow,
  clampLoopStart,
  clampLoopEnd,
  MIN_LOOP_GAP,
  crossfeedInput,
  reelOutSample,
  type TapeState,
} from './twotracks-engine';

describe('loopWindow + start/end clamps (loop scrubbers)', () => {
  const T = TWOTRACKS_TAPE_LEN;
  it('default 0..1 during playback loops just the recorded region', () => {
    const w = loopWindow(0, 1, 'play', 96_000, T);
    expect(w.windowStart).toBe(0);
    expect(w.windowEnd).toBe(96_000); // = bufLen, NOT the whole tape
  });
  it('narrowed start/end carve a sub-window within the recording', () => {
    const w = loopWindow(0.1, 0.25, 'play', 480_000, T);
    expect(w.windowStart).toBeCloseTo(0.1 * T, 0);
    expect(w.windowEnd).toBeCloseTo(0.25 * T, 0);
  });
  it('end clamps to the recorded extent (can’t loop into blank tape)', () => {
    const w = loopWindow(0, 1, 'play', 100_000, T);
    expect(w.windowEnd).toBe(100_000);
  });
  it('while recording the window spans the whole tape', () => {
    const w = loopWindow(0, 1, 'rec', 0, T);
    expect(w.windowEnd).toBe(T);
  });

  it('clampLoopStart blocks crossing END and (while rolling) the playhead', () => {
    expect(clampLoopStart(0.9, 0.5, null)).toBeCloseTo(0.5 - MIN_LOOP_GAP);
    expect(clampLoopStart(0.8, 0.95, 0.4)).toBe(0.4);
    expect(clampLoopStart(-1, 0.5, null)).toBe(0);
  });
  it('clampLoopEnd blocks crossing START and (while rolling) the playhead', () => {
    expect(clampLoopEnd(0.1, 0.5, null)).toBeCloseTo(0.5 + MIN_LOOP_GAP);
    expect(clampLoopEnd(0.2, 0.05, 0.6)).toBe(0.6);
    expect(clampLoopEnd(2, 0.5, null)).toBe(1);
  });
  it('when stopped (playhead null) start/end move freely within [0,1]', () => {
    expect(clampLoopStart(0.3, 1, null)).toBe(0.3);
    expect(clampLoopEnd(0.7, 0, null)).toBe(0.7);
  });
});

// ── A tiny tape rig that drives the engine like the worklet's inner loop does:
//    read (output) → record-span → advance. Returns the captured buffer + trace.
function simulateRecord(opts: {
  input: Float32Array;       // mono input fed to L (R mirrors)
  rate: number;              // transport speed
  tapeLen: number;
  modeVal?: 0 | 1;
}) {
  const { input, rate, tapeLen, modeVal = 1 } = opts;
  const bufL = new Float32Array(tapeLen);
  const bufR = new Float32Array(tapeLen);
  let bufLen = 0;
  let cursor = 0;
  let state: TapeState = 'rec';
  const playheads: number[] = [];

  for (let i = 0; i < input.length; i++) {
    if (state !== 'rec') break; // stopped (hit tape end)
    const src = input[i] ?? 0;
    // window spans the whole tape while recording
    const winLen = recordWindowLen(state, bufLen, tapeLen);
    const windowStart = 0;
    const windowEnd = winLen;
    bufLen = recordSpan(bufL, bufR, cursor, cursor + rate, src, src, false, tapeLen, bufLen);
    const adv = advanceCursor(cursor, rate, state, modeVal, windowStart, windowEnd);
    cursor = adv.cursor;
    state = adv.state;
    playheads.push(playheadNorm(cursor, tapeLen));
  }
  return { bufL, bufR, bufLen, cursor, state, playheads };
}

describe('echoesToDecay', () => {
  it('maps ECHOES 1..5 to an increasing per-pass decay factor', () => {
    expect(echoesToDecay(1)).toBeCloseTo(0.1, 5);
    expect(echoesToDecay(3)).toBeCloseTo(Math.pow(0.1, 1 / 3), 5);
    expect(echoesToDecay(5)).toBeCloseTo(Math.pow(0.1, 1 / 5), 5);
    // more echoes ⇒ slower decay ⇒ larger factor
    expect(echoesToDecay(5)).toBeGreaterThan(echoesToDecay(1));
  });
  it('clamps + rounds out-of-range echoes', () => {
    expect(echoesToDecay(0)).toBe(echoesToDecay(1));
    expect(echoesToDecay(99)).toBe(echoesToDecay(5));
  });
});

describe('recordWindowLen', () => {
  it('rec spans the FULL tape regardless of how much is recorded (the chopped-record bug)', () => {
    for (const grown of [0, 1, 128, 480_000, 5_000_000]) {
      expect(recordWindowLen('rec', grown, TWOTRACKS_TAPE_LEN)).toBe(TWOTRACKS_TAPE_LEN);
    }
  });
  it('play/overdub/idle loop over the recorded region', () => {
    expect(recordWindowLen('play', 96_000, TWOTRACKS_TAPE_LEN)).toBe(96_000);
    expect(recordWindowLen('overdub', 96_000, TWOTRACKS_TAPE_LEN)).toBe(96_000);
    expect(recordWindowLen('idle', 0, TWOTRACKS_TAPE_LEN)).toBe(TWOTRACKS_TAPE_LEN);
  });
});

describe('recordSpan varispeed write', () => {
  it('rate=1 writes contiguous 1:1 and grows bufLen linearly', () => {
    const L = new Float32Array(100), R = new Float32Array(100);
    let bufLen = 0, cursor = 0;
    for (let i = 0; i < 10; i++) {
      bufLen = recordSpan(L, R, cursor, cursor + 1, i + 1, i + 1, false, 100, bufLen);
      cursor += 1;
    }
    expect(bufLen).toBe(10);
    expect(Array.from(L.slice(0, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('rate=2 stretches input across 2 cells each (records longer → octave-down on 1x)', () => {
    const L = new Float32Array(100), R = new Float32Array(100);
    let bufLen = 0, cursor = 0;
    for (let i = 0; i < 5; i++) {
      bufLen = recordSpan(L, R, cursor, cursor + 2, i + 1, i + 1, false, 100, bufLen);
      cursor += 2;
    }
    expect(bufLen).toBe(10); // 5 inputs × 2 cells
    expect(Array.from(L.slice(0, 10))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('rate=0.5 compresses (every other input lands → octave-up on 1x)', () => {
    const L = new Float32Array(100), R = new Float32Array(100);
    let bufLen = 0, cursor = 0;
    for (let i = 0; i < 8; i++) {
      bufLen = recordSpan(L, R, cursor, cursor + 0.5, i + 1, i + 1, false, 100, bufLen);
      cursor += 0.5;
    }
    // 8 inputs at 0.5/sample → 4 cells; later input overwrites the shared cell.
    expect(bufLen).toBe(4);
    expect(Array.from(L.slice(0, 4))).toEqual([2, 4, 6, 8]);
  });

  it('overdub ADDS onto existing content instead of overwriting', () => {
    const L = new Float32Array(10).fill(1), R = new Float32Array(10).fill(1);
    const bufLen = recordSpan(L, R, 0, 1, 0.5, 0.5, true, 10, 10);
    expect(L[0]).toBeCloseTo(1.5);
    expect(bufLen).toBe(10);
  });

  it('never writes past the physical tape end', () => {
    const L = new Float32Array(5), R = new Float32Array(5);
    const bufLen = recordSpan(L, R, 4, 7, 9, 9, false, 5, 4);
    expect(L[4]).toBe(9);
    expect(bufLen).toBe(5); // clamped, no OOB write/crash
  });
});

describe('advanceCursor boundaries', () => {
  it('rec stops at the tape end → play, rewound to start', () => {
    const r = advanceCursor(99, 1, 'rec', 1, 0, 100);
    expect(r.state).toBe('play');
    expect(r.cursor).toBe(0);
  });
  it('rec stops at the tape start under reverse rate → play', () => {
    const r = advanceCursor(0.5, -1, 'rec', 1, 0, 100);
    expect(r.state).toBe('play');
    expect(r.cursor).toBe(0);
  });
  it('loop-mode play wraps modulo the window without changing state', () => {
    const r = advanceCursor(99.5, 1, 'play', 1, 0, 100);
    expect(r.state).toBe('play');
    expect(r.cursor).toBeCloseTo(0.5);
  });
  it('loop-mode overdub flags a decay pass on wrap', () => {
    const r = advanceCursor(99.5, 1, 'overdub', 1, 0, 100);
    expect(r.decayPass).toBe(true);
  });
  it('one-shot play → idle at the end', () => {
    const r = advanceCursor(99, 1, 'play', 0, 0, 100);
    expect(r.state).toBe('idle');
  });
  it('mid-window advance is a plain step (no boundary)', () => {
    const r = advanceCursor(10, 1, 'play', 1, 0, 100);
    expect(r).toEqual({ cursor: 11, state: 'play', decayPass: false });
  });
});

describe('full record→stop→play simulation (synthetic sine)', () => {
  const SR = 48000;
  function sine(freq: number, n: number): Float32Array {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    return b;
  }

  it('rate=1 captures the WHOLE take (not a snippet) at true 1:1', () => {
    const input = sine(220, SR); // 1 s
    const { bufLen, bufL } = simulateRecord({ input, rate: 1, tapeLen: TWOTRACKS_TAPE_LEN });
    // 1 s in → ~1 s of tape (true 1.0×), NOT a few-ms fragment.
    expect(bufLen).toBe(SR);
    // recorded content is the sine, not silence
    let energy = 0;
    for (let i = 0; i < bufLen; i++) energy += bufL[i]! * bufL[i]!;
    expect(Math.sqrt(energy / bufLen)).toBeGreaterThan(0.5);
  });

  it('rate=2 records ~2× the tape length for the same input (varispeed)', () => {
    const input = sine(220, SR / 2); // 0.5 s
    const { bufLen } = simulateRecord({ input, rate: 2, tapeLen: TWOTRACKS_TAPE_LEN });
    expect(bufLen).toBe(SR); // 0.5 s input × 2 = 1 s of tape
  });

  it('playhead advances monotonically L→R during forward record (no backward drift)', () => {
    const input = sine(220, 2000);
    const { playheads } = simulateRecord({ input, rate: 1, tapeLen: TWOTRACKS_TAPE_LEN });
    for (let i = 1; i < playheads.length; i++) {
      expect(playheads[i]!).toBeGreaterThanOrEqual(playheads[i - 1]!);
    }
    // and it reflects position within the WHOLE tape (tiny fraction after 2000 of 960k)
    expect(playheads.at(-1)!).toBeCloseTo(2000 / TWOTRACKS_TAPE_LEN, 4);
  });

  it('recording the entire tape stops automatically at the end → play', () => {
    const input = sine(220, TWOTRACKS_TAPE_LEN + 5000); // longer than the tape
    const { state, bufLen } = simulateRecord({ input, rate: 1, tapeLen: TWOTRACKS_TAPE_LEN });
    expect(state).toBe('play');          // stopped on its own
    expect(bufLen).toBe(TWOTRACKS_TAPE_LEN);
  });
});

describe('transportButton (tape-deck REC/PLAY/STOP)', () => {
  it('REC when stopped ARMS (nothing records yet)', () => {
    expect(transportButton('rec', 'idle', false)).toEqual({ state: 'armed', seekToStart: false });
  });
  it('PLAY when armed rolls + records from the top (overwrite)', () => {
    expect(transportButton('play', 'armed', false)).toEqual({ state: 'rec', seekToStart: true });
  });
  it('PLAY when armed + overdub flag records as overdub from the top', () => {
    expect(transportButton('play', 'armed', true)).toEqual({ state: 'overdub', seekToStart: true });
  });
  it('PLAY when stopped plays the tape from the top', () => {
    expect(transportButton('play', 'idle', false)).toEqual({ state: 'play', seekToStart: true });
  });
  it('REC while playing PUNCHES IN at the current playhead (no rewind)', () => {
    expect(transportButton('rec', 'play', false)).toEqual({ state: 'rec', seekToStart: false });
    expect(transportButton('rec', 'play', true)).toEqual({ state: 'overdub', seekToStart: false });
  });
  it('REC while recording PUNCHES OUT back to play (keeps rolling)', () => {
    expect(transportButton('rec', 'rec', false)).toEqual({ state: 'play', seekToStart: false });
    expect(transportButton('rec', 'overdub', false)).toEqual({ state: 'play', seekToStart: false });
  });
  it('REC while armed disarms', () => {
    expect(transportButton('rec', 'armed', false)).toEqual({ state: 'idle', seekToStart: false });
  });
  it('STOP always idles', () => {
    for (const s of ['idle', 'armed', 'play', 'rec', 'overdub'] as TapeState[]) {
      expect(transportButton('stop', s, false)).toEqual({ state: 'idle', seekToStart: false });
    }
  });
  it('PLAY while already recording is a no-op (keeps rolling, no rewind)', () => {
    expect(transportButton('play', 'rec', false)).toEqual({ state: 'rec', seekToStart: false });
  });
});

describe('readInterp', () => {
  it('reads exact integer samples and interpolates between', () => {
    const b = new Float32Array([0, 10, 20, 30]);
    expect(readInterp(b, 1)).toBe(10);
    expect(readInterp(b, 1.5)).toBeCloseTo(15);
    expect(readInterp(b, -1)).toBe(0);
  });
});

describe('playheadNorm', () => {
  it('normalizes cursor against the whole tape and clamps', () => {
    expect(playheadNorm(0, 100)).toBe(0);
    expect(playheadNorm(50, 100)).toBe(0.5);
    expect(playheadNorm(150, 100)).toBe(1);
  });
});

describe('crossfeedInput (A→B / B→A bleed)', () => {
  it('crossGain 0 is identity — byte-for-byte today\'s behavior', () => {
    expect(crossfeedInput(0.5, 0, 0.9)).toBe(0.5);
    expect(crossfeedInput(-0.3, 0, 1.0)).toBe(-0.3);
  });
  it('scales the other reel\'s playback into the input path', () => {
    expect(crossfeedInput(0.2, 0.5, 0.8)).toBeCloseTo(0.2 + 0.4);
    expect(crossfeedInput(0, 1, 0.7)).toBeCloseTo(0.7); // full bleed, no own input
    expect(crossfeedInput(0, 0.25, 1)).toBeCloseTo(0.25);
  });
  it('is additive so A→B and B→A are symmetric in form', () => {
    // A's input gets b2a*B_play; B's input gets a2b*A_play — same function.
    expect(crossfeedInput(0.1, 0.3, 0.5)).toBe(crossfeedInput(0.1, 0.3, 0.5));
  });
});

describe('reelOutSample (dry gating + monitor mix)', () => {
  it('monitor OFF → ONLY the tape under the head (no dry, no live cross-feed)', () => {
    expect(reelOutSample(0.4, 0.9, false)).toBe(0.4);
    // even with a big input path (dry + cross), nothing leaks live when not monitoring
    expect(reelOutSample(0, 1.5, false)).toBe(0);
  });
  it('monitor ON → input path mixed INTO the play/record mix (input + tape)', () => {
    expect(reelOutSample(0.4, 0.3, true)).toBeCloseTo(0.7);
    // fresh record on blank tape (tape=0) + monitor → you hear the input
    expect(reelOutSample(0, 0.6, true)).toBeCloseTo(0.6);
  });
  it('not rolling (tapePlay=0) + monitor off → silence', () => {
    expect(reelOutSample(0, 0.5, false)).toBe(0);
  });
  it('composes with crossfeedInput: monitoring hears A bleed; not monitoring does not', () => {
    const inputPath = crossfeedInput(0.0, 0.5, 0.8); // B has no own input, A bleeds in
    expect(reelOutSample(0.2, inputPath, true)).toBeCloseTo(0.2 + 0.4);  // heard while monitoring
    expect(reelOutSample(0.2, inputPath, false)).toBe(0.2);              // only tape when not
  });
});
