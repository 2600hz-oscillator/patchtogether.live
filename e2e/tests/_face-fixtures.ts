// e2e/tests/_face-fixtures.ts
//
// Fixtures for the workflow-mode FACE / legacy-fallback bridge specs.
//
// Deliberately NOT in `_helpers.ts`: that file is a hand-listed member of the
// @collab attest basis (scripts/collab-attest-lib.ts, COLLAB_STANDALONE_HELPER),
// so anything added to it churns the collab content-hash and forces a full
// re-attest — a Postgres spin-up plus the ~50-test @collab lane. None of this
// has anything to do with multiplayer, so it lives here instead and the collab
// hash stays put. Keep it that way: put face/shell fixtures in THIS file.

import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';
import { getModuleDef } from '../../packages/web/src/lib/audio/module-registry';
import { domainClassForDef } from '../../packages/web/src/lib/ui/workflow/module-shell-model';

/**
 * A still-UN-MIGRATED audio module — the fixture for every legacy-fallback test
 * (uniform placeholder in the lane + the verbatim legacy card in the dock).
 *
 * DERIVED, not hard-coded, because a hard-coded fixture ROTS: each P1 face wave
 * promotes more modules, and whichever module the bridge tests named eventually
 * joins STRICT_FACES and starts rendering a curated face — so the test asserting
 * "placeholder is visible" fails for a reason that is not a bug. That has now
 * happened twice: `vca` was consumed by P1 batch 1, `delay` by P1 batch 3.
 *
 * The candidate list is an ORDERED PREFERENCE of simple, stable, cheap-to-mount
 * audio modules; we take the first that is not yet promoted. Deterministic (a
 * fixed list, not registry iteration order), and self-healing across future
 * waves — the day `noise` gets a face, this silently moves to `attenumix`.
 * Every entry must be `domain: 'audio'` (the bridge specs assert
 * `.faceplate.audio`) and must mount a real legacy card with controls.
 *
 * ⚠ A PROMOTED MODULE IS REMOVED FROM THE LIST, not left in for `find` to skip.
 * `ringback` was consumed by the 2026-08-02 face batch and dropped here in the
 * same commit: leaving it would have made the sentence above name a module
 * that can never be picked, which is how a self-healing fixture quietly stops
 * being readable.
 */
// `destroy` is the working pick: 3 params, audio in AND out, cheap to mount.
// Deliberately NOT `audioIn` (needs getUserMedia — capability-dependent on CI)
// and NOT `twotracks` (a two-reel tape emulator; it mounts, but the bridge test
// timed out at 30 s on `boundingBox` waiting for it, and this fixture's whole
// contract is "simple, stable, cheap-to-mount"). `gatemaiden` is kept in the
// list on purpose: the predicate below now REJECTS it out loud, which is the
// documentation.
const UNMIGRATED_CANDIDATES = ['noise', 'attenumix', 'destroy', 'gatemaiden'] as const;

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
    return true;
  });
  if (!pick) {
    throw new Error(
      'no UNMIGRATED_CANDIDATES module can serve as the legacy-fallback fixture. ' +
        'Add another module that is BOTH un-promoted AND renders .faceplate.audio ' +
        `(domainClassForDef === 'audio') in e2e/tests/_face-fixtures.ts.\n  ` +
        rejected.join('\n  '),
    );
  }
  return pick;
})();
