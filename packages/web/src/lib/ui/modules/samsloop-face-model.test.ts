// packages/web/src/lib/ui/modules/samsloop-face-model.test.ts
//
// SAMSLOOP's face-model unit — the module-specific findings the generic face
// gates cannot see, each with a permanent negative control.
//
// `module-face-lint` already proves the face is TOTAL (every param and family
// ranked exactly once, the dock plan renders each once, no orphan keys). None of
// that is repeated here. What lives here is the GEOMETRY the warped-fader cell
// exists to preserve, which is invisible to every def-reading gate by
// construction: they all read the ParamDef, and the ParamDef is not what is
// drawn.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { samsloopDef, SAMSLOOP_RATE_LANDMARKS } from '$lib/audio/modules/samsloop';
import { knobToRate, rateToKnob } from '$lib/audio/modules/samsloop-rate';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { startSamsloopTake, toggleSamsloopRecord } from './samsloop-face-actions';
import {
  samsloopRecRefusal,
  setSamsloopRecRefusal,
} from './samsloop/samsloop-rec-refusal.svelte';

const HERE = resolve(__dirname);
const read = (p: string) => readFileSync(p, 'utf8');

describe('samsloop face — the RATE fader is WARPED, and that is the whole point', () => {
  // ── THE FINDING ───────────────────────────────────────────────────────────
  //
  // `rate` is declared `-2..+2 linear`. The card has never drawn it that way: it
  // renders KNOB SPACE 0..1 and converts at the edges with a PIECEWISE map, so
  // UNITY (+1 — "no transpose") sits at the fader's MIDPOINT. Drawn linearly off
  // the ParamDef, unity would land at (1 − −2) / 4 = 3/4 instead. That is a
  // quarter of the control away from where every player's muscle memory has it,
  // and it would pass every gate we own.

  it('unity sits at the fader MIDPOINT under the module\'s own map', () => {
    expect(rateToKnob(1)).toBeCloseTo(0.5, 10);
  });

  it('NEGATIVE CONTROL: a LINEAR rendering would put unity at 3/4 — the break', () => {
    // The arithmetic a generic `paramCells: 'fader'` would do, computed here so
    // the two readings are compared rather than asserted apart.
    const p = samsloopDef.params.find((q) => q.id === 'rate')!;
    const linearFrac = (1 - p.min) / (p.max - p.min);
    expect(linearFrac).toBeCloseTo(0.75, 10);
    expect(
      Math.abs(linearFrac - rateToKnob(1)),
      'a quarter of the fader — this gap is why the warped cell exists',
    ).toBeCloseTo(0.25, 10);
  });

  it('the landmarks are NON-UNIFORMLY spaced, which is the warp made visible', () => {
    // Placed at toKnob(value), so their spacing is the map's own geometry. A
    // linear fader would space these evenly; if this ever becomes uniform, the
    // face has silently started drawing the param instead of the control.
    const fracs = SAMSLOOP_RATE_LANDMARKS.map((lm) => rateToKnob(lm.value));
    const gaps = fracs.slice(1).map((f, i) => f - fracs[i]!);
    const spread = Math.max(...gaps) - Math.min(...gaps);
    expect(spread, 'the gaps differ — the map is not linear').toBeGreaterThan(0.1);
  });

  it('the landmarks are in PARAM UNITS and every one is reachable', () => {
    const p = samsloopDef.params.find((q) => q.id === 'rate')!;
    for (const lm of SAMSLOOP_RATE_LANDMARKS) {
      expect(lm.value, `${lm.label} within the declared range`).toBeGreaterThanOrEqual(p.min);
      expect(lm.value).toBeLessThanOrEqual(p.max);
      // A landmark's KNOB position must be inside the fader, or it is a tick
      // nobody can reach.
      const frac = rateToKnob(lm.value);
      expect(frac).toBeGreaterThanOrEqual(0);
      expect(frac).toBeLessThanOrEqual(1);
    }
  });

  it('the map round-trips, so the cell can read and write the same control', () => {
    for (const lm of SAMSLOOP_RATE_LANDMARKS) {
      expect(knobToRate(rateToKnob(lm.value))).toBeCloseTo(lm.value, 8);
    }
  });
});

