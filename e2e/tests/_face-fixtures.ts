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
 * waves — the day `noise` gets a face, this silently moves to `ringback`.
 * Every entry must be `domain: 'audio'` (the bridge specs assert
 * `.faceplate.audio`) and must mount a real legacy card with controls.
 */
const UNMIGRATED_CANDIDATES = ['noise', 'ringback', 'attenumix', 'gatemaiden'] as const;

export const UNMIGRATED_AUDIO_MODULE: string = (() => {
  const pick = UNMIGRATED_CANDIDATES.find((t) => !STRICT_FACES.has(t));
  if (!pick) {
    throw new Error(
      'every UNMIGRATED_CANDIDATES module is now in STRICT_FACES — add another ' +
        'un-migrated audio module to the list in e2e/tests/_face-fixtures.ts',
    );
  }
  return pick;
})();
