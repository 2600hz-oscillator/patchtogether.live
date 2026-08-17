// packages/web/src/lib/ui/card-control-ranges.test.ts
//
// A CARD MAY NOT RESTATE A RANGE THE DEF ALREADY OWNS.
//
// ── The bug this exists for ──────────────────────────────────────────────────
// BACKDRAFT's two camera joysticks were authored with literal `xMin={-1}
// xMax={1}` while the def constrained those params to ±0.2 (tilt) and ±0.5
// (position). That is not a cosmetic mislabel: the pads WROTE values the
// contract forbids — drag to 0.8, store 0.8, model silently clamps to 0.2 —
// so most of the stick's travel did nothing and the control lied about its own
// scale.
//
// ── Why nothing caught it, which is the whole point ─────────────────────────
// contract-lock, the living-docs lint and every range assertion in the module's
// unit suite READ THE DEF. They agreed with the def because they ARE the def.
// The e2e never touches the control. So a card that disagrees with its own def
// is invisible to the entire existing gate set — there was no assertion
// anywhere that could have gone red. The same week, `card-control-overflow`
// turned out to be blind to controls that only mount in a non-default mode.
// Two structural blind spots on one card in one day.
//
// ── The invariant ───────────────────────────────────────────────────────────
// The cheap, sound fix is to make the divergence UNREPRESENTABLE rather than
// to detect it: a control's range must come from the ParamDef (or from the
// exported constant the def itself uses), never from a number retyped in the
// card. Then there is nothing to drift. This test pins that by rejecting
// NUMERIC-LITERAL range props on the listed cards.
//
// It deliberately checks the SOURCE, not the rendered value: a rendered-value
// check would have to build the expected number from the def and would
// therefore inherit exactly the blind spot above.
//
// ── THE RATCHET ─────────────────────────────────────────────────────────────
// STRICT_DEF_DERIVED_RANGES only GROWS. Adding a card is a one-line change
// after its literals are replaced with def lookups; nothing may be removed to
// make a red run green. Repo-wide enforcement is deliberately NOT attempted
// here — a blanket sweep goes red on every card that legitimately exposes a
// SUB-range of a param, and triaging that is its own PR. Boy-scout rule: bring
// a card onto this list when you touch it.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { RACK_SIZE_DEFAULTS } from './rack-sizes';

/** Cards whose control ranges MUST be derived from the module def. Only grows. */
const STRICT_DEF_DERIVED_RANGES = [
  // BACKDRAFT — every Fader reads pmin()/pmax() off backdraftDef.params. The
  // virtual-camera XyPads (on the branch that follows) read the exported
  // BACKDRAFT_CAM_TILT_RANGE / BACKDRAFT_CAM_POS_RANGE, which is the same rule:
  // the number is written once, next to the contract.
  'BackdraftCard.svelte',
] as const;

/** Range props on the shared controls (Fader / Knob / XyPad). */
const RANGE_PROPS = ['min', 'max', 'xMin', 'xMax', 'yMin', 'yMax'] as const;

function cardSource(file: string): string {
  const url = new URL(`./modules/${file}`, import.meta.url);
  const path = url.pathname;
  if (!existsSync(path)) throw new Error(`card not found: ${path}`);
  return readFileSync(url, 'utf8');
}

describe('card control ranges are DERIVED from the module def', () => {
  for (const file of STRICT_DEF_DERIVED_RANGES) {
    it(`${file} — no control carries a numeric-literal range`, () => {
      const src = cardSource(file);
      const offences: string[] = [];
      for (const prop of RANGE_PROPS) {
        // `min={0}` / `max={-1}` / `xMin={ -0.2 }` — a bare number in a range
        // prop. An expression (`min={pmin('zoom')}`, `xMin={-CAM_RANGE}`) does
        // not match, which is exactly the distinction we want.
        const re = new RegExp(`\\b${prop}=\\{\\s*-?\\d`, 'g');
        for (const m of src.matchAll(re)) {
          const line = src.slice(0, m.index).split('\n').length;
          offences.push(`${prop} at line ${line}`);
        }
      }
      expect(
        offences,
        `${file} restates a range the def already owns (${offences.join(', ')}). ` +
          'Read it off the ParamDef (pmin/pmax) or the exported constant the def uses — ' +
          'a retyped number can drift from the contract, and no other gate can see that drift.',
      ).toEqual([]);
    });

    it(`${file} — reads its ranges from the module def`, () => {
      const src = cardSource(file);
      // A card on this list must actually consult the def; otherwise "no
      // literals" could be satisfied by hardcoding a local constant instead.
      expect(
        /Def\.params\b/.test(src),
        `${file} must resolve control ranges from <module>Def.params`,
      ).toBe(true);
    });
  }
});

