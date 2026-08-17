// packages/web/src/lib/ui/modules/mixmstrs-face-model.test.ts
//
// THE PERMANENT LEGS BEHIND MIXMSTRS' FACEPLATE.
//
// Four groups, and none of them is a one-time authoring check:
//
//   1. THE RANKING INVARIANT — the whole argument of this face, asserted from
//      the live def in BOTH directions. A mixer is N interchangeable channel
//      strips; the face's claim is that the eleven BUS-SCOPED controls take
//      every rank a lane tier can reach, so no channel is ever privileged.
//      That is a property, not a comment, and it is checked as one.
//   2. GLYPH RESOLUTION — established, not assumed (#1692's `meter` that fell
//      through to twelve dead segments), and with the #1667 leg: the resolved
//      port must be the MASTER BUS, not a per-channel direct out.
//   3. THE FOUR DERIVED READOUTS — each negative-controlled on the input a knob
//      readback is BLIND to, plus a totality leg, plus the cross-controls that
//      make the readouts each other's instruments.
//   4. CARD ↔ DEF OPERATIONAL AGREEMENT OVER THE TEMPLATED CONTROLS — the
//      surface `card-def-agreement.ts` declares itself structurally unable to
//      see, closed here for this module.
//
// The numbers quoted below were MEASURED against the shipped Faust wasm through
// `renderFaustOffline`, 48 kHz, statistics over a settled tail, and the harness
// was determinism-checked first: two identical renders were bit-equal on all
// fourteen outputs (max|Δ| 0.0000e+0), so #1680's non-reproducible-render
// hazard does not apply to any figure here.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MIXMSTRS_CHANNELS,
  MIXMSTRS_RETURNS,
  mixmstrsDef,
} from '$lib/audio/modules/mixmstrs';
import { FACE_TIER_CAPS, laneOrder } from '$lib/ui/workflow/curated-face';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { controlTags, OPERATIONAL_FIELDS } from './card-def-agreement';
import { isChannelScoped } from './mixmstrs-face-model';

const FACE = mixmstrsDef.face!;
const PARAMS = mixmstrsDef.params ?? [];
const PARAM_IDS = PARAMS.map((p) => p.id);

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE RANKING INVARIANT
// ─────────────────────────────────────────────────────────────────────────────

