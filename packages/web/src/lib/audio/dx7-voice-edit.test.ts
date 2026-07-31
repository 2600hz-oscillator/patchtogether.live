// packages/web/src/lib/audio/dx7-voice-edit.test.ts
//
// THE MIGRATION IS THE POINT OF THIS FILE.
//
// `DX7OpData` stored only the DERIVED `ratio` until this PR — `parsePackedVoice`
// read the coarse and fine bytes and threw them away. So every rack ALREADY
// SAVED has `node.data.userPatches[i].operators[j]` with no `coarse` and no
// `fine`, and a pitch row reading `op.coarse` straight would render nothing for
// an imported cartridge. That is the failure mode this PR exists to prevent, so
// the first describe block loads LEGACY-SHAPED voices — the literal pre-PR
// object shape — and asserts the pitch row RESOLVES, at the level the UI
// actually prints.
//
// Every block here also carries a negative control on its own instrument, per
// CLAUDE.md's "validate the instrument" rule: a legacy fixture that quietly
// gained the bytes, a `canonicalVoice` blind to a field, or a syncedStore that
// handed back plain objects would each turn a green run into a lie.

import { describe, it, expect } from 'vitest';
import { createPatch } from '$lib/graph/store';
import {
  copyEg,
  deepUnwrapVoice,
  fixedHzToCoarseFine,
  isDirty,
  ratioToCoarseFine,
  resolveOpCoarseFine,
  setOpField,
} from './dx7-voice-edit';
import { DX7_BUILTIN_BANK } from './dx7-banks';
import {
  computeChecksum,
  dx7DetuneFactor,
  dx7FixedHz,
  dx7Ratio,
  parseSyxBank,
  type DX7OpData,
  type DX7Voice,
} from './dx7-syx';
import { dx7FormatFrequency, dx7FormatRatio } from './dx7-format';
import { renderDx7Note } from './dx7-render';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Strip `coarse`/`fine` from every operator — reproduces the EXACT shape a
 *  rack saved before this PR has on disk. The keys are DELETED, not set to
 *  undefined, because that is what `JSON.parse` of a stored rack yields. */
function toLegacyShape(voice: DX7Voice): DX7Voice {
  const v = JSON.parse(JSON.stringify(voice)) as DX7Voice;
  for (const op of v.operators) {
    delete (op as Partial<DX7OpData>).coarse;
    delete (op as Partial<DX7OpData>).fine;
  }
  return v;
}

/** A synthetic 32-voice cartridge with a WIDE spread of coarse/fine pairs, so
 *  the migration is exercised against ratios a hand-written fixture would miss
 *  (the aliased ones, the 0.5 slot, the top of the coarse range). */
function buildWideSyx(): Uint8Array {
  const out = new Uint8Array(4104);
  out[0] = 0xf0;
  out[1] = 0x43;
  out[3] = 0x09;
  out[4] = 0x20;
  out[4103] = 0xf7;
  const payload = out.subarray(6, 4102);
  for (let v = 0; v < 32; v++) {
    const base = v * 128;
    for (let op = 0; op < 6; op++) {
      const o = base + op * 17;
      payload[o + 0] = 99;
      payload[o + 1] = 50;
      payload[o + 2] = 30;
      payload[o + 3] = 60;
      payload[o + 4] = 99;
      payload[o + 5] = 70;
      payload[o + 6] = 50;
      payload[o + 7] = 0;
      payload[o + 12] = 7 << 3;
      payload[o + 13] = 4 << 2;
      payload[o + 14] = 80;
      // Walk coarse 0..31 across the voices and fine 0..99 across the ops, so
      // the bank covers both ends of both bytes including the 0.5 slot.
      const coarse = v % 32;
      const fine = (v * 6 + op) % 100;
      payload[o + 15] = coarse << 1; // osc mode 0 = ratio
      payload[o + 16] = fine;
    }
    for (let k = 0; k < 4; k++) {
      payload[base + 102 + k] = 99;
      payload[base + 106 + k] = 50;
    }
    payload[base + 110] = v % 32;
    payload[base + 111] = 4;
    payload[base + 117] = 24;
    for (let i = 0; i < 10; i++) payload[base + 118 + i] = 'WIDE'.charCodeAt(i % 4);
  }
  out[4102] = computeChecksum(payload);
  return out;
}

const WIDE_BANK = parseSyxBank(buildWideSyx()).voices;

/** Every voice the migration must survive: the 9 built-ins plus a 32-voice
 *  cartridge, all reduced to the legacy on-disk shape. */