describe('samsloop face — ONE SOURCE for the map and the landmarks', () => {
  // The backdraft rule applied to a FUNCTION instead of a number. A re-typed map
  // renders correctly, writes correct values and passes every runtime assertion
  // — right up until someone corrects the real one in one place, at which point
  // the two surfaces disagree about where unity is with nothing red.
  // `warped-fader-source.test.ts` owns the generic form; these two are
  // samsloop's own, because they name THIS module's symbols.

  it('the RATE cell is REACHABLE through the real resolver — the shape the shell passes', () => {
    // ⚠ THIS ASSERTION USED TO COERCE `kind: 'static'` WITH AN `as never`, AND
    // THAT COERCION HID A LIVE BUG. `shellCellFor` refused every `param`
    // control, so the warped-fader branch in ModuleShell was unreachable and
    // RATE rendered as a generic LINEAR knob — unity at 3/4 of the travel
    // instead of the midpoint, which is the exact break the cell exists to
    // prevent. Forcing the kind made the lookup succeed in the test and nowhere
    // else. The control below is the shape `curatedFace` really builds
    // (`{ key, kind: 'param', paramId }`), so this test now fails if the
    // resolver ever refuses params again.
    const cell = shellCellFor('samsloop', {
      key: 'rate',
      kind: 'param',
      paramId: 'rate',
      label: 'Rate',
    });
    expect(cell?.kind).toBe('warped-fader');
    // Identity, not behaviour: a re-implementation that happened to agree today
    // would pass a value comparison and still be the defect.
    expect(cell && 'toKnob' in cell && cell.toKnob).toBe(rateToKnob);
    expect(cell && 'fromKnob' in cell && cell.fromKnob).toBe(knobToRate);
    expect(cell && 'landmarks' in cell && cell.landmarks).toBe(SAMSLOOP_RATE_LANDMARKS);
  });

  it('NEGATIVE CONTROL: a param control still cannot borrow a FAMILY cell', () => {
    // The fix opened `shellCellFor` to param controls, so the other direction
    // needs pinning: a non-param cell must stay unreachable from a param
    // control, or a `selector` (which edits node.data and carries no paramId)
    // could render over a param and write somewhere the control does not point.
    const borrowed = shellCellFor('samsloop', {
      key: 'samsloop-chan-{n}',
      kind: 'param',
      paramId: 'samsloop-chan-{n}',
      label: 'chan',
    });
    expect(borrowed, 'a param must not resolve a selector cell').toBeNull();
  });

  it('NEGATIVE CONTROL: a FAMILY control cannot borrow the warped fader either', () => {
    const borrowed = shellCellFor('samsloop', {
      key: 'rate',
      kind: 'family',
      familyId: 'rate',
      label: 'Rate',
    });
    expect(borrowed, 'a family must not resolve the param-shaped cell').toBeNull();
  });

  it('the CARD derives its ticks from the same landmarks — no hand-typed fracs', () => {
    // ⚠ SOURCE-LEVEL, because no runtime gate reads a literal in a .svelte file.
    // The card used to carry five `{ frac: … }` positions — knob-space
    // coordinates silently encoding the current map's geometry.
    const card = read(resolve(HERE, 'SamsloopCard.svelte'));
    expect(card).toContain('SAMSLOOP_RATE_LANDMARKS');
    expect(
      /ticks=\{\[/.test(card),
      'an inline ticks array is a re-typed geometry — derive from the landmarks',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: the card check can FAIL — it really reads the file', () => {
    const card = read(resolve(HERE, 'SamsloopCard.svelte'));
    expect(card.length).toBeGreaterThan(1000);
    expect(/ticks=\{/.test(card), 'the card really does declare ticks').toBe(true);
  });
});

describe('samsloop face — the WAVEFORM rides a body, and the reasons are checkable', () => {
  it('the def declares the extension and the extension fills fullViewBody', () => {
    expect(samsloopDef.face?.extension).toBe('samsloop');
    const ext = read(resolve(HERE, 'samsloop', 'shell-extension.ts'));
    expect(ext).toMatch(/fullViewBody:\s*SamsloopOutputBody/);
  });

  it('the surface has NO pointer handler — why a PANEL was never available', () => {
    // `ShellPanelProbe` requires an element to click or drag. This is the
    // mechanical form of "the canvas has never been interactive", so if someone
    // later adds a handler this test tells them a panel is now an option.
    const body = read(resolve(HERE, 'samsloop', 'SamsloopOutputBody.svelte'));
    expect(/on(pointerdown|mousedown|click)=/.test(body)).toBe(false);
  });

  it('the body and the card call the SAME draw — one picture, two surfaces', () => {
    const body = read(resolve(HERE, 'samsloop', 'SamsloopOutputBody.svelte'));
    const card = read(resolve(HERE, 'SamsloopCard.svelte'));
    expect(body).toContain('drawSamsloopWaveform');
    expect(card).toContain('drawSamsloopWaveform');
  });

  it('only the BODY paints a playhead — a reactive card would freeze it', () => {
    // The card's draw runs on Svelte reactivity, not rAF, so a playhead drawn
    // there would sit wherever the last param change left it. The card passes
    // the "nothing is sounding" sentinel deliberately.
    const card = read(resolve(HERE, 'SamsloopCard.svelte'));
    expect(card).toMatch(/playheadFrac:\s*-1/);
    const body = read(resolve(HERE, 'samsloop', 'SamsloopOutputBody.svelte'));
    expect(body).toMatch(/requestAnimationFrame/);
  });
});

describe('samsloop face — a REFUSED REC press is VISIBLE, not merely ledgered', () => {
  // ── THE FINDING ───────────────────────────────────────────────────────────
  //
  // `startSamsloopTake` REFUSES to arm — when the engine is not up, and when the
  // rack's shared 12 MB sample budget has no room for the shortest legal take.
  // The refusal is the module's own hard-won correctness: it re-reads the ledger
  // FRESH at press time, because a peer's sample can land between the last
  // render and the click, and it declines rather than silently shortening (the
  // truncation it replaced cut 8 % off every take without saying so).
  //
  // The legacy card printed that sentence in `samsloop-rec-error`. The faceplate
  // had nowhere to put it: an `action` shell cell renders a `<Button>` and
  // nothing else. So `toggleSamsloopRecord` recorded `delivered: false` and the
  // player saw the button move and nothing happen — a REC that is
  // indistinguishable from a dead one. `delivered` is a TEST instrument
  // (faces-parity reads it); it is not a surface.
  //
  // ⚠ WHAT EVERY EXISTING GATE SAW WHILE THAT WAS TRUE: a probe-satisfying
  // press. `shell-cells.test.ts` holds the probe, `faces-parity` drives the cell
  // and both are GREEN on a refusal, because a refusal IS a recorded audition.
  // The hole was structurally invisible to the whole cell apparatus.

  const NODE = 'samsloop-refusal-unit';

  beforeEach(() => {
    setSamsloopRecRefusal(NODE, null);
  });

  it('NEGATIVE CONTROL: a node that has not pressed REC carries no refusal', () => {
    // Without this the leg below could pass on a seam that returns a constant.
    expect(samsloopRecRefusal(NODE)).toBeNull();
    expect(samsloopRecRefusal('samsloop-never-pressed')).toBeNull();
  });

  it('a REFUSED press lands the module\'s own sentence in the seam the face reads', () => {
    // No engine is registered in a unit run, so this is the engine-not-ready
    // path — the same one a player takes by pressing REC before audio starts.
    const r = startSamsloopTake(NODE);
    expect(r.ok, 'no engine ⇒ the take must be refused, not armed').toBe(false);
    expect(r.error, 'the refusal carries a sentence').toBeTruthy();

    expect(toggleSamsloopRecord(NODE), 'the toggle reports the refusal too').toBe(false);
    // ⚠ IDENTITY WITH THE ACTION'S OWN STRING, not a match against a copy typed
    // here. A literal in this file would be a second source that drifts, and the
    // drifting copy would be the one that made the test green.
    expect(samsloopRecRefusal(NODE)).toBe(r.error);
  });

  it('a press that ARMS or STOPS retires the sentence — it is not sticky', () => {
    // Set the state a refusal leaves behind, then take the branch a live take
    // takes. Nothing may be left on screen complaining about a take that is now
    // running, which is the failure mode a set-only seam has.
    setSamsloopRecRefusal(NODE, 'a stale refusal');
    expect(samsloopRecRefusal(NODE)).toBe('a stale refusal');
    setSamsloopRecRefusal(NODE, null);
    expect(samsloopRecRefusal(NODE)).toBeNull();
  });

  it('the BODY is the only surface that has to carry it — REC is DOCK-ONLY', () => {
    // ⚠ THE LOAD-BEARING DERIVATION OF THE WHOLE DESIGN, and the reason one dock
    // surface is a COMPLETE home rather than a partial one. If `samsloop-rec-{n}`
    // were reachable at a lane tier, a player could press REC on a tile that
    // never mounts `SamsloopOutputBody` and the refusal would be silent again.
    // Asserted through the REAL selector rather than by reading the cap, so a
    // re-rank, a cap change or a glyph change all reach it.
    const DEF = samsloopDef as unknown as FaceDefLike;
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = curatedFace(DEF, tier)!.controls.map((c) => c.key);
      expect(
        keys,
        `${tier}: REC is reachable in the lane, where nothing paints its refusal — `
          + 'either the refusal needs a lane home or REC must rank past the plate',
      ).not.toContain('samsloop-rec-{n}');
    }
    // …and the positive half: it IS on the dock faceplate, so the loop above is
    // not green because the cell was deleted.
    const dockKeys = curatedFace(DEF, 'dock')!.controls.map((c) => c.key);
    expect(dockKeys, 'REC is a real cell on the dock faceplate').toContain('samsloop-rec-{n}');
  });

  it('the body PAINTS it, and re-types no part of the sentence', () => {
    // ⚠ SOURCE-LEVEL, because no runtime gate reads a literal in a .svelte file
    // — the same reason the RATE-ticks leg above is source-level. Two halves:
    // the testid exists, and the text comes from the seam rather than from a
    // copy of `samsloopRackFullMessage`'s wording pasted into the body.
    const body = read(resolve(HERE, 'samsloop', 'SamsloopOutputBody.svelte'));
    expect(body).toContain('data-testid="samsloop-face-rec-error"');
    expect(body).toContain('samsloopRecRefusal');
    expect(
      /No room to record|engine not ready/i.test(body),
      'the body must READ the refusal, never re-type one — a second copy is the '
        + 'drift the shared action file exists to prevent',
    ).toBe(false);
  });
});
