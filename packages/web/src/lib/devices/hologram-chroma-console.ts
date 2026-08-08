// packages/web/src/lib/devices/hologram-chroma-console.ts
//
// HOLOGRAM ELECTRONICS — CHROMA CONSOLE. The first device descriptor.
//
// ══════════════════════════ SOURCE OF THE CC MAP ══════════════════════════
//
// Transcribed from Hologram's OWN user manual, section 16 "MIDI IMPLEMENTATION
// CHART", printed pages 46-48:
//
//   https://cdn.shopify.com/s/files/1/0920/2928/8752/files/CC_manual_WEB.pdf
//   (linked from https://hologramelectronics.com/chroma-console ; the copy read
//    was ?v=1761075763)
//
// Every control below carries `source: 'manual'` because every one of them is
// in that chart. Nothing here is inferred, and nothing is community-sourced.
//
// ⚠ TWO CORRECTIONS TO THE PRIOR RESEARCH, both found by reading the manual.
//
//   1. The device has **34** documented CCs, not 28. The "28 CCs, complete"
//      figure in the device-control proposals doc was community-sourced and is
//      wrong. Count: 8 primary + 8 secondary + 4 module selectors + 2 bypass +
//      4 per-module bypass + 8 other = 34.
//
//   2. **RATE is CC 66 and TIME is CC 68.** The proposals doc has them swapped
//      ("TIME (CC 66) and RATE (CC 68)"). Building to that would have put the
//      two most-used knobs on each other's controller.
//
// ═══════════════════════ THE DEVICE IS RECEIVE-ONLY ═══════════════════════
//
// There is no "query parameter" message and no state dump. Three separate
// developers are reported to have attempted a Chroma preset manager and
// abandoned it for this reason. The manual documents MIDI IN behaviour and a
// MIDI OUT that carries clock and thru traffic — not parameter reporting.
//
// Consequences that are NOT negotiable in the UI:
//   * the app is permanently the authority, and a hand on a physical knob
//     desyncs it with no way for us to detect that;
//   * nothing may indicate "synced", "connected to state", or show a value as
//     though it were read from the pedal;
//   * resync is an explicit user-initiated PUSH, never an automatic reconcile.
//
// ═════════════════ RATE AND TIME ARE STEPPED, TABLE UNKNOWN ═════════════════
//
// The manual states the quantization directly — "TIME: sets the delay
// subdivision", and for Cascade "delay times will be quantized subdivisions of
// the tempo you tap" — and lists the seven effects that sync to tap tempo or
// external MIDI clock (Vibrato, Phaser, Tremolo, Cascade, Reels, Collage,
// Reverse). Hologram have separately confirmed the quantization cannot be
// disabled.
//
// ⚠ The value→subdivision TABLE is not published. A full-text search of all 50
// manual pages returns zero hits for "triplet", "dotted" or "note value". So
// these two controls are marked `format: 'stepped-unmeasured'`, which renders
// the raw value with an explicit snap marker rather than pretending to a
// smoothness the hardware does not have.
//
//   TODO(hardware): measure the actual value→subdivision boundaries for CC 66
//   (RATE) and CC 68 (TIME) on a physical unit, per effect — the mapping is
//   very likely per-effect, since RATE means "doubling time" for DOUBLER and
//   "modulation frequency" for VIBRATO. Until then DO NOT invent a `ranges`
//   list for them; a fabricated table is worse than an honest raw value,
//   because it looks authoritative.
//
// ═══════════════════════════════ SCOPE ═══════════════════════════════
//
// Audio I/O is out of scope by owner decision — the pedal's audio is patched
// through the ES-9 by hand. This descriptor is the CONTROL surface only.

import type { DeviceDescriptor } from './device-descriptor';

