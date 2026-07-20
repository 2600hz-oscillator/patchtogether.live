// packages/web/src/lib/graph/patch-convenience.test.ts
//
// Coverage for the workflow-mode "Control from → Clip" / "Send to → MixMaster"
// eligibility + wiring planner. Three layers:
//   1. PURE predicate unit tests (synthetic defs) — the tricky rules in isolation.
//   2. LIVE-REGISTRY membership — the option APPEARS for representative eligible
//      modules and is ABSENT for representative ineligible ones (owner hard req:
//      "appears in all cases where it should AND is absent when it should not"),
//      computed procedurally from the real defs (no allow-list).
//   3. CHANNEL PORT-MAP guard — the encoded clip/mixer channel port ids match
//      the live clipplayer / mixmstrs defs, so a def change trips this test.

import { describe, it, expect } from 'vitest';
// Side-effect imports: register every audio + video module def so the live
// registry is populated (registerAudioModules() runs at barrel import time).
import '$lib/audio/modules';
import '$lib/video/modules';
import type { PortDef } from './types';
import {
  isClipEligible,
  isMixerEligible,
  isNoteSource,
  resolveClipWiring,
  resolveMainAudioOut,
  planClipControl,
  planSendToMixer,
  clipChannelPorts,
  mixerChannelPorts,
  CLIP_CHANNEL_COUNT,
  MIXER_CHANNEL_COUNT,
  type ConvenienceDef,
} from './patch-convenience';
import { listModuleDefs } from '$lib/audio/module-registry';

// ---------------- helpers ----------------

const port = (id: string, type: PortDef['type'], extra: Partial<PortDef> = {}): PortDef =>
  ({ id, type, ...extra });

const def = (
  inputs: PortDef[],
  outputs: PortDef[],
  stereoPairs?: readonly (readonly [string, string])[],
): ConvenienceDef => ({ inputs, outputs, stereoPairs });

function liveDef(type: string): ConvenienceDef | undefined {
  return listModuleDefs().find((d) => (d as { type?: string }).type === type) as
    | ConvenienceDef
    | undefined;
}

// ================================================================
// 1. PURE predicate unit tests
// ================================================================

describe('clip eligibility (pure)', () => {
  it('a poly instrument (poly input) is clip-eligible via the poly path', () => {
    const d = def([port('poly', 'polyPitchGate')], [port('out', 'audio')]);
    expect(isClipEligible(d)).toBe(true);
    expect(resolveClipWiring(d)).toEqual({ mode: 'poly', pitchInPort: 'poly' });
  });

  it('a mono instrument (pitch + note-gate) is clip-eligible via the mono path', () => {
    const d = def([port('pitch', 'pitch'), port('gate', 'gate', { edge: 'gate' })], [port('out', 'audio')]);
    expect(isClipEligible(d)).toBe(true);
    expect(resolveClipWiring(d)).toEqual({ mode: 'monoPitchGate', pitchInPort: 'pitch', gateInPort: 'gate' });
  });

  it('a drum (pitch + trigger-edge gate) is clip-eligible', () => {
    const d = def([port('pitch', 'pitch'), port('strike', 'gate', { edge: 'trigger' })], [port('out', 'audio')]);
    expect(isClipEligible(d)).toBe(true);
  });

  it('POLY takes precedence when a module has both a poly input and a mono pitch+gate', () => {
    const d = def(
      [port('poly', 'polyPitchGate'), port('pitch', 'pitch'), port('gate', 'gate')],
      [port('out', 'audio')],
    );
    expect(resolveClipWiring(d)?.mode).toBe('poly');
  });

  it('a pitch input with NO gate (a drone VCO) is NOT clip-eligible', () => {
    const d = def([port('pitch', 'pitch'), port('fm', 'cv')], [port('out', 'audio')]);
    expect(isClipEligible(d)).toBe(false);
  });

  it('gate-only percussion (note-gate + audio out, no v/oct pitch) is clip-eligible via gateOnly', () => {
    // kickdrum shape: a trigger gate + CV mod params + audio out, no `pitch` cable.
    const drum = def(
      [port('trigger_in', 'gate', { edge: 'trigger' }), port('pitch_cv', 'cv')],
      [port('out', 'audio')],
    );
    expect(isClipEligible(drum)).toBe(true);
    expect(resolveClipWiring(drum)).toEqual({ mode: 'gateOnly', gateInPort: 'trigger_in' });
  });

  it('a gated UTILITY with no audio out is NOT clip-eligible (gate-only needs a voice)', () => {
    const util = def([port('gate', 'gate', { edge: 'gate' })], [port('cv_out', 'cv')]);
    expect(isClipEligible(util)).toBe(false);
  });

  it('a CONTROL gate (freeze) does not count as a note gate → not clip-eligible', () => {
    const d = def([port('pitch', 'pitch'), port('freeze_gate', 'gate')], [port('out', 'audio')]);
    expect(isClipEligible(d)).toBe(false);
  });

  it('other control gates (reset/sync/record/hold) are excluded too', () => {
    for (const g of ['reset', 'sync_in', 'record', 'holdGate', 'clock']) {
      const d = def([port('pitch', 'pitch'), port(g, 'gate')], [port('out', 'audio')]);
      expect(isClipEligible(d), `${g} must not qualify`).toBe(false);
    }
  });

  it('a NOTE SOURCE (emits polyPitchGate) is never a clip target', () => {
    const seq = def([port('clock', 'gate')], [port('pitch1', 'polyPitchGate')]);
    expect(isNoteSource(seq)).toBe(true);
    expect(isClipEligible(seq)).toBe(false);
  });

  it('a note source that emits pitch + gate separately is excluded', () => {
    const seq = def(
      [port('pitch', 'pitch'), port('gate', 'gate')], // even though it LOOKS playable
      [port('pitch_out', 'pitch'), port('gate_out', 'gate')],
    );
    expect(isNoteSource(seq)).toBe(true);
    expect(isClipEligible(seq)).toBe(false);
  });
});

