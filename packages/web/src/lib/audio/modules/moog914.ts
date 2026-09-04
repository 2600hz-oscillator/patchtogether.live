// packages/web/src/lib/audio/modules/moog914.ts
//
// MOOG 914 EXTENDED FIXED FILTER BANK — a slice of the Moog System 55/35
// clone initiative (.myrobots/MOOG/). The 914 is the Moog System 55's full
// FIXED filter bank: a fan of TWELVE fixed-frequency bandpass sections (the
// classic 1/3-octave series), each with its own level knob, plus a fixed
// low-pass and a fixed high-pass section at the band-edges, all summed to one
// output. The band centers DO NOT MOVE — you sculpt a spectrum by setting each
// band's level (a graphic-EQ-like / formant-shaping tool). The 914 is the
// "extended" bank versus the System 35's smaller 907A.
//
// PURE Web Audio — NO AudioWorklet, NO Faust DSP. Identical wiring to the
// 907A (see moog-filterbank-factory.ts): a fan GainNode feeding one HP biquad,
// twelve BP biquads, and one LP biquad, each through its own level GainNode
// into a summing GainNode. 907A and 914 share that factory VERBATIM and differ
// ONLY in which center array they import — 914 uses the full 12-band series.
//
// NO CV: a FIXED filter bank — the band centers are constants from the shared
// moog-filterbank-dsp lib. Categorized under Ports → moogafakkin; category 'filters'.
//
// Inputs:
//   audio (audio): the signal to filter.
//
// Outputs:
//   audio (audio): the summed multi-band-shaped signal.
//
// Params:
//   hp (linear 0..1, default 0.5): level of the fixed HIGH-PASS section.
//   band1..band12 (linear 0..1, default 0.5): level of each fixed BANDPASS
//     section (N = FILTERBANK_914_CENTERS.length = 12).
//   lp (linear 0..1, default 0.5): level of the fixed LOW-PASS section.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  FILTERBANK_914_CENTERS,
  FILTERBANK_914_LP_HZ,
  FILTERBANK_914_HP_HZ,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';
import { buildFilterBank } from './moog-filterbank-factory';
import {
  filterbankHpLabel,
  filterbankHzLabel,
  filterbankLpLabel,
} from './moog-filterbank-labels';
import { createLevelTap } from '$lib/audio/level-meter';

const CENTERS = FILTERBANK_914_CENTERS;

/** Every section id, LOW → HIGH — the low-pass shelf, the bandpasses in grid
 *  order, then the high-pass shelf. DERIVED from the shared centre table, so
 *  `face.order`, `face.paramCells` and the sidebar table below all resolve the
 *  same population the `params` array is built from, and none of them carries a
 *  count. (The faceplate model re-derives the identical list from the def and
 *  asserts the two agree in both directions.) */
const SECTIONS_LOW_TO_HIGH: readonly string[] = [
  'lp',
  ...CENTERS.map((_, i) => bandParamId(i + 1)),
  'hp',
];

