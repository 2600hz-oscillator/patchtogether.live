// packages/web/src/lib/graph/exposable-controls.test.ts
//
// Exposable-control discovery tests.
//
// Schema-validates the module-def declarations (sequencers + TIMELORDE) so a
// typo in `exposableControls` is caught at unit time rather than in E2E, and
// pins the auto-synthesis rules: explicit entries win, a 0/1 discrete param
// becomes a 'button', and a `face.momentary` PRESS PAD is never auto-exposed
// (a proxying surface with no release edge would latch it).
//
// ⚠ TWO DESCRIBE BLOCKS WENT WITH THE GROUP! MODULE — `validateExposedControls`
// and `resolveExposedControls`, which resolved a group's saved
// `data.exposedControls` against the live patch and bucketed the survivors per
// child for the group bar. Both functions are deleted with that surface; the
// discovery half below is the part five non-group importers depend on.

import { describe, expect, it } from 'vitest';
import type { ExposableControl } from '$lib/audio/module-registry';
import {
  listExposableControls,
  type ControlDefLookup,
} from './exposable-controls';

import { scoreDef } from '$lib/audio/modules/score';
import { timelordeDef } from '$lib/audio/modules/timelorde';
import { moog956Def } from '$lib/audio/modules/moog956';

// ---------- shared fixtures --------------------------------------------------

const defs = {
  score: scoreDef,
  timelorde: timelordeDef,
} as const;

const defLookup: ControlDefLookup = (t) =>
  (defs as Record<string, { exposableControls?: readonly ExposableControl[]; params?: readonly import('./types').ParamDef[] }>)[t];

// ---------- v1 module-def coverage ------------------------------------------

describe('exposableControls — v1 scope module-def declarations', () => {
  // (Was the four step sequencers until their deletion 2026-08-24 —
  // deprecated by CLIP PLAYER; SCORE is the surviving declarer.)
  it.each([
    ['score', scoreDef],
  ] as const)('%s declares a single playStop button bound to isPlaying', (_label, def) => {
    expect(def.exposableControls).toBeDefined();
    const ctrls = def.exposableControls ?? [];
    expect(ctrls).toHaveLength(1);
    const c = ctrls[0];
    expect(c.id).toBe('playStop');
    expect(c.kind).toBe('button');
    expect(c.paramId).toBe('isPlaying');
    // The button must reference a real param on this def, otherwise
    // writes from the group bar silently no-op.
    const param = def.params.find((p) => p.id === c.paramId);
    expect(param, `${def.type}.params is missing ${c.paramId}`).toBeDefined();
  });

  it('TIMELORDE exposes every visible knob (bpm, swingAmount, swingSource)', () => {
    const ctrls = timelordeDef.exposableControls ?? [];
    const ids = ctrls.map((c) => c.id).sort();
    expect(ids).toEqual(['bpm', 'swingAmount', 'swingSource']);
    for (const c of ctrls) {
      expect(c.kind).toBe('knob');
      const param = timelordeDef.params.find((p) => p.id === c.paramId);
      expect(param, `timelorde.params is missing ${c.paramId}`).toBeDefined();
    }
  });

  it('every declared exposableControl references a real param on its own def', () => {
    // Generic sweep so a future module that adds the field can't slip past
    // a missing-param typo.
    for (const def of Object.values(defs)) {
      for (const c of def.exposableControls ?? []) {
        const param = def.params.find((p) => p.id === c.paramId);
        expect(
          param,
          `[${def.type}] exposableControls[id=${c.id}] paramId="${c.paramId}" missing`,
        ).toBeDefined();
      }
    }
  });
});

// ---------- listExposableControls -------------------------------------------

