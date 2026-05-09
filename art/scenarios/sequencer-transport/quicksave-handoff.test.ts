// art/scenarios/sequencer-transport/quicksave-handoff.test.ts
//
// Sequencer-transport ART scenario. We exercise the pure-JS portion of the
// new transport + quicksave plumbing — the rising-edge detector + the slot
// snapshot/apply round-trip — under deterministic inputs.
//
// Why this shape: each module's full engine wiring runs setTimeout-based
// schedulers against AudioContext.currentTime, which OfflineAudioContext +
// node-web-audio-api don't pump in real-time. Rather than reverse-engineer
// that scheduling, we verify the building blocks (rising-edge detection on
// raw Float32Array gate buffers, snapshot apply -> live state mutation) at
// the math level, and rely on the Playwright e2e tier to validate the
// full chain end-to-end in a real browser (where the setTimeout loop
// behaves naturally).

import { describe, it, expect } from 'vitest';
import {
  createRisingEdgeDetector,
  defaultSlots,
  coerceSlots,
  resolveSlotClick,
  type SlotMap,
  type Snapshot,
} from '../../../packages/web/src/lib/audio/modules/transport-helpers';
import {
  defaultTracks,
  applyEuclideanToTrack,
  type DrumseqzTrack,
} from '../../../packages/web/src/lib/audio/modules/drumseqz';
import { defaultSteps, type Step } from '../../../packages/web/src/lib/audio/modules/sequencer';

describe('sequencer-transport / rising-edge detection on simulated CV gate buffers', () => {
  it('counts each gate pulse exactly once across two adjacent ticks', () => {
    // Build a gate buffer that pulses at samples 100, 500, 900 — three
    // distinct rising edges. Buffer is 1024 samples.
    const buf = new Float32Array(1024);
    for (let i = 100; i < 130; i++) buf[i] = 1;
    for (let i = 500; i < 530; i++) buf[i] = 1;
    for (let i = 900; i < 930; i++) buf[i] = 1;
    const det = createRisingEdgeDetector(0.5);
    expect(det.scan(buf, 0, buf.length)).toBe(3);
  });

  it('does not miss an edge that straddles two ticks', () => {
    // Tick 1: samples 0..512. Pulse rises at sample 510, still high at 511.
    // Tick 2: samples 512..1024. Pulse continues to 530, then drops.
    // With cross-tick state remembered, this should count as ONE edge.
    const buf1 = new Float32Array(512);
    for (let i = 510; i < 512; i++) buf1[i] = 1;
    const buf2 = new Float32Array(512);
    for (let i = 0; i < 18; i++) buf2[i] = 1;
    const det = createRisingEdgeDetector(0.5);
    const e1 = det.scan(buf1, 0, buf1.length);
    const e2 = det.scan(buf2, 0, buf2.length);
    expect(e1 + e2).toBe(1);
  });

  it('synth-grade BPM clock at 240 bpm 16ths produces 16 edges per second', () => {
    // 240 BPM 16th = 16 advances/sec. Render 1 sec at 48 kHz with a 5 ms
    // gate-on per pulse and assert the detector finds 16 edges.
    const SR = 48000;
    const PULSES_PER_SEC = 16;
    const buf = new Float32Array(SR);
    const samplesPerPulse = SR / PULSES_PER_SEC;
    const gateOnSamples = Math.floor(SR * 0.005); // 5 ms
    for (let p = 0; p < PULSES_PER_SEC; p++) {
      const start = Math.floor(p * samplesPerPulse);
      for (let i = 0; i < gateOnSamples; i++) {
        if (start + i < buf.length) buf[start + i] = 1;
      }
    }
    const det = createRisingEdgeDetector(0.5);
    expect(det.scan(buf, 0, buf.length)).toBe(PULSES_PER_SEC);
  });
});

describe('sequencer-transport / SAVE-then-LOAD round-trip preserves the snapshot', () => {
  it('Sequencer snapshot: 32 steps + bpm/length round-trip exactly', () => {
    // Build a non-default Sequencer pattern: every step in the lower 16 is on.
    const original: Step[] = defaultSteps();
    for (let i = 0; i < 16; i++) {
      original[i] = { on: true, midi: 60 + i, chord: 'mono' };
    }
    const snap: Snapshot = {
      steps: original.map((s) => ({ on: s.on, midi: s.midi, chord: s.chord })),
      bpm: 145,
      length: 16,
      octave: 1,
      gateLength: 0.6,
      swing: 0.25,
    };
    // Save to slot 2.
    const slots: SlotMap = defaultSlots();
    slots['2'] = snap;
    // Read back.
    const decoded = coerceSlots(slots);
    expect(decoded['2']).toBeTruthy();
    const restored = decoded['2'] as Snapshot;
    expect(restored.bpm).toBe(145);
    expect(restored.length).toBe(16);
    expect((restored.steps as Step[])[0].midi).toBe(60);
    expect((restored.steps as Step[])[15].midi).toBe(75);
  });

  it('DRUMSEQZ snapshot: per-track Bjorklund pattern round-trips', () => {
    // Track 0: Bjorklund(4, 16). Track 1: Bjorklund(7, 16).
    const tracks: DrumseqzTrack[] = defaultTracks();
    tracks[0] = applyEuclideanToTrack(tracks[0], 4);
    tracks[1] = applyEuclideanToTrack(tracks[1], 7);
    const snap: Snapshot = {
      tracks: tracks.map((t) => t.map((c) => ({ on: c.on, midi: c.midi }))),
      bpm: 174,
    };
    const slots = defaultSlots();
    slots['1'] = snap;
    const restored = coerceSlots(slots)['1'] as Snapshot;
    expect(restored.bpm).toBe(174);
    const restoredTracks = restored.tracks as DrumseqzTrack[];
    // 4 pulses on track 0, 7 on track 1.
    expect(restoredTracks[0].filter((c) => c.on).length).toBe(4);
    expect(restoredTracks[1].filter((c) => c.on).length).toBe(7);
  });

  it('SCORE snapshot: notes + ties + stop-bar round-trip', () => {
    const snap: Snapshot = {
      notes: [
        { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 9, accidental: null },
        { id: 'n2', bar: 0, tick: 12, duration: 'quarter', midi: 62, staffStep: 8, accidental: null },
      ],
      dynamics: [{ id: 'd1', bar: 0, tick: 0, level: 'mf' }],
      ties: [{ id: 't1', fromNoteId: 'n1', toNoteId: 'n2' }],
      keySignature: 0,
      pages: 1,
      loop: true,
      stopBar: { bar: 1, tick: 0 },
      bpm: 120,
    };
    const slots = defaultSlots();
    slots['3'] = snap;
    const restored = coerceSlots(slots)['3'] as Snapshot;
    expect(restored.loop).toBe(true);
    expect((restored.notes as Array<{ midi: number }>)[0].midi).toBe(60);
    expect((restored.ties as Array<{ id: string }>)[0].id).toBe('t1');
    expect((restored.stopBar as { bar: number }).bar).toBe(1);
  });
});

describe('sequencer-transport / pendingMode → action resolution', () => {
  it('save / load / queue dispatch correctly', () => {
    expect(resolveSlotClick('save', '1').kind).toBe('save');
    expect(resolveSlotClick('load', '2').kind).toBe('load');
    expect(resolveSlotClick('queue', '3').kind).toBe('queue');
  });

  it('null pending mode is noop', () => {
    expect(resolveSlotClick(null, '4').kind).toBe('noop');
  });
});
