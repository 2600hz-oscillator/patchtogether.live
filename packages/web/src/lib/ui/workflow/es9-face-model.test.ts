// ES-9's face, pinned where a def-reading gate cannot see it — plus the ONE
// behaviour the promotion fixed, which no gate anywhere could see.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `dock-row-plan`, `faces-parity`) already assert that this face is COMPLETE
// and that every cell OPERATES. What they cannot ask is whether the specific
// decisions in it are the ones that were argued for, so this file pins the ones
// a future edit could reverse while every other gate stayed green, and
// negative-controls each in the direction it would actually break.

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  ES9_CLASS_AUDIO,
  ES9_CLASS_CV,
  ES9_CLASS_GATE,
  ES9_CLASS_NAMES,
  ES9_CLASS_OPTIONS,
  ES9_CLASS_PITCH,
  ES9_FACE,
  ES9_REF_LINE,
  ES9_REF_MODULAR,
  ES9_REF_NAMES,
  ES9_REF_OPTIONS,
  ES9_REF_PARAM_IDS,
  es9BridgeConfig,
  es9Def,
  es9OutputModes,
} from '$lib/audio/modules/es9';
import { STRICT_FACES } from './strict-faces';
import { curatedFace, dockFacePlan } from './curated-face';
import { paramCellKind } from './shell-control-kind';
import { panelCellKeys, shellCellKeys } from './shell-cells';
import { consoleGridCols, faceConsoleGridCols } from './console-grid';
import { glyphBinding } from './shell-glyph-live';
import {
  es9BridgeDetail,
  es9BridgeLit,
  es9CvBuddyDetail,
  es9CvBuddyLit,
  es9XrunDetail,
  es9XrunLit,
} from '$lib/ui/modules/es9/es9-status-model';
import type { Es9OwnerSnapshot } from '$lib/audio/es9/bridge-owner';

const DOWN: Es9OwnerSnapshot = {
  state: 'disconnected' as Es9OwnerSnapshot['state'],
  detail: undefined,
  device: null,
  meters: null,
  rtt: null,
  supported: true,
};

const CLASS_PARAMS = es9Def.params.filter((p) => /_class$/.test(p.id));
const REF_PARAMS = es9Def.params.filter((p) => /_ref$/.test(p.id));

