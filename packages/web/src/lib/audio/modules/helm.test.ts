// packages/web/src/lib/audio/modules/helm.test.ts
//
// Unit tests for the HELM module def. Worklet-side DSP is exercised via the
// pure-math mirror (renderAdsr) + structural assertions on the def itself.
// Audio-rate spectral assertions live in the ART scenario.

import { describe, it, expect } from 'vitest';
import {
  helmDef,
  expandChannelSet,
  midiChannelMatches,
  parseHelmMidiEvent,
  renderAdsr,
} from './helm';

describe('helm module def', () => {
  it('declares the expected I/O surface', () => {
    expect(helmDef.type).toBe('helm');
    expect(helmDef.domain).toBe('audio');
    expect(helmDef.label).toBe('HELM');
    // 3 inputs: pitch_cv fallback, gate fallback, midi_in marker
    expect(helmDef.inputs.map((p) => p.id).sort()).toEqual(['gate', 'midi_in', 'pitch_cv']);
    // Stereo audio output
    expect(helmDef.outputs.map((p) => p.id).sort()).toEqual(['out_l', 'out_r']);
  });

  it('exposes 2 oscillators + sub + filter + 3 envelopes + 2 LFOs + step seq params', () => {
    const ids = helmDef.params.map((p) => p.id);
    // OSC 1 (6 knobs)
    for (const id of ['osc1Wave', 'osc1Trans', 'osc1Tune', 'osc1Unison', 'osc1Detune', 'osc1Vol']) {
      expect(ids).toContain(id);
    }
    // OSC 2 (6 knobs)
    for (const id of ['osc2Wave', 'osc2Trans', 'osc2Tune', 'osc2Unison', 'osc2Detune', 'osc2Vol']) {
      expect(ids).toContain(id);
    }
    // Sub + noise
    for (const id of ['subWave', 'subVol', 'noiseVol']) expect(ids).toContain(id);
    // Filter (6 knobs)
    for (const id of ['filterCutoff', 'filterRes', 'filterBlend', 'filterStyle', 'filterDrive', 'filterKeyTrack']) {
      expect(ids).toContain(id);
    }
    // 3 envelopes × 4 stages
    for (const env of ['amp', 'fil', 'mod']) {
      for (const stage of ['Attack', 'Decay', 'Sustain', 'Release']) {
        expect(ids).toContain(`${env}${stage}`);
      }
    }
    // LFOs (2 × 3 knobs)
    for (const i of [1, 2]) {
      for (const k of ['Wave', 'Freq', 'Amp']) {
        expect(ids).toContain(`lfo${i}${k}`);
      }
    }
    // Step sequencer
    for (const id of ['stepNumSteps', 'stepRate', 'stepSmooth', 'stepDepth']) {
      expect(ids).toContain(id);
    }
    // Polyphony + master
    expect(ids).toContain('voiceCount');
    expect(ids).toContain('volume');
    expect(ids).toContain('spread');
  });

  it('voiceCount param ranges 1..8 (poly cap)', () => {
    const vc = helmDef.params.find((p) => p.id === 'voiceCount');
    expect(vc).toBeDefined();
    expect(vc!.min).toBe(1);
    expect(vc!.max).toBe(8);
    expect(vc!.defaultValue).toBeGreaterThanOrEqual(4);
    expect(vc!.defaultValue).toBeLessThanOrEqual(8);
  });

  it('step sequencer numSteps maxes at 16', () => {
    const n = helmDef.params.find((p) => p.id === 'stepNumSteps');
    expect(n!.max).toBe(16);
  });

  it('filterStyle is discrete (12dB / 24dB selector)', () => {
    const fs = helmDef.params.find((p) => p.id === 'filterStyle');
    expect(fs!.curve).toBe('discrete');
    expect(fs!.min).toBe(0);
    expect(fs!.max).toBe(1);
  });

  it('credits Matt Tytel via ossAttribution', () => {
    expect(helmDef.ossAttribution?.author).toBe('Matt Tytel');
  });
});

describe('helm MIDI helpers', () => {
  it('parses note-on with velocity > 0', () => {
    const ev = parseHelmMidiEvent(new Uint8Array([0x90, 60, 100]));
    expect(ev).toEqual({ kind: 'note-on', note: 60, velocity: 100, channel: 0 });
  });

  it('parses note-on with velocity 0 as note-off (runs-status convention)', () => {
    const ev = parseHelmMidiEvent(new Uint8Array([0x90, 60, 0]));
    expect(ev).toEqual({ kind: 'note-off', note: 60, channel: 0 });
  });

  it('parses note-off message', () => {
    const ev = parseHelmMidiEvent(new Uint8Array([0x82, 64, 50]));
    expect(ev).toEqual({ kind: 'note-off', note: 64, channel: 2 });
  });

  it('parses CC123 (all notes off)', () => {
    const ev = parseHelmMidiEvent(new Uint8Array([0xb0, 123, 0]));
    expect(ev).toEqual({ kind: 'all-off', channel: 0 });
  });

  it('returns null for non-note messages', () => {
    expect(parseHelmMidiEvent(new Uint8Array([0xe0, 0, 64]))).toBeNull(); // pitch bend
    expect(parseHelmMidiEvent(new Uint8Array([0xf8]))).toBeNull(); // timing clock
  });

  it('expandChannelSet rejects out-of-range / non-int values', () => {
    expect(expandChannelSet([0, 5, 15])?.size).toBe(3);
    expect(expandChannelSet([0, 16, -1, 1.5])?.size).toBe(1); // only 0 is valid
    expect(expandChannelSet(null)).toBeNull();
  });

  it('midiChannelMatches honors channel filter', () => {
    const s = expandChannelSet([3, 5]);
    expect(midiChannelMatches(0x93, s)).toBe(true);  // ch 3
    expect(midiChannelMatches(0x95, s)).toBe(true);  // ch 5
    expect(midiChannelMatches(0x90, s)).toBe(false); // ch 0
    expect(midiChannelMatches(0x90, null)).toBe(true); // all-channels
  });
});

describe('helm pure-math envelope', () => {
  const sr = 48000;
  it('reaches sustain after attack + decay with a gate-on trigger', () => {
    const out = renderAdsr(
      { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.1 },
      [{ sample: 0, on: true }],
      sr * 0.5,
      sr,
    );
    // Past attack+decay, env should be at sustain.
    const last = out[out.length - 1]!;
    expect(last).toBeGreaterThan(0.45);
    expect(last).toBeLessThan(0.55);
  });

  it('peaks near 1.0 at end of attack', () => {
    const out = renderAdsr(
      { attack: 0.01, decay: 8, sustain: 1, release: 1 },
      [{ sample: 0, on: true }],
      sr * 0.05,
      sr,
    );
    expect(Math.max(...out)).toBeCloseTo(1.0, 1);
  });

  it('decays to 0 after release', () => {
    const out = renderAdsr(
      { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.02 },
      [
        { sample: 0, on: true },
        { sample: Math.floor(sr * 0.1), on: false },
      ],
      Math.floor(sr * 0.5),
      sr,
    );
    // Last sample is well past release; should be ~0.
    expect(out[out.length - 1]!).toBeLessThan(1e-3);
  });
});
