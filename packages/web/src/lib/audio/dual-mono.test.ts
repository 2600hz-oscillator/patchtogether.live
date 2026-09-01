// packages/web/src/lib/audio/dual-mono.test.ts
//
// THE DUAL-MONO LEDGER GATE. Deny-by-default classification of every module
// that declares exactly one audio input (plan §0b, PR-3b).
//
// Two inversions, per CLAUDE.md:
//   1. NAMED entry per module, with a written reason — never a filename and
//      never "one audio input ⇒ wrap it". A mono-in module nobody classified is
//      RED, so a NEW module auto-enrolls itself into this decision.
//   2. ANCHORED TO THE ARTIFACT. The population comes from the live registry,
//      and the class must survive the module's live PORT SHAPE — an entry
//      naming a module that no longer qualifies, or whose ports contradict its
//      class, is RED. A stale exemption is one nobody is watching.
//
// There was a third — "RATCHETED BOTH WAYS", a per-class `CEILINGS` table plus
// a `POPULATION_SIZE`. Both are GONE (2026-08-10); the removal note sits where
// the constants stood. What replaces them is `GOLDEN_ROSTER`, a text pin of the
// whole population WITH ITS CLASS, asserted EQUAL to the live derivation — the
// same both-directions property, in a form that reports which module moved and
// that no concurrent branch can merge cleanly-and-wrongly.
//
// Plus: the gate STATES ITS SCOPE (the `SCOPE` export is asserted, not just
// documented) and is NEGATIVE-CONTROLLED — every leg is shown to be capable of
// going red against a synthetic def, so a green run means "looked and found
// nothing", not "looked at nothing".
//
// ⚠ WHAT THIS GATE CANNOT SEE, and what covers it instead:
//   - It reads DEFS. It cannot see the Web Audio graph the wrapper builds.
//     → dual-mono-engine.test.ts pins the topology against a recording context;
//       art/scenarios/stereo-dual-mono pins the actual SIGNAL against real
//       Web Audio, including the mono-patch up-mix hazard.
//   - It cannot see a handle field that only exists at runtime. The
//     read/write/videoSources ban is therefore ALSO enforced by a source grep
//     here and by a throw in the wrapper.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Side-effect barrels — register every module def. MUST precede the registry
// read (the contract-lock pattern).
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  DUAL_MONO_LEDGER, SCOPE, auditDualMonoLedger, dualMonoClassOf, monoAudioInputTypes,
  type DualMonoDefLike,
} from './dual-mono';

const allDefs = (): DualMonoDefLike[] => [
  ...(listModuleDefs() as unknown as DualMonoDefLike[]),
  ...(listVideoModuleDefs() as unknown as DualMonoDefLike[]),
  ...(listMetaModuleDefs() as unknown as DualMonoDefLike[]),
].sort((a, b) => a.type.localeCompare(b.type));

const MODULES_DIR = fileURLToPath(new URL('./modules/', import.meta.url));

// ---------------------------------------------------------------------------
// THE ROSTER — a text pin, so a reclassification shows up as a readable diff
// rather than as a number that moved.
// ---------------------------------------------------------------------------

const GOLDEN_ROSTER = `
delay            native-stereo
destroy          dual-mono
dockscope        sum
featurecv        sum
filter           dual-mono
foxy             sum
gibribbon        video-domain
milkdrop         video-domain
moog902          deferred
moog904a         dual-mono
moog904b         dual-mono
moog904c         dual-mono
moog905          dual-mono
moog907a         native-stereo
moog912          sum
moog914          native-stereo
moog923          deferred
moog961          sum
rasterize        deferred
resofilter       deferred
reverb           dual-mono
rings            deferred
scaler           native-stereo
spectrograph     sum
swolevco         sum
vca              deferred
warrensspectrum  deferred
wavecel          sum
`.trim();

/**
 * The roster text `GOLDEN_ROSTER` pins, derived LIVE. One function, called by
 * the real check AND by its negative control, so the control cannot drift into
 * exercising a re-typed copy of the derivation (that is how the previous
 * generation of self-tests in this repo went blind).
 */
function rosterText(defs: DualMonoDefLike[]): string {
  const pop = monoAudioInputTypes(defs);
  const width = Math.max(...pop.map((t) => t.length)) + 2;
  return pop
    .map((t) => `${t.padEnd(width - 1)} ${dualMonoClassOf(t)}`.replace(/\s+$/, ''))
    .join('\n');
}