describe('listExposableControls', () => {
  it('includes the explicit exposableControls first', () => {
    const got = listExposableControls('score', defLookup);
    const ids = got.map((c) => c.id);
    // playStop (explicit) comes first; auto-generated entries follow.
    expect(ids[0]).toBe('playStop');
    expect(ids.length).toBeGreaterThan(1);
  });

  it('auto-synthesizes a knob entry for every other param on the def', () => {
    const got = listExposableControls('timelorde', defLookup);
    const autoIds = got.filter((c) => c.id.startsWith('param-')).map((c) => c.id);
    // TIMELORDE's bpm/swingAmount/swingSource are explicit; any OTHER param
    // is auto-exposed. We just assert the auto-tail is non-empty — the
    // exact id set drifts as we add params and shouldn't be load-bearing.
    expect(autoIds.length).toBeGreaterThan(0);
    for (const c of got) {
      expect(c.kind === 'knob' || c.kind === 'button').toBe(true);
    }
  });

  it('does NOT duplicate a param that is already in the explicit list', () => {
    const got = listExposableControls('score', defLookup);
    // score's playStop binds to isPlaying; the auto-tail must NOT
    // also include a `param-isPlaying` entry.
    const paramIds = got.map((c) => c.paramId);
    const isPlayingCount = paramIds.filter((p) => p === 'isPlaying').length;
    expect(isPlayingCount).toBe(1);
    expect(got.some((c) => c.id === 'param-isPlaying')).toBe(false);
  });

  it('renders 0/1 discrete params as buttons (toggle UX), not knobs', () => {
    // A drum module can carry discrete 0..1 'mute' / 'solo' params.
    const lookup: ControlDefLookup = () => ({
      exposableControls: [],
      params: [
        { id: 'mute', label: 'Mute', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
        { id: 'gain', label: 'Gain', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
      ],
    });
    const got = listExposableControls('whatever', lookup);
    const mute = got.find((c) => c.id === 'param-mute');
    const gain = got.find((c) => c.id === 'param-gain');
    expect(mute?.kind).toBe('button');
    expect(gain?.kind).toBe('knob');
  });

  // ── A PRESS PAD IS NOT AN EXPOSABLE CONTROL (2026-09-02) ──────────────────
  //
  // The group bar has NO release edge: `GroupExposedControls.svelte`'s
  // `togglePlay` is a single `setNodeParam(child, paramId, playing ? 0 : 1)`
  // per click, so a `face.momentary` param rendered there LATCHES a durable
  // Y.Doc value — the persisted-stuck-pad bug `$lib/audio/momentary-params`
  // exists to end, re-entered by a different surface.
  //
  // ⚠ THE TRAP IS THAT A PAD AND A LATCHING SWITCH ARE THE SAME ParamDef.
  // `looksLikeToggle` is `discrete && 0..1` and matches both, so the intent
  // can only come from the DECLARATION. That is exactly why moog956 became
  // reachable: correcting its `gate` from a mis-declared `linear` to the
  // `discrete` it always behaved as promoted it into the button branch.
  it('does NOT auto-expose a face.momentary press pad, but still exposes a real toggle', () => {
    const lookup: ControlDefLookup = () => ({
      exposableControls: [],
      params: [
        // IDENTICAL ParamDef shapes — only the declaration separates them.
        { id: 'strike', label: 'Strike', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
        { id: 'mute', label: 'Mute', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
      ],
      face: { momentary: ['strike'] },
    });
    const got = listExposableControls('whatever', lookup);
    expect(got.some((c) => c.paramId === 'strike')).toBe(false);
    // NEGATIVE CONTROL: the filter must be the DECLARATION, not the shape —
    // an ordinary latching switch of the same shape still reaches the bar.
    expect(got.find((c) => c.paramId === 'mute')?.kind).toBe('button');
  });

  it('still honours an EXPLICIT exposableControls entry for a momentary param', () => {
    // The explicit list is a louder claim than this default, exactly as
    // `noUserControl` treats it — it is matched before the auto tail.
    const lookup: ControlDefLookup = () => ({
      exposableControls: [
        { id: 'bigPad', label: 'Pad', kind: 'button', paramId: 'strike' },
      ] as readonly ExposableControl[],
      params: [
        { id: 'strike', label: 'Strike', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
      ],
      face: { momentary: ['strike'] },
    });
    const got = listExposableControls('whatever', lookup);
    expect(got.map((c) => c.id)).toEqual(['bigPad']);
  });

  it('the REAL moog956 def never puts its ribbon gate on the group bar', () => {
    // Anchored to the SHIPPED def rather than a fixture: moog956's `gate` is
    // `0..1 discrete` + `face.momentary`, so without the filter it renders as
    // a latching ▶/■ button that writes a HIGH gate into the rack and never
    // drops it — the drone this module's promotion exists to prevent.
    const lookup: ControlDefLookup = () => moog956Def;
    const got = listExposableControls('moog956', lookup);
    expect(got.some((c) => c.paramId === 'gate')).toBe(false);
    // …and the ordinary params are untouched, so the filter is narrow.
    for (const id of ['pos', 'scale', 'offset']) {
      expect(got.some((c) => c.paramId === id), `${id} is still exposable`).toBe(true);
    }
  });

  it('returns [] for an unknown type', () => {
    const got = listExposableControls('does-not-exist', defLookup);
    expect(got).toEqual([]);
  });

  it('returns [] for a known type whose def has no exposableControls and no params', () => {
    const lookup: ControlDefLookup = () => ({ exposableControls: undefined, params: [] });
    expect(listExposableControls('whatever', lookup)).toEqual([]);
  });
});
