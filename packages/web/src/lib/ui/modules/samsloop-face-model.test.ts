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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { samsloopDef, SAMSLOOP_RATE_LANDMARKS } from '$lib/audio/modules/samsloop';
import { knobToRate, rateToKnob } from '$lib/audio/modules/samsloop-rate';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

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
