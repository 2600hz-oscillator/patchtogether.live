// packages/web/src/lib/ui/modules/drummergirl-face-model.test.ts
//
// (a) THE SOURCE-GREP PIN. The five preset tables are RE-TYPED in the model
//     because drummergirl's DSP is FAUST and cannot be imported — and the
//     module has NO ART baseline either, so no downstream audio pin would
//     notice a drift. This grep is the ONLY guard, which is why it also asserts
//     SIXTEEN values parsed per table: a regex that silently matched nothing
//     would otherwise pass green, which is the failure mode a grep-based gate
//     has and a compiled import does not.
//
// (b) THE PRESET-NOTE PIN. The face's 16 authored `note` strings are DERIVED
//     DATA (`round(48·sweepAt[i])` / `round(1000·releaseAt[i])`), so they are
//     verified against the tables rather than being prose that can go stale.
//
// (c) THE PERMANENT NEGATIVE CONTROLS — one per readout, in BOTH directions.
//     The central one: line :69 of the .dsp contains no `decayKnob` at all, so
//     the DECAY knob must move NEITHER the sweep's depth nor its duration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { drummergirlDef } from '$lib/audio/modules/drummergirl';
import {
  ATTACK_AT,
  DECAY_AT,
  RELEASE_AT,
  SUSTAIN_AT,
  SWEEP_AT,
  drummergirlHitText,
  drummergirlParams,
  drummergirlPresetNote,
  drummergirlStartHz,
  drummergirlSustainText,
  drummergirlSweepMs,
  drummergirlSweepSemitones,
  shapeSeg,
  type DrummergirlParams,
} from './drummergirl-face-model';

const DEFAULTS: DrummergirlParams = drummergirlParams(() => undefined);

function withParams(over: Partial<DrummergirlParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}

function readout(id: string, over: Partial<DrummergirlParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

describe('drummergirl face model — the .dsp SOURCE PIN', () => {
  it('the five preset tables still match the .dsp, sixteen values each', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/drummergirl.dsp', import.meta.url)),
      'utf8',
    );
    const tables: [string, readonly number[]][] = [
      ['attackAt', ATTACK_AT],
      ['decayAt', DECAY_AT],
      ['sustainAt', SUSTAIN_AT],
      ['releaseAt', RELEASE_AT],
      ['sweepAt', SWEEP_AT],
    ];
    for (const [name, mirror] of tables) {
      const m = new RegExp(`${name}\\(i\\)\\s*=\\s*ba\\.selectn\\(16,\\s*i,([^)]*)\\)`).exec(src);
      expect(m, `${name} not found in drummergirl.dsp`).not.toBeNull();
      const nums = m![1]!
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map(Number);
      // ⚠ THE COUNT ASSERTION IS THE POINT. A regex that matched an empty body
      // would compare [] to [] and pass.
      expect(nums, `${name} must parse to sixteen values`).toHaveLength(16);
      expect(nums.every(Number.isFinite), `${name} parsed a non-number`).toBe(true);
      expect(nums, `${name} drifted from the model's re-typed copy`).toEqual([...mirror]);
    }
  });

  it('the pitch envelope still reads SHAPE’s decay and NOT the DECAY knob', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/drummergirl.dsp', import.meta.url)),
      'utf8',
    );
    // The line the whole face rests on.
    const line = src.split('\n').find((l) => l.startsWith('pitchEnv(g)'));
    expect(line, 'pitchEnv not found').toBeTruthy();
    expect(line).toContain('decayOf(shapeKnob)');
    expect(line, 'the DECAY knob entered the pitch envelope').not.toContain('decayKnob');
    // …and the amp envelope is the ONLY place the knob appears.
    expect(src).toContain('max(0.001,  decayKnob)');
  });

  it('TONE — not SHAPE — is still the sine ↔ noise crossfade', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/drummergirl.dsp', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('mixed(g) = vco(g) * toneKnob + noise * (1.0 - toneKnob);');
  });
});

describe('drummergirl face model — the authored preset roster', () => {

  it('rows 4, 5 and 6 are the DEAD ZONE the shipped default sits in', () => {
    // The face's headline, asserted rather than asserted-in-a-comment.
    for (const i of [4, 5, 6]) {
      expect(drummergirlPresetNote(i).startsWith('0 st'), `preset ${i}`).toBe(true);
    }
    expect(shapeSeg(DEFAULTS.shape)).toEqual({ idx: 4.5, seg: 4, seg2: 5, frac: 0.5 });
  });
});

