// patch-panel-labels.test.ts
//
// Verbose-label rule: every UI port label expands to the human form by
// default. The test asserts the canonical mappings from a sampling of
// real module ids on `main`. If anyone adds an abbreviation back into a
// card, this test fires loudly — there's no "ATK" or "RES" hiding behind
// a default fall-through.

import { describe, expect, it } from 'vitest';
import {
  resolveVerboseLabel,
  groupPortsByCableType,
  type PortDescriptor,
} from './patch-panel-labels';

describe('resolveVerboseLabel', () => {
  it('expands ADSR ids verbatim', () => {
    expect(resolveVerboseLabel({ id: 'attack' })).toBe('ATTACK');
    expect(resolveVerboseLabel({ id: 'decay' })).toBe('DECAY');
    expect(resolveVerboseLabel({ id: 'sustain' })).toBe('SUSTAIN');
    expect(resolveVerboseLabel({ id: 'release' })).toBe('RELEASE');
  });

  it('expands canonical abbreviations to full words', () => {
    expect(resolveVerboseLabel({ id: 'atk' })).toBe('ATTACK');
    expect(resolveVerboseLabel({ id: 'sus' })).toBe('SUSTAIN');
    expect(resolveVerboseLabel({ id: 'rel' })).toBe('RELEASE');
    expect(resolveVerboseLabel({ id: 'res' })).toBe('RESONANCE');
    expect(resolveVerboseLabel({ id: 'cut' })).toBe('CUTOFF');
    expect(resolveVerboseLabel({ id: 'vol' })).toBe('VOLUME');
  });

  it('preserves hardware-convention shorthand (FM, PW, L/R)', () => {
    // These must stay as-is — not expanded to FREQUENCY MODULATION etc.
    expect(resolveVerboseLabel({ id: 'fm' })).toBe('FM');
    expect(resolveVerboseLabel({ id: 'pw' })).toBe('PW');
    expect(resolveVerboseLabel({ id: 'L' })).toBe('L');
    expect(resolveVerboseLabel({ id: 'R' })).toBe('R');
    expect(resolveVerboseLabel({ id: 'cv' })).toBe('CV');
  });

  it('expands voice-prefixed ports for RIOTGIRLS', () => {
    expect(resolveVerboseLabel({ id: 'v1_tone' })).toBe('V1 TONE');
    expect(resolveVerboseLabel({ id: 'v4_attack' })).toBe('V4 ATTACK');
    expect(resolveVerboseLabel({ id: 'v3_sendA' })).toBe('V3 SEND A');
    expect(resolveVerboseLabel({ id: 'pitch1' })).toBe('PITCH1');
    expect(resolveVerboseLabel({ id: 'gate2' })).toBe('GATE2');
  });

  it('expands FX-prefixed ports', () => {
    expect(resolveVerboseLabel({ id: 'flt_cutoff' })).toBe('FILTER CUTOFF');
    expect(resolveVerboseLabel({ id: 'flt_resonance' })).toBe('FILTER RESONANCE');
    expect(resolveVerboseLabel({ id: 'flt_mode' })).toBe('FILTER MODE');
    expect(resolveVerboseLabel({ id: 'rv_size' })).toBe('REVERB SIZE');
    expect(resolveVerboseLabel({ id: 'rv_damp' })).toBe('REVERB DAMP');
    expect(resolveVerboseLabel({ id: 'bc_decimate' })).toBe('DESTROY DECIMATE');
    expect(resolveVerboseLabel({ id: 'bc_bits' })).toBe('DESTROY BITS');
  });

  it('expands MIXMSTRS channel ports', () => {
    expect(resolveVerboseLabel({ id: 'ch1L' })).toBe('CH1 L');
    expect(resolveVerboseLabel({ id: 'ch3R' })).toBe('CH3 R');
    expect(resolveVerboseLabel({ id: 'ch2_volume' })).toBe('CH2 VOLUME');
    expect(resolveVerboseLabel({ id: 'master_volume' })).toBe('MASTER VOLUME');
    expect(resolveVerboseLabel({ id: 'masterL' })).toBe('MASTER L');
    expect(resolveVerboseLabel({ id: 'send1L' })).toBe('SEND 1 L');
    expect(resolveVerboseLabel({ id: 'ret2R' })).toBe('RETURN 2 R');
  });

  it('expands camelCase ids by inserting spaces', () => {
    expect(resolveVerboseLabel({ id: 'wavePos' })).toBe('WAVE POS');
    expect(resolveVerboseLabel({ id: 'cvAmount' })).toBe('CV AMOUNT');
    expect(resolveVerboseLabel({ id: 'gateLength' })).toBe('GATE LENGTH');
  });

  it('respects an explicit label override', () => {
    expect(resolveVerboseLabel({ id: 'whatever', label: 'my custom label' })).toBe(
      'MY CUSTOM LABEL',
    );
  });

  it('does NOT silently pass through abbreviations as the panel default', () => {
    // The whole point of the verbose-label rule: someone reverting "RES" or
    // "ATK" inside a card should fail this test.
    const badAbbrevs = ['ATK', 'DCY', 'SUS', 'REL', 'RES', 'CUT', 'VOL', 'PNG', 'PIT', 'TRG'];
    for (const id of ['attack', 'decay', 'sustain', 'release', 'resonance', 'cutoff', 'volume', 'pitch', 'trigger']) {
      const out = resolveVerboseLabel({ id });
      expect(badAbbrevs).not.toContain(out);
    }
  });
});

describe('groupPortsByCableType', () => {
  it('orders gate, pitch, cv, audio, poly groups', () => {
    const ports: PortDescriptor[] = [
      { id: 'audio_in', cable: 'audio' },
      { id: 'cutoff', cable: 'cv' },
      { id: 'gate', cable: 'gate' },
      { id: 'pitch', cable: 'pitch' },
      { id: 'poly', cable: 'polyPitchGate' },
    ];
    const groups = groupPortsByCableType(ports, 'input');
    expect(groups.map((g) => g.cable)).toEqual(['gate', 'pitch', 'cv', 'audio', 'polyPitchGate']);
    expect(groups.map((g) => g.label)).toEqual(['Gates', 'Pitches', 'CV', 'Audio', 'Poly']);
  });

  it('preserves declared order within a group', () => {
    const ports: PortDescriptor[] = [
      { id: 'attack', cable: 'cv' },
      { id: 'decay', cable: 'cv' },
      { id: 'sustain', cable: 'cv' },
      { id: 'release', cable: 'cv' },
    ];
    const groups = groupPortsByCableType(ports, 'input');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ports.map((p) => p.id)).toEqual(['attack', 'decay', 'sustain', 'release']);
  });
});