describe('es9 face — the promotion itself', () => {
  it('is promoted, and every ranked key resolves to a param or a registered cell', () => {
    expect(STRICT_FACES.has('es9')).toBe(true);

    // DERIVED MEMBERSHIP, both directions, over the two routes this face uses.
    // Family keys must be exactly the registered cells; the rest must be exactly
    // the declared params. A cell nobody ranks is dead code; a ranked key that
    // is neither renders the explicitly-INERT cell.
    const ranked = [...ES9_FACE.order];
    const familyKeys = ranked.filter((k) => /-\{n\}$/.test(k)).sort();
    const paramKeys = ranked.filter((k) => !/-\{n\}$/.test(k)).sort();
    expect(familyKeys).toEqual(shellCellKeys('es9'));
    expect(paramKeys).toEqual(es9Def.params.map((p) => p.id).sort());

    // …and the family templates match the declared controlFamilies, which is
    // what `module-docs-lint`'s card-drift leg then anchors to real card source.
    expect(familyKeys.map((k) => k.replace(/-\{n\}$/, ''))).toEqual(
      (es9Def.controlFamilies ?? []).map((f) => f.id).sort(),
    );
  });

  it('CONNECT ranks FIRST — the module is silent until the helper answers', () => {
    // The practical argument for promoting this module. `laneRenderKind` gave
    // it a PLACEHOLDER tile with zero ranked controls, so both gestures lived
    // behind the dock full view on a module that does nothing until one of them
    // is pressed. Demoting CONNECT below rank 3 would push it off the compact
    // tier and quietly restore that.
    expect(ES9_FACE.order[0]).toBe('es9-connect-{n}');
    expect(ES9_FACE.order[1]).toBe('es9-disconnect-{n}');
  });

  it('BOTH gestures actually reach the LANE TILE — the claim, resolved', () => {
    // ⚠ ASSERTED AT THE TIER, NOT AT THE RANK. "CONNECT is rank 1" is a
    // statement about the declaration; "CONNECT paints on a lane tile" is a
    // statement about the RESOLVER, and the two come apart (laneOrder drops a
    // hero cell, the tier caps are geometry, and a glyph costs a cell at
    // compact). Running the real selector is the only way to ask it.
    for (const tier of ['compact', 'full'] as const) {
      const resolved = curatedFace(es9Def, tier);
      expect(resolved, `${tier} resolves`).not.toBeNull();
      const keys = resolved!.controls.map((c) => c.key);
      expect(keys, `CONNECT must survive the ${tier} tier`).toContain('es9-connect-{n}');
      expect(keys, `DISCONNECT must survive the ${tier} tier`).toContain('es9-disconnect-{n}');
    }
    // MINI caps at one cell, and the one it keeps is the gesture the module is
    // silent without.
    expect(curatedFace(es9Def, 'mini')!.controls.map((c) => c.key)).toContain('es9-connect-{n}');
  });

  it('and NOTHING here is dock-restricted — the other half of that claim', () => {
    // `curatedFace` keeping a key at the compact tier is necessary and not
    // sufficient: a PANEL cell is filtered out of every non-dock tier. This
    // module registers none, so the plan above is what the lane renders — and
    // pinning it means "the gestures reach the lane" cannot be quietly
    // falsified by re-shaping a cell into a panel later.
    expect(panelCellKeys('es9')).toEqual([]);
  });

  it('NEGATIVE CONTROL: the tier selector CAN drop a key, so the leg above is not vacuous', () => {
    // If `curatedFace` returned every key at every tier, the checks above would
    // pass on any ranking at all. The cap is real, and with 46 keys (2 gestures
    // + 22 classes + 22 refs) it is not remotely close.
    const dock = curatedFace(es9Def, 'dock');
    const mini = curatedFace(es9Def, 'mini');
    expect(dock!.controls.length).toBe(ES9_FACE.order.length);
    expect(mini!.controls.length).toBeLessThan(dock!.controls.length);
    // And the ranked-LAST key is one a lane tier drops, so "survives the tier"
    // genuinely discriminates between rank 1 and rank 46.
    expect(
      curatedFace(es9Def, 'compact')!.controls.map((c) => c.key),
    ).not.toContain(ES9_FACE.order[ES9_FACE.order.length - 1]);
  });
});

describe('es9 face — the 22 class switches are SELECTABLE, not dials', () => {
  it('every class param carries the roster, and it is DERIVED from the class names', () => {
    // The roster exists for SELECTABILITY: without it `paramCellKind` falls
    // through to a knob, and a four-state switch on a dial is a control a drag
    // quantises straight back to where it started (`moog962`, twice).
    for (const p of CLASS_PARAMS) {
      expect(p.options, `${p.id} must carry the class roster`).toBe(ES9_CLASS_OPTIONS);
    }
    // DERIVED, never re-typed: the labels ARE the names the worklet indexes by,
    // and their VALUES are the indices. A roster typed by hand could name
    // `gate` at index 2 and nothing outside a hardware session would notice.
    expect(ES9_CLASS_OPTIONS.map((o) => o.label)).toEqual([...ES9_CLASS_NAMES]);
    expect(ES9_CLASS_OPTIONS.map((o) => o.value)).toEqual([
      ES9_CLASS_AUDIO, ES9_CLASS_CV, ES9_CLASS_PITCH, ES9_CLASS_GATE,
    ]);
  });

  it('the roster is DENSE, which is why `optionsExhaustive` must NOT be declared', () => {
    // `param-vocabulary` refuses a redundant declaration by name: a roster that
    // covers every step buys an exemption from a rule it already satisfies.
    // Asserted here as the PROPERTY rather than as the absence, so a future
    // author who widens the class space sees which half moved.
    for (const p of CLASS_PARAMS) {
      const steps = Math.round(p.max - p.min) + 1;
      expect(ES9_CLASS_OPTIONS.length, `${p.id} roster covers every step`).toBe(steps);
      expect(p.optionsExhaustive, `${p.id} must not declare it`).toBeUndefined();
    }
  });

  it('so the DOCK renders SEGMENTED cells and the LANE renders knobs', () => {
    const none = new Set<string>();
    for (const p of CLASS_PARAMS) {
      expect(paramCellKind(p, none, 'dock')).toBe('segmented');
      // Every non-dock tier is a knob column by construction — the roster still
      // earns its place there, because `paintsReadout` paints the option NAME
      // rather than a number.
      expect(paramCellKind(p, none, 'lane')).toBe('knob');
    }
  });

  it('NEGATIVE CONTROL: stripping the roster really does produce the inert dial', () => {
    // Without this, the leg above would look identical if `paramCellKind` had
    // been broken to answer 'segmented' for everything.
    const bare = { ...CLASS_PARAMS[0]!, options: undefined };
    expect(paramCellKind(bare, new Set<string>(), 'dock')).toBe('knob');
  });
});