describe('drummergirl face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({ pitch: 0, tone: 0.3, shape: 0.3, volume: 1, decay: 0.15 });
  });

  it('prints the face’s own figures', () => {
    // THE HEADLINE: the pitch sweep is OFF out of the box.
    expect(readout('drummergirl-sweep-depth')).toBe('0 st');
    expect(readout('drummergirl-start-hz')).toBe('65 Hz');
    expect(readout('drummergirl-hit-ms')).toBe('186 ms');
    expect(readout('drummergirl-shape-index')).toBe('4.5 · 4→5');
    expect(readout('drummergirl-attack-ms')).toBe('1 ms');
    expect(readout('drummergirl-sustain-db')).toBe('-40.0 dB');
    expect(readout('drummergirl-release-ms')).toBe('35 ms');
    expect(readout('drummergirl-sweep-ms')).toBe('60 ms');
  });
});

describe('drummergirl face model — NEGATIVE CONTROLS (both directions)', () => {
  // ── THE CENTRAL ONE. DECAY and the sweep are DISJOINT in the .dsp.
  it('SHAPE moves the sweep; DECAY moves NEITHER its depth nor its duration', () => {
    expect(drummergirlSweepSemitones({ ...DEFAULTS, shape: 0 })).toBeCloseTo(48, 6);
    expect(drummergirlSweepMs({ ...DEFAULTS, shape: 0 })).toBeCloseTo(400, 6);
    // …and the whole DECAY travel leaves both frozen. A readout wired to
    // `decay` would move here, so this is falsifiable rather than decorative.
    const depths = new Set<string>();
    const times = new Set<string>();
    for (const decay of [0.001, 0.05, 0.15, 0.3, 0.5]) {
      depths.add(readout('drummergirl-sweep-depth', { decay }));
      times.add(readout('drummergirl-sweep-ms', { decay }));
    }
    expect([...depths]).toEqual(['0 st']);
    expect([...times]).toEqual(['60 ms']);
  });

  // ── `starts at` — a `paramId: 'pitch'` readout is blind to exactly this.
  it('SHAPE moves the starting pitch with the PITCH knob pinned at 0', () => {
    expect(drummergirlStartHz(DEFAULTS)).toBeCloseTo(65.406, 3);
    expect(drummergirlStartHz({ ...DEFAULTS, shape: 0 })).toBeCloseTo(1046.5, 1);
    expect(readout('drummergirl-start-hz', { shape: 0 })).toBe('1.0 kHz');
    expect(DEFAULTS.pitch).toBe(0);
  });

  // ── `hit` — a `paramId: 'decay'` readout prints 150 ms at both.
  it('SHAPE moves the hit length 186 → 601 ms with DECAY pinned at 0.15', () => {
    expect(readout('drummergirl-hit-ms', { shape: 0.9 })).toBe('601 ms');
    expect(readout('drummergirl-hit-ms')).toBe('186 ms');
    expect(DEFAULTS.decay).toBe(0.15);
  });

  it('the hit REFUSES a number when SUSTAIN makes the question unanswerable', () => {
    // ⚠ The alternative was to print A+D+R anyway under a hidden gate-length
    // assumption. `en.adsr` HOLDS at the sustain level while the gate is high,
    // so at index 11 (sustain 0.5) there is no such number.
    expect(drummergirlHitText({ ...DEFAULTS, shape: 11 / 15 })).toBe('sustains');
    expect(drummergirlHitText({ ...DEFAULTS, shape: 0.9 })).toBe('601 ms');
  });

  // ── `sustain` — and the correction to the batch spec, pinned.
  it('sustain is −6 dB at index 11 and −∞ at shape 0.90, not the other way round', () => {
    // The spec claimed shape 0.30 → 0.90 gives −40 → −6 dB. sustainAt[13] and
    // [14] are BOTH 0.0, so sustainOf(0.90) is −∞. −6 dB (sustain 0.5) lives at
    // index 11, shape = 11/15 ≈ 0.7333. Pinned so the correction cannot rot.
    expect(drummergirlSustainText({ ...DEFAULTS, shape: 0.9 })).toBe('−∞ dB');
    expect(drummergirlSustainText({ ...DEFAULTS, shape: 11 / 15 })).toBe('-6.0 dB');
    expect(drummergirlSustainText(DEFAULTS)).toBe('-40.0 dB');
  });

  it('the preset INDEX readout distinguishes sitting ON a preset from between two', () => {
    expect(readout('drummergirl-shape-index', { shape: 0 })).toBe('0');
    expect(readout('drummergirl-shape-index', { shape: 1 })).toBe('15');
    expect(readout('drummergirl-shape-index', { shape: 11 / 15 })).toBe('11');
    expect(readout('drummergirl-shape-index')).toBe('4.5 · 4→5');
  });
});
