// packages/web/src/lib/ui/stereo-jack-collapse.test.ts
//
// JACK COLLAPSE — the rules, plus THE COLLAPSED-LABEL GOLDEN over the live
// registry.
//
// WHY A GOLDEN. Every one of these 59 lines is a claim that two jacks now
// render as one, and a NAME the user will read on that jack. A count would only
// trip by growing and could not say which jack was renamed. So the pin is the
// map, one line per (module, direction, pair), reviewed on change.
//
// WHAT THIS GATE CANNOT SEE, stated so a green run is read for what it is:
//   1. Whether the PANEL actually renders these rows. This is the pure model;
//      the DOM contract is pinned by patch-panel-stereo-collapse.test.ts (the
//      MixmstrsCard row count) and by the e2e.
//   2. A pair `derivedStereoPairs` does not derive (no declaration, no shared
//      l/r token). Those stay two jacks — the safe direction — and the
//      population is ratcheted in stereo-pairs.test.ts, not here.
//   3. Whether a collapsed name is a GOOD name. That is a human call; the
//      golden is what makes it a reviewable one.

import { describe, expect, it } from 'vitest';

// Side-effect barrels — register every module def (the contract-lock pattern).
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  derivedStereoPairs,
  type PortDirection,
  type StereoPairDefLike,
} from '$lib/graph/stereo-pairs';
import { collapseStereoPorts, collapsedPairLabel, collapsedPortIds } from './stereo-jack-collapse';
import { resolveVerboseLabel, type PortDescriptor } from './patch-panel-labels';

function allDefs(): StereoPairDefLike[] {
  return [
    ...(listModuleDefs() as unknown as StereoPairDefLike[]),
    ...(listVideoModuleDefs() as unknown as StereoPairDefLike[]),
    ...(listMetaModuleDefs() as unknown as StereoPairDefLike[]),
  ].sort((a, b) => (a.type ?? '').localeCompare(b.type ?? ''));
}

/** Every port on a rail as the panel's descriptor shape — what a card that
 *  derives its rows from the def (144 of the 188) passes in. */
function railDescriptors(def: StereoPairDefLike, direction: PortDirection): PortDescriptor[] {
  const ports = (direction === 'input' ? def.inputs : def.outputs) ?? [];
  return ports.map((p) => ({ id: p.id, cable: p.type }));
}

// ────────────────────────────────────────────────────────────────────────────
// THE RULES
// ────────────────────────────────────────────────────────────────────────────