/** The 6-way selector layout every Chroma effect MODULE uses. */
function moduleRanges(
  a: string,
  b: string,
  c: string,
  d: string,
  e: string,
): readonly { label: string; from: number; to: number }[] {
  return [
    { label: a, from: 0, to: 21 },
    { label: b, from: 22, to: 43 },
    { label: c, from: 44, to: 65 },
    { label: d, from: 66, to: 87 },
    { label: e, from: 88, to: 109 },
    { label: 'OFF', from: 110, to: 127 },
  ];
}

/** The 2-way BYPASS / ENGAGE layout the bypass CCs share. */
const BYPASS_RANGES = [
  { label: 'BYPASS', from: 0, to: 63 },
  { label: 'ENGAGE', from: 64, to: 127 },
] as const;

export const CHROMA_CONSOLE: DeviceDescriptor = {
  id: 'hologram-chroma-console',
  manufacturer: 'Hologram Electronics',
  name: 'Chroma Console',
  // The USB port enumerates under this name — taken from Hologram's own
  // firmware updater. The shorter hints catch a DIN interface that reports a
  // truncated or differently-cased name.
  portHints: ['HOLOGRAM Chroma Console MIDI', 'Chroma Console', 'Chroma'],
  defaultChannel: 1,
  readBack: 'none',

  // The eight PRIMARY knobs are the performance surface, so they are what the
  // automatable slots hold out of the box.
  defaultSlots: [
    'tilt',
    'rate',
    'time',
    'mix',
    'amountCharacter',
    'amountMovement',
    'amountDiffusion',
    'amountTexture',
  ],

  programChange: {
    count: 80,
    note:
      'PC# 0-79 recall the 80 user presets (banks A-D × 20). Program-change dropouts ' +
      'were manufacturer-acknowledged and largely fixed in firmware v1.04 but not ' +
      'eliminated — prefer PC for setup and CC for performance.',
  },

  notes: [
    'RECEIVE-ONLY: the device never reports parameter state. The app is always the authority.',
    'MIDI channel is configurable on the pedal (Global Settings, TILT knob); default is 1.',
    'A Windows/Chrome crash on MIDI input disconnect is reported for this device — port teardown is handled defensively.',
    'Audio routing is out of scope: the pedal is patched through the ES-9 by hand.',
  ],

  controls: [
    // ───────────────────────── PRIMARY CONTROLS ─────────────────────────
    {
      id: 'tilt',
      label: 'tilt',
      group: 'primary',
      role: 'continuous',
      cc: 64,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Tilt-EQ tone control across the whole signal. The filter style (tilt / lowpass / highpass) is chosen by FILTER MODE.',
      source: 'manual',
    },
    {
      id: 'rate',
      label: 'rate',
      group: 'primary',
      role: 'continuous',
      cc: 66,
      resolution: 7,
      default: 64,
      format: 'stepped-unmeasured',
      quantize: {
        kind: 'tempo-subdivision',
        table: 'unmeasured',
        note:
          'The pedal snaps RATE to tempo subdivisions and this cannot be disabled. ' +
          'The value→subdivision table is unpublished and likely differs per effect ' +
          '(RATE is doubling time for DOUBLER, modulation frequency for VIBRATO). ' +
          'Needs measuring on hardware.',
      },
      doc: 'Rate of the selected MOVEMENT effect. The pedal quantizes this to tempo subdivisions, so it steps rather than glides.',
      source: 'manual',
    },
    {
      id: 'time',
      label: 'time',
      group: 'primary',
      role: 'continuous',
      cc: 68,
      resolution: 7,
      default: 64,
      format: 'stepped-unmeasured',
      quantize: {
        kind: 'tempo-subdivision',
        table: 'unmeasured',
        note:
          'The manual states it directly: "TIME: sets the delay subdivision", and for ' +
          'CASCADE "delay times will be quantized subdivisions of the tempo you tap". ' +
          'The boundaries are unpublished. Needs measuring on hardware.',
      },
      doc: 'Time of the selected DIFFUSION effect. The pedal quantizes this to tempo subdivisions, so it steps rather than glides.',
      source: 'manual',
    },
    {
      id: 'mix',
      label: 'mix',
      group: 'primary',
      role: 'continuous',
      cc: 70,
      resolution: 7,
      default: 64,
      format: 'percent',
      doc: 'Blend between the input signal and the effected signal.',
      source: 'manual',
    },
    {
      id: 'amountCharacter',
      label: 'amount · character',
      group: 'primary',
      role: 'continuous',
      cc: 65,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Depth of the selected CHARACTER effect (drive, sweeten, fuzz, howl, swell).',
      source: 'manual',
    },
    {
      id: 'amountMovement',
      label: 'amount · movement',
      group: 'primary',
      role: 'continuous',
      cc: 67,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Depth of the selected MOVEMENT effect — modulation depth, doubling mix, or pitch interval.',
      source: 'manual',
    },
    {
      id: 'amountDiffusion',
      label: 'amount · diffusion',
      group: 'primary',
      role: 'continuous',
      cc: 69,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Depth of the selected DIFFUSION effect. On CASCADE it increases repeats and feedback until the delay self-oscillates.',
      source: 'manual',
    },
    {
      id: 'amountTexture',
      label: 'amount · texture',
      group: 'primary',
      role: 'continuous',
      cc: 71,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Depth of the selected TEXTURE effect (filter, squash, cassette, broken, interference).',
      source: 'manual',
    },

    // ──────────────────────── SECONDARY CONTROLS ────────────────────────
    {
      id: 'sensitivity',
      label: 'sensitivity',
      group: 'secondary',
      role: 'continuous',
      cc: 72,
      resolution: 7,
      default: 64,
      format: 'raw7',
      doc: 'Input sensitivity — how strongly the pedal reacts to playing dynamics.',
      source: 'manual',
    },
    {
      id: 'driftMovement',
      label: 'drift · movement',
      group: 'secondary',
      role: 'continuous',
      cc: 74,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'Randomness and instability in the MOVEMENT effect — stereo width, tape-warble modulation, random pitch shifts.',
      source: 'manual',
    },
    {
      id: 'driftDiffusion',
      label: 'drift · diffusion',
      group: 'secondary',
      role: 'continuous',
      cc: 76,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'Randomness in the DIFFUSION effect — pitch modulation on repeats, random double-speed loops, signal degradation.',
      source: 'manual',
    },
    {
      id: 'outputLevel',
      label: 'output level',
      group: 'secondary',
      role: 'continuous',
      cc: 78,
      resolution: 7,
      default: 96,
      format: 'percent',
      doc: 'Overall output level of the pedal.',
      source: 'manual',
    },
    {
      id: 'effectVolCharacter',
      label: 'effect vol · character',
      group: 'secondary',
      role: 'continuous',
      cc: 73,
      resolution: 7,
      default: 96,
      format: 'percent',
      doc: 'Output volume of the CHARACTER module alone, for balancing it against the other three.',
      source: 'manual',
    },
    {
      id: 'effectVolMovement',
      label: 'effect vol · movement',
      group: 'secondary',
      role: 'continuous',
      cc: 75,
      resolution: 7,
      default: 96,
      format: 'percent',
      doc: 'Output volume of the MOVEMENT module alone.',
      source: 'manual',
    },
    {
      id: 'effectVolDiffusion',
      label: 'effect vol · diffusion',
      group: 'secondary',
      role: 'continuous',
      cc: 77,
      resolution: 7,
      default: 96,
      format: 'percent',
      doc: 'Output volume of the DIFFUSION module alone.',
      source: 'manual',
    },
    {
      id: 'effectVolTexture',
      label: 'effect vol · texture',
      group: 'secondary',
      role: 'continuous',
      cc: 79,
      resolution: 7,
      default: 96,
      format: 'percent',
      doc: 'Output volume of the TEXTURE module alone.',
      source: 'manual',
    },

    // ───────────────────────── MODULE SELECTORS ─────────────────────────
    {
      id: 'characterModule',
      label: 'character',
      group: 'modules',
      role: 'enum',
      cc: 16,
      resolution: 7,
      default: 11, // DRIVE
      format: 'enum',
      ranges: moduleRanges('DRIVE', 'SWEETEN', 'FUZZ', 'HOWL', 'SWELL'),
      doc: 'Which of the five CHARACTER effects is active, or OFF. Saturation and gain shaping.',
      source: 'manual',
    },
    {
      id: 'movementModule',
      label: 'movement',
      group: 'modules',
      role: 'enum',
      cc: 17,
      resolution: 7,
      default: 11, // DOUBLER
      format: 'enum',
      ranges: moduleRanges('DOUBLER', 'VIBRATO', 'PHASER', 'TREMOLO', 'PITCH'),
      doc: 'Which of the five MOVEMENT effects is active, or OFF. Modulation and pitch.',
      source: 'manual',
    },
    {
      id: 'diffusionModule',
      label: 'diffusion',
      group: 'modules',
      role: 'enum',
      cc: 18,
      resolution: 7,
      default: 11, // CASCADE
      format: 'enum',
      ranges: moduleRanges('CASCADE', 'REELS', 'SPACE', 'COLLAGE', 'REVERSE'),
      doc: 'Which of the five DIFFUSION effects is active, or OFF. Delay, reverb and time smearing.',
      source: 'manual',
    },
    {
      id: 'textureModule',
      label: 'texture',
      group: 'modules',
      role: 'enum',
      cc: 19,
      resolution: 7,
      default: 11, // FILTER
      format: 'enum',
      ranges: moduleRanges('FILTER', 'SQUASH', 'CASSETTE', 'BROKEN', 'INTERFERENCE'),
      doc: 'Which of the five TEXTURE effects is active, or OFF. Filtering, compression and lo-fi degradation.',
      source: 'manual',
    },

    // ───────────────────────── BYPASS CONTROLS ─────────────────────────
    {
      id: 'standardBypass',
      label: 'bypass',
      group: 'bypass',
      role: 'enum',
      cc: 91,
      resolution: 7,
      default: 96, // ENGAGE
      format: 'enum',
      ranges: BYPASS_RANGES,
      doc: 'Whole-pedal bypass or engage.',
      source: 'manual',
    },
    {
      id: 'dualBypass',
      label: 'dual bypass',
      group: 'bypass',
      role: 'enum',
      cc: 92,
      resolution: 7,
      default: 96, // TOTAL ENGAGE
      format: 'enum',
      ranges: [
        { label: 'TOTAL BYPASS', from: 0, to: 31 },
        { label: 'DUAL BYPASS', from: 32, to: 63 },
        { label: 'TOTAL ENGAGE', from: 64, to: 127 },
      ],
      doc: 'Dual-bypass state: everything off, the dual-bypass subset, or everything on.',
      source: 'manual',
    },
    {
      id: 'bypassCharacter',
      label: 'bypass · character',
      group: 'bypass',
      role: 'enum',
      cc: 103,
      resolution: 7,
      default: 96,
      format: 'enum',
      ranges: BYPASS_RANGES,
      doc: 'Bypass or engage the CHARACTER module on its own.',
      source: 'manual',
    },
    {
      id: 'bypassMovement',
      label: 'bypass · movement',
      group: 'bypass',
      role: 'enum',
      cc: 104,
      resolution: 7,
      default: 96,
      format: 'enum',
      ranges: BYPASS_RANGES,
      doc: 'Bypass or engage the MOVEMENT module on its own.',
      source: 'manual',
    },
    {
      id: 'bypassDiffusion',
      label: 'bypass · diffusion',
      group: 'bypass',
      role: 'enum',
      cc: 105,
      resolution: 7,
      default: 96,
      format: 'enum',
      ranges: BYPASS_RANGES,
      doc: 'Bypass or engage the DIFFUSION module on its own.',
      source: 'manual',
    },
    {
      id: 'bypassTexture',
      label: 'bypass · texture',
      group: 'bypass',
      role: 'enum',
      cc: 106,
      resolution: 7,
      default: 96,
      format: 'enum',
      ranges: BYPASS_RANGES,
      doc: 'Bypass or engage the TEXTURE module on its own.',
      source: 'manual',
    },

    // ───────────────────────── OTHER FUNCTIONS ─────────────────────────
    {
      id: 'captureRouting',
      label: 'capture routing',
      group: 'other',
      role: 'enum',
      cc: 83,
      resolution: 7,
      default: 32, // POST-FX
      format: 'enum',
      ranges: [
        { label: 'POST-FX', from: 0, to: 63 },
        { label: 'PRE-FX', from: 64, to: 127 },
      ],
      doc: 'Whether CAPTURE records the signal before or after the effect chain. A persistent setting, not a command.',
      source: 'manual',
    },
    {
      id: 'filterMode',
      label: 'filter mode',
      group: 'other',
      role: 'enum',
      cc: 84,
      resolution: 7,
      default: 66, // TILT
      format: 'enum',
      ranges: [
        { label: 'LPF', from: 0, to: 43 },
        { label: 'TILT', from: 44, to: 87 },
        { label: 'HPF', from: 88, to: 127 },
      ],
      doc: 'What the TILT knob does: lowpass, tilt-EQ, or highpass.',
      source: 'manual',
    },
    {
      id: 'calibrationLevel',
      label: 'calibration level',
      group: 'other',
      role: 'enum',
      cc: 94,
      resolution: 7,
      default: 48, // MEDIUM
      format: 'enum',
      ranges: [
        { label: 'LOW', from: 0, to: 31 },
        { label: 'MEDIUM', from: 32, to: 63 },
        { label: 'HIGH', from: 64, to: 95 },
        { label: 'VERY HIGH', from: 96, to: 127 },
      ],
      doc: 'Input calibration level. A setup control — set it once for your instrument, not something to sequence.',
      source: 'manual',
    },

    // ACTIONS — momentary commands. Never slottable: a slot write is undoable,
    // and undoing it would RE-FIRE the command. See DeviceControlRole.
    {
      id: 'gesturePlayRec',
      label: 'gesture play / rec',
      group: 'other',
      role: 'action',
      cc: 80,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'Start GESTURE playback (0-63) or GESTURE recording (64-127). Recording overwrites the existing loop for whichever knob you then move.',
      source: 'manual',
    },
    {
      id: 'gestureStopErase',
      label: 'gesture stop / erase',
      group: 'other',
      role: 'action',
      cc: 81,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'Stop gesture playback and erase recorded knob movements. Any value triggers it.',
      source: 'manual',
    },
    {
      id: 'capture',
      label: 'capture',
      group: 'other',
      role: 'action',
      cc: 82,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'CAPTURE transport: stop/clear (0-43), play (44-87), record (88-127). Recording replaces the held audio.',
      source: 'manual',
    },
    {
      id: 'tapTempo',
      label: 'tap tempo',
      group: 'other',
      role: 'action',
      cc: 93,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'One tap of the tempo used by Vibrato, Phaser, Tremolo, Cascade, Reels, Collage and Reverse. Any value taps.',
      source: 'manual',
    },
    {
      id: 'calibrationMenu',
      label: 'calibration menu',
      group: 'other',
      role: 'action',
      cc: 95,
      resolution: 7,
      default: 0,
      format: 'raw7',
      doc: 'Enter (64-127) or exit (0-63) the calibration menu. Entering takes the pedal out of normal operation — a setup command, never a performance one.',
      source: 'manual',
    },
  ],
};

/** Every descriptor the app ships. A second device is one more entry here. */
export const DEVICE_DESCRIPTORS: readonly DeviceDescriptor[] = [CHROMA_CONSOLE];
