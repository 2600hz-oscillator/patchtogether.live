// packages/web/src/lib/ui/modules/cloudseed-preset-actions.test.ts
//
// THE LOSS-1 REGRESSION, in its pure half.
//
// The shipped bug was a state-consistency bug: turning the dock's PRESET
// control pushed the preset into the WORKLET and left the store alone, so the
// sound changed while the persisted Y.Doc kept the old 45 values. The recall is
// now a graph stamp, and the stamp is a pure `slot → {paramId: value}`
// projection — so "all 46 values land, on real def param ids" is checkable here
// with no browser, no engine and no flake. (The other half — that a knob edit
// made AFTER a recall survives — is the e2e, because only a live graph can show
// it.)
//
// The cppId map is the other thing worth pinning. It used to be a 45-case
// `switch` hand-transcribed inside the card: a two-sided contract whose second
// side no def-reading gate could see, so a renamed param would silently drop
// out of preset recall while every gate stayed green.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CloudseedParam,
  CLOUDSEED_MESSAGE_PARAMS,
  CLOUDSEED_PRESETS,
  cloudseedDef,
} from '$lib/audio/modules/cloudseed';
import {
  cloudseedCppIdMap,
  cloudseedParamIdForCppId,
  cloudseedPresetLabel,
  cloudseedPresetStamp,
} from './cloudseed-preset-actions';

const DEF_PARAM_IDS = new Set(cloudseedDef.params.map((p) => p.id));

describe('cppId → param id (derived, never hand-transcribed)', () => {
  it('covers EVERY C++ Parameter index the engine declares', () => {
    const missing: number[] = [];
    for (let cppId = 0; cppId < CloudseedParam.COUNT; cppId++) {
      if (!cloudseedParamIdForCppId(cppId)) missing.push(cppId);
    }
    expect(
      missing,
      'a C++ parameter with no def param would be DROPPED from every preset recall',
    ).toEqual([]);
  });

  it('every mapped id is a REAL def param, and the mapping is 1:1', () => {
    const map = cloudseedCppIdMap();
    const ids = Object.values(map);
    for (const id of ids) expect(DEF_PARAM_IDS.has(id), `${id} is a declared param`).toBe(true);
    expect(new Set(ids).size, 'no two cppIds map to the same param').toBe(ids.length);
  });

  it('agrees with the two source tables it is derived from', () => {
    expect(cloudseedParamIdForCppId(CloudseedParam.DryOut)).toBe('dry_out');
    expect(cloudseedParamIdForCppId(CloudseedParam.EqCrossSeed)).toBe('cross_seed');
    for (const p of CLOUDSEED_MESSAGE_PARAMS) {
      expect(cloudseedParamIdForCppId(p.cppId), `cppId ${p.cppId}`).toBe(p.id);
    }
  });

  it('an unmapped index is null, not a wrong guess', () => {
    expect(cloudseedParamIdForCppId(999)).toBeNull();
  });
});

describe('cloudseedPresetStamp — every value the recall writes', () => {
  it('each bundled preset stamps ALL 46 params, including preset_index', () => {
    for (let slot = 0; slot < CLOUDSEED_PRESETS.length; slot++) {
      const stamp = cloudseedPresetStamp(slot)!;
      expect(stamp, `slot ${slot}`).toBeTruthy();
      expect(Object.keys(stamp).sort(), `slot ${slot} covers the def`).toEqual(
        [...DEF_PARAM_IDS].sort(),
      );
      expect(stamp.preset_index).toBe(slot);
    }
  });

  it('the stamped values ARE the preset bank values', () => {
    const stamp = cloudseedPresetStamp(3)!; // INFINITE PAD
    const preset = CLOUDSEED_PRESETS[3]!;
    for (const [cppIdStr, v] of Object.entries(preset.values)) {
      const id = cloudseedParamIdForCppId(Number(cppIdStr))!;
      expect(stamp[id], `${id}`).toBe(v);
    }
    // The corner this preset exists to prove: a ~30 s tail.
    expect(stamp.late_line_decay).toBe(0.95);
  });

  it('the four bundled spaces are genuinely DIFFERENT stamps', () => {
    // A stamp that returned the same values for every slot would satisfy every
    // clause above and make preset recall a no-op.
    const decays = CLOUDSEED_PRESETS.map((_, i) => cloudseedPresetStamp(i)!.late_line_decay);
    expect(new Set(decays).size).toBe(CLOUDSEED_PRESETS.length);
  });

  it('a slot outside the bank stamps NOTHING', () => {
    expect(cloudseedPresetStamp(-1)).toBeNull();
    expect(cloudseedPresetStamp(CLOUDSEED_PRESETS.length)).toBeNull();
    expect(cloudseedPresetStamp(Number.NaN)).toBeNull();
  });
});

