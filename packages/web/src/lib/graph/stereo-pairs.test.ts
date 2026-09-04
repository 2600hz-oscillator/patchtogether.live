// packages/web/src/lib/graph/stereo-pairs.test.ts
//
// THE GOLDEN for stereo pairing: the FULL derived pair map across the whole
// registry, pinned as text.
//
// WHY A GOLDEN AND NOT A COUNT
// ----------------------------
// A count can only trip by growing, and it cannot tell you WHICH pair moved.
// Five subsystems are wired onto this derivation; the thing that has to be
// reviewable is the MAP, one line per module. So the pin is the serialized
// map, plus the artifact anchor that makes a stale exemption RED.
//
// ⚠ THE COUNTS THAT USED TO SIT ON TOP OF THE MAP ARE GONE (2026-08-10).
// `DERIVED_PAIR_CEILING` (58) and `MODULES_WITH_PAIRS_CEILING` (34) re-measured
// this same golden as a number: every pair they counted is a token on a line of
// `GOLDEN_PAIR_MAP`, so a pair appearing or disappearing already reddens the pin
// with a readable line diff (both directions are negative-controlled below).
// They added nothing but a hand-typed literal, and a hand-typed literal in a
// file three concurrent branches edit is a merge hazard BY CONSTRUCTION — see
// the repo standard "No hand-typed population count".
//
// WHAT THIS GATE CANNOT SEE — stated here so a green run is read for what it
// is (CLAUDE.md "state the gate's scope inside the gate"):
//   1. A CARD that hardcodes its own L/R descriptor rows. This reads DEFS. A
//      card can still disagree with the def it renders (the backdraft class);
//      PR-4's PatchPanel-central collapse is what removes that second source.
//      Today the ONLY render-path consumer is rear-card-model.ts; the ~44
//      hand-descriptor cards are still a second, unchecked source.
//   2. A pair whose two ids share NO l/r token and carry NO declaration —
//      scope's `ch1`/`ch2`, synesthesia's per-band taps, es9's `in1..in14`.
//      Invisible here, and therefore two jacks by default: the safe direction,
//      but not a proof of absence. The audio ports sitting outside every
//      derived pair are no longer COUNTED here; they are pinned twice over
//      elsewhere and the derivation's own failure mode is asserted directly —
//      see 'an L/R-TOKENED audio port always lands in a pair' below.
//   3. Anything about SEMANTICS. The derivation says two ports are one stereo
//      signal by NAME or by DECLARATION. Whether that is musically true is a
//      human call, which is what COLLAPSE_EXEMPT records.

import { describe, expect, it } from 'vitest';

// Side-effect barrels — register every module def (the contract-lock pattern).
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  COLLAPSE_EXEMPT,
  allStereoPairs,
  ambiguousStereoStems,
  collapseExemptKey,
  derivedStereoPairs,
  idWords,
  serializeStereoPair,
  stereoPairForPort,
  stereoSideForPort,
  stereoSideOfId,
  stereoPairStemId,
  stereoStemOfId,
  wiringPairForPort,
  type StereoPairDefLike,
} from './stereo-pairs';

/** Every registered def (audio + video + meta), sorted by type — the same
 *  three-registry read `getContractDefs()` does for contract-lock. */
type RegistryDef = StereoPairDefLike & { type: string };

