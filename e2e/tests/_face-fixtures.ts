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
import { domainClassForDef } from '../../packages/web/src/lib/ui/workflow/module-shell-model';
// ⚠ THERE IS NO IMPORTABLE VIDEO REGISTRY HERE, and the video fixture below
// found that out by rejecting every one of its candidates. `getModuleDef`
// (audio) returns undefined for a video module, and `getVideoModuleDef` returns
// undefined too under Playwright's loader: the video registry is populated by
// `import.meta.glob` side effects, which is Vite-only and does not run in plain
// Node. So the video check reads the SOURCE, exactly like `mountsAFader` below
// and for exactly the same stated reason.

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
 * The candidate list is an ORDERED PREFERENCE of simple, stable, cheap-to-mount
 * audio modules; we take the first that is not yet promoted. Deterministic (a
 * fixed list, not registry iteration order), and self-healing across future
 * waves — the day `moog902` gets a face, this moves to whatever is added below
 * it. Every entry must be `domain: 'audio'` (the bridge specs assert
 * `.faceplate.audio`) and must mount a real legacy card with controls.
 *
 * ⚠ SELF-HEALING IS NOT THE SAME AS SELF-REFILLING, and the Q18 promotion is
 * the proof: the list ran DRY. A promoting PR must leave at least one ACCEPTED
 * candidate behind it, and the IIFE below throws at import time when it does
 * not — loudly, but only once someone runs the suite.
 *
 * ⚠ A PROMOTED MODULE IS REMOVED FROM THE LIST, not left in for `find` to skip.
 * `ringback` was consumed by the 2026-08-02 face batch and dropped here in the
 * same commit: leaving it would have made the sentence above name a module
 * that can never be picked, which is how a self-healing fixture quietly stops
 * being readable.
 */
// `stereovca` is the working pick: 2 params, audio in and out, a two-Fader
// card, and a self-contained TS worklet with no Faust bundle and no asset load.
//
// ⚠ IT HAS TO MOUNT A **FADER**, and that requirement was NOWHERE in this file
// until it cost a cycle. `workflow-shell.spec.ts`'s operability leg drives
// `.fader-wrap .track` specifically; the first replacement tried here
// (`moog902`) satisfied every stated requirement — un-promoted, audio class, a
// real card with controls — and its card draws KNOBS, so the spec spent 30 s in
// `locator.boundingBox` and failed as a TIMEOUT, which reads like a broken app.
// The predicate below now CHECKS it, for the same reason `gatemaiden`'s domain
// class is checked rather than described.
//
// ⚠ IT REPLACES `destroy`, WHICH THIS WAVE PROMOTED — and the replacement is
// the whole reason a promotion has to read this file. `destroy` was the LAST
// candidate the predicate could accept (`noise` and `attenumix` were consumed
// by earlier waves and `gatemaiden` is rejected below), so promoting it with
// this list untouched does not degrade the fixture, it EXHAUSTS it: the IIFE
// throws at module load and every spec that imports this file fails before it
// runs a line. That is #1689's class with the failure moved to import time.
//
// Deliberately NOT `audioIn` (needs getUserMedia — capability-dependent on CI)
// and NOT `twotracks` (a two-reel tape emulator; it mounts, but the bridge test
// timed out at 30 s on `boundingBox` waiting for it, and this fixture's whole
// contract is "simple, stable, cheap-to-mount"). `gatemaiden` is kept in the
// list on purpose: the predicate below now REJECTS it out loud, which is the
// documentation.
const UNMIGRATED_CANDIDATES = ['stereovca', 'moog902', 'gatemaiden'] as const;

/**
 * ORDERED PREFERENCE of un-promoted VIDEO modules for `UNMIGRATED_VIDEO_MODULE`
 * — same contract as the audio list: a promoting PR removes its module from
 * here and must leave at least one accepted candidate behind, or the IIFE
 * throws at import time.
 *
 * `backdraft` is deliberately ABSENT: the first video face consumed it, and per
 * the audio list's own rule a promoted module is REMOVED rather than left for
 * `find` to skip. `bentbox` / `b3ntb0x` are the mirror-gate siblings (simple
 * cards, cheap to mount); `freezeframe` and `grainsOfVision` back them up.
 */
const UNMIGRATED_VIDEO_CANDIDATES = ['bentbox', 'b3ntb0x', 'freezeframe', 'grainsOfVision'] as const;

/**
 * Is this a VIDEO module? Read off the DEF SOURCE — a file under
 * `lib/video/modules/` declaring `domain: 'video'` is exactly what the video
 * registry's glob picks up, so this asks the registry's own question without
 * needing the registry (see the import note at the top of this file).
 *
 * Fails SAFE: an unreadable or non-matching file rejects the candidate with a
 * named reason rather than accepting it silently.
 */