const LEGACY_CORPUS: DX7Voice[] = [...DX7_BUILTIN_BANK, ...WIDE_BANK].map(toLegacyShape);

// ---------------------------------------------------------------------------
// THE MIGRATION
// ---------------------------------------------------------------------------

describe('MIGRATION — a legacy-shaped voice still resolves a pitch row', () => {
  it('the corpus really IS legacy-shaped (the fixture negative control)', () => {
    // Without this, a future `toLegacyShape` that stopped deleting — or a
    // built-in that grew the bytes somewhere else — would make every assertion
    // below pass while proving nothing about migration at all.
    expect(LEGACY_CORPUS.length).toBe(9 + 32);
    for (const v of LEGACY_CORPUS) {
      for (const op of v.operators) {
        expect(Object.prototype.hasOwnProperty.call(op, 'coarse')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(op, 'fine')).toBe(false);
        expect((op as Partial<DX7OpData>).coarse).toBeUndefined();
      }
    }
    // And the pre-PR reading — straight off the field — is exactly the empty
    // pitch row this PR exists to prevent.
    const naive = LEGACY_CORPUS[0]!.operators[0] as Partial<DX7OpData>;
    expect(`${naive.coarse ?? ''}`).toBe('');
  });

  it('resolveOpCoarseFine returns real in-range bytes for EVERY legacy operator', () => {
    for (const v of LEGACY_CORPUS) {
      for (let i = 0; i < 6; i++) {
        const { coarse, fine } = resolveOpCoarseFine(v.operators[i]!);
        expect(Number.isInteger(coarse), `${v.name} op${i + 1} coarse`).toBe(true);
        expect(Number.isInteger(fine), `${v.name} op${i + 1} fine`).toBe(true);
        expect(coarse).toBeGreaterThanOrEqual(0);
        expect(coarse).toBeLessThanOrEqual(31);
        expect(fine).toBeGreaterThanOrEqual(0);
        expect(fine).toBeLessThanOrEqual(99);
      }
    }
  });

  it('the resolved bytes reproduce the stored ratio EXACTLY — no audible drift', () => {
    for (const v of LEGACY_CORPUS) {
      for (let i = 0; i < 6; i++) {
        const op = v.operators[i]!;
        const { coarse, fine } = resolveOpCoarseFine(op);
        // Exact equality, not toBeCloseTo: the inverse lands on the same
        // float the forward law produced, so an operator migrated from a
        // saved rack plays the same pitch it always did.
        expect(dx7Ratio(coarse, fine), `${v.name} op${i + 1}`).toBe(op.ratio);
      }
    }
  });

  it('THE PITCH ROW RENDERS — the readout matches what the ratio alone would print', () => {
    // This is the assertion at the level the user sees. `dx7FormatFrequency`
    // is what the PITCH row's resolved readout calls; if the migration failed,
    // it would print the fallback ratio for coarse 1 / fine 0 (`×1.00`) rather
    // than the operator's real frequency.
    let distinct = 0;
    const seen = new Set<string>();
    for (const v of LEGACY_CORPUS) {
      for (let i = 0; i < 6; i++) {
        const op = v.operators[i]!;
        const { coarse, fine } = resolveOpCoarseFine(op);
        const shown = dx7FormatFrequency(coarse, fine, op.fixedMode);
        expect(shown, `${v.name} op${i + 1}`).not.toBe('');
        expect(shown).toBe(dx7FormatRatio(op.ratio));
        if (!seen.has(shown)) { seen.add(shown); distinct++; }
      }
    }
    // NEGATIVE CONTROL on this instrument: if the resolver silently returned a
    // constant (say the (1, 0) default) every readout would agree with itself
    // and the assertion above would still be green. The corpus must produce
    // MANY different readouts.
    expect(distinct).toBeGreaterThan(30);
  });

  it('deepUnwrapVoice BACKFILLS the bytes onto the whole voice', () => {
    for (const legacy of LEGACY_CORPUS) {
      const migrated = deepUnwrapVoice(legacy);
      for (let i = 0; i < 6; i++) {
        const before = legacy.operators[i]!;
        const after = migrated.operators[i]!;
        expect(typeof after.coarse).toBe('number');
        expect(typeof after.fine).toBe('number');
        // Strictly ADDITIVE: everything the engine reads is carried across
        // untouched, so migrating a saved rack cannot move a sample of audio.
        expect(after.ratio).toBe(before.ratio);
        expect(after.detuneFactor).toBe(before.detuneFactor);
        expect(after.level).toBe(before.level);
        expect(after.detune).toBe(before.detune);
        expect(after.r).toEqual(before.r);
        expect(after.l).toEqual(before.l);
        expect(after.fixedMode).toBe(before.fixedMode);
        expect(after.fixedHz).toBe(before.fixedHz);
      }
      expect(migrated.algorithm).toBe(legacy.algorithm);
      expect(migrated.feedback).toBe(legacy.feedback);
      expect(migrated.transpose).toBe(legacy.transpose);
    }
  });

  it('THE NEW BYTES ARE INERT TO THE RENDERER — which is why ART did not move', () => {
    // The claim this whole PR rests on: adding coarse/fine cannot change a
    // sample of audio, so the six dx7 ART threshold specs need no re-authoring
    // and there is nothing to re-pin. Prove it structurally instead of
    // arguing it — and prove it with a CORRUPTION, not just a strip, because
    // a renderer that read an ABSENT byte might coincidentally agree while a
    // renderer that read a WRONG one cannot.
    for (const voice of DX7_BUILTIN_BANK) {
      const opts = { midi: 60, durationS: 0.15, sampleRate: 48000, holdGate: true } as const;
      const reference = renderDx7Note(voice, opts);
      const stripped = renderDx7Note(toLegacyShape(voice), opts);
      const corrupted = JSON.parse(JSON.stringify(voice)) as DX7Voice;
      for (const op of corrupted.operators) { op.coarse = 31; op.fine = 99; }
      const wrong = renderDx7Note(corrupted, opts);

      expect(reference.length).toBeGreaterThan(0);
      for (let i = 0; i < reference.length; i++) {
        expect(stripped[i], `${voice.name} stripped @${i}`).toBe(reference[i]);
        expect(wrong[i], `${voice.name} corrupted @${i}`).toBe(reference[i]);
      }
      // Negative control on the instrument: a renderer that ignored EVERYTHING
      // would pass the two assertions above trivially, so confirm the probe
      // can actually see a difference by moving the field the engine DOES read.
      const retuned = JSON.parse(JSON.stringify(voice)) as DX7Voice;
      retuned.operators[0]!.ratio *= 1.5;
      const moved = renderDx7Note(retuned, opts);
      expect(moved.some((s, i) => s !== reference[i]), `${voice.name} probe is blind`).toBe(true);
    }
    // ⚠ If a future PR makes the renderer derive its pitch FROM coarse/fine,
    // this test goes red — and that is correct, not a nuisance: at that moment
    // every legacy voice's audio starts depending on the ratio inverse, and
    // the ART baselines genuinely do need re-auditing.
  });

  it('a voice that ALREADY has the bytes keeps them verbatim — the inverse never overrides', () => {
    // The aliased pairs are the test: (2, 50) is ×3.00, and so is (3, 0). A
    // resolver that ran the inverse unconditionally would silently rewrite the
    // stored COARSE 2 / FINE 50 to COARSE 3 / FINE 0 and the pitch row would
    // change under a user who touched nothing.
    expect(resolveOpCoarseFine({ coarse: 2, fine: 50, ratio: 3 })).toEqual({ coarse: 2, fine: 50 });
    expect(ratioToCoarseFine(3)).toEqual({ coarse: 3, fine: 0 });
    for (const v of DX7_BUILTIN_BANK) {
      for (const op of v.operators) {
        expect(resolveOpCoarseFine(op)).toEqual({ coarse: op.coarse, fine: op.fine });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The inverse
// ---------------------------------------------------------------------------

describe('ratioToCoarseFine — the defined inverse', () => {
  it('reproduces the ratio with ZERO error for all 3200 reachable pairs', () => {
    let worst = 0;
    let worstAt = '';
    for (let c = 0; c <= 31; c++) {
      for (let f = 0; f <= 99; f++) {
        const r = dx7Ratio(c, f);
        const back = ratioToCoarseFine(r);
        const err = Math.abs(dx7Ratio(back.coarse, back.fine) - r);
        if (err > worst) { worst = err; worstAt = `coarse ${c} fine ${f}`; }
      }
    }
    expect(worst, `worst at ${worstAt}`).toBe(0);
  });

  it('is EXACT IN RATIO but not in BYTES — 588 of the 3200 pairs are aliases', () => {
    // Naming the number keeps the two claims apart. A byte round trip is
    // genuinely impossible once only the ratio was stored, which is the whole
    // argument for storing coarse/fine from here on; if this count MOVES, the
    // forward ratio law changed and the inverse needs re-deriving.
    let aliased = 0;
    for (let c = 0; c <= 31; c++) {
      for (let f = 0; f <= 99; f++) {
        const back = ratioToCoarseFine(dx7Ratio(c, f));
        if (back.coarse !== c || back.fine !== f) aliased++;
      }
    }
    expect(aliased).toBe(588);
  });

  it('tie-breaks on the LARGER base — ×3.00 reads back as COARSE 3 / FINE 0', () => {
    expect(ratioToCoarseFine(3)).toEqual({ coarse: 3, fine: 0 });
    expect(ratioToCoarseFine(1)).toEqual({ coarse: 1, fine: 0 });
    expect(ratioToCoarseFine(2)).toEqual({ coarse: 2, fine: 0 });
  });

  it('SEARCHES every base instead of taking floor(ratio) — ×3.10 is exact only on base 2', () => {
    const got = ratioToCoarseFine(3.1);
    expect(got).toEqual({ coarse: 2, fine: 55 });
    expect(dx7Ratio(got.coarse, got.fine)).toBeCloseTo(3.1, 12);
    // The wrong answer, named: floor() would have picked base 3, whose fine
    // steps are 0.03, landing on 3.09 — a ~6-cent detune on every round trip.
    expect(dx7Ratio(3, Math.round((3.1 / 3 - 1) * 100))).toBeCloseTo(3.09, 12);
  });

  it('keeps the 0.5 slot', () => {
    expect(ratioToCoarseFine(0.5)).toEqual({ coarse: 0, fine: 0 });
    expect(ratioToCoarseFine(0.75)).toEqual({ coarse: 0, fine: 50 });
  });

  it('falls back to ×1.00 on garbage rather than producing NaN', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const got = ratioToCoarseFine(bad);
      expect(Number.isInteger(got.coarse)).toBe(true);
      expect(Number.isInteger(got.fine)).toBe(true);
      expect(dx7Ratio(got.coarse, got.fine)).toBe(1);
    }
  });
});

describe('FIXED mode — the trap the ratio inverse must never spring', () => {
  it('recovers the exact Hz for every fixed-mode pair from a legacy op', () => {
    for (let c = 0; c <= 31; c++) {
      for (let f = 0; f <= 99; f++) {
        const hz = dx7FixedHz(c, f);
        const back = fixedHzToCoarseFine(hz, dx7Ratio(c, f));
        expect(dx7FixedHz(back.coarse, back.fine), `coarse ${c} fine ${f}`).toBeCloseTo(hz, 9);
      }
    }
  });

  it('resolveOpCoarseFine routes a fixed-mode operator AWAY from the ratio inverse', () => {
    // The documented catastrophe: coarse 4 / fine 13 is ratio 4.52 and
    // 10^(0.13) = 1.35 Hz. Inverting the RATIO gives base 4 → (4, 13) here,
    // but the general failure is a pair whose ratio base and fixed decade
    // disagree, so use one: coarse 7 / fine 50 → ratio 10.5, fixed 10^3.5.
    const coarse = 7;
    const fine = 50;
    const op = {
      ratio: dx7Ratio(coarse, fine),
      fixedMode: true,
      fixedHz: dx7FixedHz(coarse, fine),
    };
    const got = resolveOpCoarseFine(op);
    expect(dx7FixedHz(got.coarse, got.fine)).toBeCloseTo(op.fixedHz, 9);

    // What the RATIO path would have produced, and how far wrong it is.
    const viaRatio = ratioToCoarseFine(op.ratio);
    const wrongHz = dx7FixedHz(viaRatio.coarse, viaRatio.fine);
    expect(Math.abs(Math.log10(wrongHz / op.fixedHz))).toBeGreaterThan(0.5);
    expect(dx7FixedHz(got.coarse, got.fine)).not.toBeCloseTo(wrongHz, 3);
  });

  it('a fixed-mode op with NO stored fixedHz still resolves rather than coming up empty', () => {
    const got = resolveOpCoarseFine({ ratio: 4.5, fixedMode: true });
    expect(Number.isInteger(got.coarse)).toBe(true);
    expect(Number.isInteger(got.fine)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deepUnwrapVoice
// ---------------------------------------------------------------------------

describe('deepUnwrapVoice — survives a real Yjs proxy', () => {
  /** Put a voice through a REAL syncedStore + Y.Doc, the way a SYX-loaded
   *  cartridge lives in `node.data.userPatches`, and hand back the proxy. */
  function throughYDoc(voice: DX7Voice): unknown {
    const { patch } = createPatch();
    const id = 'dx7-voice-edit-test';
    patch.nodes[id] = {
      id, type: 'dx7', domain: 'audio',
      position: { x: 0, y: 0 }, params: {}, data: {},
    } as never;
    const data = (patch.nodes[id] as never as Record<string, Record<string, unknown>>).data;
    data.userPatches = [JSON.parse(JSON.stringify(voice))];
    return (data.userPatches as never as unknown[])[0];
  }

  it('the proxy really is structuredClone-hostile (the instrument negative control)', () => {
    // The SHIPPED bug this function exists for (modules/dx7.ts:261-273). If a
    // future syncedStore handed back plain objects, every assertion below would
    // pass while testing nothing, so prove the hazard is present FIRST.
    const proxy = throughYDoc(DX7_BUILTIN_BANK[0]!) as Record<string, unknown>;
    expect(() => structuredClone(proxy)).toThrow();
    const op0 = (proxy.operators as unknown[])[0] as Record<string, unknown>;
    expect(() => structuredClone(op0.r)).toThrow();
    // …and it is hostile even though it LOOKS like a plain array, which is
    // exactly why the reader walks it by index instead of spreading it.
    expect(Array.isArray(op0.r)).toBe(true);
  });

  it('unwraps a proxied voice to plain JS that structuredClone accepts', () => {
    for (const original of DX7_BUILTIN_BANK) {
      const unwrapped = deepUnwrapVoice(throughYDoc(original));
      expect(() => structuredClone(unwrapped)).not.toThrow();
      expect(unwrapped).toEqual(original);
      expect(Array.isArray(unwrapped.operators[0]!.r)).toBe(true);
      expect(unwrapped.operators[0]!.r).toHaveLength(4);
    }
  });

  it('unwraps a proxied LEGACY voice — the migration path through the store', () => {
    const legacy = LEGACY_CORPUS[0]!;
    const unwrapped = deepUnwrapVoice(throughYDoc(legacy));
    expect(() => structuredClone(unwrapped)).not.toThrow();
    for (let i = 0; i < 6; i++) {
      expect(typeof unwrapped.operators[i]!.coarse).toBe('number');
      expect(dx7Ratio(unwrapped.operators[i]!.coarse!, unwrapped.operators[i]!.fine!)).toBe(
        legacy.operators[i]!.ratio,
      );
    }
  });

  it('is NOT the sendPatch payload — it carries the WHOLE voice', () => {
    // "Two functions, not one." `sendPatch`'s unwrap builds the worklet's
    // PatchMessage operator payload: no pitchEg, no lfo, no name/algorithm/
    // feedback/transpose wrapper. Collapsing them loses half the voice on
    // every stamp, so pin the fields that distinguish them.
    const v = deepUnwrapVoice(throughYDoc(DX7_BUILTIN_BANK[2]!));
    expect(v.pitchEg.r).toHaveLength(4);
    expect(v.pitchEg.l).toHaveLength(4);
    expect(v.lfo).toEqual(DX7_BUILTIN_BANK[2]!.lfo);
    expect(v.name).toBe(DX7_BUILTIN_BANK[2]!.name);
    expect(v.algorithm).toBe(DX7_BUILTIN_BANK[2]!.algorithm);
    expect(v.feedback).toBe(DX7_BUILTIN_BANK[2]!.feedback);
    expect(v.transpose).toBe(DX7_BUILTIN_BANK[2]!.transpose);
  });

  it('returns a COMPLETE voice for undefined / garbage input', () => {
    for (const bad of [undefined, null, {}, 42, 'nope', [], { operators: 'no' }]) {
      const v = deepUnwrapVoice(bad);
      expect(v.operators).toHaveLength(6);
      for (const op of v.operators) {
        expect(op.r).toHaveLength(4);
        expect(op.l).toHaveLength(4);
        expect(Number.isFinite(op.ratio)).toBe(true);
        expect(Number.isInteger(op.coarse!)).toBe(true);
      }
      expect(v.algorithm).toBeGreaterThanOrEqual(1);
      expect(v.algorithm).toBeLessThanOrEqual(32);
      // 24, never 0 — the transpose byte is BIASED, and defaulting it to 0
      // would drop every unresolvable voice two octaves.
      expect(v.transpose).toBe(24);
    }
  });

  it('never mutates its input', () => {
    const legacy = toLegacyShape(DX7_BUILTIN_BANK[0]!);
    const before = JSON.stringify(legacy);
    deepUnwrapVoice(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// setOpField
// ---------------------------------------------------------------------------

describe('setOpField — derived values are recomputed, and only the right ones', () => {
  const base = DX7_BUILTIN_BANK[0]!;

  it('a COARSE edit rewrites ratio AND fixedHz', () => {
    const v = setOpField(base, 1, 'coarse', 9);
    const op = v.operators[1]!;
    expect(op.coarse).toBe(9);
    expect(op.ratio).toBe(dx7Ratio(9, op.fine!));
    expect(op.fixedHz).toBe(dx7FixedHz(9, op.fine!));
    // The other operators are untouched.
    expect(v.operators[0]).toEqual(base.operators[0]);
  });

  it('a FINE edit rewrites ratio AND fixedHz', () => {
    const v = setOpField(base, 0, 'fine', 47);
    const op = v.operators[0]!;
    expect(op.fine).toBe(47);
    expect(op.ratio).toBe(dx7Ratio(op.coarse!, 47));
    expect(op.fixedHz).toBe(dx7FixedHz(op.coarse!, 47));
  });

  it('a DETUNE edit rewrites detuneFactor', () => {
    const v = setOpField(base, 3, 'detune', 12);
    expect(v.operators[3]!.detune).toBe(12);
    expect(v.operators[3]!.detuneFactor).toBe(dx7DetuneFactor(12));
  });

  it('an ENVELOPE edit on a LEGACY voice backfills the bytes but never retunes', () => {
    // The guard that stops "editing R1 retuned the operator": a legacy voice
    // gains coarse/fine, but `ratio` — the thing the engine plays — is left
    // exactly as stored.
    const legacy = LEGACY_CORPUS[12]!;
    for (let i = 0; i < 6; i++) {
      const v = setOpField(legacy, i, 'r0', 42);
      expect(v.operators[i]!.r[0]).toBe(42);
      expect(v.operators[i]!.ratio).toBe(legacy.operators[i]!.ratio);
      expect(v.operators[i]!.fixedHz).toBe(legacy.operators[i]!.fixedHz);
      expect(typeof v.operators[i]!.coarse).toBe('number');
    }
  });

  it('writes every r/l slot to the right index', () => {
    for (const slot of [0, 1, 2, 3] as const) {
      const rv = setOpField(base, 2, `r${slot}` as 'r0', 11);
      expect(rv.operators[2]!.r[slot]).toBe(11);
      const lv = setOpField(base, 2, `l${slot}` as 'l0', 13);
      expect(lv.operators[2]!.l[slot]).toBe(13);
      // Nothing else in the quad moved.
      expect(rv.operators[2]!.l).toEqual(base.operators[2]!.l);
    }
  });

  it('clamps to each field\'s real domain', () => {
    expect(setOpField(base, 0, 'coarse', 999).operators[0]!.coarse).toBe(31);
    expect(setOpField(base, 0, 'coarse', -5).operators[0]!.coarse).toBe(0);
    expect(setOpField(base, 0, 'fine', 1e6).operators[0]!.fine).toBe(99);
    expect(setOpField(base, 0, 'detune', 99).operators[0]!.detune).toBe(14);
    expect(setOpField(base, 0, 'level', -1).operators[0]!.level).toBe(0);
    expect(setOpField(base, 0, 'velocitySens', 50).operators[0]!.velocitySens).toBe(7);
    expect(setOpField(base, 0, 'r0', 500).operators[0]!.r[0]).toBe(99);
  });

  it('toggles fixedMode without touching the pitch bytes', () => {
    const on = setOpField(base, 4, 'fixedMode', true);
    expect(on.operators[4]!.fixedMode).toBe(true);
    expect(on.operators[4]!.coarse).toBe(base.operators[4]!.coarse);
    expect(on.operators[4]!.ratio).toBe(base.operators[4]!.ratio);
    expect(setOpField(on, 4, 'fixedMode', false).operators[4]!.fixedMode).toBe(false);
  });

  it('an out-of-range operator index or unknown field is a no-op, never a throw', () => {
    const ref = deepUnwrapVoice(base);
    for (const bad of [-1, 6, 1.5, NaN]) {
      expect(setOpField(base, bad, 'level', 10)).toEqual(ref);
    }
    expect(setOpField(base, 0, 'nope' as 'level', 10)).toEqual(ref);
    // `r9` is outside the 4-tuple: the quad must not GROW.
    const grown = setOpField(base, 0, 'r9' as 'r0', 10);
    expect(grown.operators[0]!.r).toHaveLength(4);
    expect(grown).toEqual(ref);
  });

  it('never mutates its input, and works straight off a Yjs proxy', () => {
    const before = JSON.stringify(base);
    setOpField(base, 0, 'level', 3);
    expect(JSON.stringify(base)).toBe(before);

    const { patch } = createPatch();
    patch.nodes['n'] = {
      id: 'n', type: 'dx7', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {},
    } as never;
    const data = (patch.nodes['n'] as never as Record<string, Record<string, unknown>>).data;
    data.userPatches = [JSON.parse(JSON.stringify(base))];
    const proxy = (data.userPatches as never as unknown[])[0];
    const edited = setOpField(proxy, 0, 'coarse', 5);
    expect(() => structuredClone(edited)).not.toThrow();
    expect(edited.operators[0]!.coarse).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// copyEg
// ---------------------------------------------------------------------------

describe('copyEg', () => {
  const base = DX7_BUILTIN_BANK[0]!;

  it('copies the four rates and four levels', () => {
    const v = copyEg(base, 1, 4);
    expect(v.operators[4]!.r).toEqual(base.operators[1]!.r);
    expect(v.operators[4]!.l).toEqual(base.operators[1]!.l);
    // …by VALUE — the two quads must not be the same array, or a later edit to
    // one operator's envelope would move the other's.
    expect(v.operators[4]!.r).not.toBe(v.operators[1]!.r);
  });

  it('does NOT copy the OUTPUT LEVEL — the shape moves, the mix balance stays', () => {
    // op4 (level 60) -> op1 (level 99): the two levels must DIFFER or the
    // assertion is vacuous, so assert that about the fixture first.
    expect(base.operators[3]!.level).not.toBe(base.operators[0]!.level);
    const v = copyEg(base, 3, 0);
    expect(v.operators[0]!.level).toBe(base.operators[0]!.level);
    expect(v.operators[0]!.level).not.toBe(base.operators[3]!.level);
    // Nor the pitch.
    expect(v.operators[0]!.ratio).toBe(base.operators[0]!.ratio);
    expect(v.operators[0]!.detune).toBe(base.operators[0]!.detune);
  });

  it('same-index and out-of-range copies are no-ops', () => {
    const ref = deepUnwrapVoice(base);
    expect(copyEg(base, 2, 2)).toEqual(ref);
    for (const bad of [-1, 6, 1.5, NaN]) {
      expect(copyEg(base, bad, 0)).toEqual(ref);
      expect(copyEg(base, 0, bad)).toEqual(ref);
    }
  });

  it('never mutates its input', () => {
    const before = JSON.stringify(base);
    copyEg(base, 0, 5);
    expect(JSON.stringify(base)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// isDirty
// ---------------------------------------------------------------------------

describe('isDirty — the dirty chip', () => {
  const base = DX7_BUILTIN_BANK[0]!;

  it('a voice is not dirty against itself', () => {
    for (const v of DX7_BUILTIN_BANK) expect(isDirty(v, v)).toBe(false);
  });

  it('A MIGRATED VOICE IS NOT DIRTY against the legacy voice it came from', () => {
    // The one that would light the chip on a rack nobody touched: backfilling
    // coarse/fine is additive, so the canonical form must be blind to it.
    for (const legacy of LEGACY_CORPUS) {
      expect(isDirty(deepUnwrapVoice(legacy), legacy), legacy.name).toBe(false);
      expect(isDirty(legacy, deepUnwrapVoice(legacy)), legacy.name).toBe(false);
    }
    // …and the built-ins, which now ship WITH the bytes, still match their own
    // legacy-stripped copies.
    for (const v of DX7_BUILTIN_BANK) expect(isDirty(v, toLegacyShape(v)), v.name).toBe(false);
  });

  it('compares the SOUND, not the label — a rename is not an edit', () => {
    const renamed = deepUnwrapVoice(base);
    renamed.name = 'MY PATCH';
    expect(isDirty(renamed, base)).toBe(false);
  });

  it('a real edit to ANY canonical field flips it (the instrument negative control)', () => {
    // A `canonicalVoice` that dropped a field would return false forever on
    // that field and this suite would still be green without this sweep.
    const perturbations: Array<[string, (v: DX7Voice) => void]> = [
      ['algorithm', (v) => { v.algorithm = v.algorithm === 5 ? 6 : 5; }],
      ['feedback', (v) => { v.feedback = (v.feedback + 1) % 8; }],
      ['transpose', (v) => { v.transpose = v.transpose + 1; }],
      // Pitch goes through setOpField, which is how the panel edits it — a
      // bare `op.coarse = 7` leaves `ratio` stale and is not a real edit.
      ['op coarse', (v) => { v.operators[0]! = setOpField(v, 0, 'coarse', 7).operators[0]!; }],
      ['op fine', (v) => { v.operators[0]! = setOpField(v, 0, 'fine', 33).operators[0]!; }],
      ['op level', (v) => { v.operators[2]!.level = 12; }],
      ['op detune', (v) => { v.operators[3]!.detune = 2; }],
      ['op velocitySens', (v) => { v.operators[4]!.velocitySens = 3; }],
      ['op fixedMode', (v) => { v.operators[5]!.fixedMode = !v.operators[5]!.fixedMode; }],
      ['op rate', (v) => { v.operators[1]!.r[2] = 7; }],
      ['op level byte', (v) => { v.operators[1]!.l[3] = 44; }],
      ['pitchEg rate', (v) => { v.pitchEg.r[0] = 1; }],
      ['pitchEg level', (v) => { v.pitchEg.l[3] = 1; }],
      ['lfo speed', (v) => { v.lfo.speed = 1; }],
      ['lfo delay', (v) => { v.lfo.delay = 1; }],
      ['lfo pmd', (v) => { v.lfo.pmd = 9; }],
      ['lfo amd', (v) => { v.lfo.amd = 9; }],
      ['lfo sync', (v) => { v.lfo.sync = !v.lfo.sync; }],
      ['lfo waveform', (v) => { v.lfo.waveform = (v.lfo.waveform + 1) % 6; }],
      ['lfo pitchModSens', (v) => { v.lfo.pitchModSens = 4; }],
    ];
    for (const [label, mutate] of perturbations) {
      const edited = deepUnwrapVoice(base);
      mutate(edited);
      expect(isDirty(edited, base), `${label} did not move the dirty chip`).toBe(true);
    }
  });

  it('an edit made THROUGH setOpField is dirty', () => {
    expect(isDirty(setOpField(base, 0, 'level', 40), base)).toBe(true);
    expect(isDirty(copyEg(base, 0, 5), base)).toBe(true);
  });

  it('an ALIASED byte move is NOT dirty — the documented trade', () => {
    // (2, 50) and (3, 0) are both ×3.00. Nothing audible changed, so the chip
    // stays clean. That is the deliberate cost of keying pitch on the engine's
    // frequency, and the alternative — keying on bytes — puts a FALSE chip on
    // every migrated rack holding an aliased ratio (the test above). Pin both
    // halves so a future "fix" has to confront the trade rather than trip it.
    const b = setOpField(setOpField(base, 0, 'coarse', 2), 0, 'fine', 50);
    const d = setOpField(setOpField(base, 0, 'coarse', 3), 0, 'fine', 0);
    expect(b.operators[0]!.coarse).not.toBe(d.operators[0]!.coarse);
    expect(b.operators[0]!.ratio).toBe(d.operators[0]!.ratio);
    expect(isDirty(b, d)).toBe(false);
    // …but a pitch move that CHANGES the frequency is dirty, which is what
    // stops this from being "isDirty ignores pitch".
    expect(isDirty(setOpField(base, 0, 'coarse', 4), base)).toBe(true);
    expect(isDirty(setOpField(base, 0, 'fine', 33), base)).toBe(true);
  });

  it('the built-in TUB BELLS really does hold an aliased pair (the regression\'s origin)', () => {
    // The concrete voice that exposed this: op5 is authored COARSE 5 / FINE 40
    // and the ratio inverse canonicalises it to COARSE 7 / FINE 0 — the same
    // ×7.00. If a future re-voicing removed the alias, the migration test
    // above would silently lose its only real-world aliased case.
    const tub = DX7_BUILTIN_BANK.find((v) => v.name === 'TUB BELLS')!;
    const op5 = tub.operators[4]!;
    expect({ coarse: op5.coarse, fine: op5.fine }).toEqual({ coarse: 5, fine: 40 });
    expect(ratioToCoarseFine(op5.ratio)).toEqual({ coarse: 7, fine: 0 });
    expect(dx7Ratio(7, 0)).toBe(op5.ratio);
  });

  it('a missing voice or preset reads as NOT dirty', () => {
    expect(isDirty(null, base)).toBe(false);
    expect(isDirty(base, null)).toBe(false);
    expect(isDirty(undefined, undefined)).toBe(false);
  });

  it('works across the Yjs boundary — a stored voice is not dirty against its source', () => {
    const { patch } = createPatch();
    patch.nodes['n'] = {
      id: 'n', type: 'dx7', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {},
    } as never;
    const data = (patch.nodes['n'] as never as Record<string, Record<string, unknown>>).data;
    data.userPatches = [JSON.parse(JSON.stringify(base))];
    const proxy = (data.userPatches as never as unknown[])[0];
    expect(isDirty(proxy, base)).toBe(false);
    expect(isDirty(setOpField(proxy, 0, 'level', 1), base)).toBe(true);
  });
});
