// packages/web/src/lib/ui/modules/attenumix-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for ATTENUMIX's three derived readouts, plus
// the one measurement its `face.order` is ranked on.
//
// A derived readout earns its slot only if it is negative-controlled on the
// input a KNOB READBACK IS BLIND TO — permanently, on every run, not once at
// authoring time (`face-readout-values.ts`, and the kick-drum TAIL case that
// put the rule there). Each readout below therefore ships with the exact knob
// it beats, asserted as an INVARIANCE on that knob's own value and a MOVEMENT
// on the readout, in the same leg. A readout that quietly became a relabelled
// knob would fail here rather than merely look plausible on the faceplate.
//
//   peak    beats MASTER. At the shipped defaults MASTER reads a confident
//           `1.00` — unity — and the mix bus is EXACTLY SILENT. It also does
//           not move when a channel opens.
//   drive   beats MASTER again, on a different axis: MASTER is INVARIANT to
//           the channel count, which is half of what decides the drive.
//   cv room beats every attenuator readback (each is blind to the other three)
//           AND is INVARIANT TO MASTER — the leg that makes it the orthogonal
//           third rather than a third view of `peak`.
//
// And the RANKING measurement: `master` is ranked LAST on this module, against
// the `mixer` precedent that ranks it FIRST, because at the shipped defaults it
// is bit-exactly inert. That claim is asserted here through the module's own
// math, so a future default change (an attenuator that no longer starts at 0)
// turns the ranking argument RED instead of leaving a stale comment behind.

import { describe, expect, it } from 'vitest';
import { attenumixDef, attenumixMath } from '$lib/audio/modules/attenumix';
import {
  ATTENUMIX_ATT_PARAM_IDS,
  ATTENUMIX_MASTER_PARAM_ID,
  attenumixCvRoom,
  attenumixCvRoomText,
  attenumixDrive,
  attenumixDriveText,
  attenumixFaceParams,
  attenumixPeak,
  attenumixPeakDb,
  attenumixPeakText,
  attenumixSquashDb,
  attenumixSumAtt,
} from './attenumix-face-model';

/** A param reader over an explicit override map — the shape
 *  `FaceReadoutValue` is handed, including `undefined` for untouched params. */
function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined => over[id];
}

/** Every param at its declared default — a freshly spawned node. */
const SPAWN = attenumixFaceParams(reader());

function allAtt(v: number, master = 1): ReturnType<typeof attenumixFaceParams> {
  const over: Record<string, number> = { [ATTENUMIX_MASTER_PARAM_ID]: master };
  for (const id of ATTENUMIX_ATT_PARAM_IDS) over[id] = v;
  return attenumixFaceParams(reader(over));
}

/** Open the first `n` channels to unity, leave the rest at 0. */
function openN(n: number, master = 1): ReturnType<typeof attenumixFaceParams> {
  const over: Record<string, number> = { [ATTENUMIX_MASTER_PARAM_ID]: master };
  ATTENUMIX_ATT_PARAM_IDS.forEach((id, i) => (over[id] = i < n ? 1 : 0));
  return attenumixFaceParams(reader(over));
}

describe('attenumix face model: the params the readouts read', () => {
  it('derives the attenuator roster from the DEF, in declaration order', () => {
    // Never a hand-typed channel count: the roster IS the def's `att\d+` params.
    expect(ATTENUMIX_ATT_PARAM_IDS).toEqual(
      attenumixDef.params.filter((p) => /^att\d+$/.test(p.id)).map((p) => p.id),
    );
    expect(ATTENUMIX_ATT_PARAM_IDS.length).toBe(SPAWN.att.length);
    expect(attenumixDef.params.some((p) => p.id === ATTENUMIX_MASTER_PARAM_ID)).toBe(true);
  });

  it('an UNTOUCHED param reads its DEF DEFAULT, not zero', () => {
    // `node.params` is a sparse overlay of what has been touched. Reading it
    // bare would print an unmuted mix on a module that is muted.
    for (const [i, id] of ATTENUMIX_ATT_PARAM_IDS.entries()) {
      expect(SPAWN.att[i], `${id} must fall back to its def default`).toBe(
        attenumixDef.params.find((p) => p.id === id)!.defaultValue,
      );
    }
    expect(SPAWN.master).toBe(
      attenumixDef.params.find((p) => p.id === ATTENUMIX_MASTER_PARAM_ID)!.defaultValue,
    );
  });
});

