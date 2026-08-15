// packages/web/src/lib/ui/modules/moog-filterbank-face-model.test.ts
//
// THE PERMANENT CONTROLS for both Moog fixed-filter-bank faceplates.
//
// One file for two modules, like the model itself: every leg below runs over
// BOTH banks from the same table, so the pair cannot drift into two behaviours
// and there is no per-module copy to keep in step.
//
// What this file is responsible for, in the order the audit asked the questions:
//
//   1. DERIVED MEMBERSHIP — the face's population IS the def's, both directions,
//      with no count anywhere.
//   2. THE GLYPH RESOLVES — established, with a negative control, not assumed
//      (#1692: a `meter` that fell through to `{ kind: 'static' }` and painted
//      twelve segments that could never light).
//   3. THE CV AUDIT IS VACUOUS BY CONSTRUCTION — asserted as an ABSENCE, so the
//      claim is checked rather than merely written down, and so it goes red the
//      day someone adds a CV port without running the rig.
//   4. THE READOUTS' NEGATIVE CONTROLS — each on the input a knob readback is
//      structurally blind to, permanently.
//   5. TOTALITY — a readout runs on every render, so a throw takes the faceplate
//      down mid-drag.
//
// The one thing NOT here is whether the model describes the AUDIO. That is a
// claim about a graph, so it is checked against the graph, in
// art/scenarios/moog-filterbank/response-model.test.ts.

import { describe, it, expect } from 'vitest';
import { moog907aDef } from '$lib/audio/modules/moog907a';
import { moog914Def } from '$lib/audio/modules/moog914';
import {
  glyphBinding,
  primaryAudioOutPortId,
} from '$lib/ui/workflow/shell-glyph-live';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import {
  MOOG907A_BANK,
  MOOG914_BANK,
  MOOG_BANK_MODEL_SR,
  type MoogBank,
  moogBankGrid,
  moogBankLevels,
  moogBankNotch,
  moogBankNotchText,
  moogBankOrder,
  moogBankPeak,
  moogBankPeakText,
  moogBankResponseDb,
  moogBankSectionDb,
  moogBankSections,
  moogBankTiltDb,
  moogBankTiltText,
} from './moog-filterbank-face-model';

/** The two banks, with the id prefix their readouts are registered under. */
const BANKS: readonly { name: string; prefix: string; bank: MoogBank }[] = [
  { name: 'moog914', prefix: 'moog914', bank: MOOG914_BANK },
  { name: 'moog907a', prefix: 'moog907a', bank: MOOG907A_BANK },
];

/** A reader over an explicit level map — undefined for anything absent, which
 *  is exactly the sparse `node.params` shape the shell hands a readout. */
const readerFor =
  (levels: Record<string, number>) =>
  (id: string): number | undefined =>
    levels[id];

function defaults(bank: MoogBank): Record<string, number> {
  return moogBankLevels(bank, () => undefined);
}

/** Every level multiplied by `k` — the uniform change `tilt` must not see. */
function scaled(levels: Record<string, number>, k: number): Record<string, number> {
  return Object.fromEntries(Object.entries(levels).map(([id, v]) => [id, v * k]));
}

/** The section closest to `hz`. DERIVED, so no leg below names a band id. */
function nearestSection(bank: MoogBank, hz: number) {
  return moogBankSections(bank).reduce((a, b) =>
    Math.abs(b.hz - hz) < Math.abs(a.hz - hz) ? b : a,
  );
}

/** The highest section BELOW `hz` — deterministic where `nearestSection` ties,
 *  which it always does at a notch (a notch sits at a geometric midpoint, so
 *  both of its neighbours are the same distance away by construction). */
function sectionBelow(bank: MoogBank, hz: number) {
  const below = moogBankSections(bank).filter((s) => s.hz < hz);
  return below.at(-1) ?? moogBankSections(bank)[0]!;
}

