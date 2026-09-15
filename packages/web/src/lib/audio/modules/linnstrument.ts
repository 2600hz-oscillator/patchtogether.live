// LINNSTRUMENT — a LinnStrument 200 in User Firmware Mode as a 16×8 fourths
// keyboard, a column of controls and an 8×8 XY/MPE pad, in one audio-domain
// control module.
//
// AUTHORITY, per part (decision-register.md; the package sits BELOW code,
// AGENTS.md, the skills and docs/):
//   OWNER RULINGS   D01 standard MIDI transport · D04 R/G/B are INDEPENDENT
//                   toggles, all eight masks legal · D09 +1/+5 fourths layout.
//   RECOMMENDATIONS the 16×8 | 1×8 | 8×8 split (D03), the single-pointer and
//                   join policies (D05/D07 — `join_policy` is the switch), the
//                   initial state R on / G,B off / centred / arps off (D08),
//                   keys root 36 / pad root 60, the lower five control cells
//                   ARP / HOLD / OCT− / OCT+ / PANIC (D17 — `extra_controls` is
//                   the switch), joystick mirroring (D15 — `node.data.targets`,
//                   opt-in, default unbound), the LED lighting ROLES (root
//                   cyan / scale tone green / played white — profile data,
//                   hardware-verify, D18).
//   LIGHTING        the D09 ruling's other half: `scale` (default chromatic)
//                   with the two roots lights the keys and the pad on the
//                   instrument — root, in-scale, out-of-scale (still
//                   playable) and a played mark — because User Firmware Mode
//                   switches the stock lighting off. The device paints from
//                   THIS node's roots, so lights and notes cannot disagree.
//   NOT BUILT       D14 expression jacks: `polyCv` is a graph-wide change and
//                   the per-voice-scalar fallback is equally unruled, so the
//                   two poly buses carry PITCH + GATE only and per-lane
//                   velocity / pressure / timbre stay on the card-api.
//
// Outputs:
//   r_x r_y g_x g_y b_x b_y (cv): the three RETAINED joystick pairs, bipolar.
//   keys_poly, pad_poly (polyPitchGate): one 16-lane note bus per region.
// Inputs: none (the device is the input; nothing patches INTO this module).
//
// THE RUNTIME IS IN `linnstrument-runtime.ts` and the arp transport in
// `linnstrument-arp.ts`; this file is the contract, the face and the docs.
// `linnstrumentDef.factory` delegates to `createLinnstrumentRuntime`.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace, ParamDef } from '$lib/graph/types';
import {
  ARP_DIVISION_DEFAULT_INDEX,
  ARP_DIVISION_LABELS,
  ARP_DIVISIONS,
  ARP_OCTAVE_RANGE_DEFAULT_INDEX,
  ARP_OCTAVE_RANGE_LABELS,
  ARP_OCTAVE_RANGES,
} from '$lib/audio/arp-engine';
import { RECOMMENDED_KEYS_ROOT, RECOMMENDED_PAD_ROOT } from '$lib/midi/linnstrument/profile';
import { createLinnstrumentRuntime, LINN_ROOT_MAX, LINN_ROOT_MIN, LINN_SCALE_OPTIONS } from './linnstrument-runtime';
import { ARP_DIRECTIONS } from './linnstrument-arp';

export type {
  LaneExpression,
  LinnstrumentCardApi,
  LinnstrumentSnapshot,
  LinnTargets,
} from './linnstrument-runtime';

const ON_OFF = [
  { value: 0, label: 'OFF' },
  { value: 1, label: 'ON' },
] as const;

/** The two roots share one shape; the defaults are the package's
 *  RECOMMENDATION (`initial_roots`), not a ruling. */
function rootParam(id: string, label: string, defaultValue: number, hint: string): ParamDef {
  return {
    id,
    label,
    defaultValue,
    min: LINN_ROOT_MIN,
    max: LINN_ROOT_MAX,
    curve: 'discrete',
    units: hint,
  };
}

/** One region's five arp params. Option rosters are bound to the engine's own
 *  tables (ARP_DIVISIONS / ARP_OCTAVE_RANGES) — never re-typed. */