describe('mixer eligibility (pure)', () => {
  it('a declared stereo pair resolves the main out (naming-agnostic, e.g. odd/even)', () => {
    const d = def([], [port('odd', 'audio'), port('even', 'audio')], [['odd', 'even']]);
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'stereo', left: 'odd', right: 'even' });
    expect(isMixerEligible(d)).toBe(true);
  });

  it('an L/R id-token pair resolves when no stereoPairs are declared', () => {
    const d = def([], [port('audio_l_out', 'audio'), port('audio_r_out', 'audio')]);
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'stereo', left: 'audio_l_out', right: 'audio_r_out' });
  });

  it('a single mono audio out resolves as mono', () => {
    const d = def([], [port('out', 'audio')]);
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'mono', out: 'out' });
  });

  it('a main pair AMID extra outs still resolves (L/R + sync)', () => {
    const d = def([], [port('outL', 'audio'), port('outR', 'audio'), port('sync', 'audio')], [['outL', 'outR']]);
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'stereo', left: 'outL', right: 'outR' });
  });

  it('one canonical main among several audio outs (out + aux) resolves as mono', () => {
    const d = def([], [port('out', 'audio'), port('aux', 'audio')]);
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'mono', out: 'out' });
  });

  it('a bank of equal parallel outs with NO identifiable main is NOT eligible', () => {
    const d = def([], [port('out1', 'audio'), port('out2', 'audio'), port('out3', 'audio'), port('out4', 'audio')]);
    expect(resolveMainAudioOut(d)).toBeNull();
    expect(isMixerEligible(d)).toBe(false);
  });

  it('a module with only CV / video outs is NOT mixer-eligible', () => {
    const cvOnly = def([], [port('cv_out', 'cv'), port('gate_out', 'gate')]);
    expect(isMixerEligible(cvOnly)).toBe(false);
    const rgba = def([], [port('out_red', 'cv'), port('out_grn', 'cv'), port('out_blu', 'cv')]);
    expect(isMixerEligible(rgba)).toBe(false);
  });
});

