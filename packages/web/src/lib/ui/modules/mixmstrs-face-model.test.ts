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
import {
  busGainLinear,
  busGainText,
  compAsleepText,
  isChannelScoped,
  mixmstrsFaceParams,
  sendText,
} from './mixmstrs-face-model';

const FACE = mixmstrsDef.face!;
const PARAMS = mixmstrsDef.params ?? [];
const PARAM_IDS = PARAMS.map((p) => p.id);

/** A reader over the def's declared defaults, with `overrides` on top — the
 *  shape a `FaceReadoutValue` is actually handed. */
const reader =
  (overrides: Record<string, number> = {}) =>
  (id: string): number | undefined =>
    id in overrides ? overrides[id] : PARAMS.find((p) => p.id === id)?.defaultValue;

const at = (overrides: Record<string, number> = {}) => mixmstrsFaceParams(reader(overrides));

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
      expect(FACE.paramCells?.[id], `${id} is a level and must render as a fader`).toBe('fader');
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
// 2 · GLYPH RESOLUTION
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
// 3 · THE DERIVED READOUTS
// ─────────────────────────────────────────────────────────────────────────────

describe('mixmstrs readout · BUS — the worst-case gain no fader can show', () => {
  it('prints the measured bound at the shipped defaults', () => {
    // MEASURED, ten correlated full-scale sources through the shipped Faust
    // wasm at the factory defaults: masterL peak 6.7187, against the formula's
    // (8 x 0.8 + 2 x 1.0) x 0.8 = 6.72. Mute both returns and it is 5.1190
    // against 5.12. TWO correlated full-scale channels already exceed 1.0
    // (measured peak 1.2797) and nothing in the module limits.
    expect(busGainText(at())).toBe('≤ 6.72× · +16.5 dB');
  });

  it('NEGATIVE CONTROL — ch1_thresh across its WHOLE travel must not move it', () => {
    // `ch1_thresh` is bit-exactly inert at the shipped defaults (measured
    // 0.0000e+0 over -36 -> 0 dB with every input driven), so a bus-gain readout
    // that reacted to it would be reporting a control the DSP is ignoring.
    const lo = PARAMS.find((p) => p.id === 'ch1_thresh')!.min!;
    const hi = PARAMS.find((p) => p.id === 'ch1_thresh')!.max!;
    expect(busGainText(at({ ch1_thresh: lo }))).toBe(busGainText(at()));
    expect(busGainText(at({ ch1_thresh: hi }))).toBe(busGainText(at()));
  });

  it('LEG — master_volume 0.8 -> 1.0 scales it by EXACTLY 1.25', () => {
    // The render agrees: masterL peak ratio 1.250030 across the same move. A
    // readout that only ever went up with a channel fader would pass a
    // one-sided test while being blind to the master.
    const base = busGainLinear(at());
    const full = busGainLinear(at({ master_volume: 1 }));
    expect(full / base).toBeCloseTo(1.25, 12);
  });

  it('LEG — the RETURNS are in the sum, which no channel fader can reveal', () => {
    // The measurement that forces this leg: with both return volumes at 0 the
    // same ten-source render peaks at 5.1190 instead of 6.7187. A readout that
    // summed only `ch{N}_volume` would pass every other leg in this block.
    const muted = Object.fromEntries(MIXMSTRS_RETURNS.map((r) => [`ret${r}_volume`, 0]));
    expect(busGainLinear(at(muted))).toBeCloseTo(5.12, 12);
    expect(busGainLinear(at())).toBeCloseTo(6.72, 12);
  });

  it('TOTALITY — a fresh node, NaN and ±Infinity all render a string, never a throw', () => {
    // The function runs on every render, so a throw takes the faceplate down
    // mid-drag.
    expect(busGainText(mixmstrsFaceParams(() => undefined))).toBe('≤ 6.72× · +16.5 dB');
    expect(busGainText(at({ master_volume: Number.NaN }))).toBe('≤ 6.72× · +16.5 dB');
    expect(() => busGainText(at({ master_volume: Number.POSITIVE_INFINITY }))).not.toThrow();
    expect(() => busGainText(at({ ch1_volume: Number.NEGATIVE_INFINITY }))).not.toThrow();
    expect(busGainText(at({ master_volume: 0 }))).toBe('0× · −∞ dB');
    for (const s of [
      busGainText(at({ master_volume: Number.POSITIVE_INFINITY })),
      busGainText(at({ ch1_volume: Number.NEGATIVE_INFINITY })),
    ]) {
      expect(s, 'a readout must never print a raw NaN at the user').not.toMatch(/NaN/);
    }
  });
});