describe('es9 face — the 22 REF toggles (ADR-020) are SELECTABLE, sit beside their jack, and default to today', () => {
  it('every ref param carries the roster, DERIVED from the two reference names', () => {
    expect(REF_PARAMS.map((p) => p.id).sort()).toEqual([...ES9_REF_PARAM_IDS].sort());
    for (const p of REF_PARAMS) {
      expect(p.options, `${p.id} must carry the ref roster`).toBe(ES9_REF_OPTIONS);
      expect(p.defaultValue, `${p.id} defaults to modular (today)`).toBe(ES9_REF_MODULAR);
    }
    expect(ES9_REF_OPTIONS.map((o) => o.label)).toEqual([...ES9_REF_NAMES]);
    expect(ES9_REF_OPTIONS.map((o) => o.value)).toEqual([ES9_REF_MODULAR, ES9_REF_LINE]);
  });

  it('the roster is DENSE (2 options / 2 steps), so `optionsExhaustive` must NOT be declared', () => {
    for (const p of REF_PARAMS) {
      const steps = Math.round(p.max - p.min) + 1;
      expect(ES9_REF_OPTIONS.length, `${p.id} roster covers every step`).toBe(steps);
      expect(p.optionsExhaustive, `${p.id} must not declare it`).toBeUndefined();
    }
  });

  it('so the DOCK renders SEGMENTED cells (two captioned buttons, not an anonymous switch) and the LANE renders knobs', () => {
    const none = new Set<string>();
    for (const p of REF_PARAMS) {
      expect(paramCellKind(p, none, 'dock'), p.id).toBe('segmented');
      expect(paramCellKind(p, none, 'lane'), p.id).toBe('knob');
    }
  });

  it('NEGATIVE CONTROL: stripping the roster produces the anonymous toggle, so the segmented read is earned', () => {
    // A 0..1 discrete default 0 with no roster is `looksLikeToggle` → 'toggle'
    // at the dock: the ref would still be operable, but nameless.
    const bare = { ...REF_PARAMS[0]!, options: undefined };
    expect(paramCellKind(bare, new Set<string>(), 'dock')).toBe('toggle');
  });

  it('GROUP BY LANE: each ref is ranked IMMEDIATELY after its own jack\'s class, in the same page and cluster', () => {
    // Owner ruling 2026-09-04: lane 1 is for ALL things lane 1 — never a page
    // of classes and then a page of refs.
    const order = [...ES9_FACE.order];
    for (const id of ES9_REF_PARAM_IDS) {
      const cls = id.replace(/_ref$/, '_class');
      expect(order.indexOf(id), `${id} follows ${cls}`).toBe(order.indexOf(cls) + 1);
      const page = (ES9_FACE.pages ?? []).find((pg) => pg.controls.includes(id));
      expect(page, `${id} is on a page`).toBeDefined();
      expect(page!.controls, `${id} shares ${cls}'s page`).toContain(cls);
      const cluster = (page!.clusters ?? []).find((c) => c.controls.includes(id));
      expect(cluster, `${id} is clustered`).toBeDefined();
      expect(cluster!.controls, `${id} shares ${cls}'s cluster`).toContain(cls);
    }
    // The ranked-LAST key is now the last jack's ref (the e2e negative control
    // reads it by name).
    expect(ES9_FACE.order[ES9_FACE.order.length - 1]).toBe('in14_ref');
  });
});