function arpParams(region: 'keys' | 'pad', label: string): ParamDef[] {
  return [
    { id: `${region}_arp_on`, label: `${label} arp`, defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
    {
      id: `${region}_arp_dir`,
      label: `${label} dir`,
      defaultValue: 0,
      min: 0,
      max: ARP_DIRECTIONS.length - 1,
      curve: 'discrete',
      options: ARP_DIRECTIONS.map((d, i) => ({ value: i, label: d === 'updown' ? 'up/dn' : d })),
    },
    {
      id: `${region}_arp_div`,
      label: `${label} rate`,
      defaultValue: ARP_DIVISION_DEFAULT_INDEX,
      min: 0,
      max: ARP_DIVISIONS.length - 1,
      curve: 'discrete',
      options: ARP_DIVISION_LABELS.map((l, i) => ({ value: i, label: l })),
    },
    {
      id: `${region}_arp_range`,
      label: `${label} oct`,
      defaultValue: ARP_OCTAVE_RANGE_DEFAULT_INDEX,
      min: 0,
      max: ARP_OCTAVE_RANGES.length - 1,
      curve: 'discrete',
      options: ARP_OCTAVE_RANGE_LABELS.map((l, i) => ({ value: i, label: l })),
    },
    { id: `${region}_arp_latch`, label: `${label} hold`, defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
  ];
}

// ── THE FACE ──────────────────────────────────────────────────────────────
//
// ⚠ `glyph: 'none'` IS FORCED, not chosen: six `cv` outputs and two
// `polyPitchGate` buses, no `audio` port, so `primaryAudioOutPortId` resolves
// null and every live glyph literal falls through to `{ kind: 'static' }`,
// which module-face-lint's dead-glyph clause refuses. `'algorithm'` would
// RESOLVE (any def carrying `face.extension`) and paint an empty topology
// plate — `linnstrument-face-model.test.ts` pins both.
//
// ⚠ NO `xyPads`. The joystick precedent (#1974 → owner decision 2026-08-31):
// a pad-only face resolves to zero lane controls, so the six axes rank as
// ORDINARY knob cells and the three real pads are the extension's
// `fullViewBody` — the module's own surface, which emits no `control-*`
// anchor. The redundancy at the dock (pads above, knobs below) is stated,
// as it is on joystick.
//
// ⚠ NOT `tabbed`. Six bands is under `DOCK_TAB_MIN_BANDS` (7) and the
// per-face opt-in is declared only on an explicit owner instruction, which
// this module does not have; the pages are honest groups, never padded.
//
// GROUPED BY LANE, never by control type (owner ruling 2026-09-04): the R
// band is everything about R — its toggle and its two retained axes — and so
// for G and B; `keys` is the keyboard's root and its arp, `pad` the pad's.
// `surface` holds what is not any one lane's: the bind, the two policy
// switches and the two global gestures.
//
// CONNECT RANKS FIRST for the trails/midiclock reason: the module is inert
// until Web MIDI consents, and `faceTierCap` caps a glyph-less compact tile at
// three cells, so rank 0 is what keeps the only enabling gesture on the lane.
export const LINNSTRUMENT_FACE: ModuleFace = {
  glyph: 'none',
  extension: 'linnstrument',
  order: [
    'linnstrument-connect-{n}',
    'sel_r',
    'pos_r_x',
    'pos_r_y',
    'sel_g',
    'pos_g_x',
    'pos_g_y',
    'sel_b',
    'pos_b_x',
    'pos_b_y',
    'linnstrument-center-{n}',
    'linnstrument-panic-{n}',
    'extra_controls',
    'join_policy',
    'scale',
    'keys_root',
    'keys_arp_on',
    'keys_arp_dir',
    'keys_arp_div',
    'keys_arp_range',
    'keys_arp_latch',
    'pad_root',
    'pad_arp_on',
    'pad_arp_dir',
    'pad_arp_div',
    'pad_arp_range',
    'pad_arp_latch',
  ],
  pages: [
    {
      id: 'surface',
      label: 'surface',
      hint:
        'CONNECT is the one-time Web-MIDI grant plus the bind of any port named like a '
        + 'LinnStrument; until then every jack rests. CENTER returns the SELECTED pairs to '
        + '(0, 0); PANIC closes every note on both buses and keeps the pairs where they are. '
        + 'EXTRAS lights the lower five control cells (ARP, HOLD, OCT−, OCT+, PANIC); JOIN '
        + 'decides how a pair that becomes selected mid-gesture catches up with the finger; '
        + "SCALE lights the keys and the pad on the instrument (root, in scale, out of scale) — "
        + 'it never changes what a cell plays.',
      controls: ['linnstrument-connect-{n}', 'linnstrument-center-{n}', 'linnstrument-panic-{n}', 'extra_controls', 'join_policy', 'scale'],
    },
    {
      id: 'r',
      label: 'r',
      hint: 'The R joystick: whether the pad finger drives it, and the pair it holds. It keeps the last pair after the finger lifts.',
      controls: ['sel_r', 'pos_r_x', 'pos_r_y'],
    },
    {
      id: 'g',
      label: 'g',
      hint: 'The G joystick: its own toggle and its own retained pair, independent of R and B.',
      controls: ['sel_g', 'pos_g_x', 'pos_g_y'],
    },
    {
      id: 'b',
      label: 'b',
      hint: 'The B joystick: its own toggle and its own retained pair, independent of R and G.',
      controls: ['sel_b', 'pos_b_x', 'pos_b_y'],
    },
    {
      id: 'keys',
      label: 'keys',
      hint:
        'The 16×8 fourths keyboard: the note at its bottom-left cell, and an arpeggiator over '
        + 'whatever is held there, clocked by TIMELORDE.',
      controls: ['keys_root', 'keys_arp_on', 'keys_arp_dir', 'keys_arp_div', 'keys_arp_range', 'keys_arp_latch'],
    },
    {
      id: 'pad',
      label: 'pad',
      hint:
        'The 8×8 pad as an instrument: the note at its bottom-left cell, and its own '
        + 'independent arpeggiator. The same finger that plays a pad note is the XY pointer.',
      controls: ['pad_root', 'pad_arp_on', 'pad_arp_dir', 'pad_arp_div', 'pad_arp_range', 'pad_arp_latch'],
    },
  ],
};

export const linnstrumentDef: AudioModuleDef = {
  // String LITERALS: module-manifest.ts extracts these with a ?raw regex.
  type: 'linnstrument',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'linnstrument',
  category: 'sources',
  // `3u` because the dock body carries three live pads; `hp` 2 so three
  // 140 px pads fit side by side (trails.ts:582-583 shape).
  size: '3u',
  hp: 2,

  inputs: [],
  outputs: [
    { id: 'r_x', type: 'cv', label: 'r x' },
    { id: 'r_y', type: 'cv', label: 'r y' },
    { id: 'g_x', type: 'cv', label: 'g x' },
    { id: 'g_y', type: 'cv', label: 'g y' },
    { id: 'b_x', type: 'cv', label: 'b x' },
    { id: 'b_y', type: 'cv', label: 'b y' },
    { id: 'keys_poly', type: 'polyPitchGate', label: 'keys' },
    { id: 'pad_poly', type: 'polyPitchGate', label: 'pad' },
  ],
  params: [
    // D08 RECOMMENDATION: R on, G and B off. Three INDEPENDENT bits (D04
    // owner ruling) — three params, never one radio index.
    { id: 'sel_r', label: 'r', defaultValue: 1, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
    // joystick.ts:74-78 persist shape: the retained pair IS the param, no
    // snap-back (#1963 "1 - persist").
    { id: 'pos_r_x', label: 'r x', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_r_y', label: 'r y', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'sel_g', label: 'g', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
    { id: 'pos_g_x', label: 'g x', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_g_y', label: 'g y', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'sel_b', label: 'b', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
    { id: 'pos_b_x', label: 'b x', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_b_y', label: 'b y', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    // D17 RECOMMENDATION: the lower five control cells, ON by default.
    { id: 'extra_controls', label: 'extras', defaultValue: 1, min: 0, max: 1, curve: 'discrete', options: ON_OFF },
    // D07 SWITCH: 0 = the pair jumps to the next coherent sample (the
    // package recommendation), 1 = soft takeover (the pair waits until the
    // finger passes within pickup range). The preference is OPEN.
    {
      id: 'join_policy',
      label: 'join',
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'discrete',
      options: [
        { value: 0, label: 'JUMP', title: 'A newly selected pair follows the very next finger sample' },
        { value: 1, label: 'PICKUP', title: 'A newly selected pair waits until the finger passes within pickup range of where it rests' },
      ],
    },
    // D09 (owner ruling): the scale affects LIGHTING, not playability. Roster
    // bound to the tree's SCALE_NAMES; 0 = chromatic, the tree's absent scale.
    { id: 'scale', label: 'scale', defaultValue: 0, min: 0, max: LINN_SCALE_OPTIONS.length - 1, curve: 'discrete', options: LINN_SCALE_OPTIONS },
    rootParam('keys_root', 'keys root', RECOMMENDED_KEYS_ROOT, 'midi'),
    ...arpParams('keys', 'keys'),
    rootParam('pad_root', 'pad root', RECOMMENDED_PAD_ROOT, 'midi'),
    ...arpParams('pad', 'pad'),
  ],

  face: LINNSTRUMENT_FACE,

  // Three non-param gestures. None writes a param on its own (CONNECT asks
  // the browser; CENTER and PANIC are reducer intents), so they reach
  // `face.order` through the family key-space like trails' connect does.
  controlFamilies: [
    { id: 'linnstrument-connect', label: 'Connect LinnStrument', kind: 'other', testidPrefix: 'linnstrument-connect' },
    { id: 'linnstrument-center', label: 'Center selected', kind: 'other', testidPrefix: 'linnstrument-center' },
    { id: 'linnstrument-panic', label: 'Panic', kind: 'other', testidPrefix: 'linnstrument-panic' },
  ],

  docs: {
    explanation:
      "A LinnStrument 200 played into the rack as three instruments at once. The playing surface is split into a 16 by 8 keyboard on the left, laid out in fourths like the instrument's own default (one semitone per column, five per row, so the same shape is the same chord anywhere), a single column of eight control cells, and an 8 by 8 pad on the right. The keyboard and the pad are each a polyphonic MPE instrument with their own note bus: every finger is its own voice with its own pitch slide, pressure and vertical timbre, and two fingers on the same pitch stay two voices. The pad is also the rack's joystick hand. Three of the control cells are the R, G and B toggles, each an independent switch — any of the eight combinations is legal — and the first finger to land on the pad moves every joystick that is currently selected, as one coherent X/Y pair per sample; lifting the finger leaves each pair exactly where it was, and a joystick that is not selected simply keeps its last pair. That is what the six CV jacks carry: three retained X/Y pairs, bipolar, held between gestures and stored in the patch like a knob, so they survive a reload. The lower five control cells are ARP, HOLD, OCT−, OCT+ and PANIC for the keyboard, and each region has an arpeggiator that walks whatever is held there in time with TIMELORDE. Mental model: a keyboard, a pad, and three joysticks you can pick up and put down with one hand, with the rack hearing all of it at once. The device binds through CONNECT (the one-time Web MIDI grant); which port is bound is a setting of this computer, not of the patch. Nothing that a finger does is streamed into the saved patch: touches, pressures and voices are live engine state, and only the six retained pairs and the switches are stored. The three pads on the dock faceplate are the same three joysticks — drag one to move it, whether or not the hardware is connected — and they go through exactly the same selection logic as the instrument, so the face, the CV and the lights on the device can never disagree. Because User Firmware Mode switches the instrument's own lighting off, the module lights it: on the keyboard and the pad every root is cyan, every other note of the chosen SCALE green, out-of-scale cells dark but still playable, a cell under a finger white, and the control column shows which of R, G and B are on — all painted from this module's own roots, so the lights and the notes cannot disagree. No expression jacks are offered yet: pressure, timbre and velocity per voice are kept aligned to the note bus lanes inside the module and wait on a rack-wide poly-CV cable decision.",
    inputs: {},
    outputs: {
      r_x: "The R joystick's retained horizontal position as bipolar CV, −1 at the pad's left edge through 0 at its centre to +1 at the right. It follows the pad finger while R is selected, holds the last value when the finger lifts or R is deselected, and is stored in the patch.",
      r_y: "The R joystick's retained vertical position as bipolar CV, −1 at the bottom of the pad through +1 at the top (up reads positive), held between gestures and stored in the patch.",
      g_x: "The G joystick's retained horizontal position, in the same coordinates as R X. It moves only while G is selected and otherwise keeps its last pair.",
      g_y: "The G joystick's retained vertical position, in the same coordinates as R Y, moving only while G is selected.",
      b_x: "The B joystick's retained horizontal position, in the same coordinates as R X, moving only while B is selected.",
      b_y: "The B joystick's retained vertical position, in the same coordinates as R Y, moving only while B is selected.",
      keys_poly:
        "The keyboard as a polyphonic pitch and gate bus, up to sixteen voices, one lane per finger for as long as that finger is down. Pitch is the cell's note plus the finger's horizontal slide, so a bend is a real pitch movement on the lane; the gate stays high while the finger holds and drops when it lifts, and a finger that is stolen when a seventeenth arrives hands its lane to the newcomer without ending the newcomer later. When the keyboard arp is on the bus carries the arpeggio instead — one lane, a real gate-low interval between steps, so an envelope re-fires on every note. Patch it into any poly-aware voice (CUBE, DX7) to hear the keyboard.",
      pad_poly:
        "The 8 by 8 pad as its own polyphonic pitch and gate bus, independent of the keyboard: the same finger that steers the selected joysticks also plays a note here, with its own pitch slide, so the pad can be a second instrument, a drum surface, or simply the joystick hand with this jack left unpatched. The pad arp takes the bus over in the same way the keyboard arp takes the keyboard bus.",
    },
    controls: {
      'linnstrument-connect-{n}':
        "The gesture that makes the module do anything at all. A browser shows no MIDI port until it has consented, and it only asks when a click asks it to — so before this the module has no device to read, every jack rests, and the three pads on the face are the only way to move the joysticks. Pressing it grants access (one prompt, once per origin), binds the port named like a LinnStrument that was picked on the preflight page, and asks the instrument to enter User Firmware Mode so its cells report raw touches rather than notes — the LINK lamp reports the mode as confirmed only once the instrument's own mode notification comes back, never from the request alone; unbinding asks it to restore its own mode. Loading a patch containing this module never raises the prompt by itself, and which port is bound is remembered on this computer, not in the patch.",
      'linnstrument-center-{n}':
        "Returns every SELECTED joystick pair to (0, 0) — the pairs whose toggles are on — and leaves the others where they are. It does not move the finger or change how the pad is read: the next sample from a finger on the pad moves the selected pairs again from the centre.",
      'linnstrument-panic-{n}':
        "Closes every note on both buses now and cancels both arpeggiators' queued steps, then leaves the six joystick pairs, the R/G/B selection and any finger on the pad exactly as they were. It is the all-notes-off for this module; it never touches the CV jacks.",
      sel_r:
        "Whether the R joystick follows the pad finger. ON and it takes every coherent X/Y sample the finger produces; OFF and it keeps the pair it has. It is one of three independent switches, so any combination of R, G and B can be on at once, and toggling it on the instrument's control column, on this cell or from a collaborator's screen is the same change.",
      pos_r_x:
        "The R joystick's stored X in the −1..+1 range — the value behind the R X jack. Written by the pad finger while R is selected, by dragging the R pad on the face, or by turning this cell directly; the finger lifting leaves it where it was, and it survives a reload.",
      pos_r_y:
        "The R joystick's stored Y in the −1..+1 range, +1 at the top of the pad — the value behind the R Y jack, written the same ways as R X and held between gestures.",
      sel_g:
        "Whether the G joystick follows the pad finger, independent of R and B. OFF keeps G's pair where it is while the finger moves the others.",
      pos_g_x: "The G joystick's stored X in −1..+1, the value behind the G X jack, held between gestures and stored in the patch.",
      pos_g_y: "The G joystick's stored Y in −1..+1, +1 at the top, the value behind the G Y jack.",
      sel_b:
        "Whether the B joystick follows the pad finger, independent of R and G. OFF keeps B's pair where it is while the finger moves the others.",
      pos_b_x: "The B joystick's stored X in −1..+1, the value behind the B X jack, held between gestures and stored in the patch.",
      pos_b_y: "The B joystick's stored Y in −1..+1, +1 at the top, the value behind the B Y jack.",
      extra_controls:
        "Whether the lower five cells of the control column do anything. ON gives the keyboard an ARP toggle, a HOLD toggle, OCT− and OCT+ (which move KEYS ROOT by an octave) and a PANIC cell; OFF leaves those five cells inert and unlit, so a hand resting on the column cannot change a setting. The R, G and B toggles at the top of the column are always live. The assignment of those five is the design's recommendation, kept switchable so it can be changed without touching the patch format.",
      join_policy:
        "How a joystick that becomes selected while a finger is already on the pad catches up. JUMP moves its pair to the very next finger sample, so it snaps to the hand at once. PICKUP leaves its pair where it rests until the finger passes within a small radius of that point, then takes it along — the soft-takeover behaviour a hardware fader uses so a switch cannot cause a jump in the CV. A pair that is selected before the finger lands always follows from the first sample either way.",
      scale:
        "Which notes the instrument's lights treat as in the scale, on both the keyboard and the pad: every root of the region is cyan, every other scale note green, and anything outside the scale is dark. It changes only the lights — every cell still plays its chromatic note, so an out-of-scale cell is dark and playable. CHROMATIC treats every note as in scale, leaving the roots as the only landmarks. The scale is relative to each region's own root.",
      keys_root:
        "The MIDI note at the keyboard's bottom-left cell, from which every other cell is one semitone per column and five per row. The default 36 (C2) puts middle C on the fourth row. OCT− and OCT+ on the instrument's control column move it by twelve. A cell whose note would fall outside the MIDI range simply does not sound.",
      keys_arp_on:
        "Whether the keyboard arpeggiator runs. ON and the KEYS bus stops carrying the held fingers directly and plays them one at a time instead, in KEYS DIR order at the KEYS RATE division of the TIMELORDE beat, one lane with a real gap between notes; OFF hands the bus back to the fingers that are down. Each generated note carries the expression of the finger it came from — two fingers on the same pitch count as one note that stays until both lift.",
      keys_arp_dir:
        "The order the keyboard arp walks its notes: up, down, or up/dn — a pendulum that plays each end once (C E G E C E G, never C E G G E).",
      keys_arp_div:
        "How fast the keyboard arp steps, as a multiple of the TIMELORDE beat: 1x is one note per beat, 2x and 4x and 8x are subdivisions, 1/2 through 1/8 stretch a note over several beats. Changing it mid-run keeps the arp's place in the pattern.",
      keys_arp_range:
        "How far the keyboard arp reaches beyond the held notes: 1 oct plays only what is held, +1..−1 adds a copy an octave above and below, +2..−2 two octaves each way. Symmetric around the played notes.",
      keys_arp_latch:
        "Whether the keyboard arp keeps going after every finger lifts. ON freezes the last set of held notes and keeps walking them; a new note played while any finger is still down joins the set, and a new note played after a full release replaces it. OFF stops the arp the moment the last finger lifts. HOLD on the instrument's control column is this same switch.",
      pad_root:
        "The MIDI note at the pad's bottom-left cell, laid out in fourths like the keyboard. The default 60 (C4) puts a two-octave span across the eight columns and rows. A cell outside the MIDI range does not sound.",
      pad_arp_on:
        "Whether the pad arpeggiator runs. ON and the PAD bus plays the held pad notes one at a time in PAD DIR order at the PAD RATE division, independent of the keyboard arp and with its own held set; OFF hands the bus back to the fingers that are down. It does not affect the joystick pairs — the finger still steers them while its note is arpeggiated.",
      pad_arp_dir: "The order the pad arp walks its notes: up, down, or the up/dn pendulum.",
      pad_arp_div: "How fast the pad arp steps, as a multiple of the TIMELORDE beat, on the same table as KEYS RATE.",
      pad_arp_range: "How many octaves the pad arp adds around the held notes, on the same table as KEYS OCT.",
      pad_arp_latch: "Whether the pad arp keeps walking its last held set after every finger lifts, with the same join and replace rules as KEYS HOLD.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    return createLinnstrumentRuntime(ctx, node);
  },
};
