// packages/web/src/lib/audio/modules/cv-buddy-mini.ts
//
// CV BUDDY MINI — pitch + gate only, so it costs TWO ES-9 output jacks instead
// of three.
//
// WHY IT EXISTS (owner, 2026-08-07). The ES-9 has eight DC-coupled outputs, and
// the full CV Buddy spends three of them per voice (pitch, gate, velocity) —
// which means two voices consume 1-6 and the whole device is full. Dropping
// velocity, which plenty of Eurorack voices ignore anyway, buys back a jack per
// instance and opens the two layouts the owner actually wants:
//
//   THREE minis      {1,2} {3,4} {5,6}   and jacks 7/8 are STILL RUN + CLOCK
//   ONE mini         {1,2} + 7/8         leaving 3,4,5,6 free for send/return
//
// Both are pinned by name in cv-buddy/slot-alloc.test.ts.
//
// IT IS THE SAME MODULE MINUS ONE PORT. The engine handle comes from the SHARED
// `createCvBuddyHandle` — one implementation of the RUN + CLOCK generator that
// jacks 7/8 carry and that Pam's locks to. A second copy would be a second
// clock, free to drift from the first, with any timing fix landing in only one
// of them. `kind: 'mini'` changes exactly one thing: no velocity.
//
// SLOT ALLOCATION IS SHARED TOO, and must be: `allocateCvBuddySlots` hands out
// the 1-6 note pool across BOTH kinds in one pass. Two independent allocators
// would each believe they owned jack 1, and two modules driving one physical
// DC-coupled output is silently wrong VOLTAGE at the hardware — no error, just
// a wrong note.
//
// Contract mirrors cvBuddy: outputs are cv/gate-typed, never 'pitch'-typed and
// never poly, so `isNoteSource(def)` stays FALSE and a clip lane can drive it.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// ⚠ The PPQN param is IMPORTED, not re-declared. Both kinds render one shared
// body and share one ES-9 jack pool; two copies of the roster would be two menus
// free to drift, and the drift would be invisible until a user noticed one card
// offering a division the other refused.
// ⚠ The FACE is imported too, and it is the SAME OBJECT rather than a copy —
// `cv-buddy-face-model.test.ts` asserts that by IDENTITY. Two face literals
// would be two rosters free to drift exactly as two PPQN rosters would be, and
// the drift would be invisible until a player noticed one plate carrying a band
// the other had lost.
import { createCvBuddyHandle, CV_BUDDY_FACE, CV_BUDDY_PPQN_PARAM } from './cv-buddy';

export const cvBuddyMiniDef: AudioModuleDef = {
  type: 'cvBuddyMini',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'cv buddy mini',
  category: 'output',
  // One tier shorter than cvBuddy: no velocity row on the card.
  size: '2u',
  hp: 2,

  // No `velocity` input — that absence IS the feature.
  inputs: [
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'pitch', type: 'cv' },
  ],
  // No `velCv`. RUN + CLOCK stay, because a mini can be the id-smallest
  // instance and therefore the clock owner — which is what makes "three minis
  // and still have a clock" work.
  outputs: [
    { id: 'pitchCv', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'run', type: 'gate', edge: 'gate' },
    { id: 'clock', type: 'gate', edge: 'trigger' },
  ],
  params: [
    CV_BUDDY_PPQN_PARAM,
    { id: 'clockOffsetMs', label: 'Clock offset', defaultValue: 0, min: -20, max: 20, curve: 'linear', units: 'ms' },
  ],

  // Same lane role as cvBuddy, minus the velocity tap.
  chainWiring: {
    role: 'noteSink',
    laneTap: { pitchIn: 'pitch', gateIn: 'gate' },
    returnsAudio: true,
  },

  // ⚠ THE SAME OBJECT cvBuddy declares — legal here because the two defs differ
  // only in PORTS, and `face.order` names params. See CV_BUDDY_FACE.
  face: CV_BUDDY_FACE,

  docs: {
    explanation:
      "CV BUDDY MINI is the two-jack version of CV BUDDY: it takes a note's PITCH and GATE from a clip lane and hands them to the ES-9's physical DC-coupled outputs, where pitch becomes 1 V/oct and the gate becomes a +5 V pulse — so a rack sequence plays a real Eurorack voice. What it drops is VELOCITY, and that is the entire point: the full CV BUDDY spends three of the ES-9's eight outputs per voice, so two of them fill the device. A mini spends two. Three minis fit in outputs 1-6 and leave jacks 7 and 8 doing RUN and CLOCK, so you can drive three voices and still clock a Pam's. A single mini occupies 1, 2, 7 and 8 and leaves four outputs free for audio sends and returns. Slots are handed out automatically in node-id order and shared with any full CV BUDDYs on the rack — the two kinds draw from one pool, so they can never claim the same physical jack. The id-smallest instance of either kind owns RUN (a gate held high while the transport plays) and CLOCK (PPQN pulses locked to the rack transport); every other instance just plays notes. If there are not enough free outputs left, the card says so rather than silently doing nothing.",
    inputs: {
      pitch: 'Note pitch as CV, normally wired from a clip lane. Passed through unchanged; the ES-9 jack does the 1 V/oct scaling, so this carries app units rather than volts.',
      gate: 'Note gate. High while the note sounds; the ES-9 jack turns it into a +5 V gate for the voice.',
    },
    outputs: {
      pitchCv: "The pitch CV, auto-routed to this instance's allocated ES-9 pitch jack. Patchable by hand too if you want it somewhere else.",
      gate: "The gate input passed through — it stays HIGH while the note is held and low between notes; the reconciler auto-routes it to this instance's allocated ES-9 gate jack (+5 V while high).",
      run: 'A gate held HIGH while the rack transport is playing and LOW when stopped — it follows play state and does not pulse. Driven only by the clock-owner instance (the id-smallest CV BUDDY of either kind), which routes it to ES-9 jack 7. Inert on every other instance.',
      clock: 'A pulse train at the chosen PPQN, phase-locked to the rack transport, for clocking Pam\'s New Workout or any DIN-sync-style input. Owner-only, routed to ES-9 jack 8. Inert on every other instance.',
    },
    controls: {
      ppqn: 'Clock resolution in pulses per quarter note (1, 2, 4, 8, 12, 24, 48; default 24 = DIN-sync). Only the clock-owner instance uses it.',
      clockOffsetMs: 'A manual timing trim for the CLOCK, ±20 ms, to nudge the pulse train earlier or later against downstream gear. Owner-only.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    return createCvBuddyHandle(ctx, node, 'mini');
  },
};