export const moog914Def: AudioModuleDef = {
  type: 'moog914',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '914 extended fixed filter bank',
  category: 'filters',

  inputs: [
    // The signal to shape. Plain audio passthrough into the fan node.
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    // The summed multi-band-shaped signal.
    { id: 'audio', type: 'audio' },
  ],
  params: [
    // HP section first, then the bandpass bands low→high, then LP — the same
    // top-to-bottom order the card lays the knobs out in.
    {
      id: 'hp',
      label: filterbankHpLabel(FILTERBANK_914_HP_HZ),
      defaultValue: 0.5,
      min: 0,
      max: 1,
      curve: 'linear',
    },
    ...CENTERS.map((freq, i) => ({
      id: bandParamId(i + 1),
      label: filterbankHzLabel(freq),
      defaultValue: 0.5,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
    {
      id: 'lp',
      label: filterbankLpLabel(FILTERBANK_914_LP_HZ),
      defaultValue: 0.5,
      min: 0,
      max: 1,
      curve: 'linear',
    },
  ],

  // THE FACE. Authored as ONE design with the 907A — same rank law, same three
  // hero readouts, same table — because the two modules ARE one idea over two
  // slices of one grid (see moog-filterbank-face-model.ts).
  //
  // ── THE RANK IS THE FREQUENCY AXIS, AND THAT IS A MEASURED CHOICE ──────────
  //
  // `order` normally means PRIORITY, and here there is none to express: fourteen
  // interchangeable level knobs over fourteen fixed sections. Rather than assume
  // that, it was measured — per-section AUTHORITY, as max |ΔdB| of the summed
  // response over the band grid when one level is driven from its 0.5 default to
  // 1 and to 0:
  //
  //   914   hp 20.4 · lp 15.4 · band12 15.2 · band4 13.4 … band11 9.9   → 2.07x
  //   907A  lp 17.2 · band4 14.6 · band5 13.9 … band8 4.9               → 3.54x
  //
  // Nothing owns the module (2.07x across fourteen sections), AND the two banks
  // do not even agree on which end leads — an authority rank would have given
  // the PAIR two different layouts for one idea, which is the exact failure this
  // entry is paired to avoid. So the rank expresses the ONE order these controls
  // genuinely have: the spectrum, LOW → HIGH. `lp` (100 Hz and everything below)
  // first, the twelve grid bands ascending, `hp` (7.5 kHz and everything above)
  // last.
  //
  // ⚠ IT DISAGREES WITH DECLARATION ORDER, AND WITH THE LEGACY CARD, ON PURPOSE.
  // Both list `hp, band1…band12, lp` — a column whose top cell is 7.5 kHz, whose
  // bottom cell is 100 Hz, and whose middle ascends. That is not an axis; the
  // face makes it one. The tier ladder therefore reads: mini = `LP 100`;
  // compact = `LP 100` + `125` beside the meter; plate = the bottom six; dock =
  // all fourteen, in one unlabelled row, plus the hero and the table.
  //
  // ── NO PAGES ──────────────────────────────────────────────────────────────
  // Every control is the same idea — a level on a fixed section — and the only
  // structure is the axis `order` already carries. A page would buy an ~81 px
  // band for an editorial word (owner ruling 2026-08-11: plain labels and values
  // on the face), and any register split fine enough to be useful would cross
  // DOCK_TAB_MIN_BANDS and turn a graphic EQ into a tab rail.
  face: {
    order: SECTIONS_LOW_TO_HIGH,

    // A live tap on the output. UNLIT on a silent rack, which is correct AND
    // deterministic rather than merely hoped: this is a filter with no generator
    // in it, so with nothing patched into `audio` the summing bus carries no
    // signal at all. `glyphBinding` RESOLVES rather than falls through —
    // `primaryAudioOutPortId` finds the single `audio` output, so the binding is
    // `{ kind: 'live-audio', portId: 'audio' }` and not the `{ kind: 'static' }`
    // twelve-dead-segments shape ninelives was saved from (#1692). Asserted in
    // moog-filterbank-face-model.test.ts, for both modules, with a negative
    // control on a def whose only output is `cv`.
    glyph: 'meter',

    // EVERY cell is a FADER, because every control here is a LEVEL and that is
    // the declared reason the kind exists (ModuleFace.paramCells, owner
    // directive 2026-08-10). A fourteen-throw graphic EQ is what this module is.
    // Width was checked rather than guessed: PARAM_CELL_WIDTH_CLASS.fader is
    // 'column' (a 22 px track — NARROWER than a knob's 40–68.8 px column), so a
    // fourteen-cell band still packs as one row. The comment on that entry is a
    // warning about exactly the inference "it is not a knob, so it is wide".
    paramCells: Object.fromEntries(
      SECTIONS_LOW_TO_HIGH.map((id) => [id, 'fader' as const]),
    ),


  },

  docs: {
    explanation:
      "A recreation of the Moog 914 Extended Fixed Filter Bank — the System 55's full fixed filter bank, the bigger sibling of the 907A and a kind of fixed graphic EQ for spectral and formant shaping. The signal fans into fourteen parallel filter sections whose centre frequencies DO NOT move: a fixed low-pass shelf at the bottom, TWELVE fixed band-pass sections in the classic 1/3-octave series (125 Hz, 175, 250, 350, 500, 700, 1 kHz, 1.4 k, 2 k, 2.8 k, 4 k, 5.6 k), and a fixed high-pass shelf at the top. Each section has its own LEVEL knob and all sum to one output, so you sculpt a sound by boosting and cutting fixed regions — emphasise formants, notch harsh bands, or carve detailed vocal/telephone tones with finer resolution than the 907A. The bands never move and there is no CV: a pure Web Audio biquad + gain graph, identical wiring to the 907A with twelve bands instead of eight. At the default 0.5 every section passes at half level — which is a neutral STARTING POINT, not a flat response, and the faceplate prints the difference. The sections are summed by fan-in, so they add as signals rather than as levels, and they overlap: at the shipped defaults the summed spectrum peaks at -3.9 dB near 1 kHz, falls to -24.8 dB in the gap between the top band and the high-pass corner, and the twelve band centres themselves span 7.1 dB (125 Hz reads -11.0 dB against 1 kHz's -3.9, because a band at the end of the grid has an overlapping neighbour on one side only). The hero's peak / notch / tilt and the per-section table are that spectrum, live.",
    inputs: {
      audio: "The signal to filter — fanned in parallel into every fixed filter section.",
    },
    outputs: {
      audio: "The summed multi-band output — every section's contribution added together, the shaped spectrum.",
    },
    controls: {
      hp: "Level of the fixed HIGH-PASS section at the top of the bank (corner 7.5 kHz) — raise to add air and brightness, cut to soften the top. It is a RESONANT high-pass rather than a flat shelf: measured +4.0 dB at its own corner, because the bank's shared Q is read in decibels by a high-pass. Defaults to 0.5.",
      band1: "Level of the fixed 125 Hz band-pass section (bass / fundamental). Defaults to 0.5.",
      band2: "Level of the fixed 175 Hz band-pass section (low end / warmth). Defaults to 0.5.",
      band3: "Level of the fixed 250 Hz band-pass section (low mids / body). Defaults to 0.5.",
      band4: "Level of the fixed 350 Hz band-pass section (lower mids). Defaults to 0.5.",
      band5: "Level of the fixed 500 Hz band-pass section (mids). Defaults to 0.5.",
      band6: "Level of the fixed 700 Hz band-pass section (mids). Defaults to 0.5.",
      band7: "Level of the fixed 1 kHz band-pass section (presence). Defaults to 0.5.",
      band8: "Level of the fixed 1.4 kHz band-pass section (presence / nasal). Defaults to 0.5.",
      band9: "Level of the fixed 2 kHz band-pass section (upper mids / bite). Defaults to 0.5.",
      band10: "Level of the fixed 2.8 kHz band-pass section (high presence). Defaults to 0.5.",
      band11: "Level of the fixed 4 kHz band-pass section (clarity / edge). Defaults to 0.5.",
      band12: "Level of the fixed 5.6 kHz band-pass section (brilliance / sizzle). Defaults to 0.5.",
      lp: "Level of the fixed LOW-PASS section at the bottom of the bank (corner 100 Hz) — raise to add sub weight, cut to thin the bottom. Like the high-pass it is RESONANT rather than a flat shelf: measured +4.0 dB at its own corner. Defaults to 0.5.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const handle = buildFilterBank(
      ctx,
      node,
      moog914Def,
      CENTERS,
      FILTERBANK_Q,
      FILTERBANK_914_LP_HZ,
      FILTERBANK_914_HP_HZ,
    );

    // Live OUTPUT-LEVEL for the card's VuMeter glyph. This is added HERE (the
    // def), NOT in the shared factory, on purpose: the factory's node graph is
    // SHA-pinned by the moog914/moog907a ART audio profiles, and a level meter
    // must never touch the audio pin. `createLevelTap` hangs a PURE PASSIVE
    // AnalyserNode SINK off the summing-bus output node — a side branch, never
    // inserted into the signal path — so the rendered audio is byte-identical
    // (verified: ART .f32 unchanged, no re-pin). Only the 914 adopts the meter;
    // the 907A shares the factory verbatim and is untouched.
    const outNode = handle.outputs.get('audio')?.node;
    const levelTap = outNode
      ? createLevelTap(ctx, outNode)
      : { getLevel: () => 0, dispose: () => {} };
    const baseDispose = handle.dispose.bind(handle);
    return {
      ...handle,
      // The card's VuMeter polls this on the shared meter frame: the live
      // output RMS as a 0..1 fraction.
      read(key: string) {
        if (key === 'level') return levelTap.getLevel();
        return handle.read ? handle.read(key) : undefined;
      },
      dispose() {
        baseDispose();
        levelTap.dispose();
      },
    };
  },
};