describe('BACKDRAFT card size agrees with its rack tier', () => {
  // Same divergence class as the ranges, one level up: the card's scoped CSS
  // carries an un-racked fallback width, while the rack/dock wrappers size it
  // from RACK_SIZE_DEFAULTS. Two numbers for one truth — so pin them together.
  // (The preview's persisted node.data.width/height, the third copy of this
  // truth, is gone with the corner-resize.)
  const RACK_UNIT = 180;

  it('the scoped fallback width == hp × 180 and min-height == u × 180', () => {
    const src = cardSource('BackdraftCard.svelte');
    const tier = RACK_SIZE_DEFAULTS.backdraft;
    expect(tier, 'backdraft resolves a fixed rack tier').toBeDefined();

    const width = /\.card\s*\{[^}]*?\bwidth:\s*(\d+)px/s.exec(src);
    const minHeight = /\.card\s*\{[^}]*?\bmin-height:\s*(\d+)px/s.exec(src);
    expect(width, 'BackdraftCard scopes a fallback .card width').not.toBeNull();
    expect(minHeight, 'BackdraftCard scopes a fallback .card min-height').not.toBeNull();

    expect(Number(width![1]), 'fallback width matches the hp tier').toBe(tier!.hp * RACK_UNIT);
    expect(Number(minHeight![1]), 'fallback min-height matches the u tier').toBe(
      Number(tier!.size.replace('u', '')) * RACK_UNIT,
    );
  });

  it('the card no longer reads a persisted resize size', () => {
    const src = cardSource('BackdraftCard.svelte');
    // The corner-resize came off with the preview; node.data.width/height left
    // on an already-saved patch must be IGNORED, not re-honoured, or the tier
    // and the persisted size become two competing truths again.
    expect(src).not.toContain('data?.width');
    expect(src).not.toContain('startCornerResize');
  });
});

describe('BACKDRAFT — every control stays REACHABLE', () => {
  // The card's rule: a control that is inert IN THE MODEL is DIMMED (opacity)
  // and explains itself in a `title`. It is never `disabled` and never
  // `{#if}`-ed away.
  //
  // This is not styling pedantry. Both of those make a control unreachable
  // WHILE THE GATE CV PATH KEEPS WRITING THE SAME PARAM — a real UI/CV
  // disagreement, and one that actually shipped: PURE GEO carried
  // `disabled={tvOn}` while `pure_geo_gate` went on flipping `pureGeo` from a
  // cable, so the engine's value moved under a button that refused the click.
  // Dimming keeps drag, dbl-click reset, wheel and right-click MIDI-Learn all
  // working, and it keeps the control's BOX — which is what makes the card's
  // height identical in all three TV modes, the property the three
  // card-control-overflow measurements jointly pin.
  //
  // Deterministic, pure-source, ~0ms — the cheapest possible encoding of "all
  // controls must be usable".
  it('no control on the card is `disabled`', () => {
    const src = cardSource('BackdraftCard.svelte');
    const offences = [...src.matchAll(/\bdisabled=\{/g)].map(
      (m) => `line ${src.slice(0, m.index).split('\n').length}`,
    );
    expect(
      offences,
      'BackdraftCard disables a control (' + offences.join(', ') + '). ' +
        'Dim it with an opacity class + an explanatory title instead: a disabled ' +
        'control is unreachable while its gate CV input keeps writing the param.',
    ).toEqual([]);
  });

  it('the TV SCREEN bank is DIMMED, not unmounted, when TV MODE is OFF', () => {
    const src = cardSource('BackdraftCard.svelte');
    // The dim is a class toggle on an always-rendered bank…
    expect(
      /class:dim=\{!tvOn\}/.test(src),
      'the TV SCREEN bank must carry class:dim={!tvOn}',
    ).toBe(true);
    // …and the faders must NOT sit behind a mode conditional. `{#if tvOn}` is
    // legal for pure READOUT chrome (the fill/bands text), but never for a
    // control: an unmounted fader cannot be dragged, MIDI-learned, or reset,
    // and unmounting it would also make the card's height mode-dependent.
    // ⚠ THE TAG NAME IS PART OF THIS ASSERTION'S SUBJECT (#1794). This read
    // `<Fader`, and a NEGATIVE assertion goes green — not red — when its
    // pattern stops matching anything: after the migration to `<NeonFader` it
    // would have kept passing while being structurally blind to the very
    // regression it exists to catch.
    expect(
      /\{#if tvOn\}[\s\S]{0,400}?<NeonFader/.test(src),
      'a fader must never be mounted behind {#if tvOn} — dim it instead',
    ).toBe(false);
    // …and the probe is really looking at this file: the card DOES mount
    // faders, so a zero-match above is about the CONDITIONAL, not about the
    // pattern having gone stale.
    expect(/<NeonFader(?=[\s/>])/.test(src), 'BackdraftCard must still mount faders at all').toBe(true);
  });
});