describe('cloudseedPresetLabel — the face roster', () => {
  it('strips the [FX] marker and lowercases, leaving the stored name alone', () => {
    expect(cloudseedPresetLabel('[FX] DIVINE INSPIRATION')).toBe('divine inspiration');
    expect(cloudseedPresetLabel('[FX] SHORT ROOM')).toBe('short room');
    // The ART impulse-response scenario matches on `.includes('SHORT')`.
    expect(CLOUDSEED_PRESETS.some((p) => p.name.includes('SHORT'))).toBe(true);
  });

  it("the def's declared options are exactly this label over the bank, in order", () => {
    const preset = cloudseedDef.params.find((p) => p.id === 'preset_index')!;
    expect(preset.options?.map((o) => o.label)).toEqual(
      CLOUDSEED_PRESETS.map((p) => cloudseedPresetLabel(p.name)),
    );
    expect(preset.options?.map((o) => o.value)).toEqual(CLOUDSEED_PRESETS.map((_, i) => i));
  });
});

// ── THE CARD ↔ DEF SOURCE GUARD ──────────────────────────────────────────────
//
// The same divergence class the cppId switch was deleted for, one level down.
// `CloudseedCard.svelte` used to pass 29 hand-typed `min={0} max={1}
// defaultValue={0.63} curve="linear"` prop sets. Every one AGREED with the def,
// so nothing was broken — and nothing COULD have caught it if one stopped
// agreeing, because contract-lock, module-docs-lint and every range assertion
// read the DEF and none of them can see a card. This is the textual gate that
// keeps them gone, in the same shape as module-docs-lint's controlFamilies →
// card-testid grep.

describe('SOURCE guard — CloudseedCard cannot re-type what the def declares', () => {
  const cardSrc = readFileSync(
    fileURLToPath(new URL('./CloudseedCard.svelte', import.meta.url)),
    'utf8',
  );
  /** Comments are prose, not markup — and this card's own comments quote the
   *  literals they document the removal of. */
  const cardCode = cardSrc
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /** Any `<word>Min`/`<word>Max`/`defaultValue`/`step` bound to a number. The
   *  prefix class is `[A-Za-z]*` on purpose: `\b(min|max)` finds no boundary
   *  inside `xMin`, which is the literal form of the backdraft bug. */
  const LITERAL_RANGE = /(?:^|[^A-Za-z0-9_])([A-Za-z]*(?:[Mm]in|[Mm]ax)|defaultValue|step)=\{\s*-?\d/g;
  /** `curve` is the MAPPING, not decoration: a card saying `linear` against a
   *  `log` def moves the control's midpoint by a decade. */
  const LITERAL_MAPPING = /(?:^|[^A-Za-z0-9_])(curve|units)=(["'])[^"']*\2/g;

  it('the guard matches the shapes it claims to (instrument negative control)', () => {
    for (const s of ['min={0} max={1}', 'xMin={-1}', 'defaultValue={0.63}', 'step={0.01}']) {
      expect([...s.matchAll(LITERAL_RANGE)].length, `must catch: ${s}`).toBeGreaterThan(0);
    }
    for (const s of ['curve="linear"', "units='s'"]) {
      expect([...s.matchAll(LITERAL_MAPPING)].length, `must catch: ${s}`).toBeGreaterThan(0);
    }
    for (const s of ["min={pmin('dry_out')}", "curve={pcurve('dry_out')}"]) {
      expect([...s.matchAll(LITERAL_RANGE)].length, `must not fire on: ${s}`).toBe(0);
      expect([...s.matchAll(LITERAL_MAPPING)].length, `must not fire on: ${s}`).toBe(0);
    }
  });

  it('passes NO hand-typed range or mapping to any control', () => {
    expect(
      [...cardCode.matchAll(LITERAL_RANGE)].map((m) => m[0].trim()),
      'read it from cloudseedDef.params — pmin/pmax/pdef/pcurve',
    ).toEqual([]);
    expect(
      [...cardCode.matchAll(LITERAL_MAPPING)].map((m) => m[0].trim()),
      'read it from cloudseedDef.params — pcurve',
    ).toEqual([]);
  });

  it('every bound control names a REAL def param (the helper throws; this says so first)', () => {
    const ids = new Set(cloudseedDef.params.map((p) => p.id));
    const bad = [...cardCode.matchAll(/p(?:min|max|def|curve)\('([^']+)'\)/g)]
      .map((m) => m[1]!)
      .filter((pid) => !ids.has(pid));
    expect([...new Set(bad)], "a typo'd id throws at card mount, which is a blank module").toEqual([]);
  });

  it('the CLEAR TAIL testid carries the numbered-key suffix its docs key promises', () => {
    // `controlFamilies` members render as `${testidPrefix}-${nodeId}-${n}` and
    // the docs key is `cloudseed-clear-{n}`; the card emitted no `-1`, and
    // module-docs-lint's grep is PREFIX-ONLY so nothing caught the drift.
    const fam = cloudseedDef.controlFamilies!.find((f) => f.id === 'cloudseed-clear')!;
    expect(cardCode).toContain(`${fam.testidPrefix}-\${id}-1`);
  });
});