describe.each(BANKS)('$name faceplate model', ({ name, prefix, bank }) => {
  // ── 1. DERIVED MEMBERSHIP ────────────────────────────────────────────────
  describe('the population is DERIVED from the shared grid, both directions', () => {
    it('the model\'s sections are exactly the def\'s params', () => {
      expect(new Set(moogBankSections(bank).map((s) => s.id))).toEqual(
        new Set(bank.def.params.map((p) => p.id)),
      );
    });

    it('`face.order` IS the model\'s low→high section order', () => {
      expect([...(bank.def.face?.order ?? [])]).toEqual([...moogBankOrder(bank)]);
    });

    it('…and that order is STRICTLY ASCENDING in frequency — it is the axis', () => {
      const hz = moogBankSections(bank).map((s) => s.hz);
      for (let i = 1; i < hz.length; i++) {
        expect(hz[i], `${name}: section ${i} at ${hz[i]} Hz follows ${hz[i - 1]} Hz`).toBeGreaterThan(
          hz[i - 1]!,
        );
      }
      // The ends are the two shelves, which is what makes the axis unbounded.
      expect(moogBankSections(bank)[0]!.kind).toBe('lowpass');
      expect(moogBankSections(bank).at(-1)!.kind).toBe('highpass');
    });

    it('every section LABEL is the def\'s own — the model never re-types one', () => {
      for (const s of moogBankSections(bank)) {
        expect(s.label).toBe(bank.def.params.find((p) => p.id === s.id)!.label);
      }
    });

    it('the sidebar table has exactly one row per section, and every row RESOLVES', () => {
      const block = bank.def.face?.sidebar?.[0];
      expect(block?.kind).toBe('readouts');
      const entries = block?.kind === 'readouts' ? block.entries : [];
      const sections = moogBankSections(bank);
      expect(entries.map((e) => e.valueId)).toEqual(sections.map((s) => `${prefix}-section-${s.id}`));
      expect(entries.map((e) => e.label)).toEqual(sections.map((s) => s.label));
      for (const e of entries) {
        expect(faceReadoutValueFor(e.valueId!), `${e.valueId} is registered`).toBeTruthy();
      }
    });

    it('every hero readout resolves too', () => {
      for (const r of bank.def.face?.hero?.readouts ?? []) {
        expect(faceReadoutValueFor(r.valueId!), `${r.valueId} is registered`).toBeTruthy();
      }
      // The hero promotes NO control: fourteen interchangeable levels have no
      // member whose promotion is anything but an arbitrary claim.
      expect(bank.def.face?.hero?.control).toBeUndefined();
      expect(bank.def.face?.hero?.cell).toBeUndefined();
    });

    it('every cell is a FADER, because every control is a level', () => {
      const cells = bank.def.face?.paramCells ?? {};
      expect(Object.keys(cells).sort()).toEqual([...moogBankOrder(bank)].sort());
      expect(new Set(Object.values(cells))).toEqual(new Set(['fader']));
      // `fader` is DECLARED-never-inferred and refuses a discrete param, so the
      // whole roster must be continuous. It is — they are all 0..1 linear.
      for (const p of bank.def.params) expect(p.curve).toBe('linear');
    });
  });

  // ── 2. THE GLYPH RESOLVES ────────────────────────────────────────────────
  describe('the `meter` glyph binds to real audio (established, not assumed)', () => {
    it('resolves the single audio output, so the binding is live-audio', () => {
      expect(bank.def.face?.glyph).toBe('meter');
      expect(primaryAudioOutPortId(bank.def)).toBe('audio');
      expect(glyphBinding(bank.def)).toEqual({ kind: 'live-audio', portId: 'audio' });
    });

    it('NEGATIVE CONTROL — the same glyph over CV-only outputs falls through to static', () => {
      // The #1692 shape, reproduced against THIS def with one field changed, so
      // the leg above is known to be reading the output roster and not merely
      // agreeing with a constant.
      expect(
        glyphBinding({
          ...bank.def,
          outputs: bank.def.outputs.map((o) => ({ ...o, type: 'cv' })),
        } as unknown as Parameters<typeof glyphBinding>[0]),
      ).toEqual({ kind: 'static' });
    });
  });

  // ── 3. THE CV AUDIT IS VACUOUS BY CONSTRUCTION ───────────────────────────
  it('has NO CV surface at all — the cv-path rig has nothing to drive here', () => {
    const ports = [...bank.def.inputs, ...bank.def.outputs];
    expect(
      ports.filter((p) => p.type === 'cv').map((p) => p.id),
      `${name}: a cv-typed port appeared. The face was promoted on the finding that the CV ` +
        'audit is VACUOUS here by construction — one plain audio input, one plain audio ' +
        'output, no paramTarget. A new CV port needs the audit rig run against it ' +
        '(art/scenarios/*/cv-path.test.ts), not this assertion relaxed.',
    ).toEqual([]);
    expect(
      ports.filter((p) => (p as { paramTarget?: string }).paramTarget).map((p) => p.id),
      `${name}: a paramTarget port appeared — see the message above.`,
    ).toEqual([]);
    expect(bank.def.inputs.map((p) => p.id)).toEqual(['audio']);
    expect(bank.def.outputs.map((p) => p.id)).toEqual(['audio']);
  });

  // ── 4. THE READOUTS' NEGATIVE CONTROLS ───────────────────────────────────
  describe('the three hero readouts, each controlled on what a knob cannot see', () => {
    it('EQUAL KNOBS ARE NOT EQUAL CONTRIBUTIONS — the finding the table exists for', () => {
      const lv = defaults(bank);
      // Every level identically at its default, and the summed response at the
      // band centres still spans several dB, because a band at the end of the
      // grid has an overlapping neighbour on one side and a band in the middle
      // has them on both. No knob readback contains this.
      const bandDb = moogBankSections(bank)
        .filter((s) => s.kind === 'bandpass')
        .map((s) => moogBankSectionDb(bank, lv, s.id));
      const spread = Math.max(...bandDb) - Math.min(...bandDb);
      expect(
        spread,
        `${name}: with every level identical, the band centres span ${spread.toFixed(2)} dB ` +
          `(${Math.min(...bandDb).toFixed(2)} … ${Math.max(...bandDb).toFixed(2)}). If this ` +
          'collapses to ~0 the sections have stopped overlapping (or stopped summing ' +
          'coherently) and the table is printing the knob back at the player.',
      ).toBeGreaterThan(3);
      // …and every level IS identical, so the spread is the bank's and not the patch's.
      expect(new Set(Object.values(lv)).size).toBe(1);
    });

    it('`tilt` is EXACTLY blind to a uniform level change; `peak` and `notch` see it exactly', () => {
      const lv = defaults(bank);
      const k = 2;
      const up = scaled(lv, k);
      const expectedShift = 20 * Math.log10(k);

      // A uniform scalar multiplies the whole complex sum, so it moves every
      // level by the same dB and cancels out of a DIFFERENCE. That is not an
      // approximation — assert it at machine precision, in BOTH directions.
      expect(moogBankTiltDb(bank, up) - moogBankTiltDb(bank, lv)).toBeCloseTo(0, 10);
      expect(moogBankTiltText(bank, up)).toBe(moogBankTiltText(bank, lv));

      expect(moogBankPeak(bank, up).db - moogBankPeak(bank, lv).db).toBeCloseTo(expectedShift, 9);
      expect(moogBankNotch(bank, up).db - moogBankNotch(bank, lv).db).toBeCloseTo(expectedShift, 9);
      // The extrema do not MOVE in frequency, only in level — so `peak`/`notch`
      // are reporting a gain change and not a different feature.
      expect(moogBankPeak(bank, up).hz).toBe(moogBankPeak(bank, lv).hz);
      expect(moogBankNotch(bank, up).hz).toBe(moogBankNotch(bank, lv).hz);
    });

    it('`notch` is blind to what `peak` reports — driving the band UNDER the peak', () => {
      // Open the band the peak already sits on. The bank gets audibly louder
      // where it was already loudest and its deepest hole is essentially where
      // it was, so a single "output level" readout reports a patch that is
      // spectrally almost unchanged as a big move — and says nothing about the
      // hole it left alone.
      const lv = defaults(bank);
      const p0 = moogBankPeak(bank, lv);
      const atPeak = nearestSection(bank, p0.hz);
      const driven = { ...lv, [atPeak.id]: 1 };

      const dPeak = moogBankPeak(bank, driven).db - p0.db;
      const dNotch = Math.abs(moogBankNotch(bank, driven).db - moogBankNotch(bank, lv).db);
      expect(
        dPeak,
        `${name}: driving ${atPeak.id} (${atPeak.hz} Hz, the section under the peak) to 1`,
      ).toBeGreaterThan(3);
      expect(
        dPeak / Math.max(dNotch, 1e-9),
        `${name}: peak moved ${dPeak.toFixed(2)} dB and notch moved ${dNotch.toFixed(2)} dB`,
      ).toBeGreaterThan(4);
    });

    it('…and `peak` is blind to what `notch` reports — removing the hole\'s own edge', () => {
      // The converse, and the reason `notch` is published at all. Take out the
      // section that forms the LOW edge of the deepest hole: the hole stops
      // being the deepest thing on the module and the notch RELOCATES entirely —
      // 6.5 kHz → 112 Hz on the 914, 209 Hz → 4.3 kHz on the 907A — while the
      // loudest point does not move at all, in level OR in frequency.
      //
      // ⚠ THIS LEG WAS WRITTEN TWICE. The first version muted the MIDDLE band
      // and asserted the notch got deeper; measured, it moved 0.13 dB (914) and
      // −0.09 dB (907A), because the deepest hole on both banks at the defaults
      // is a STRUCTURAL gap at the edge of the grid and a new local hole in the
      // middle does not beat it. The control is kept in the form the measurement
      // supports, which is also the more informative one.
      const lv = defaults(bank);
      const n0 = moogBankNotch(bank, lv);
      const p0 = moogBankPeak(bank, lv);
      const edge = sectionBelow(bank, n0.hz);
      const cut = { ...lv, [edge.id]: 0 };

      const dNotch = Math.abs(moogBankNotch(bank, cut).db - n0.db);
      const dPeak = Math.abs(moogBankPeak(bank, cut).db - p0.db);
      expect(
        dNotch,
        `${name}: cutting ${edge.id} (${edge.hz} Hz, the low edge of the ${n0.hz.toFixed(0)} Hz ` +
          `hole) moved the notch ${dNotch.toFixed(2)} dB`,
      ).toBeGreaterThan(3);
      expect(
        dNotch / Math.max(dPeak, 1e-9),
        `${name}: notch moved ${dNotch.toFixed(2)} dB and peak moved ${dPeak.toFixed(2)} dB`,
      ).toBeGreaterThan(4);
      // The notch is a different FEATURE now, not the same one deeper.
      expect(moogBankNotch(bank, cut).hz).not.toBe(n0.hz);
      // ⚠ AND THE PEAK'S FREQUENCY IS NOT ASSERTED STABLE, because it is not.
      // Measured: on the 907A this cut takes the loudest point from 1400 Hz to
      // 250 Hz while its LEVEL moves 0.85 dB — removing the 175 Hz shelf removes
      // the destructive interference that was holding the 250 Hz band down. A
      // "the peak does not move" leg would have been a nicer sentence and a
      // false one; the claim this readout pair actually makes is about LEVELS,
      // and that is what the ratio above pins.
    });

    it('`tilt` sees a BALANCE change that leaves the overall level alone', () => {
      // The complement of the leg above: tilt is invariant to gain and sensitive
      // to slope, so cutting the bottom of the grid while lifting the top must
      // move it — otherwise it is a constant wearing a label.
      const lv = defaults(bank);
      const bands = moogBankSections(bank).filter((s) => s.kind === 'bandpass');
      const tilted = { ...lv };
      tilted[bands[0]!.id] = lv[bands[0]!.id]! * 0.25;
      tilted[bands.at(-1)!.id] = 1;
      expect(
        Math.abs(moogBankTiltDb(bank, tilted) - moogBankTiltDb(bank, lv)),
        `${name}: tilt moved from ${moogBankTiltDb(bank, lv).toFixed(2)} to ` +
          `${moogBankTiltDb(bank, tilted).toFixed(2)} dB`,
      ).toBeGreaterThan(3);
    });

    it('the registered readout ids print what the model says, through the real reader', () => {
      // Joins the REGISTRY to the MODEL: a readout wired to the wrong bank (the
      // 907A's id resolving the 914's numbers) passes every leg above and fails
      // this one.
      const lv = defaults(bank);
      const read = readerFor(lv);
      expect(faceReadoutValueFor(`${prefix}-peak`)!(read)).toBe(moogBankPeakText(bank, lv));
      expect(faceReadoutValueFor(`${prefix}-notch`)!(read)).toBe(moogBankNotchText(bank, lv));
      expect(faceReadoutValueFor(`${prefix}-tilt`)!(read)).toBe(moogBankTiltText(bank, lv));
    });
  });

  // ── 5. TOTALITY ──────────────────────────────────────────────────────────
  describe('total — a readout runs on every render', () => {
    it('a FRESH node (no params touched) resolves the def defaults, not undefined', () => {
      const fresh = () => undefined;
      const lv = moogBankLevels(bank, fresh);
      for (const p of bank.def.params) expect(lv[p.id]).toBe(p.defaultValue);
      for (const id of [`${prefix}-peak`, `${prefix}-notch`, `${prefix}-tilt`]) {
        expect(faceReadoutValueFor(id)!(fresh)).not.toContain('NaN');
      }
    });

    it('NaN / ±Infinity / negative levels do not throw and do not print NaN', () => {
      for (const poison of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
        const read = (id: string): number | undefined => (id === 'band1' ? poison : 0.5);
        for (const suffix of ['peak', 'notch', 'tilt']) {
          const fn = faceReadoutValueFor(`${prefix}-${suffix}`)!;
          let out = '';
          expect(() => {
            out = fn(read);
          }, `${prefix}-${suffix} with band1=${poison}`).not.toThrow();
          expect(out, `${prefix}-${suffix} with band1=${poison}`).not.toMatch(/NaN|undefined/);
        }
        for (const s of moogBankSections(bank)) {
          const fn = faceReadoutValueFor(`${prefix}-section-${s.id}`)!;
          expect(() => fn(read)).not.toThrow();
        }
      }
    });

    it('every level at 0 prints `silent` rather than a number', () => {
      const read = () => 0;
      expect(faceReadoutValueFor(`${prefix}-peak`)!(read)).toBe('silent');
      expect(faceReadoutValueFor(`${prefix}-notch`)!(read)).toBe('silent');
    });
  });
});

