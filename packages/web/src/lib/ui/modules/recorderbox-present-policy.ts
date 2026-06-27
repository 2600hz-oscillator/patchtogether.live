// packages/web/src/lib/ui/modules/recorderbox-present-policy.ts
//
// Pure UI-policy for starting a RECORDING without breaking PRESENTATION mode.
//
// While the page is in element-fullscreen, Chrome resolves ANY modal browser
// surface — the directory picker, a permission prompt, a confirm() — by EXITING
// fullscreen. That kicks the performer out of presentation, re-flashes the
// "<site> is now full screen" overlay, and forces a re-click. So at record START
// while presenting we must NOT open a modal: use an already-chosen folder if we
// have one, else fall back to the no-prompt download path; and skip the
// (datetime-named, near-impossible) overwrite confirm.
//
// These are pure functions (no DOM) so they unit-test under node — the card
// passes `document.fullscreenElement != null`. Lives under lib/ui/modules (NOT
// lib/video) ON PURPOSE: lib/video/** is the WebGL attest basis, and this is
// non-rendering UI policy that must not force a real-GPU re-attest.
// See the presentation-fullscreen-plan memory.

export type RecordFolderPlan =
  /** A usable folder is already chosen+granted → write to it, no prompt. */
  | { action: 'use' }
  /** No folder, and it's safe to show the picker (not presenting). */
  | { action: 'prompt' }
  /** No folder while presenting → don't pop the picker; use the download fallback. */
  | { action: 'download' };

/**
 * Decide how to resolve the destination folder at record START without ever
 * opening a modal while presenting. `haveUsableFolder` = a cached dir handle
 * whose write permission is already granted (the caller verifies that first).
 */
export function planRecordStartFolder(
  haveUsableFolder: boolean,
  isFullscreen: boolean,
): RecordFolderPlan {
  if (haveUsableFolder) return { action: 'use' };
  return isFullscreen ? { action: 'download' } : { action: 'prompt' };
}

/**
 * The overwrite `confirm()` is a modal, so it's only allowed when NOT presenting.
 * Chunk names carry a unique datetime, so skipping it while fullscreen risks
 * essentially nothing and keeps the performer in fullscreen.
 */
export function mayShowOverwriteConfirm(isFullscreen: boolean): boolean {
  return !isFullscreen;
}
