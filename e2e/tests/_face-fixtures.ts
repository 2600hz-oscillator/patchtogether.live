// e2e/tests/_face-fixtures.ts
//
// Fixtures for the workflow-mode FACE / legacy-fallback bridge specs.
//
// NOT in `_helpers.ts`: none of this has anything to do with multiplayer, and
// `_helpers.ts` is the shared multi-context helper file. Keep it that way — put
// face/shell fixtures in THIS file.
//
// The split originally had teeth: `_helpers.ts` was a hand-listed member of the
// @collab attest basis, so anything added to it churned the collab content-hash
// and forced a full re-attest (a Postgres spin-up plus the ~50-test @collab
// lane). collab-attest was deleted 2026-08-17, so the rule now rests on meaning
// alone.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';
import { getModuleDef } from '../../packages/web/src/lib/audio/module-registry';
import { domainClassForCable } from '../../packages/web/src/lib/ui/workflow/module-shell-model';

/**
 * A still-UN-MIGRATED audio module — the fixture for every legacy-fallback test
 * (uniform placeholder in the lane + the verbatim legacy card in the dock).
 *
 * DERIVED, not hard-coded, because a hard-coded fixture ROTS: each P1 face wave
 * promotes more modules, and whichever module the bridge tests named eventually
 * joins STRICT_FACES and starts rendering a curated face — so the test asserting
 * "placeholder is visible" fails for a reason that is not a bug. That has now
 * happened four times: `vca` (P1 batch 1), `delay` (P1 batch 3), `noise` and
 * `attenumix` (face batch 4), and `destroy` (2026-08-16, Q18).
 *
 * ⚠ THE POOL IS DERIVED FROM THE REGISTRY, NOT HAND-WRITTEN (#1789, #1794).
 *
 * It used to be `UNMIGRATED_CANDIDATES`, an ordered list of three module names.
 * That list was SELF-HEALING (a promoted entry was skipped) but never
 * SELF-REFILLING, so every face wave drained it by one and five modules were
 * consumed this way — `vca`, `delay`, `noise`, `attenumix`, `destroy` — each
 * discovered by breaking the suite. #1765 made the exhaustion LOUD (the throw
 * below) but left the draining in place, guarded only by a comment asking the
 * next promoting author to top the list up: an unenforced obligation, in a file
 * a promoting PR has no other reason to open.
 *
 * Deriving it deletes that obligation. A promotion removes a module from the
 * pool automatically (it enters `STRICT_FACES`), and the pool REFILLS from the
 * registry as new un-promoted audio modules land.
 *
 * Determinism — the property the fixed list was written to get — is preserved
 * by SORTING, not by hand-ordering: registry iteration order is a glob artifact
 * and must never decide which module the bridge specs drive.
 *
 * The three predicates are the ASSERTIONS' OWN predicates, run here rather than
 * described in prose, because each one has already cost a cycle when it was
 * only prose:
 *   * `STRICT_FACES` — a promoted module renders a curated face, so the spec
 *     asserting "placeholder is visible" fails for a reason that is not a bug.
 *   * the DOMAIN CLASS — the bridge specs assert `.faceplate.audio`, which is
 *     derived from the module's CABLE TYPES, not its declared `domain`.
 *     `gatemaiden` is `domain: 'audio'` with GATE ports and renders
 *     `.faceplate.gate`: it satisfied the requirement as written and still
 *     could not satisfy the assertion.
 *   * `mountsAFader` — `workflow-shell.spec.ts`'s operability leg drives
 *     `.fader-wrap .track` specifically. `moog902` satisfied every OTHER stated
 *     requirement and its card draws KNOBS, so the spec spent 30 s in
 *     `locator.boundingBox` and failed as a TIMEOUT, which reads like a broken
 *     app rather than an unfit fixture.
 *
 * ⚠⚠ THE DOMAIN PREDICATE USED TO BE VACUOUS HERE, AND NOTHING SAID SO.
 *
 * It read `domainClassForDef(getModuleDef(t))`. `getModuleDef` reads a registry
 * that `$lib/audio/modules/index.ts` fills with Vite's `import.meta.glob` —
 * and PLAYWRIGHT DOES NOT RUN VITE. This file never imports that glob, so under
 * the test loader the registry is EMPTY, `getModuleDef` returns `undefined` for
 * every type, and `domainClassForDef(undefined)` falls all the way through to
 * its `default:` arm and answers `'audio'` UNCONDITIONALLY (measured
 * 2026-08-17: `listModuleDefs().length === 0`).
 *
 * So the check the header advertised as rejecting `gatemaiden` "out loud" had
 * never once fired. `gatemaiden` was rejected only for being third in a
 * hand-ordered list whose first entry already matched — i.e. by luck, and the
 * luck was documented as a mechanism. That is the exact shape CLAUDE.md warns
 * about: a filter applied before the check that quietly redefines the check's
 * subject, with a green run that looks identical to a working one.
 *
 * The fix is to feed the predicate a def it can actually read.
 * `contract-lock.txt` is a COMMITTED, GENERATED artifact carrying every
 * module's domain and every port's cable type, it is on the `docs:accept` loop,
 * and it is a plain file — so it is available at import time under any loader.
 * The cable→domain mapping itself is still the REAL `domainClassForCable`,
 * imported rather than re-typed.
 */