// ── the pair, and the one approximation the model makes ────────────────────

describe('the two banks are ONE face', () => {
  it('same rank law, same glyph, same hero shape, same table shape', () => {
    for (const a of BANKS) {
      for (const b of BANKS) {
        expect(a.bank.def.face?.glyph).toBe(b.bank.def.face?.glyph);
        expect(a.bank.def.face?.hero?.readouts?.map((r) => r.label)).toEqual(
          b.bank.def.face?.hero?.readouts?.map((r) => r.label),
        );
        expect(a.bank.def.face?.pages).toBeUndefined();
        expect(b.bank.def.face?.pages).toBeUndefined();
      }
    }
    // And the rank law itself: BOTH orders are their own section list, low→high.
    expect([...(moog914Def.face!.order)]).toEqual([...moogBankOrder(MOOG914_BANK)]);
    expect([...(moog907aDef.face!.order)]).toEqual([...moogBankOrder(MOOG907A_BANK)]);
  });

  it('the model evaluates at a NOMINAL rate — the 44.1 kHz spread is measured, not shrugged at', () => {
    // `FaceReadoutValue` receives a param reader and nothing else, so the
    // readouts cannot ask the live AudioContext for its sample rate. This pins
    // the size of that approximation instead of leaving it unstated: if a future
    // change makes the response meaningfully rate-dependent, this goes red.
    for (const { name, bank } of BANKS) {
      const lv = defaults(bank);
      let worst = 0;
      for (const f of moogBankGrid(bank)) {
        worst = Math.max(
          worst,
          Math.abs(
            moogBankResponseDb(bank, lv, f, MOOG_BANK_MODEL_SR) -
              moogBankResponseDb(bank, lv, f, 44_100),
          ),
        );
      }
      expect(worst, `${name}: 48k vs 44.1k spread = ${worst.toFixed(3)} dB`).toBeLessThan(1.5);
    }
  });
});
