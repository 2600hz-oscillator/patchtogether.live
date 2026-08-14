// e2e/tests/_flip-key.ts
//
// THE RACK-FLIP SHORTCUT, for specs (#1508).
//
// The flip gesture used to be BARE TAB. That consumed the browser's
// fundamental focus-traversal key across the entire shell, which for a
// keyboard-only or screen-reader user is the only way to reach a control at
// all — an accessibility defect, not a preference. Tab is native again and the
// flip moved to a bare letter.
//
// `RACK_FLIP_KEY` is imported from the APP SOURCE, never re-typed here: the
// binding then has exactly ONE definition, and a rebind updates the specs by
// construction instead of leaving a suite that is green about the wrong key.
//
// ⚠ A spec that wants NATIVE TAB (blurring a field, walking the focus order)
// should keep calling `page.keyboard.press('Tab')` directly — that is now a
// real traversal and no longer a flip.

import type { Page } from '@playwright/test';
import { RACK_FLIP_KEY } from '../../packages/web/src/lib/graph/workflow-pins';

export { RACK_FLIP_KEY };

/**
 * Press the rack-flip shortcut.
 *
 * SINGLE-OWNER by occupancy (Canvas.svelte): with the dock full-view OPEN the
 * dock flips its panes to their rear cards; with it CLOSED the canvas-wide
 * rear view toggles. One handler acts per keystroke either way.
 *
 * Both owners are inert while a text input / textarea / select /
 * contenteditable holds focus (`isTypingTarget`), so a spec that has just
 * typed into a field must blur first — same as it had to for bare Tab.
 */
export async function pressFlipKey(page: Page): Promise<void> {
  await page.keyboard.press(RACK_FLIP_KEY);
}