/**
 * Modules the predicates ACCEPT but that are known unfit, each with the
 * evidence already paid for. Deny-by-default with a reason per entry, rather
 * than a silent omission — and anchored below, so an entry naming a module that
 * would not have been picked anyway is RED instead of quietly decorative.
 */
export const DENIED: Readonly<Record<string, string>> = {
  audioIn:
    'needs getUserMedia — capability-dependent on CI, where there is no camera or mic to grant',
  audioOut:
    'the rack MASTER OUTPUT: `AudioIoSurface.svelte` hosts it (and audioIn) in a dedicated ' +
    'I/O drawer via DockCardHost, so it never renders the lane tile + dock full view the ' +
    'bridge specs assert on. It passes every content predicate and is still unfit.',
  twotracks:
    'a two-reel tape emulator: it mounts, but the bridge test timed out at 30 s in ' +
    "`boundingBox` waiting for it, and this fixture's whole contract is " +
    '"simple, stable, cheap-to-mount"',
};

/**
 * Does this module's legacy card mount a fader? Read off the CARD SOURCE, so
 * the fixture is rejected at import time with a reason instead of at 30 s with
 * a timeout.
 *
 * ⚠ THE TAG IS `<NeonFader`, NOT `<Fader` (#1794). This read `/<Fader\b/` until
 * every card was migrated onto `NeonFader` and `Fader.svelte` was deleted —
 * and `<NeonFader` does NOT match `/<Fader\b/`, so the un-updated predicate
 * would have rejected every candidate at once, emptied the pool, and thrown at
 * import time in every spec that imports this file.
 */
function mountsAFader(type: string): boolean {
  const def = getModuleDef(type) as { card?: string } | undefined;
  // The `modules-card-map` convention (`card` override wins, else
  // `PascalCase(type) + 'Card'`), mirrored rather than imported: that module
  // resolves its components with `import.meta.glob`, which is Vite-only and
  // takes the whole spec file down at load time under Playwright's loader
  // ("No tests found", with no import error printed). A mis-resolve here fails
  // SAFE — the candidate is rejected with a named reason, never silently
  // accepted.
  const file = def?.card
    ? `${def.card}.svelte`
    : `${type.charAt(0).toUpperCase()}${type.slice(1)}Card.svelte`;
  try {
    return /<NeonFader\b/.test(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/web/src/lib/ui/modules', file),
        'utf8',
      ),
    );
  } catch {
    return false;
  }
}

/** One module's ports and param count, read off `contract-lock.txt`. */
interface LockedPorts {
  outputs: string[];
  inputs: string[];
  params: number;
}

/**
 * Parse the committed contract golden into `type → cable types`. Lines are
 * `<type> meta domain=<d>` / `<type> in <portId> <cable> …` /
 * `<type> out <portId> <cable>` / `<type> param …`.
 */
function readContractLock(): Map<string, LockedPorts> {
  const text = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/web/src/lib/docs/contract-lock.txt'),
    'utf8',
  );
  const byType = new Map<string, LockedPorts>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [type, kind, , cable] = line.split(/\s+/);
    if (!type || !kind) continue;
    const entry = byType.get(type) ?? { outputs: [], inputs: [], params: 0 };
    if (kind === 'out' && cable) entry.outputs.push(cable);
    else if (kind === 'in' && cable) entry.inputs.push(cable);
    else if (kind === 'param') entry.params += 1;
    byType.set(type, entry);
  }
  return byType;
}