describe('es9 face — the bands, and why the wide ones are clustered', () => {
  it('THREE bands, no tab rail, and none of them padded toward one', () => {
    const ids = (ES9_FACE.pages ?? []).map((p) => p.id);
    expect(ids).toEqual(['bridge', 'out', 'in']);
    // `DOCK_TAB_MIN_BANDS` is 7. Three honest pages render as one column and
    // that is correct; `face.tabbed` is owner-instruction-only and not declared.
    expect(ES9_FACE.tabbed).toBeUndefined();
  });

  it('no page is named `signal` or `voice` — those ids belong to the rear rails', () => {
    const ids = (ES9_FACE.pages ?? []).map((p) => p.id);
    expect(ids).not.toContain('signal');
    expect(ids).not.toContain('voice');
  });

  it('BOTH jack bands are CONSOLE GRIDS of 4 (one JACK PAIR per row), so the face-wide ruler engages', () => {
    // ⚠ THE WIDTH FIX, PINNED AS A PROPERTY. The class cells are segmented
    // cells painting FOUR option labels each — wider than a knob by a long
    // way. Before the ref toggle the clustered plate measured 891 CSS px
    // against the 1220 px box with two 4-option cells per half-row; a row is
    // now class, ref, class, ref — two 4-option and two 2-option cells — which
    // is NARROWER than the four 4-option cells it replaces. Un-clustering
    // either band puts sixteen or twenty-eight cells on one row, the shape
    // `moog960/stepmode` measured at 1336 px and had refused.
    //
    // ONE JACK PAIR PER CLUSTER is the group-by-lane ruling applied twice:
    // column j means the same thing in every row of both bands — class of the
    // pair's first jack, its ref, class of the second, its ref. Fourteen
    // input jacks now divide evenly (7 pairs), so the IN band that used to be
    // RAGGED (4/4/4/2, refused by the rule) is a console grid too.
    const plan = dockFacePlan(es9Def)!;
    const byId = new Map(plan.map((b) => [b.id, b] as const));
    expect(consoleGridCols(byId.get('out')!), 'four equal clusters of four').toBe(4);
    expect(consoleGridCols(byId.get('in')!), 'seven equal clusters of four').toBe(4);
    expect(consoleGridCols(byId.get('bridge')!), 'no clusters at all').toBeNull();
    // TWO console bands (FACE_CONSOLE_MIN_BANDS), both 4 wide, so the FACE-WIDE
    // ruler engages at 4: a class column above a class column, a ref above a ref.
    expect(faceConsoleGridCols(plan)).toBe(4);
  });

  it('every cluster is a subset of its own band, and covers it exactly once', () => {
    // Membership lives in `controls`; a cluster is a grouping HINT over keys the
    // page already claims. A cluster naming a key the band does not hold would
    // render nowhere, and a key in two clusters would render twice.
    for (const page of ES9_FACE.pages ?? []) {
      const claimed = page.controls;
      const clustered = (page.clusters ?? []).flatMap((c) => c.controls);
      for (const k of clustered) expect(claimed, `${page.id} claims ${k}`).toContain(k);
      expect(new Set(clustered).size, `${page.id}: no key in two clusters`).toBe(clustered.length);
      if (clustered.length > 0) {
        expect([...clustered].sort(), `${page.id}: clusters cover the band`).toEqual(
          [...claimed].sort(),
        );
      }
    }
  });
});

describe('es9 face — the glyph is REACHABLE, and that is unusual for a binder', () => {
  it('`meter` resolves to a LIVE audio binding on in1', () => {
    expect(ES9_FACE.glyph).toBe('meter');
    // `glyphBinding` short-circuits on `primaryAudioOutPortId`, which matches
    // `type === 'audio'` EXACTLY. The MIDI binders declare no audio output and
    // are all forced to 'none'; this module declares sixteen, so the glyph is a
    // real picture of a real port rather than the dead static binding.
    expect(glyphBinding(es9Def)).toEqual({ kind: 'live-audio', portId: 'in1' });
  });

  it('NEGATIVE CONTROL: with no audio output the same glyph would be DEAD', () => {
    // Without this the leg above would look identical if `glyphBinding` had been
    // broken to answer 'live-audio' unconditionally.
    const noAudio = { ...es9Def, outputs: es9Def.outputs.filter((o) => o.type !== 'audio') };
    expect(glyphBinding(noAudio).kind).toBe('static');
  });
});