describe('mixmstrs readout · ASLEEP — the sixteen faders that do nothing', () => {
  it('counts every gated fader at the shipped defaults', () => {
    // MEASURED: sweeping ch1_thresh across its entire -36..0 dB travel with all
    // twenty audio inputs driven moves masterL by 0.0000e+0, and ch1_ratio
    // (1..10) likewise. Open the enable and the same sweeps move it by
    // 1.8631e-1 and 1.1563e-1. The module's own floor — the smallest move ANY
    // control makes on the same harness — is ch1_volume 0.800 -> 0.801 =
    // 2.9062e-4, so the plateau is a real zero and not a quantisation bucket.
    expect(compAsleepText(at())).toBe('16 asleep');
  });

  it('NEGATIVE CONTROL — a level change wakes nothing', () => {
    expect(compAsleepText(at({ ch1_volume: 0 }))).toBe('16 asleep');
    expect(compAsleepText(at({ master_volume: 1 }))).toBe('16 asleep');
  });

  it('LEG A — the MANUAL switch wakes its pair', () => {
    expect(compAsleepText(at({ ch1_compEnable: 1 }))).toBe('14 asleep');
  });

  it('LEG B — the MACRO wakes it too, and the two legs are each other\'s controls', () => {
    // The module ships TWO independent enablers. A readout watching only the
    // manual switch passes LEG A and prints `16 asleep` here while the DSP has
    // already engaged the compressor — the macro writes `compEnable` downstream
    // through `mapCompMacro`, which this model imports rather than restates.
    expect(compAsleepText(at({ comp1: 0.5 }))).toBe('14 asleep');
    // …and the macro's own bypass point is the def's, not a guessed one.
    expect(compAsleepText(at({ comp1: 0 }))).toBe('16 asleep');
  });

  it('reads `all live` only when EVERY channel is awake', () => {
    const allOn = Object.fromEntries(MIXMSTRS_CHANNELS.map((c) => [`ch${c}_compEnable`, 1]));
    expect(compAsleepText(at(allOn))).toBe('all live');
    // One short of the whole bank must NOT read `all live`.
    const { [`ch${MIXMSTRS_CHANNELS[0]}_compEnable`]: _drop, ...allButOne } = allOn;
    expect(compAsleepText(at(allButOne))).toBe('2 asleep');
  });

  it('TOTALITY — a fresh node and a NaN both render', () => {
    expect(compAsleepText(mixmstrsFaceParams(() => undefined))).toBe('16 asleep');
    expect(compAsleepText(at({ comp1: Number.NaN }))).toBe('16 asleep');
    expect(() => compAsleepText(at({ ch1_compEnable: Number.POSITIVE_INFINITY }))).not.toThrow();
  });
});