describe('attenumix PEAK: the readout MASTER cannot give you', () => {
  it('THE HEADLINE — a freshly spawned attenumix is EXACTLY silent while MASTER says unity', () => {
    // units: linear sample amplitude, then dBFS.
    expect(attenumixSumAtt(SPAWN), 'units: linear sum of the attenuators').toBe(0);
    expect(attenumixPeak(SPAWN), 'units: linear sample amplitude').toBe(0);
    expect(attenumixPeakDb(SPAWN)).toBe(Number.NEGATIVE_INFINITY);
    expect(attenumixPeakText(SPAWN)).toBe('muted');
    // …and the knob a player would look at instead reads unity.
    expect(SPAWN.master, 'the MASTER knob readback on a silent module').toBe(1);
  });

  it('NEGATIVE CONTROL — MASTER is bit-exactly BLIND to it at the defaults', () => {
    // Sweep the whole master range on an untouched module: the readout the
    // faceplate prints must not move, because the module is a wire either way.
    const seen = new Set<string>();
    for (const m of [0, 0.25, 0.5, 1, 1.5, 2]) {
      const p = attenumixFaceParams(reader({ [ATTENUMIX_MASTER_PARAM_ID]: m }));
      expect(attenumixPeak(p), `units: linear amplitude, at master ${m}`).toBe(0);
      seen.add(attenumixPeakText(p));
    }
    expect(
      [...seen],
      'MASTER cannot change the peak of a mix bus fed exactly zero — a `peak` ' +
        'that moved here would be reading the knob, not the bus',
    ).toEqual(['muted']);
  });

  it('POSITIVE CONTROL — it MOVES when a channel opens, with MASTER untouched', () => {
    const before = attenumixPeakText(SPAWN);
    const after = attenumixPeakText(openN(1));
    expect(after).not.toBe(before);
    expect(attenumixPeak(openN(1)), 'units: linear amplitude, tanh(1 * 1)').toBeCloseTo(
      Math.tanh(1), 12,
    );
    // …and keeps moving, monotonically, as more channels open at a FIXED master.
    let prev = -Infinity;
    for (let n = 0; n <= ATTENUMIX_ATT_PARAM_IDS.length; n++) {
      const v = attenumixPeak(openN(n));
      expect(v, `units: linear amplitude, ${n} channels open at master 1`).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('is computed through the MODULE OWN soft-clip, not a re-typed tanh', () => {
    // If `attenumixMath.mixSample` changes law, this readout must change with
    // it rather than keep insisting on the old one.
    for (const n of [1, 2, 3, 4]) {
      for (const m of [0.5, 1, 2]) {
        const p = openN(n, m);
        expect(attenumixPeak(p)).toBe(attenumixMath.mixSample(attenumixSumAtt(p), m));
      }
    }
  });
});

describe('attenumix DRIVE: MASTER is invariant to the channel count', () => {
  it('NEGATIVE CONTROL — one knob, one reading, four different drives', () => {
    // MASTER reads `1.00` in every row below. The drive spans 4x and the tanh's
    // charge spans ~12 dB across the same rows: that whole spread is what the
    // knob readback cannot see.
    const rows = [1, 2, 3, 4].map((n) => {
      const p = openN(n, 1);
      return { n, master: p.master, drive: attenumixDrive(p), squashDb: attenumixSquashDb(p) };
    });
    expect(
      new Set(rows.map((r) => r.master)).size,
      'the MASTER readback is one value across all four rows — that is the blindness',
    ).toBe(1);
    expect(rows.map((r) => r.drive), 'units: x (a pre-tanh multiplier)').toEqual([1, 2, 3, 4]);
    // units: dB. tanh(1)/1 = 0.7615942 -> -2.36553; tanh(4)/4 = 0.2499329 -> -12.04703.
    expect(rows[0]!.squashDb, 'units: dB of gain reduction at drive 1.00x').toBeCloseTo(-2.36553, 4);
    expect(rows[3]!.squashDb, 'units: dB of gain reduction at drive 4.00x').toBeCloseTo(-12.04703, 4);
    const spread = rows[0]!.squashDb - rows[3]!.squashDb;
    expect(spread, 'units: dB spread hidden behind one `1.00` on the MASTER dial')
      .toBeGreaterThan(9);
  });

  it('THE PAIRING — peak is tanh(drive), so one moving without the other is a broken model', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      for (const m of [0, 0.5, 1, 2]) {
        const p = openN(n, m);
        expect(attenumixPeak(p)).toBeCloseTo(Math.tanh(attenumixDrive(p)), 12);
      }
    }
  });

  it('the tanh charges NOTHING at zero drive — not `-Infinity dB`', () => {
    // The limit of tanh(D)/D as D -> 0 is 1. Getting this clause wrong prints
    // `-Infinity dB` on every freshly spawned attenumix.
    expect(attenumixSquashDb(SPAWN)).toBe(0);
    expect(attenumixDriveText(SPAWN)).toBe('0.00x · 0.0 dB');
  });
});

describe('attenumix CV ROOM: the orthogonal third', () => {
  it('NEGATIVE CONTROL — MASTER cannot move it AT ALL', () => {
    // This is the leg that makes `cv room` a third readout rather than a third
    // view of `peak`: the master multiplies the bus and the CV law lives
    // entirely inside the per-channel clamp.
    for (const half of [0, 0.5, 1]) {
      const seen = new Set<string>();
      for (const m of [0, 0.5, 1, 1.5, 2]) seen.add(attenumixCvRoomText(allAtt(half, m)));
      expect([...seen].length, `cv room must be invariant to MASTER at att=${half}`).toBe(1);
    }
  });

  it('POSITIVE CONTROL — it moves with EVERY attenuator, and no single knob can print it', () => {
    // 100 % at spawn (all four knobs at 0, so CV owns the whole travel) down to
    // `deaf` at unity — where the cable is patched, the jack lights, the LFO
    // runs, and clamp(1 + cv, 0, 1) never moves.
    expect(attenumixCvRoomText(SPAWN)).toBe('100 %');
    expect(attenumixCvRoomText(allAtt(1))).toBe('deaf');
    expect(attenumixCvRoom(allAtt(0.5))).toBeCloseTo(0.5, 12);

    // Each channel individually: a readback of att1 is blind to att2..att4, so
    // the readout must move on each one SEPARATELY.
    const moved: string[] = [];
    for (const id of ATTENUMIX_ATT_PARAM_IDS) {
      const t = attenumixCvRoomText(attenumixFaceParams(reader({ [id]: 1 })));
      if (t !== attenumixCvRoomText(SPAWN)) moved.push(id);
    }
    expect(
      moved,
      'every attenuator must move cv room on its own — otherwise one knob could print it',
    ).toEqual([...ATTENUMIX_ATT_PARAM_IDS]);
  });

  it('the CLAMP is the law it reports — through the module own channelAtt', () => {
    // A knob at unity has zero room BECAUSE clamp(1 + cv) == 1 for any cv >= 0.
    for (const cv of [0, 0.25, 1, 4]) {
      expect(attenumixMath.channelAtt(1, cv), 'units: linear attenuator value').toBe(1);
    }
    expect(attenumixCvRoom(allAtt(1))).toBe(0);
  });
});

describe('attenumix face.order: MASTER is ranked LAST because it is INERT AT SPAWN', () => {
  it('at the shipped defaults the whole MASTER range is bit-exactly silent', () => {
    // The ranking argument, asserted rather than commented. `mixer` ranks its
    // master FIRST and is right to: its channels default to 1.0. This module's
    // default to 0, so the master is the one control that cannot make a sound
    // on a freshly spawned node — the opposite premise, hence the opposite rank.
    const defaults = attenumixDef.params
      .filter((p) => /^att\d+$/.test(p.id))
      .map((p) => p.defaultValue);
    expect(defaults, 'every attenuator ships CLOSED — this is the ranking premise').toEqual(
      defaults.map(() => 0),
    );
    const outs = [0, 0.5, 1, 1.5, 2].map((m) => attenumixMath.mixSample(0, m));
    expect(outs, 'units: linear sample amplitude, the whole MASTER travel').toEqual(
      outs.map(() => 0),
    );

    // POSITIVE CONTROL on the same metric: an attenuator DOES make sound on its
    // own, so the metric is not simply returning zero for everything.
    expect(attenumixMath.mixSample(attenumixMath.channelAtt(1, 0) * 0.5, 1)).toBeCloseTo(
      Math.tanh(0.5), 12,
    );
  });

  it('face.order is the declared attenuators in layout order, then master', () => {
    expect(attenumixDef.face?.order).toEqual([...ATTENUMIX_ATT_PARAM_IDS, ATTENUMIX_MASTER_PARAM_ID]);
  });
});

describe('attenumix readouts are TOTAL — they run on every frame', () => {
  const HOSTILE: (number | undefined)[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    99,
    undefined,
  ];
  const IDS = ['attenumix-peak', 'attenumix-drive', 'attenumix-cv-room'] as const;

  it('an out-of-range value is CLAMPED to the def range, not believed', () => {
    // A corrupt save saying `master: 99` must not print a peak the module
    // cannot reach; the AudioParam would clamp it, so the readout does too.
    const wild = attenumixFaceParams(reader({ att1: 99, [ATTENUMIX_MASTER_PARAM_ID]: 99 }));
    const master = attenumixDef.params.find((p) => p.id === ATTENUMIX_MASTER_PARAM_ID)!;
    const att1 = attenumixDef.params.find((p) => p.id === 'att1')!;
    expect(wild.master).toBe(master.max);
    expect(wild.att[0]).toBe(att1.max);
  });
});