const normalizeRoster = (s: string): string =>
  s.split('\n').map((l) => l.trim().split(/\s+/).join(' ')).join('\n');

// ⚠ SIX HAND-TYPED COUNTS DELETED HERE (2026-08-10):
//
//     const CEILINGS: Record<DualMonoClass, number> = {
//       'dual-mono': 7, 'native-stereo': 4, sum: 8, deferred: 7, 'video-domain': 1,
//     };
//     const POPULATION_SIZE = 27;
//
// …together with the describe block 'ratcheted in BOTH directions' that read
// them (`seen.length <= ceiling` plus `ceiling - seen.length === 0`, per class),
// the test titled `exactly 27 modules declare one audio input`, one clause of
// 'the classes partition the population exactly', and the negative control 'a
// class ceiling that grows is caught'.
//
// WHAT THEY PROTECTED: that no module joins or leaves the one-audio-input
// population, and that none changes class, without a human noticing.
//
// WHO CARRIES THAT NOW: 'the roster matches the golden, module by module',
// which asserts `GOLDEN_ROSTER` EQUAL to `rosterText(allDefs())` — the roster
// derived live from `monoAudioInputTypes(allDefs())` × `dualMonoClassOf()`.
// That equality is STRICTLY STRONGER than all six numbers: every one of them
// was, by construction, a count of GOLDEN_ROSTER lines (27 total, splitting
// 7/4/8/7/1 by class), so a tree that satisfies the roster satisfies them and a
// tree that violates any of them fails the roster FIRST — naming the module and
// its class, where the number could only say a total moved. Deny-by-default
// ('every mono-in module is CLASSIFIED') and the anchors ('no ledger entry names
// a module that is no longer mono-in', 'every class survives the module's LIVE
// port shape') are unchanged and still do their own jobs.
//
// NOTHING WAS DROPPED. Unlike the other counts in this sweep there is not even a
// growth-by-listing hole: the roster is not an exemption list you can add
// yourself to quietly — enrolling a module means editing a text pin that appears
// in the diff as a new line with its class on it.
describe('dual-mono ledger — the population', () => {
  it('the registry is actually loaded (the gate is not vacuously empty)', () => {
    const defs = allDefs();
    expect(defs.length).toBeGreaterThan(150);
    expect(defs.some((d) => d.type === 'vca')).toBe(true);
  });

  it('includes milkdrop — the population is NOT filtered to domain=audio', () => {
    // Plan §0b's own corrected table says 26 because it filtered on
    // domain=audio and silently dropped this one. A filter applied before the
    // check redefines the check's subject; that is the repo's recurring defect,
    // so the filter is absent here and milkdrop is classified explicitly.
    expect(monoAudioInputTypes(allDefs())).toContain('milkdrop');
    expect(dualMonoClassOf('milkdrop')).toBe('video-domain');
  });
});

describe('dual-mono ledger — deny by default, anchored to the artifact', () => {
  const audit = () => auditDualMonoLedger(allDefs());

  it('every mono-in module is CLASSIFIED (no silent enrolment)', () => {
    expect(
      audit().unclassified,
      'these modules declare exactly one audio input and are NOT in DUAL_MONO_LEDGER. '
      + 'Deny by default: decide whether the engine should run the DSP twice '
      + "('dual-mono'), down-mix its input ('sum'), or leave it alone ('native-stereo' "
      + "/ 'deferred') — and write down why.",
    ).toEqual([]);
  });

  it('no ledger entry names a module that is no longer mono-in (STALE)', () => {
    expect(
      audit().stale,
      'a stale entry is one nobody is watching, and it silently re-classifies the next '
      + 'module that takes the name. Remove it and lower its class ceiling.',
    ).toEqual([]);
  });

  it('every class survives the module\'s LIVE port shape', () => {
    expect(
      audit().shapeMismatch.map((m) => `${m.type} [${m.cls}]: ${m.problem}`),
      'the ledger and the def disagree. The class is a falsifiable claim about the '
      + 'ports, not a label.',
    ).toEqual([]);
  });

  it('the roster matches the golden, module by module', () => {
    // THE both-directions check, and the only one this file needs: a module
    // joining the population, leaving it, or changing class all show up here as
    // a readable line diff naming the module. It replaced five class ceilings
    // and a population size (see the removal note above GOLDEN_ROSTER).
    expect(normalizeRoster(rosterText(allDefs()))).toBe(normalizeRoster(GOLDEN_ROSTER));
  });
});