function declaresVideoDomain(type: string): boolean {
  try {
    return /domain:\s*'video'/.test(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../packages/web/src/lib/video/modules',
          `${type}.ts`,
        ),
        'utf8',
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Does this module's legacy card mount a `Fader`? Read off the CARD SOURCE, so
 * the fixture is rejected at import time with a reason instead of at 30 s with
 * a timeout. Same shape as the `domainClassForDef` check below: the predicate
 * the assertion depends on, run here rather than described in prose.
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
    return /<Fader\b/.test(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/web/src/lib/ui/modules', file),
        'utf8',
      ),
    );
  } catch {
    return false;
  }
}

/**
 * ⚠ "AUDIO" HERE MEANS THE FACEPLATE'S CLASS, NOT THE DEF'S `domain` FIELD, and
 * the two disagree. The bridge specs assert `.faceplate.audio`, which
 * `DockFullView` derives via `domainClassForDef` — i.e. from the module's CABLE
 * types, not its declared domain. `gatemaiden` is `domain: 'audio'` with GATE
 * ports, so it renders `.faceplate.gate`: it satisfied the comment's stated
 * requirement and still could not satisfy the assertion.
 *
 * That stayed invisible while `attenumix` was the pick and surfaced the moment
 * attenumix was promoted — a fixture that heals itself into an INVALID pick is
 * worse than one that rots loudly, so the requirement is now CHECKED with the
 * same predicate the assertion depends on instead of being described in prose.
 */
export const UNMIGRATED_AUDIO_MODULE: string = (() => {
  const rejected: string[] = [];
  const pick = UNMIGRATED_CANDIDATES.find((t) => {
    if (STRICT_FACES.has(t)) {
      rejected.push(`${t}: promoted (in STRICT_FACES)`);
      return false;
    }
    const cls = domainClassForDef(getModuleDef(t));
    if (cls !== 'audio') {
      rejected.push(`${t}: renders .faceplate.${cls}, not .faceplate.audio`);
      return false;
    }
    if (!mountsAFader(t)) {
      rejected.push(`${t}: its legacy card mounts no <Fader>, so the operability leg has no '.fader-wrap .track' to drive`);
      return false;
    }
    return true;
  });
  if (!pick) {
    throw new Error(
      'no UNMIGRATED_CANDIDATES module can serve as the legacy-fallback fixture. ' +
        'Add another module that is un-promoted, renders .faceplate.audio ' +
        `(domainClassForDef === 'audio') AND mounts a <Fader>, in ` +
        'e2e/tests/_face-fixtures.ts.\n  ' +
        rejected.join('\n  '),
    );
  }
  return pick;
})();

/**
 * A still-UN-MIGRATED **VIDEO** module — the legacy-card half of
 * `workflow-dock-ux`'s "migrated AND legacy cards" split-pane case.
 *
 * ⚠ IT EXISTS BECAUSE THAT SPEC HARD-CODED `backdraft`, AND THE FIRST VIDEO
 * FACE PROMOTED IT. The spec needs a module that renders a lane PLACEHOLDER and
 * a verbatim LEGACY CARD in the dock — i.e. one that is NOT in STRICT_FACES —
 * and it named the module that was, at the time, the most obvious un-migrated
 * video card. That is the same rot the audio sibling above was built to end,
 * one domain over, and it had to bite once here before anyone noticed the
 * asymmetry: the audio fixture was derived and the video one was a literal.
 *
 * Checked with the predicates the assertions depend on, not described in prose:
 * un-promoted (else it renders a curated face, not a placeholder) and
 * `domain: 'video'` (the case is explicitly the VIDEO legacy-card path — that
 * is the `useStore()`-at-init card class the crash-free assertion is about).
 */
export const UNMIGRATED_VIDEO_MODULE: string = (() => {
  const rejected: string[] = [];
  const pick = UNMIGRATED_VIDEO_CANDIDATES.find((t) => {
    if (STRICT_FACES.has(t)) {
      rejected.push(`${t}: promoted (in STRICT_FACES) — it renders a curated face, not a placeholder`);
      return false;
    }
    if (!declaresVideoDomain(t)) {
      rejected.push(
        `${t}: no packages/web/src/lib/video/modules/${t}.ts declaring domain: 'video'`,
      );
      return false;
    }
    return true;
  });
  if (!pick) {
    throw new Error(
      'no UNMIGRATED_VIDEO_CANDIDATES module can serve as the video legacy-fallback fixture. ' +
        'Add another un-promoted `domain: video` module with a real legacy card in ' +
        'e2e/tests/_face-fixtures.ts.\n  ' +
        rejected.join('\n  '),
    );
  }
  return pick;
})();