describe('mixmstrs readout · SENDS — the tap point AND whether the bus is alive', () => {
  it('both buses read POST and OFF at the shipped defaults', () => {
    expect(sendText(0, at())).toBe('POST · off');
    expect(sendText(1, at())).toBe('POST · off');
  });

  it('NEGATIVE CONTROL — the switch alone must still read `off` in BOTH positions', () => {
    // THE MEASUREMENT THAT FORCES THIS LEG: with every send at 0, flipping
    // send1Pre 0 -> 1 moves send1L by 0.0000e+0 and masterL by 0.0000e+0. Open
    // every send to 0.5 and the same flip moves send1L by 3.2138e-1. A caption
    // that merely echoed the switch would print `PRE` and imply something
    // happened — on the control the owner's ES-9 send/return rack depends on.
    expect(sendText(0, at({ send1Pre: 1 }))).toBe('PRE · off');
    expect(sendText(1, at({ send2Pre: 1 }))).toBe('PRE · off');
  });

  it('LEG — opening a send is what makes the bus alive', () => {
    expect(sendText(0, at({ ch3_send1: 0.5 }))).toBe('POST · 1 ch');
    expect(sendText(0, at({ ch3_send1: 0.5, send1Pre: 1 }))).toBe('PRE · 1 ch');
    const allSend1 = Object.fromEntries(MIXMSTRS_CHANNELS.map((c) => [`ch${c}_send1`, 0.2]));
    expect(sendText(0, at(allSend1))).toBe(`POST · ${MIXMSTRS_CHANNELS.length} ch`);
  });

  it('CROSS-CONTROL — the two buses are independent, in both directions', () => {
    // send 2's amounts must not move send 1's readout and vice versa. The DSP
    // sums them separately (`mixmstrs.dsp:336-339`) and the two PRE flags are
    // explicitly per-bus; a model that indexed the wrong row would pass every
    // single-bus leg above.
    expect(sendText(0, at({ ch3_send2: 1, send2Pre: 1 }))).toBe('POST · off');
    expect(sendText(1, at({ ch3_send1: 1, send1Pre: 1 }))).toBe('POST · off');
  });

  it('TOTALITY — a fresh node and a NaN both render', () => {
    expect(sendText(0, mixmstrsFaceParams(() => undefined))).toBe('POST · off');
    expect(sendText(0, at({ ch1_send1: Number.NaN }))).toBe('POST · off');
    expect(() => sendText(0, at({ send1Pre: Number.NaN }))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · CARD ↔ DEF, OVER THE CONTROLS THE TREE-WIDE GATE CANNOT SEE
// ─────────────────────────────────────────────────────────────────────────────

describe('MixmstrsCard ↔ def — the TEMPLATED controls card-def-agreement is blind to', () => {
  // `card-def-agreement.ts` keys on a LITERAL `paramId="…"` and says so in its
  // stated blind spots: a control naming its param through an EXPRESSION
  // (`paramId={`ch${ch}_volume`}`) reads as "no paramId at all". On this card
  // that is EIGHTY of the eighty-nine rendered controls — the largest single
  // un-scanned card surface in the repo — because eight channel strips are one
  // `{#each}` body. (The card's own comment says the two RETURN strips are
  // deliberately UNROLLED for exactly this reason; the channels were not.)
  //
  // MEASURED WHEN THIS FACE WAS AUTHORED: expanding every template and
  // comparing all four OPERATIONAL fields found ZERO divergence — every range,
  // default and curve the card re-types agrees with the def. That is a result,
  // not an absence of one, and this test is what keeps it true. The VOCABULARY
  // tier is a different story and is filed separately: all eighty templated
  // controls disagree on `label` (card `LOW` under a `CH 3` column header, def
  // `3Lo`), systematically and benignly, and the DOCK renders the DEF's label —
  // which is what makes the def's channel-indexed labels the right ones for the
  // console grid this face builds.
  //
  // Module-scoped on purpose: teaching the tree-wide scanner to expand
  // templates is a platform change that would redden other cards, and a
  // behaviour change does not belong in a face PR.
  const cardSrc = readFileSync(
    fileURLToPath(new URL('./MixmstrsCard.svelte', import.meta.url)),
    'utf8',
  );

  /** Every `<Knob …/>` on the card, with its `paramId` EXPANDED over the def's
   *  own channel list when it is a template. */
  function resolvedControls(): { id: string; line: number; props: string }[] {
    const out: { id: string; line: number; props: string }[] = [];
    for (const t of controlTags(cardSrc)) {
      const tpl = /paramId=\{`([^`]+)`\}/.exec(t.props)?.[1];
      const ids = t.paramId
        ? [t.paramId]
        : tpl
          ? MIXMSTRS_CHANNELS.map((c) => tpl.replace(/\$\{ch\}/g, String(c)))
          : [];
      for (const id of ids) out.push({ id, line: t.line, props: t.props });
    }
    return out;
  }

  const numProp = (props: string, field: string): number | undefined => {
    const m = new RegExp(`(?:^|[^A-Za-z0-9_])${field}=\\{\\s*(-?[0-9][0-9._eE+-]*)\\s*\\}`).exec(props);
    return m ? Number(m[1]) : undefined;
  };
  const strProp = (props: string, field: string): string | undefined =>
    new RegExp(`(?:^|[^A-Za-z0-9_])${field}="([^"]*)"`).exec(props)?.[1];

  it('the scan is NOT VACUOUS — it resolves the whole templated bank', () => {
    // A bare green here is exactly what the tree-wide gate's own header warns
    // about: a scan that resolved nothing is indistinguishable from a clean one.
    const rows = resolvedControls();
    const templated = rows.filter((r) => !/paramId="/.test(r.props));
    expect(templated.length, 'no templated control resolved — the scan is measuring nothing')
      .toBeGreaterThanOrEqual(MIXMSTRS_CHANNELS.length);
    // Every resolved id must be a real param, in both directions for the bank:
    // a template that expanded to a non-param would otherwise be skipped.
    expect(rows.filter((r) => !PARAM_IDS.includes(r.id)).map((r) => `${r.id} @${r.line}`)).toEqual([]);
  });

  it('no control contradicts the def on min / max / defaultValue / curve', () => {
    const bad: string[] = [];
    for (const row of resolvedControls()) {
      const p = PARAMS.find((q) => q.id === row.id)!;
      for (const field of OPERATIONAL_FIELDS) {
        if (field === 'curve') {
          const got = strProp(row.props, 'curve');
          if (got !== undefined && got !== (p.curve ?? 'linear')) {
            bad.push(`${row.id}.curve card=${got} def=${p.curve ?? 'linear'} @${row.line}`);
          }
          continue;
        }
        const got = numProp(row.props, field);
        const want = p[field];
        if (got !== undefined && want !== undefined && got !== want) {
          bad.push(`${row.id}.${field} card=${got} def=${want} @${row.line}`);
        }
      }
    }
    expect(
      bad.sort(),
      'a MixmstrsCard control disagrees with its def about what it can WRITE or how it MAPS — ' +
        'and no tree-wide gate can see it, because the id is a template',
    ).toEqual([]);
  });

  it('every def param is reachable from the card or from a NAMED non-knob affordance', () => {
    // The STOP-2 property, kept permanent: promotion removes the card, so
    // anything that lives ONLY there becomes unreachable. Here the answer is
    // that nothing does — every affordance is a ParamDef — and the two that are
    // not knobs are named rather than assumed.
    const knobbed = new Set(resolvedControls().map((r) => r.id));
    const nonKnob = MIXMSTRS_RETURNS.map((r) => `send${r}Pre`); // the `.prepost` buttons
    for (const id of nonKnob) {
      expect(cardSrc, `${id} must still be written by the card's button`).toContain(`set('${id}')`);
    }
    expect(
      PARAM_IDS.filter((id) => !knobbed.has(id) && !nonKnob.includes(id)),
      'a def param the card can no longer reach — either the card lost a control or this list is stale',
    ).toEqual([]);
  });
});