describe('dual-mono ledger — the classes cover the population, and every entry argues', () => {
  it('the classes partition the population exactly', () => {
    const a = auditDualMonoLedger(allDefs());
    const total = SCOPE.classes.reduce((n, c) => n + a.byClass[c].length, 0);
    // DERIVED on both sides — no literal. A module in two classes, or in none,
    // breaks this without anyone having to know how many there are.
    expect(total).toBe(a.population.length);
  });

  it('every entry carries a real, written reason', () => {
    for (const [type, entry] of DUAL_MONO_LEDGER) {
      expect(entry.why.length, `${type} has a stub reason`).toBeGreaterThan(40);
    }
  });
});

describe('dual-mono ledger — the read() decision is ENFORCED, not documented', () => {
  // SCOPE.readPolicy: read()/write()/videoSources are single-instance by
  // nature. A dual-mono module declaring one would silently meter the LEFT
  // channel only — the instrument-blindness class this repo keeps hitting.
  // The wrapper throws at materialization; this is the independent source-level
  // instrument, because the unit lane has no Web Audio and cannot materialize.
  const handleFieldRe = /^\s*(read|write|videoSources)\s*[(:]/m;

  const sourceFor = (type: string): string => {
    for (const f of readdirSync(MODULES_DIR)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(`${MODULES_DIR}${f}`, 'utf8');
      if (new RegExp(`type:\\s*'${type}'`).test(src)) return src;
    }
    throw new Error(`no factory source found for '${type}'`);
  };

  it('no dual-mono module declares read / write / videoSources', () => {
    const offenders: string[] = [];
    for (const type of auditDualMonoLedger(allDefs()).byClass['dual-mono']) {
      if (handleFieldRe.test(sourceFor(type))) offenders.push(type);
    }
    expect(
      offenders,
      "these are classed 'dual-mono' but their handle exposes a single-instance read "
      + 'surface. Two instances have no defined answer for it. Decide the key explicitly '
      + '(sum? left? both?) and reclassify, or drop the key.',
    ).toEqual([]);
  });

  it('the grep is NON-VACUOUS — it finds the read() that does exist', () => {
    // moog914 (native-stereo, so NOT wrapped) declares a level-meter read key.
    // If this stops matching, the regex has rotted and the leg above is dead.
    expect(handleFieldRe.test(sourceFor('moog914'))).toBe(true);
    expect(handleFieldRe.test(sourceFor('reverb'))).toBe(false);
  });
});

describe('dual-mono ledger — the gate STATES what it cannot see', () => {
  it('scope is declared and matches the classes actually used', () => {
    expect(SCOPE.population).toBe('defs with exactly one audio-typed input port, ANY domain');
    expect([...SCOPE.classes].sort()).toEqual(
      ['deferred', 'dual-mono', 'native-stereo', 'sum', 'video-domain'],
    );
  });

  it('names the paths that BYPASS the engine seam entirely', () => {
    // ART drives def.factory directly, so it is structurally blind to a
    // dual-mono regression. Saying so is what stops a green ART lane being read
    // as coverage.
    expect(SCOPE.bypassedBy.some((s) => s.includes('renderOfflineDef'))).toBe(true);
    expect(SCOPE.bypassedBy.length).toBeGreaterThanOrEqual(3);
  });

  it('names the leg-placement seam, and reuses the SHARED pair derivation', () => {
    // Two cables into one mono port no longer sum — addEdge places them on
    // separate legs. The side comes from legChannelOfEdge, the same derivation
    // the commit planner uses; a sixth private heuristic here would re-open
    // exactly what #1404 collapsed.
    expect(SCOPE.legPlacement).toMatch(/legInputsFor/);
    expect(SCOPE.legPlacement).toMatch(/legChannelOfEdge/);
    expect(SCOPE.legPlacement).toMatch(/not a second heuristic/);
  });

  it('names the residual case it still cannot handle', () => {
    // An unstated scope reads as full coverage. A stereo source whose outputs
    // are not a DERIVED pair is invisible to the shared derivation, so its two
    // cables still sum — the same answer the rest of the app gives it.
    expect(SCOPE.notHandled).toMatch(/not a DERIVED pair/);
  });
});

describe('dual-mono ledger — NEGATIVE CONTROL (every leg can go red)', () => {
  const port = (id: string, type: string): DualMonoDefLike['inputs'] extends undefined
    ? never : { id: string; type: string } => ({ id, type });
  const def = (
    type: string, ins: { id: string; type: string }[], outs: { id: string; type: string }[],
    domain = 'audio',
  ) => ({ type, domain, inputs: ins, outputs: outs }) as unknown as DualMonoDefLike;

  it('an UNCLASSIFIED mono-in module is caught', () => {
    const fake = def('zzzFakeMonoIn', [port('audio', 'audio')], [port('audio', 'audio')]);
    const a = auditDualMonoLedger([...allDefs(), fake]);
    expect(a.unclassified).toEqual(['zzzFakeMonoIn']);
    // …and the real registry is clean, so the leg above is a real check.
    expect(auditDualMonoLedger(allDefs()).unclassified).toEqual([]);
  });

  it('a STALE entry is caught (module loses its audio input)', () => {
    const defs = allDefs().map((d) => (d.type === 'reverb' ? { ...d, inputs: [] } : d));
    expect(auditDualMonoLedger(defs).stale).toContain('reverb');
  });

  it("a 'dual-mono' module that grows a NON-AUDIO output is caught", () => {
    const defs = allDefs().map((d) => (d.type === 'filter'
      ? { ...d, outputs: [...(d.outputs ?? []), port('scope', 'mono-video')] as never }
      : d));
    const problems = auditDualMonoLedger(defs).shapeMismatch;
    expect(problems.map((p) => p.type)).toContain('filter');
    expect(problems.find((p) => p.type === 'filter')!.problem).toMatch(/no merger/);
  });

  it("a 'dual-mono' module that loses ALL audio outputs is caught", () => {
    const defs = allDefs().map((d) => (d.type === 'moog905' ? { ...d, outputs: [] } : d));
    expect(auditDualMonoLedger(defs).shapeMismatch.map((p) => p.problem))
      .toContain('no audio output — two instances cannot be merged back into a pair');
  });

  it("a 'sum' module whose only audio input is a PARAM target is caught", () => {
    // The down-mix stage cannot be interposed in front of an AudioParam, so the
    // class would be a label over a no-op.
    const defs = allDefs().map((d) => (d.type === 'featurecv'
      ? { ...d, inputs: [{ id: 'in', type: 'audio', paramTarget: 'x' }] as never }
      : d));
    expect(auditDualMonoLedger(defs).shapeMismatch.find((p) => p.type === 'featurecv')!.problem)
      .toMatch(/paramTarget/);
  });

  it("a 'video-domain' entry on an AUDIO-domain module is caught", () => {
    const defs = allDefs().map((d) => (d.type === 'milkdrop' ? { ...d, domain: 'audio' } : d));
    expect(auditDualMonoLedger(defs).shapeMismatch.find((p) => p.type === 'milkdrop')!.problem)
      .toMatch(/AudioEngine DOES materialize it/);
  });

  it('a module JOINING the population moves the ROSTER (the surviving both-ways leg)', () => {
    // REPLACES 'a class ceiling that grows is caught', whose subject was
    // `CEILINGS['dual-mono']` — deleted 2026-08-10 with the rest of the counts.
    // The roster equality is what carries both directions now, so that is what
    // gets negative-controlled, and through the SAME `rosterText` the real check
    // calls rather than a re-typed copy of the derivation.
    const defs = [...allDefs(), def('zzzFakeMonoIn', [port('audio', 'audio')], [port('audio', 'audio')])];
    expect(monoAudioInputTypes(defs), 'the synthetic def really does enter the population')
      .toContain('zzzFakeMonoIn');
    expect(
      normalizeRoster(rosterText(defs)),
      'a new mono-in module must make the derived roster differ from GOLDEN_ROSTER',
    ).not.toBe(normalizeRoster(GOLDEN_ROSTER));
    // …and the UNPERTURBED tree still matches, so this is a real control and not
    // a roster that never matched in the first place.
    expect(normalizeRoster(rosterText(allDefs()))).toBe(normalizeRoster(GOLDEN_ROSTER));
  });

  it('a module LEAVING the population moves the ROSTER too (the other direction)', () => {
    // The direction the old zero-slack clause covered: a drain that forgets to
    // update the pin. Drop reverb's audio input and the roster must differ.
    const defs = allDefs().map((d) => (d.type === 'reverb' ? { ...d, inputs: [] } : d));
    expect(monoAudioInputTypes(defs)).not.toContain('reverb');
    expect(normalizeRoster(rosterText(defs))).not.toBe(normalizeRoster(GOLDEN_ROSTER));
  });
});