const CONTRACT = readContractLock();

/**
 * Does this module render `.faceplate.audio`?
 *
 * ⚠ DELIBERATELY STRICTER THAN THE RUNTIME RULE, and the reason is an ordering
 * hazard rather than caution. `cableTypeForDef` takes `outputs[0] ?? inputs[0]`
 * — the DEF's declaration order — while `contract-lock.txt` lists ports SORTED
 * BY ID. Those two orders are not the same, so asking this artifact for "the
 * first output" would be asking a different question than the app asks. Instead
 * every output must map to `audio`, which makes the answer INVARIANT to
 * ordering: whichever port the real def happens to declare first, the class is
 * the same. A module with mixed outputs is simply not offered as a fixture —
 * over-rejecting only shrinks the pool, and the slack assertion guards that.
 */
function rendersAudioFaceplate(type: string): boolean {
  const ports = CONTRACT.get(type);
  if (!ports) return false; // unknown to the golden → fail safe, never guess
  const cables = ports.outputs.length > 0 ? ports.outputs : ports.inputs;
  if (cables.length === 0) return false;
  return cables.every((c) => domainClassForCable(c) === 'audio');
}

/**
 * Every module that could serve, SIMPLEST FIRST.
 *
 * ⚠ THE ORDER IS DERIVED, NOT ALPHABETICAL, and that is the point rather than a
 * detail. What this fixture needs is stated in its own contract — "simple,
 * stable, cheap-to-mount" — and param count is that contract's own measure, so
 * ordering by it means the fixture's REQUIREMENT chooses the pick instead of
 * the accident of a name's first letter. Ties break on port count and then on
 * the type name, so the result is still fully deterministic and never depends
 * on registry or glob iteration order.
 */
function derivePool(): string[] {
  return [...CONTRACT.keys()]
    .filter((t) => !STRICT_FACES.has(t))
    .filter((t) => !(t in DENIED))
    .filter((t) => rendersAudioFaceplate(t))
    .filter((t) => mountsAFader(t))
    .sort((a, b) => {
      const pa = CONTRACT.get(a)!;
      const pb = CONTRACT.get(b)!;
      const ports = (p: LockedPorts): number => p.inputs.length + p.outputs.length;
      return pa.params - pb.params || ports(pa) - ports(pb) || a.localeCompare(b);
    });
}

/**
 * The whole derived pool, exported so a test can assert it has SLACK rather
 * than merely being non-empty. `_face-fixtures.test.ts` requires MORE THAN ONE
 * member: the point of #1789 is to redden while there is still room, instead of
 * at the moment the last candidate is consumed.
 */
export const UNMIGRATED_AUDIO_POOL: readonly string[] = derivePool();

/** Every module type the contract golden knows — the anchor the deny list is
 *  checked against, so an entry naming a module that no longer exists is RED
 *  rather than silently decorative. */
export const CONTRACT_MODULE_TYPES: readonly string[] = [...CONTRACT.keys()].sort();

/**
 * The pick: the first member, alphabetically. Deterministic by SORT rather than
 * by hand-ordering, so the choice never depends on registry glob order.
 */
export const UNMIGRATED_AUDIO_MODULE: string = (() => {
  const pick = UNMIGRATED_AUDIO_POOL[0];
  if (!pick) {
    // Report WHY each near-miss missed, from the same predicates — an empty
    // pool with no diagnosis is the failure #1765 was written to end.
    const near = [...CONTRACT.keys()]
      .sort()
      .map((t) => {
        if (STRICT_FACES.has(t)) return null; // promoted: the expected, boring case
        if (t in DENIED) return `${t}: DENIED — ${DENIED[t]}`;
        if (!rendersAudioFaceplate(t)) return `${t}: does not render .faceplate.audio`;
        if (!mountsAFader(t)) {
          return `${t}: its legacy card mounts no <NeonFader>, so the operability leg has no '.fader-wrap .track' to drive`;
        }
        return null;
      })
      .filter((x): x is string => x !== null);
    throw new Error(
      'the derived legacy-fallback pool is EMPTY: no registered module is un-promoted, ' +
        "renders .faceplate.audio (domainClassForDef === 'audio') and mounts a " +
        '<NeonFader>. Every spec importing e2e/tests/_face-fixtures.ts fails at import ' +
        'until this resolves.\n  ' +
        near.join('\n  '),
    );
  }
  return pick;
})();