const STEREO_DEF: StereoPairDefLike = {
  type: 'fixture-stereo',
  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
    { id: 'cutoff', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
};

describe('collapseStereoPorts — the rules', () => {
  it('a derived pair becomes ONE row addressed to the LEFT leg', () => {
    const rows = collapseStereoPorts(railDescriptors(STEREO_DEF, 'output'), STEREO_DEF, 'output');
    expect(rows.map((r) => r.id)).toEqual(['out_l']);
    expect(rows[0]!.siblingId).toBe('out_r');
    expect(rows[0]!.side).toBe('left');
    expect(rows[0]!.label).toBe('OUT');
  });

  it('non-audio ports pass through untouched, in order', () => {
    const rows = collapseStereoPorts(railDescriptors(STEREO_DEF, 'input'), STEREO_DEF, 'input');
    expect(rows.map((r) => r.id)).toEqual(['in_l', 'cutoff']);
    expect(rows[1]!.siblingId).toBeUndefined();
    expect(rows[1]!.cable).toBe('cv');
  });

  it('PER DIRECTION: an output pair does not collapse the input rail', () => {
    // charlottes-echos reuses `L`/`R` on BOTH rails, which is why the whole
    // derivation is direction-scoped. Asking the wrong rail must yield nothing.
    const def: StereoPairDefLike = {
      type: 'fixture-outs-only',
      inputs: [{ id: 'out_l', type: 'audio' }],
      outputs: [
        { id: 'out_l', type: 'audio' },
        { id: 'out_r', type: 'audio' },
      ],
    };
    expect(collapseStereoPorts(railDescriptors(def, 'input'), def, 'input').map((r) => r.id)).toEqual(
      ['out_l'],
    );
    expect(
      collapseStereoPorts(railDescriptors(def, 'input'), def, 'input')[0]!.siblingId,
    ).toBeUndefined();
  });

  it('BOTH legs must be on the surface — a rail missing one keeps a plain row', () => {
    // THE MixmstrsCard CASE. `pickInputs` silently drops ids it does not
    // recognise, so a section can legitimately carry `ch1L` without `ch1R`. A
    // collapsed row there would offer to patch a port the surface never showed.
    const rows = collapseStereoPorts([{ id: 'out_l', cable: 'audio' }], STEREO_DEF, 'output');
    expect(rows.map((r) => r.id)).toEqual(['out_l']);
    expect(rows[0]!.siblingId).toBeUndefined();
    expect(rows[0]!.label).toBeUndefined(); // untouched: still renders "OUT L"
  });

  it('the collapsed row lands where the FIRST-listed member was, R-before-L included', () => {
    const rows = collapseStereoPorts(
      [
        { id: 'cutoff', cable: 'cv' },
        { id: 'out_r', cable: 'audio' },
        { id: 'out_l', cable: 'audio' },
      ],
      STEREO_DEF,
      'output',
    );
    expect(rows.map((r) => r.id)).toEqual(['cutoff', 'out_r']);
    expect(rows[1]!.siblingId).toBe('out_l');
    expect(rows[1]!.side).toBe('right');
    // The NAME is still the pair's, not the leg's.
    expect(rows[1]!.label).toBe('OUT');
  });

  it('an explicit per-leg card label is REPLACED by the pair name', () => {
    // FoxyCard hand-passes label "OUT L" / "OUT R". A collapsed jack named
    // after one of its legs is exactly the lie this module removes.
    const rows = collapseStereoPorts(
      [
        { id: 'out_l', cable: 'audio', label: 'OUT L' },
        { id: 'out_r', cable: 'audio', label: 'OUT R' },
      ],
      STEREO_DEF,
      'output',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('OUT');
  });

  it('no def ⇒ nothing collapses (the safe direction), and the input is not mutated', () => {
    const input: PortDescriptor[] = [
      { id: 'out_l', cable: 'audio' },
      { id: 'out_r', cable: 'audio' },
    ];
    const frozen = JSON.stringify(input);
    expect(collapseStereoPorts(input, undefined, 'output').map((r) => r.id)).toEqual([
      'out_l',
      'out_r',
    ]);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('does not mutate the descriptors it was given', () => {
    const input: PortDescriptor[] = [
      { id: 'out_l', cable: 'audio' },
      { id: 'out_r', cable: 'audio' },
    ];
    collapseStereoPorts(input, STEREO_DEF, 'output');
    expect(input[0]).toEqual({ id: 'out_l', cable: 'audio' });
  });

  it('collapsedPortIds names one port, or a pair’s two', () => {
    expect(collapsedPortIds({ id: 'a' })).toEqual(['a']);
    expect(collapsedPortIds({ id: 'out_l', siblingId: 'out_r' })).toEqual(['out_l', 'out_r']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROL — the gate must be able to go RED
// ────────────────────────────────────────────────────────────────────────────

describe('collapseStereoPorts: negative controls', () => {
  it('rings odd/even stays TWO rows — the COLLAPSE_EXEMPT read, proved by construction', () => {
    // `rings` is the whole reason $lib/graph/stereo-pairs has two entry points.
    // Its declared `['odd','even']` tuple is a real pair for WIRING (its
    // autowire is shipped, e2e-pinned behaviour) and must NOT collapse. Reading
    // the wrong list here would merge two different timbre taps into one jack
    // and produce a perfectly plausible-looking green run.
    const rings = allDefs().find((d) => d.type === 'rings');
    expect(rings, 'rings must be registered for this control to mean anything').toBeTruthy();
    const rows = collapseStereoPorts(railDescriptors(rings!, 'output'), rings!, 'output');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('odd');
    expect(ids).toContain('even');
    expect(rows.every((r) => r.siblingId === undefined)).toBe(true);
  });

  it('a cv-typed L/R pair stays TWO rows (stereovca strength_l / strength_r)', () => {
    // The AUDIO-ONLY rule with no exemption: independent per-channel ring
    // depth. If this ever collapses, two knobs became one and the module lost
    // a capability.
    const def = allDefs().find((d) => d.type === 'stereovca');
    expect(def, 'stereovca must be registered').toBeTruthy();
    const rows = collapseStereoPorts(railDescriptors(def!, 'input'), def!, 'input');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('strength_l');
    expect(ids).toContain('strength_r');
    // …while its AUDIO ins DO collapse, on the same call.
    expect(ids).toContain('in_l');
    expect(ids).not.toContain('in_r');
  });

  it('gamepad’s GATE-typed d-pad dl/dr stays TWO rows', () => {
    const def = allDefs().find((d) => d.type === 'gamepad');
    expect(def, 'gamepad must be registered').toBeTruthy();
    const ids = collapseStereoPorts(railDescriptors(def!, 'output'), def!, 'output').map(
      (r) => r.id,
    );
    expect(ids).toContain('dl');
    expect(ids).toContain('dr');
  });

  it('PERTURBING the derivation moves the output (the instrument is not blind)', () => {
    // Force a pair that does not exist and confirm a row disappears; force one
    // away and confirm it comes back. Without this, "nothing collapsed" and
    // "the function does nothing" print the same result.
    const noPair: StereoPairDefLike = {
      type: 'fixture-nopair',
      outputs: [
        { id: 'alpha', type: 'audio' },
        { id: 'beta', type: 'audio' },
      ],
    };
    expect(collapseStereoPorts(railDescriptors(noPair, 'output'), noPair, 'output')).toHaveLength(2);
    const withPair: StereoPairDefLike = { ...noPair, stereoPairs: [['alpha', 'beta']] };
    expect(collapseStereoPorts(railDescriptors(withPair, 'output'), withPair, 'output')).toHaveLength(
      1,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE COLLAPSED-LABEL GOLDEN (live registry)
// ────────────────────────────────────────────────────────────────────────────

const GOLDEN_COLLAPSED_LABELS = `
archivist output:audio_l+audio_r=AUDIO
audioIn output:audio_l_out+audio_r_out=AUDIO
audioOut input:L+R=IN
blood output:audio_l+audio_r=AUDIO
charlottesEchos input:L+R=IN output:L+R=OUT
clouds input:in_l+in_r=IN output:out_l+out_r=OUT
cloudseed input:in_l+in_r=IN output:out_l+out_r=OUT
cofefve input:inL+inR=IN output:outL+outR=OUT
cube output:L+R=OUT
doom output:audio_l+audio_r=AUDIO
es9 output:spdif_l+spdif_r=SPDIF
foxy output:out_l+out_r=OUT
graphicEq input:audio_l+audio_r=AUDIO
kickdrum output:audio_l+audio_r=AUDIO
meowbox output:L+R=OUT
mixmstrs input:ch1L+ch1R=CH1 input:ch2L+ch2R=CH2 input:ch3L+ch3R=CH3 input:ch4L+ch4R=CH4 input:ch5L+ch5R=CH5 input:ch6L+ch6R=CH6 input:ch7L+ch7R=CH7 input:ch8L+ch8R=CH8 input:ret1L+ret1R=RET1 input:ret2L+ret2R=RET2 output:masterL+masterR=MASTER output:send1L+send1R=SEND 1 output:send2L+send2R=SEND 2
peertube output:audio_l+audio_r=AUDIO
pentemelodica output:out_l+out_r=OUT
qbrt input:L+R=IN output:L+R=OUT
recorderbox input:audio_l+audio_r=AUDIO
resofilter output:out_l+out_r=OUT
ringback input:in_l+in_r=IN output:out_l+out_r=OUT
samsloop input:audio_l_in+audio_r_in=AUDIO
shimmershine input:in_l+in_r=IN output:out_l+out_r=OUT
sidecar input:audio_l_in+audio_r_in=AUDIO input:sc_l_in+sc_r_in=SC output:audio_l_out+audio_r_out=AUDIO
snaredrum output:audio_l+audio_r=AUDIO
stereovca input:in_l+in_r=IN output:out_l+out_r=OUT
tidyVco output:out_l+out_r=OUT
tvLibrarian output:audio_l+audio_r=AUDIO
twotracks input:audio_l_in_a+audio_r_in_a=AUDIO IN A input:audio_l_in_b+audio_r_in_b=AUDIO IN B output:out_l+out_r=OUT
videobox output:audio_l+audio_r=AUDIO
videovarispeed output:audio_l+audio_r=AUDIO
vstFx input:in_l+in_r=IN output:out_l+out_r=OUT
vstInstrument output:out_l+out_r=OUT
wavecel output:out_l+out_r=OUT
wavesculpt output:L+R=OUT
`.trim();

describe('the collapsed-jack LABEL map (registry golden)', () => {
  const defs = allDefs();

  it('the registry is actually loaded (the golden is not vacuously empty)', () => {
    expect(defs.length).toBeGreaterThan(150);
  });

  it('matches the pinned map', () => {
    const lines: string[] = [];
    for (const def of defs) {
      const pairs = derivedStereoPairs(def);
      if (pairs.length === 0) continue;
      lines.push(
        `${def.type} ${pairs
          .map((p) => `${p.direction}:${p.left}+${p.right}=${collapsedPairLabel(p)}`)
          .join(' ')}`,
      );
    }
    expect(lines.join('\n')).toBe(GOLDEN_COLLAPSED_LABELS);
  });

  // Two rows on ONE rail that render the SAME label — the user cannot tell
  // which jack is which. DENY BY DEFAULT, with a named exemption per exact
  // (module, direction, label) triple so a NEW collision on an already-listed
  // module still reddens.
  //
  // The three below are PRE-EXISTING and have nothing to do with collapse:
  // `spirographs` declares CV inputs whose ids differ only by CASE — `s1_R`
  // (fixed radius) and `s1_r` (roll radius) — and `resolveVerboseLabel`
  // uppercases, so both have always read "S1 R". They are cv-typed, so no
  // stereo derivation touches them; this gate simply found them. Fixing it
  // needs a `PortDef.label` on a VIDEO def, which is a contract change inside
  // the WebGL attest basis — deliberately out of PR-4's scope, and recorded
  // here rather than silently tolerated.
  const KNOWN_LABEL_COLLISIONS: ReadonlyMap<string, string> = new Map([
    ['spirographs:input:S1 R', 'case-only ids s1_R (fixed radius) vs s1_r (roll radius); cv, pre-existing'],
    ['spirographs:input:S2 R', 'case-only ids s2_R vs s2_r; cv, pre-existing'],
    ['spirographs:input:S3 R', 'case-only ids s3_R vs s3_r; cv, pre-existing'],
  ]);

  function railLabelCollisions() {
    const found: { key: string; detail: string; involvesCollapsed: boolean }[] = [];
    for (const def of defs) {
      for (const direction of ['input', 'output'] as const) {
        const rows = collapseStereoPorts(railDescriptors(def, direction), def, direction);
        const seen = new Map<string, { id: string; collapsed: boolean }>();
        for (const row of rows) {
          // THE ACTUAL RENDERED STRING, not `row.label ?? row.id`. Every jack
          // surface prints `resolveVerboseLabel(port)`, which expands
          // abbreviations, strips the redundant _in/_out suffix and
          // camelCase-splits — so a check on the raw id is a check on a string
          // no user ever sees, and would miss collisions that only appear
          // after resolution (`cv_in` and `cv` both render "CV").
          const label = resolveVerboseLabel(row);
          const prev = seen.get(label);
          if (prev) {
            found.push({
              key: `${def.type}:${direction}:${label}`,
              detail: `${def.type} ${direction} "${label}": ${prev.id} vs ${row.id}`,
              involvesCollapsed: prev.collapsed || row.siblingId !== undefined,
            });
          } else {
            seen.set(label, { id: row.id, collapsed: row.siblingId !== undefined });
          }
        }
      }
    }
    return found;
  }

  it('NO collapsed row collides with another row on its rail', () => {
    // THE clause that gates THIS PR: collapse renames a jack from its leg
    // ("OUT L") to its pair stem ("OUT"), and a stem can collide with a
    // sibling port's name. Zero, with no exemption list, because a collision
    // introduced by collapse is a bug in the naming policy, not a legacy fact.
    expect(railLabelCollisions().filter((c) => c.involvesCollapsed).map((c) => c.detail)).toEqual(
      [],
    );
  });

  it('the pre-existing rail label collisions are EXACTLY the named ones', () => {
    const actual = railLabelCollisions().map((c) => c.key).sort();
    expect(actual).toEqual([...KNOWN_LABEL_COLLISIONS.keys()].sort());
  });

  it('every named collision still EXISTS (a stale exemption is one nobody watches)', () => {
    const live = new Set(railLabelCollisions().map((c) => c.key));
    for (const key of KNOWN_LABEL_COLLISIONS.keys()) {
      expect(live.has(key), `${key} is exempted but no longer collides — drop the entry`).toBe(
        true,
      );
    }
  });

  it('ANCHORED TO THE ARTIFACT: every collapsed row addresses two REAL ports on its rail', () => {
    // A row whose sibling is not a declared port on the same rail would patch
    // into nothing. This checks the rows against the def rather than against
    // the golden, so a derivation bug cannot be papered over by re-pinning.
    for (const def of defs) {
      for (const direction of ['input', 'output'] as const) {
        const ids = new Set(((direction === 'input' ? def.inputs : def.outputs) ?? []).map((p) => p.id));
        for (const row of collapseStereoPorts(railDescriptors(def, direction), def, direction)) {
          if (!row.siblingId) continue;
          expect(ids.has(row.id), `${def.type}.${row.id} (${direction})`).toBe(true);
          expect(ids.has(row.siblingId), `${def.type}.${row.siblingId} (${direction})`).toBe(true);
        }
      }
    }
  });

  it('collapse never LOSES a port: rows ∪ siblings === the audio+other rail set', () => {
    for (const def of defs) {
      for (const direction of ['input', 'output'] as const) {
        const declared = railDescriptors(def, direction).map((p) => p.id);
        const addressed = collapseStereoPorts(railDescriptors(def, direction), def, direction)
          .flatMap((r) => collapsedPortIds(r))
          .sort();
        expect(addressed, `${def.type} ${direction}`).toEqual([...declared].sort());
      }
    }
  });
});