function allDefs(): RegistryDef[] {
  return [
    ...(listModuleDefs() as unknown as RegistryDef[]),
    ...(listVideoModuleDefs() as unknown as RegistryDef[]),
    ...(listMetaModuleDefs() as unknown as RegistryDef[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

/** One line per module that has at least one DERIVED pair, module order. */
function serializeMap(defs: StereoPairDefLike[]): string {
  const lines: string[] = [];
  for (const def of defs) {
    const pairs = derivedStereoPairs(def);
    if (pairs.length === 0) continue;
    lines.push(`${def.type} ${pairs.map(serializeStereoPair).join(' ')}`);
  }
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// THE PIN
//
// `input:`/`output:` = the rail. `:token` = derived from the L/R id tokens
// (no declaration); its ABSENCE means the def declares the tuple. A module
// gaining a declaration for a pair it already derived therefore shows up as a
// line change, not as silence — which is the whole point of carrying `source`.
//
// Re-pinning is a REVIEW, not a formality: every line here is a claim that two
// jacks are one stereo signal, and PR-3/PR-4 wire real cables on that claim.
// ────────────────────────────────────────────────────────────────────────────
const GOLDEN_PAIR_MAP = `
archivist output:audio_l+audio_r:token
audioIn output:audio_l_out+audio_r_out:token
audioOut input:L+R:token
blood output:audio_l+audio_r:token
charlottesEchos input:L+R output:L+R
clipplayer output:audio1L+audio1R:token output:audio2L+audio2R:token output:audio3L+audio3R:token output:audio4L+audio4R:token output:audio5L+audio5R:token output:audio6L+audio6R:token output:audio7L+audio7R:token output:audio8L+audio8R:token
clouds input:in_l+in_r output:out_l+out_r
cloudseed input:in_l+in_r output:out_l+out_r
cofefve input:inL+inR output:outL+outR
cube output:L+R:token
doom output:audio_l+audio_r:token
es9 output:spdif_l+spdif_r:token
foxy output:out_l+out_r
graphicEq input:audio_l+audio_r:token
kickdrum output:audio_l+audio_r
meowbox output:L+R:token
mixmstrs input:ch1L+ch1R input:ch2L+ch2R input:ch3L+ch3R input:ch4L+ch4R input:ch5L+ch5R input:ch6L+ch6R input:ch7L+ch7R input:ch8L+ch8R input:ret1L+ret1R input:ret2L+ret2R output:masterL+masterR:token output:send1L+send1R:token output:send2L+send2R:token
peertube output:audio_l+audio_r:token
pentemelodica output:out_l+out_r
qbrt input:L+R:token output:L+R:token
recorderbox input:audio_l+audio_r:token
resofilter output:out_l+out_r
ringback input:in_l+in_r:token output:out_l+out_r:token
samsloop input:audio_l_in+audio_r_in:token
shimmershine input:in_l+in_r output:out_l+out_r
sidecar input:audio_l_in+audio_r_in input:sc_l_in+sc_r_in output:audio_l_out+audio_r_out
snaredrum output:audio_l+audio_r
stereovca input:in_l+in_r:token output:out_l+out_r:token
tidyVco output:out_l+out_r
tvLibrarian output:audio_l+audio_r:token
twotracks input:audio_l_in_a+audio_r_in_a input:audio_l_in_b+audio_r_in_b output:out_l+out_r
videobox output:audio_l+audio_r:token
videovarispeed output:audio_l+audio_r:token
vstFx input:in_l+in_r output:out_l+out_r
vstInstrument output:out_l+out_r
wavecel output:out_l+out_r
wavesculpt output:L+R:token
`.trim();

describe('stereo-pairs: THE derived pair map (registry golden)', () => {
  const defs = allDefs();

  it('the registry is actually loaded (the golden is not vacuously empty)', () => {
    // A golden compared against an empty registry passes for the wrong reason.
    expect(defs.length, 'registered module defs').toBeGreaterThan(150);
    expect(defs.filter((d) => (d.outputs ?? []).length > 0).length).toBeGreaterThan(100);
  });

  it('pins the FULL derived pair map across every registry module', () => {
    expect(
      serializeMap(defs),
      'Derived stereo-pair map drift. A line moved = the app now believes a ' +
        'DIFFERENT set of jacks is stereo. Review it as a contract change: ' +
        'accept and re-pin, or recognise it as a bug. `:token` = derived from ' +
        'the id, no declaration.',
    ).toBe(GOLDEN_PAIR_MAP);
  });

  it('the token fallback never REFUSES a stem as ambiguous', () => {
    // A stem carrying >1 left or >1 right is silently dropped by the fallback,
    // so a pair the author intended simply never appears. Unconditional: there
    // is nothing to tolerate, and a "ceiling of 0" measures nothing while still
    // reading like a budget somebody is managing.
    const amb = defs.flatMap((d) => ambiguousStereoStems(d).map((s) => `${d.type} ${s}`));
    expect(
      amb,
      'AMBIGUOUS STEM: >1 left or >1 right port shares this stem, so the token ' +
        'fallback refuses the whole stem and the pair vanishes with no diff on ' +
        'the golden above (the map only shows what WAS derived). Rename the ' +
        'ports so each stem has exactly one l and one r, or declare the tuple ' +
        'explicitly in `stereoPairs`.',
    ).toEqual([]);
  });

  it('an L/R-TOKENED audio port always lands in a pair (the derivation missed nothing)', () => {
    // WHAT THIS REPLACED, and why it is not the same assertion.
    // `UNPAIRED_AUDIO_PORT_CEILING = 203` counted every audio port outside a
    // derived pair. That number is not independent information: it is exactly
    // `<audio ports> - 2 * <derived pairs>` (measured 319 - 116 = 203), and BOTH
    // terms are already pinned goldens — every audio port is a line in
    // `contract-lock.txt` (319 of them, counted), every derived pair is a token
    // in GOLDEN_PAIR_MAP above. The population could not move without one of
    // those two producing a reviewed diff first, so the count was a third copy
    // of a fact pinned twice.
    //
    // What it could NOT tell you is the thing actually worth knowing: WHICH of
    // those unpaired ports look like they should have paired. That is derived
    // here instead, with no literal — an audio port whose id carries an l/r side
    // token but which no pair claims is the derivation failing on a case it was
    // built for (a lone `aux_l`, a typo'd partner, a stem split across rails).
    const orphans: string[] = [];
    for (const def of defs) {
      // `allStereoPairs`, not `derivedStereoPairs`: COLLAPSE_EXEMPT is a
      // decision about presentation, not a failure of the derivation.
      const claimed = new Set(
        allStereoPairs(def).flatMap((p) => [`${p.direction}:${p.left}`, `${p.direction}:${p.right}`]),
      );
      for (const dir of ['input', 'output'] as const) {
        for (const p of (dir === 'input' ? def.inputs : def.outputs) ?? []) {
          if (p.type !== 'audio') continue;
          if (claimed.has(`${dir}:${p.id}`)) continue;
          if (stereoSideOfId(p.id) === null) continue; // a mono jack: correct
          orphans.push(`${def.type} ${dir}:${p.id}`);
        }
      }
    }
    expect(
      orphans,
      'ORPHANED SIDE TOKEN: these audio ports name themselves left or right and ' +
        'belong to no pair, so the app renders them as two unrelated mono jacks. ' +
        'Either give the port its partner (same stem, opposite side) or rename it ' +
        'so it stops claiming a side.',
    ).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ANCHOR TO THE ARTIFACT — a stale exemption is one nobody is watching.
// ────────────────────────────────────────────────────────────────────────────
describe('stereo-pairs: COLLAPSE_EXEMPT is anchored to the live registry', () => {
  const defs = allDefs();

  it('every exemption names a pair the registry ACTUALLY derives', () => {
    const live = new Set(defs.flatMap((d) => allStereoPairs(d).map((p) => collapseExemptKey(d.type, p))));
    const stale = [...COLLAPSE_EXEMPT.keys()].filter((k) => !live.has(k));
    expect(
      stale,
      'STALE COLLAPSE_EXEMPT entries — these name a (module, direction, pair) ' +
        'the derivation no longer produces (renamed port? retyped to cv? module ' +
        'deleted?). Remove them: a stale exemption silently re-exempts the next ' +
        'regression on that key.',
    ).toEqual([]);
  });

  it('every exemption carries a written reason', () => {
    for (const [key, reason] of COLLAPSE_EXEMPT) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('the exemptions actually SUBTRACT — derived is a strict subset of all', () => {
    const all = defs.flatMap((d) => allStereoPairs(d));
    const derived = defs.flatMap((d) => derivedStereoPairs(d));
    expect(all.length - derived.length).toBe(COLLAPSE_EXEMPT.size);
  });

  it('rings: odd/even is DERIVED but EXEMPT from collapse — and still autowires', () => {
    const rings = defs.find((d) => d.type === 'rings')!;
    expect(allStereoPairs(rings).map(serializeStereoPair)).toEqual(['output:odd+even']);
    expect(derivedStereoPairs(rings)).toEqual([]);
    // The autowire half of the SEPARATE list: the declaration is untouched, so
    // stereo-autowire's findStereoSibling still fires. That behaviour is
    // shipped, and e2e-pinned by "stereo source L → stereo target L auto-wires
    // R too (rings odd/even → cofefve inL/inR)" in stereo-autowire.spec.ts.
    expect(rings.stereoPairs).toEqual([['odd', 'even']]);
  });

  it('the two ENTRY POINTS diverge on rings — collapse says no, wiring says yes', () => {
    // PR-3's commit planner asks `wiringPairForPort`. If it asked
    // `stereoPairForPort` instead, rings' shipped autowire would vanish and
    // the plan would look perfectly reasonable — one leg is a valid plan. This
    // is the per-port assert that makes reading the wrong list go RED here,
    // in the unit lane, rather than only in one e2e.
    const rings = defs.find((d) => d.type === 'rings')!;
    expect(stereoPairForPort(rings, 'odd', 'output')).toBeNull();
    expect(wiringPairForPort(rings, 'odd', 'output')).toEqual({
      left: 'odd', right: 'even', direction: 'output', source: 'declared',
    });
    // …and for every NON-exempt pair the two entry points must AGREE, or the
    // divergence would be a general split rather than the one named exemption.
    const clouds = defs.find((d) => d.type === 'clouds')!;
    expect(wiringPairForPort(clouds, 'out_l', 'output')).toEqual(
      stereoPairForPort(clouds, 'out_l', 'output'),
    );
    for (const d of defs) {
      for (const p of allStereoPairs(d)) {
        if (COLLAPSE_EXEMPT.has(collapseExemptKey(d.type, p))) continue;
        expect(
          wiringPairForPort(d, p.left, p.direction),
          `${d.type} ${p.direction}:${p.left} must resolve the same on both entry points`,
        ).toEqual(stereoPairForPort(d, p.left, p.direction));
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS — prove the gate can go RED. A gate whose green run would
// look identical if it were reading nothing is decoration.
// ────────────────────────────────────────────────────────────────────────────
describe('stereo-pairs: the gate is negative-controlled (it CAN fail)', () => {
  const defs = allDefs();

  it('SEES an unlisted new pair (an added L/R audio port pair moves the map)', () => {
    const before = serializeMap(defs);
    const spiked: StereoPairDefLike[] = defs.map((d) =>
      d.type === 'vca'
        ? { ...d, outputs: [...(d.outputs ?? []), { id: 'aux_l', type: 'audio' }, { id: 'aux_r', type: 'audio' }] }
        : d,
    );
    const after = serializeMap(spiked);
    expect(after).not.toBe(before);
    expect(after).toContain('vca output:aux_l+aux_r:token');
  });

  it('SEES a pair that DISAPPEARS (removing a declared pair moves the map)', () => {
    const before = serializeMap(defs);
    const spiked: StereoPairDefLike[] = defs.map((d) =>
      d.type === 'clouds' ? { ...d, stereoPairs: [], outputs: [] } : d,
    );
    expect(serializeMap(spiked)).not.toBe(before);
  });

  it('SEES a stale exemption (a key naming a pair that is not derived)', () => {
    const live = new Set(defs.flatMap((d) => allStereoPairs(d).map((p) => collapseExemptKey(d.type, p))));
    // The artifact anchor's own predicate, fed a key that cannot exist.
    expect(live.has('rings:output:odd+even')).toBe(true); // the real one resolves…
    expect(live.has('rings:output:odd+ODD')).toBe(false); // …and a bogus one does not.
    expect(live.has('deletedmodule:output:out_l+out_r')).toBe(false);
  });

  it('SEES a retype: flipping a pair to cv REMOVES it (the audio-only rule bites)', () => {
    const clouds = defs.find((d) => d.type === 'clouds')!;
    expect(derivedStereoPairs(clouds).some((p) => p.direction === 'output')).toBe(true);
    const retyped: StereoPairDefLike = {
      ...clouds,
      outputs: (clouds.outputs ?? []).map((p) =>
        p.id === 'out_l' || p.id === 'out_r' ? { ...p, type: 'cv' } : p,
      ),
    };
    expect(derivedStereoPairs(retyped).some((p) => p.direction === 'output')).toBe(false);
  });

  it('SEES an ambiguous stem (the same predicate the demand clause calls)', () => {
    // The unconditional `toEqual([])` above would read identically green if
    // `ambiguousStereoStems` had been reduced to `return []`. Feed it the shape
    // it exists to refuse: two lefts on one stem.
    const spiked: StereoPairDefLike = {
      type: 'fixture',
      outputs: [
        { id: 'out_l', type: 'audio' },
        { id: 'l_out', type: 'audio' },
        { id: 'out_r', type: 'audio' },
      ],
    };
    expect(ambiguousStereoStems(spiked)).toEqual(['output:out']);
    // …and the clean form is not flagged, so it is not refusing everything.
    expect(
      ambiguousStereoStems({
        type: 'fixture',
        outputs: [{ id: 'out_l', type: 'audio' }, { id: 'out_r', type: 'audio' }],
      }),
    ).toEqual([]);
  });

  it('SEES an orphaned side token (a lone `aux_l` with no partner)', () => {
    // The orphan scan's own predicate, on a def where the answer is known.
    const lonely: StereoPairDefLike = {
      type: 'fixture',
      outputs: [{ id: 'aux_l', type: 'audio' }, { id: 'sum', type: 'audio' }],
    };
    const claimed = new Set(
      allStereoPairs(lonely).flatMap((p) => [`${p.direction}:${p.left}`, `${p.direction}:${p.right}`]),
    );
    expect(claimed.size, 'a lone side token derives no pair at all').toBe(0);
    expect(stereoSideOfId('aux_l')).toBe('l'); // …so the scan flags it,
    expect(stereoSideOfId('sum')).toBeNull(); // …and leaves the mono jack alone.
  });

  it('the pin is not self-fulfilling: a DIFFERENT map produces a DIFFERENT string', () => {
    // Guards against the serializer collapsing to a constant (the "metric
    // invariant to the thing it measures" failure).
    const a = serializeMap(defs);
    const b = serializeMap(defs.filter((d) => d.type !== 'mixmstrs'));
    expect(a).not.toBe(b);
    expect(a.split('\n').length - b.split('\n').length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE DECIDED RULES, each verified against the real registry rather than
// assumed (the plan asserted several of these; three of the four exemptions it
// listed turned out never to be derived at all).
// ────────────────────────────────────────────────────────────────────────────
describe('stereo-pairs: the audio-only rule, verified on the real defs', () => {
  const defs = allDefs();
  const byType = (t: string) => defs.find((d) => d.type === t)!;

  it('stereovca: in/out pair, but strength_l/strength_r stay INDEPENDENT (cv)', () => {
    const def = byType('stereovca');
    // Ground the claim: those ports exist and they ARE cv-typed.
    const strengths = (def.inputs ?? []).filter((p) => p.id.startsWith('strength_'));
    expect(strengths.map((p) => `${p.id}:${p.type}`)).toEqual(['strength_l:cv', 'strength_r:cv']);
    // They read as a perfect L/R token pair…
    expect(stereoSideOfId('strength_l')).toBe('l');
    expect(stereoStemOfId('strength_l')).toBe('strength');
    expect(stereoStemOfId('strength_r')).toBe('strength');
    // …and the audio-only rule is what keeps them two jacks — NOT an exemption.
    expect(derivedStereoPairs(def).map(serializeStereoPair)).toEqual([
      'input:in_l+in_r:token',
      'output:out_l+out_r:token',
    ]);
    expect([...COLLAPSE_EXEMPT.keys()].some((k) => k.startsWith('stereovca:'))).toBe(false);
  });

  it('es9: spdif_l/r DOES pair; the 14 class-tagged hardware ins do NOT', () => {
    const def = byType('es9');
    expect(derivedStereoPairs(def).map(serializeStereoPair)).toEqual(['output:spdif_l+spdif_r:token']);
    // in1..in14 / out1..out8 / usb1..usb8 carry no l/r token, so they are
    // invisible to the derivation and need no exemption. (The plan listed
    // "es9's 16 class-tagged hardware jacks" as a collapse exemption; only
    // spdif_l/r is ever derived, and it is the one that SHOULD collapse.)
    expect([...COLLAPSE_EXEMPT.keys()].some((k) => k.startsWith('es9:'))).toBe(false);
  });

  it('scope + synesthesia: NO pair is derived, so NO exemption is warranted', () => {
    // Both were named as collapse exemptions in the plan. Neither ch1/ch2 nor
    // the per-band taps share an l/r token or carry a declaration, so listing
    // them would have been a STALE exemption on day one — caught by the
    // artifact anchor above. Pinned so the reasoning survives.
    expect(derivedStereoPairs(byType('scope'))).toEqual([]);
    expect(derivedStereoPairs(byType('synesthesia'))).toEqual([]);
    expect([...COLLAPSE_EXEMPT.keys()].some((k) => k.startsWith('scope:') || k.startsWith('synesthesia:'))).toBe(false);
  });

  it('a DERIVED pair is always two AUDIO ports on the SAME rail', () => {
    for (const def of defs) {
      for (const pair of allStereoPairs(def)) {
        const rail = (pair.direction === 'input' ? def.inputs : def.outputs) ?? [];
        const l = rail.find((p) => p.id === pair.left);
        const r = rail.find((p) => p.id === pair.right);
        expect(l?.type, `${def.type} ${pair.direction} ${pair.left}`).toBe('audio');
        expect(r?.type, `${def.type} ${pair.direction} ${pair.right}`).toBe('audio');
      }
    }
  });

  it('no port belongs to two pairs on the same rail', () => {
    for (const def of defs) {
      const seen = new Set<string>();
      for (const pair of allStereoPairs(def)) {
        for (const id of [pair.left, pair.right]) {
          const key = `${pair.direction}:${id}`;
          expect(seen.has(key), `${def.type} ${key} in two pairs`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  // ── REMOVED: 'every derived OUTPUT pair is ADJACENT on its rail' ──────────
  //
  // It existed for exactly one consumer: `rear-card-model`'s `pairWithPrev`,
  // which drew a "stereo pair" TIE between two CONSECUTIVE holes and would
  // therefore have tied the wrong two jacks if a pair were ever non-adjacent.
  //
  // PR-4 retired the tie for a single stereo HOLE (owner Q5), which removes the
  // precondition entirely: a collapsed hole is emitted at the position of
  // whichever member comes first and names its partner by id, so it cannot be
  // wrong about its own two ports wherever they sit in declared order.
  //
  // DELETED rather than left green, deliberately. A gate whose stated
  // justification no longer exists still LOOKS like protection — it would have
  // gone on passing forever while guarding nothing, which is the same failure
  // mode as a stale exemption. The invariants that DO still matter are pinned
  // where their consumers are: 'collapse never LOSES a port' and 'every
  // collapsed row addresses two REAL ports on its rail' in
  // `$lib/ui/stereo-jack-collapse.test.ts`, and the rear card's totality in
  // `rear-card-model.test.ts` / `module-face-lint.test.ts`.
});

// ────────────────────────────────────────────────────────────────────────────
// THE TOKENIZER — the vocabulary patch-convenience now imports from here.
// ────────────────────────────────────────────────────────────────────────────
describe('stereo-pairs: L/R id tokenization', () => {
  it('tokenizes separators AND camelCase humps', () => {
    expect(idWords('out_l')).toEqual(['out', 'l']);
    expect(idWords('inL')).toEqual(['in', 'l']);
    expect(idWords('audio_l_in')).toEqual(['audio', 'l', 'in']);
    expect(idWords('ch1L')).toEqual(['ch1', 'l']);
  });

  it('is TOKEN-based, never substring — `signal` is not a left', () => {
    // The rear card's old stem regex (`/^(.*?)_?([lr])$/`) matched any id
    // ENDING in l or r. That is how `gamepad`'s gate-typed d-pad `dl`/`dr`
    // became a "stereo pair" on the outputs rail.
    expect(stereoSideOfId('signal')).toBeNull();
    expect(stereoSideOfId('dl')).toBeNull();
    expect(stereoSideOfId('dr')).toBeNull();
    expect(stereoSideOfId('master')).toBeNull();
    expect(stereoSideOfId('l')).toBe('l');
    expect(stereoSideOfId('right')).toBe('r');
  });

  it('an id carrying BOTH sides is ambiguous, not a left', () => {
    expect(stereoSideOfId('l_r_sum')).toBeNull();
    expect(stereoStemOfId('l_r_sum')).toBeNull();
  });

  it('the stem is the id minus its side token', () => {
    expect(stereoStemOfId('out_l')).toBe('out');
    expect(stereoStemOfId('masterR')).toBe('master');
    expect(stereoStemOfId('audio_l_in')).toBe('audioin');
    expect(stereoStemOfId('audio_r_in')).toBe('audioin');
    expect(stereoStemOfId('L')).toBe(''); // charlottes-echos — a legit key
    expect(stereoStemOfId('R')).toBe('');
  });
});

describe('stereo-pairs: per-port lookup', () => {
  const def: StereoPairDefLike = {
    type: 'fixture',
    inputs: [
      { id: 'in_l', type: 'audio' },
      { id: 'in_r', type: 'audio' },
      { id: 'gain_l', type: 'cv' },
      { id: 'gain_r', type: 'cv' },
    ],
    outputs: [{ id: 'out', type: 'audio' }],
  };

  it('resolves the pair + side for an audio member, and null for everything else', () => {
    expect(stereoPairForPort(def, 'in_l', 'input')).toEqual({
      left: 'in_l', right: 'in_r', direction: 'input', source: 'token',
    });
    expect(stereoSideForPort(def, 'in_l', 'input')).toBe('left');
    expect(stereoSideForPort(def, 'in_r', 'input')).toBe('right');
    // cv members: no pair (the audio-only rule).
    expect(stereoPairForPort(def, 'gain_l', 'input')).toBeNull();
    // right rail, wrong direction.
    expect(stereoPairForPort(def, 'in_l', 'output')).toBeNull();
    // unpaired.
    expect(stereoPairForPort(def, 'out', 'output')).toBeNull();
  });

  it('stereoPairStemId gives the collapsed-jack label id, or null when stemless', () => {
    expect(stereoPairStemId({ left: 'out_l' })).toBe('out');
    expect(stereoPairStemId({ left: 'masterL' })).toBe('master');
    expect(stereoPairStemId({ left: 'audio_l_in' })).toBe('audio_in');
    expect(stereoPairStemId({ left: 'ch1L' })).toBe('ch1');
    // charlottes-echos declares bare `L`/`R`: nothing left after the side.
    expect(stereoPairStemId({ left: 'L' })).toBeNull();
    // Not a side at all → not a stem.
    expect(stereoPairStemId({ left: 'odd' })).toBeNull();
  });

  it('a def with NO type can never match an exemption', () => {
    const untyped: StereoPairDefLike = {
      outputs: [{ id: 'odd', type: 'audio' }, { id: 'even', type: 'audio' }],
      stereoPairs: [['odd', 'even']],
    };
    // Same tuple as rings, but the exemption is keyed on the module type.
    expect(derivedStereoPairs(untyped).map(serializeStereoPair)).toEqual(['output:odd+even']);
    expect(collapseExemptKey(undefined, { left: 'odd', right: 'even', direction: 'output' }))
      .toBe('?:output:odd+even');
  });
});