describe('edge plans (pure)', () => {
  it('poly instrument → one edge: clip pitch{n} (polyPitchGate) → poly input', () => {
    const d = def([port('poly', 'polyPitchGate')], [port('out', 'audio')]);
    expect(planClipControl(d, 3)).toEqual([
      { fromPortId: 'pitch3', toPortId: 'poly', sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
    ]);
  });

  it('mono instrument → two edges: pitch{n}→pitch, gate{n}→gate', () => {
    const d = def([port('vc_pitch', 'pitch'), port('trig', 'gate', { edge: 'trigger' })], [port('out', 'audio')]);
    expect(planClipControl(d, 1)).toEqual([
      { fromPortId: 'pitch1', toPortId: 'vc_pitch', sourceType: 'polyPitchGate', targetType: 'pitch' },
      { fromPortId: 'gate1', toPortId: 'trig', sourceType: 'gate', targetType: 'gate' },
    ]);
  });

  it('gate-only percussion → one edge: clip gate{n} → the note-gate input', () => {
    const drum = def([port('trigger_in', 'gate', { edge: 'trigger' })], [port('out', 'audio')]);
    expect(planClipControl(drum, 4)).toEqual([
      { fromPortId: 'gate4', toPortId: 'trigger_in', sourceType: 'gate', targetType: 'gate' },
    ]);
  });

  it('stereo source → mixer: L→ch{n}L, R→ch{n}R', () => {
    const d = def([], [port('outL', 'audio'), port('outR', 'audio')], [['outL', 'outR']]);
    expect(planSendToMixer(d, 2)).toEqual([
      { fromPortId: 'outL', toPortId: 'ch2L', sourceType: 'audio', targetType: 'audio' },
      { fromPortId: 'outR', toPortId: 'ch2R', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('mono source → mixer: single out fills BOTH ch{n}L and ch{n}R', () => {
    const d = def([], [port('out', 'audio')]);
    expect(planSendToMixer(d, 5)).toEqual([
      { fromPortId: 'out', toPortId: 'ch5L', sourceType: 'audio', targetType: 'audio' },
      { fromPortId: 'out', toPortId: 'ch5R', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('an ineligible module yields null plans', () => {
    const d = def([port('in', 'audio')], [port('cv', 'cv')]);
    expect(planClipControl(d, 1)).toBeNull();
    expect(planSendToMixer(d, 1)).toBeNull();
  });
});

// ================================================================
// 2. LIVE-REGISTRY membership — appears / absent (owner hard req)
// ================================================================

describe('clip eligibility — live registry (appears when it should)', () => {
  // Representative instruments that MUST offer "Control from → Clip".
  const EXPECTED_ELIGIBLE = [
    'cube', 'wavecel', 'dx7', 'pentemelodica', 'sixstrum', 'karplus', 'tidyVco', 'kickdrum',
  ];
  for (const type of EXPECTED_ELIGIBLE) {
    it(`${type} is clip-eligible`, () => {
      const d = liveDef(type);
      expect(d, `${type} not found in registry`).toBeDefined();
      expect(isClipEligible(d!)).toBe(true);
    });
  }
});

describe('clip eligibility — live registry (absent when it should not appear)', () => {
  // Note SOURCES, effects, visualizers, drones — must NOT offer clip control.
  const EXPECTED_INELIGIBLE = [
    'clipplayer', 'midiLane', 'polyseqz', // note sources
    'reverb', 'filter', 'delay', 'scope', // effects / visualizers
    'clouds', // freeze gate, not a note gate
  ];
  for (const type of EXPECTED_INELIGIBLE) {
    it(`${type} is NOT clip-eligible`, () => {
      const d = liveDef(type);
      if (!d) return; // module not present in this build — nothing to assert
      expect(isClipEligible(d)).toBe(false);
    });
  }
});

describe('mixer eligibility — live registry', () => {
  const EXPECTED_ELIGIBLE = ['cube', 'pentemelodica', 'tidyVco', 'kickdrum', 'reverb', 'wavecel'];
  for (const type of EXPECTED_ELIGIBLE) {
    it(`${type} is mixer-eligible (has a main audio out)`, () => {
      const d = liveDef(type);
      expect(d, `${type} not found`).toBeDefined();
      expect(isMixerEligible(d!)).toBe(true);
    });
  }

  it('a pure note-source (midiLane) is NOT mixer-eligible (no audio out)', () => {
    const d = liveDef('midiLane');
    if (d) expect(isMixerEligible(d)).toBe(false);
  });

  it('every clip-eligible instrument that is also an audio source is mixer-eligible', () => {
    // Sanity invariant: a playable instrument with audio out can go to the mixer.
    for (const d of listModuleDefs() as unknown as ConvenienceDef[]) {
      if (isClipEligible(d) && d.outputs.some((p) => p.type === 'audio')) {
        expect(isMixerEligible(d)).toBe(true);
      }
    }
  });
});

// ================================================================
// 3. CHANNEL PORT-MAP guard against the live defs
// ================================================================

describe('clip channel port map matches the live clipplayer def', () => {
  it('clipChannelPorts(n) resolve to real clipplayer output ports for all 8 lanes', () => {
    const cp = liveDef('clipplayer');
    expect(cp, 'clipplayer not found').toBeDefined();
    const outIds = new Set(cp!.outputs.map((p) => p.id));
    for (let n = 1; n <= CLIP_CHANNEL_COUNT; n++) {
      const { pitchOut, gateOut } = clipChannelPorts(n);
      expect(outIds.has(pitchOut), `${pitchOut} missing`).toBe(true);
      expect(outIds.has(gateOut), `${gateOut} missing`).toBe(true);
    }
  });

  it('clip pitch{n} is a polyPitchGate cable and gate{n} is a gate cable', () => {
    const cp = liveDef('clipplayer')!;
    const byId = new Map(cp.outputs.map((p) => [p.id, p]));
    expect(byId.get('pitch1')?.type).toBe('polyPitchGate');
    expect(byId.get('gate1')?.type).toBe('gate');
  });
});

describe('mixer channel port map matches the live mixmstrs def', () => {
  it('mixerChannelPorts(n) resolve to real mixmstrs input ports for all 6 channels', () => {
    const mx = liveDef('mixmstrs');
    expect(mx, 'mixmstrs not found').toBeDefined();
    const inIds = new Set(mx!.inputs.map((p) => p.id));
    for (let n = 1; n <= MIXER_CHANNEL_COUNT; n++) {
      const { leftIn, rightIn } = mixerChannelPorts(n);
      expect(inIds.has(leftIn), `${leftIn} missing`).toBe(true);
      expect(inIds.has(rightIn), `${rightIn} missing`).toBe(true);
    }
  });
});