describe('es9 face — where the deleted readouts went', () => {
  // The card painted a state word, a rate, a channel count, a round trip and an
  // xrun pair as visible text. None may paint. All are still known, and each is
  // composed into the sentence on the lamp that indicates it — which is
  // UNPAINTED, and therefore invisible to a VRT baseline and to a human reading
  // one. That is why they are decided in a model file and asserted here.

  it('the BRIDGE lamp is dark with no helper, and names the failure', () => {
    expect(es9BridgeLit(DOWN)).toBe(false);
    expect(es9BridgeDetail(DOWN)).toMatch(/no es9-bridge app answered/i);
    // The URL comes from `es9BridgeUrl()`, never re-typed, so an overridden
    // build cannot send the reader to the wrong port.
    expect(es9BridgeDetail(DOWN)).toMatch(/ws:\/\//);
  });

  it('…and CARRIES rate, channel count and round trip when the link is up', () => {
    // The three numbers the card printed, all in one `aria-label`. This is the
    // positive control for the removal: they are gone as TEXT, not as
    // information.
    const up: Es9OwnerSnapshot = {
      ...DOWN,
      state: 'connected',
      device: { name: 'ES-9', rate: 48000, inputChannels: 16, outputChannels: 16 } as never,
      rtt: 4.25,
    };
    expect(es9BridgeLit(up)).toBe(true);
    const s = es9BridgeDetail(up);
    expect(s).toContain('ES-9');
    expect(s).toContain('48 kHz');
    expect(s).toContain('16×16');
    expect(s).toContain('4.3 ms');
  });

  it('the eight connection states collapse onto two lamp states, and each is NAMED', () => {
    // ⚠ THE NARROWING, ASSERTED RATHER THAN ADMITTED. A lamp has two states and
    // `Es9ConnectionState` has eight, so `busy` and `device_lost` show the same
    // dark lamp at rest. What must NOT collapse is the sentence: two failures
    // with different fixes have to read differently on hover, or the trade
    // stops being a trade.
    const states = ['idle', 'stopped', 'connecting', 'busy', 'device_lost', 'disconnected'];
    const said = states.map((state) => es9BridgeDetail({ ...DOWN, state: state as never }));
    for (const s of said) expect(s.length, 'every state says something').toBeGreaterThan(20);
    expect(new Set([said[3], said[4]]).size, 'busy and device_lost read differently').toBe(2);
    expect(said[3]).toMatch(/another client/i);
    expect(said[4]).toMatch(/unplug/i);
  });

  it('the XRUN lamp is the count, and it lights on EITHER direction', () => {
    // ⚠ THE MOST CONSEQUENTIAL REMOVAL IN THIS PR, and it has a downstream
    // dependant: `CvBuddyStatusBody.svelte` names the ES-9's xruns as the other
    // half of diagnosing an unstable clock, on a SHIPPED faceplate. Deleting
    // the surface without replacing it would have broken a diagnosis that lives
    // on a different module's plate.
    const meters = (underruns: number, overruns: number) =>
      ({ ...DOWN, state: 'connected' as const, meters: { underruns, overruns } as never });
    expect(es9XrunLit(meters(0, 0))).toBe(false);
    expect(es9XrunLit(meters(3, 0))).toBe(true);
    expect(es9XrunLit(meters(0, 1))).toBe(true);
    // Both directions still reach the reader, which is what one lamp costs and
    // what the detail buys back.
    expect(es9XrunDetail(meters(3, 0))).toMatch(/3 underruns, 0 overruns/);
    expect(es9XrunDetail(meters(0, 1))).toMatch(/0 underruns, 1 overrun\b/);
    // A lamp PRESENT AND DARK says "healthy" where the card's `0/0` had to
    // argue that a zero must always render.
    expect(es9XrunDetail(meters(0, 0))).toMatch(/keeping up/i);
    expect(es9XrunDetail(DOWN)).toMatch(/nothing is being measured/i);
  });

  it('the CV BUDDY lamp says a change here will be REVERTED', () => {
    // The card called its version "purely informational", which undersold it:
    // the reconciler owns those jacks' out-class, so eight identical editable
    // cells of which three are silently reverted is a control that looks alive
    // and is not.
    expect(es9CvBuddyLit([])).toBe(false);
    expect(es9CvBuddyDetail([])).toMatch(/no CV Buddy/i);
    expect(es9CvBuddyLit(['1', '2', '3'])).toBe(true);
    const s = es9CvBuddyDetail(['1', '2', '7 (run)']);
    expect(s).toContain('1, 2, 7 (run)');
    expect(s).toMatch(/reverted/i);
  });
});

describe('es9 — the UNDERRUN POLICY now follows the param, with no view mounted', () => {
  // ⚠ THIS IS NOT A FACE TEST. It is the defect the promotion had to fix first,
  // and it was live on `main` independently of any face: `updateEs9Config` — the
  // message carrying the bridge's per-jack HOLD-vs-FADE policy — had exactly one
  // caller, on a card the default shell has not mounted in a lane since
  // ownership moved to the engine node. So the policy did not follow a class
  // change for anyone, and the CV-Buddy janitor's `out{N}_class` writes could
  // never reach it at all, since they go straight through the store.
  //
  // ⚠ NO GATE COULD SEE IT, and the reason is structural: `outputModes` is a
  // wire message to a process that does not exist on CI. So the observable has
  // to be the CALL, and this is a real positive control rather than a
  // probe-and-skip: it drives the same pure mapping the wire message carries.

  beforeEach(() => { vi.restoreAllMocks(); });

  it('a GATE out-class maps to the FADE policy on that jack, by channel', () => {
    // Jack 3 rides USB channel 11 under the ES-9's default routing, i.e. index
    // 10 (`JACK_CHANNEL_BASE` is 8). Gate FAILS LOW deliberately: a held gate
    // does not merely lose information, it emits a wrong SUSTAINED signal — a
    // stuck note, a stuck envelope, a clock that stopped.
    const cfg = es9BridgeConfig({ out3_class: ES9_CLASS_GATE });
    expect(cfg.outputModes['10']).toBe('audio');
    // …while cv and pitch HOLD, because a pitch collapsing to 0 V is a wrong
    // note rather than a silence.
    expect(es9BridgeConfig({ out4_class: ES9_CLASS_CV }).outputModes['11']).toBe('cv');
    expect(es9BridgeConfig({ out5_class: ES9_CLASS_PITCH }).outputModes['12']).toBe('cv');
    // And a jack nobody has touched keeps the bit-transparent default.
    expect(cfg.outputModes['8']).toBe('audio');
  });

  it('the config builder is the SAME one the factory acquires with', () => {
    // Two hand-written copies of this shape is exactly how the card's and the
    // factory's ended up meaning different things. Asserted as an identity of
    // OUTPUT rather than of source: the modes half must be `es9OutputModes` and
    // the masks must cover every hardware channel.
    const params = { out1_class: ES9_CLASS_GATE, in2_class: ES9_CLASS_PITCH };
    expect(es9BridgeConfig(params).outputModes).toEqual(es9OutputModes(params));
    expect(es9BridgeConfig(params).inputChannels).toEqual(
      es9BridgeConfig(params).outputChannels,
    );
    expect(es9BridgeConfig(params).inputChannels.length).toBe(
      Object.keys(es9BridgeConfig(params).outputModes).length,
    );
  });

  it('NEGATIVE CONTROL: the mapping really can move, so the legs above are not constants', () => {
    // Without this, every assertion here would pass against a builder that
    // returned a fixed table.
    expect(es9BridgeConfig({ out3_class: ES9_CLASS_CV }).outputModes['10']).toBe('cv');
    expect(es9BridgeConfig({ out3_class: ES9_CLASS_AUDIO }).outputModes['10']).toBe('audio');
  });
});