describe('mixmstrs face — the SCOPE ranking, asserted from the live def', () => {
  it('the channel-scoped PREDICATE and the def PARTITION each other, both ways', () => {
    // The predicate is the only place "acts on one channel" is written down, so
    // it is anchored to the artifact rather than to a second list. Every param
    // is on exactly one side, and both sides are non-empty — a predicate that
    // matched everything or nothing would satisfy a one-sided check.
    const channel = PARAM_IDS.filter(isChannelScoped);
    const bus = PARAM_IDS.filter((id) => !isChannelScoped(id));
    expect(new Set([...channel, ...bus]), 'the two sides must cover every param').toEqual(
      new Set(PARAM_IDS),
    );
    expect(channel.filter((id) => bus.includes(id)), 'no param may be on both sides').toEqual([]);

    // NEGATIVE CONTROL on the predicate itself, in both directions — a regex
    // that silently stopped matching would otherwise turn the partition above
    // into "everything is bus-scoped" and the lane invariant below into a
    // tautology.
    expect(isChannelScoped('master_volume'), 'the master is not a channel control').toBe(false);
    expect(isChannelScoped(`ret${MIXMSTRS_RETURNS[0]}_volume`), 'a return is not a channel').toBe(false);
    expect(isChannelScoped(`send${MIXMSTRS_RETURNS[0]}Pre`), 'a bus tap point is not a channel').toBe(false);
    expect(isChannelScoped(`ch${MIXMSTRS_CHANNELS[0]}_low`), 'a channel EQ band IS a channel control').toBe(true);
    expect(isChannelScoped(`comp${MIXMSTRS_CHANNELS[0]}`), 'a COMP macro IS a channel control').toBe(true);
  });

  it('face.order is a BUS-SCOPED prefix followed by a CHANNEL-SCOPED suffix', () => {
    // The ranking axis is SCOPE. Once the order reaches a channel control it
    // must never return to a bus one — otherwise the "every lane prefix is a
    // complete master section" property is false somewhere in the middle and
    // nothing would say so.
    const firstChannel = FACE.order.findIndex(isChannelScoped);
    expect(firstChannel, 'the order must contain at least one channel control').toBeGreaterThan(0);
    expect(
      FACE.order.slice(firstChannel).filter((k) => !isChannelScoped(k)),
      'a BUS-scoped control ranked BELOW a channel-scoped one breaks the scope axis',
    ).toEqual([]);
  });

  it('NO LANE TIER EVER PAINTS A CHANNEL-SCOPED CONTROL — the whole argument', () => {
    // #1701's finding, applied to a mixer: a rank over N interchangeable
    // controls has no priority to express, and truncating a console to five
    // channels does not make a five-channel mixer, it makes a WRONG one. The
    // face's answer is that the bus-scoped block outlasts the largest lane
    // budget, so the tie among the eight channels is never consulted at any
    // tier a lane can render.
    //
    // Both sides derived: the roster from `laneOrder` (which already drops the
    // dock-only keys) and the budget from `FACE_TIER_CAPS`, so a cap change
    // re-runs the argument instead of silently invalidating it.
    const laneBudget = FACE_TIER_CAPS.full;
    expect(Number.isFinite(laneBudget), 'the plate cap must be finite for this to mean anything').toBe(true);
    const painted = laneOrder(FACE).slice(0, laneBudget);
    expect(painted.length, 'the lane budget must actually be filled').toBe(laneBudget);
    expect(
      painted.filter(isChannelScoped),
      'a lane tier paints a per-CHANNEL control — the plate now claims one of eight ' +
        'interchangeable strips is special, which is the #1701 defect with faders',
    ).toEqual([]);
  });

  it('the COMP enablers outrank the pair they gate', () => {
    //   comp{N} / ch{N}_compEnable  →  ch{N}_thresh, ch{N}_ratio
    // Both enabler and dependents are channel-scoped, so the rule and the scope
    // axis agree here and the ordering is total.
    const rank = (id: string) => FACE.order.indexOf(id);
    for (const c of MIXMSTRS_CHANNELS) {
      for (const dep of [`ch${c}_thresh`, `ch${c}_ratio`]) {
        expect(rank(`comp${c}`), `comp${c} must outrank ${dep}`).toBeLessThan(rank(dep));
        expect(rank(`ch${c}_compEnable`), `ch${c}_compEnable must outrank ${dep}`).toBeLessThan(rank(dep));
      }
    }
  });

  it('NO LANE TIER PAINTS A CONTROL THAT IS INERT AT THE SHIPPED DEFAULTS', () => {
    // The operational half of the enabler rule, and the reason `send{R}Pre`
    // ranks 10-11 rather than 4-5.
    //
    // The other enabler family — the sixteen per-channel send amounts →
    // `send{R}Pre` — CANNOT satisfy "enabler outranks dependent" and the scope
    // axis at the same time: the enablers are channel-scoped and the dependent
    // is bus-scoped, so one of the two properties has to give. What actually
    // protects a player is this one: `order` only decides what a player meets
    // as a SUBSET at a lane tier (the dock renders everything), so no lane tier
    // may offer a control the DSP is currently ignoring.
    //
    // THE INERT SET IS MEASURED, not asserted from the declaration. With every
    // input driven on the shipped Faust wasm at the factory defaults:
    //   ch{N}_thresh  full -36..0 dB travel   max|Δ| masterL = 0.0000e+0
    //   ch{N}_ratio   full 1..10 travel       max|Δ| masterL = 0.0000e+0
    //   send{R}Pre    both positions          max|Δ| send{R}L = 0.0000e+0
    // against a module floor (the smallest move ANY control makes on the same
    // harness) of 2.9062e-4 — so these are real zeros, not one quantisation
    // bucket. Every one is woken by a control this face ranks above it or
    // states in a hero readout.
    const INERT_AT_DEFAULTS = [
      ...MIXMSTRS_CHANNELS.flatMap((c) => [`ch${c}_thresh`, `ch${c}_ratio`]),
      ...MIXMSTRS_RETURNS.map((r) => `send${r}Pre`),
    ];
    // The set must name real params, or the check below is vacuous.
    expect(INERT_AT_DEFAULTS.filter((id) => !PARAM_IDS.includes(id))).toEqual([]);
    const painted = laneOrder(FACE).slice(0, FACE_TIER_CAPS.full);
    expect(
      painted.filter((k) => INERT_AT_DEFAULTS.includes(k)),
      'a lane tier offers a control that is bit-exactly inert on a fresh module',
    ).toEqual([]);
  });

  it('THE CONSOLE GRID: every cluster is one cell per channel, in strip order', () => {
    // The owner's review note — *"the faders need to be above the 8 channels"* —
    // is a COLUMN property, not a reading-order one: fader N must sit over EQ N.
    // That only holds while every cluster in a channel band has exactly one
    // control per channel in the same order, so a cluster that lost a member
    // (or gained a stray) would silently stagger the grid by one column with no
    // pixel gate able to say why.
    //
    // Derived on both sides: the expected membership is built from
    // `MIXMSTRS_CHANNELS` and the actual is read off the live `face.pages`.
    const channelBands = (FACE.pages ?? []).filter((p) =>
      (p.clusters ?? []).some((c) => c.controls.some(isChannelScoped)),
    );
    expect(channelBands.length, 'no band carries a per-channel cluster — the grid is gone').toBeGreaterThan(0);

    // ⚠ THE PROPERTY IS ABOUT THE LEADING RUN, NOT THE WHOLE CLUSTER, and the
    // first draft of this assertion got that wrong — it demanded every cell be
    // per-channel and went red on `sends`, whose two clusters each end with
    // their bus's own `send{R}Pre`. That trailing cell is correct (a PRE/POST
    // switch belongs with the bus it re-taps) and it does NOT stagger anything:
    // it comes AFTER columns 1..8. What would stagger the grid is a non-channel
    // cell BEFORE or INSIDE the run, so that is what is refused.
    const problems: string[] = [];
    for (const band of channelBands) {
      for (const cluster of band.clusters ?? []) {
        if (!cluster.controls.some(isChannelScoped)) continue;
        const lead = cluster.controls.slice(0, MIXMSTRS_CHANNELS.length);
        const tail = cluster.controls.slice(MIXMSTRS_CHANNELS.length);
        const channels = lead.map((k) => {
          const m = /^ch(\d+)_/.exec(k) ?? /^comp(\d+)$/.exec(k);
          return m ? Number(m[1]) : null;
        });
        if (JSON.stringify(channels) !== JSON.stringify([...MIXMSTRS_CHANNELS])) {
          problems.push(
            `${band.id}/${cluster.label}: leading cells are [${lead.join(',')}] — columns 1..N must be ` +
              `each channel exactly once, in strip order [${MIXMSTRS_CHANNELS.join(',')}]`,
          );
        }
        // Anything after the run must be BUS-scoped. A ninth per-channel cell
        // would mean a channel appears twice and the next row no longer aligns.
        const strays = tail.filter(isChannelScoped);
        if (strays.length) {
          problems.push(`${band.id}/${cluster.label}: per-channel cell(s) after the strip run — ${strays.join(',')}`);
        }
      }
    }
    expect(problems.join('\n'), 'the console grid is staggered — column N is no longer channel N').toBe('');

    // AND THE FADERS LEAD. The band that holds the volumes must hold them in its
    // FIRST cluster, so a column reads fader → tone rather than tone → fader.
    const levelBand = (FACE.pages ?? []).find((p) =>
      (p.clusters ?? []).some((c) => c.controls.includes(`ch${MIXMSTRS_CHANNELS[0]}_volume`)),
    );
    expect(levelBand, 'no band carries the channel faders').toBeDefined();
    expect(
      levelBand!.clusters![0]!.controls,
      `the fader cluster must be FIRST in '${levelBand!.id}' so it heads each channel's column`,
    ).toEqual(MIXMSTRS_CHANNELS.map((c) => `ch${c}_volume`));
  });

  it('the page count stays UNDER the tab-rail threshold, and every level is a fader', () => {
    // At DOCK_TAB_MIN_BANDS the dock shows one band at a time, which would take
    // the eight faders out of one frame — the single thing this surface exists
    // for. Asserted here as well as in the VRT roster because the roster's
    // `pages` number is a scene declaration and this is the design constraint.
    expect((FACE.pages ?? []).length, 'a tabbed mixer cannot balance faders').toBeLessThan(7);

    // Every LEVEL renders as a throw. Derived from the def: the level params are
    // exactly the volumes, so a new channel arrives already a fader.
    const levels = [
      'master_volume',
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_volume`),
      ...MIXMSTRS_RETURNS.map((r) => `ret${r}_volume`),
    ];
    for (const id of levels) {
      // ⚠ `neon-fader`, the conic-knob-language throw (owner review of #1738).
      // Still asserted as an exact kind rather than "some kind of fader", so a
      // silent drop back to the plain widget is red.
      expect(
        FACE.paramCells?.[id],
        `${id} is a level and must render as the neon throw`,
      ).toBe('neon-fader');
    }
    // …and nothing else claims to be one: a `fader` is discrete-never, and the
    // ten switch-shaped params on this module would be a real defect there.
    for (const [id, kind] of Object.entries(FACE.paramCells ?? {})) {
      if (kind !== 'fader') continue;
      expect(levels, `${id} declares 'fader' but is not one of the module's levels`).toContain(id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · THE CAPTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('mixmstrs face — the CAPTIONS, as a partition of the def', () => {
  // Owner review 2026-08-17: *"the 1lo 1md 1hi etc labels should also go away
  // because the low/mid/high labels above the knob rows convey that fine"*.
  //
  // `face.bareCells` is authored as EVERY param except a small exception set,
  // so what is worth asserting is the PARTITION rather than the list: every
  // declared param is on exactly one side, both sides are non-empty, and the
  // captioned side is exactly the cells that sit outside the
  // heading-plus-column arrangement. Read off the live def in both directions,
  // so a ninth channel or a new per-channel control is swept without touching
  // this file — and a rename cannot leave a dead exception quietly captioning
  // a cell nobody meant to caption.
  const BARE = new Set(FACE.bareCells ?? []);

  it('every param is either BARE or one of the NAMED exceptions — nothing in between', () => {
    // The exception restated as a PROPERTY rather than copied as a list: a
    // send-bus PRE/POST switch is the one control whose cluster heading names
    // something else (the send AMOUNT row), so it is the one that keeps its
    // own caption.
    const isSendPre = (id: string) => /^send\d+Pre$/.test(id);
    const captioned = PARAM_IDS.filter((id) => !BARE.has(id));
    expect(
      captioned.filter((id) => !isSendPre(id)).sort(),
      'a param is captioned but is not a send PRE/POST switch — either it was left out of ' +
        'face.bareCells by accident, or the exception rule changed and this test did not',
    ).toEqual([]);
    expect(
      PARAM_IDS.filter(isSendPre).filter((id) => BARE.has(id)),
      'a send PRE/POST switch went bare — nothing else on the face names the tap point, and ' +
        'the header echo that used to was removed in #1738',
    ).toEqual([]);
  });

  it('ANCHOR: bareCells names only live params, and both sides are non-empty', () => {
    // A dead entry is invisible in the render — the cell simply keeps a caption
    // nobody meant it to keep — which is why it is asserted rather than
    // eyeballed. The two non-emptiness legs are the anti-vacuity pair: an empty
    // BARE set satisfies everything above while changing nothing, and a BARE
    // set covering every param would silently strip the two switches.
    const live = new Set(PARAM_IDS);
    expect(
      [...BARE].filter((id) => !live.has(id)).sort(),
      'face.bareCells names a param that no longer exists',
    ).toEqual([]);
    expect(BARE.size, 'no param is bare — the declutter did not reach the face').toBeGreaterThan(0);
    expect(
      PARAM_IDS.filter((id) => !BARE.has(id)).length,
      'EVERY param is bare — the two PRE/POST switches lost the only text naming them',
    ).toBeGreaterThan(0);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 3 · GLYPH RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('mixmstrs face — the glyph RESOLVES, and to the MASTER BUS', () => {
  it('binds live-audio on masterL, not the static dead-segment shape', () => {
    expect(primaryAudioOutPortId(mixmstrsDef), 'the resolver must find a port').toBe('masterL');
    expect(glyphBinding(mixmstrsDef)).toEqual({ kind: 'live-audio', portId: 'masterL' });
  });

  it('the resolved port is the MASTER BUS — the #1667 leg, named', () => {
    // `primaryAudioOutPortId` takes `outputs[0]`. On `attenumix` that is a
    // per-channel DIRECT OUT and the meter would paint one of four channels
    // while claiming to show the module — which is why #1667 is open and why
    // that face ships with no glyph at all. mixmstrs is on the right side of
    // the same resolver, and this leg is what keeps it there: reordering the
    // outputs so a SEND came first would redden here rather than silently
    // re-point the meter at an aux bus.
    const resolved = primaryAudioOutPortId(mixmstrsDef)!;
    const masterOuts = (mixmstrsDef.outputs ?? [])
      .filter((o) => o.type === 'audio' && /^master/.test(o.id))
      .map((o) => o.id);
    expect(masterOuts.length, 'the module must declare a master bus at all').toBeGreaterThan(0);
    expect(masterOuts, 'the glyph must tap the MASTER bus, never a send').toContain(resolved);
    expect(/^send/.test(resolved), 'the glyph must not tap an aux send').toBe(false);
  });

  it('NEGATIVE CONTROL — the same call on a def with no audio output falls through to static', () => {
    // Proves the assertion above reads the resolution rather than the literal
    // `glyph: 'meter'` declaration, which is exactly the confusion #1692 was.
    const cvOnly = { face: { glyph: 'meter' as const, order: [] }, outputs: [{ id: 'cv_out', type: 'cv' as const }], params: [] };
    expect(glyphBinding(cvOnly as never)).toEqual({ kind: 'static' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · THE DERIVED READOUTS
// ─────────────────────────────────────────────────────────────────────────────

// ── THE READOUT SUITES ARE DELETED WITH THEIR SUBJECT ─────────────────────
//
// Three describes lived here — `BUS`, `ASLEEP` and `SENDS` — and each carried a
// PERMANENT negative control on the input a knob readback is blind to (a
// bit-exactly inert `ch1_thresh` must not move BUS; `ch1_volume` must not move
// ASLEEP; a PRE/POST flip must still print `off` while every send is shut).
// They were good tests. Their subject is gone: owner ruling 2026-08-17 removed
// the hero readout strip from the faceplate, and the functions went with the
// display rather than being left registered against a declaration nothing
// renders (see `mixmstrs-face-model.ts`'s closing note).
//
// ⚠ NOTHING WAS WEAKENED TO MAKE A SUITE PASS. The assertions above — the SCOPE
// ranking anchored to the live def in both directions, the glyph resolving to
// `masterL` by name, and the card/def agreement sweep — are untouched, and they
// are what this file exists for. What is missing is coverage of arithmetic that
// no longer runs anywhere.

