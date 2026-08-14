// e2e/tests/_flip-key.ts
//
// THE RACK-FLIP SHORTCUT, for specs.
//
// The flip gesture is BARE TAB, by owner ruling (#1629): the flip outranks
// native focus traversal in this app (the #1508→#1599 rebind to `f` was
// reversed). Shift-Tab and Tab inside typing targets remain native.
//
// `RACK_FLIP_KEY` is imported from the APP SOURCE, never re-typed here: the
// binding then has exactly ONE definition, and a rebind updates the specs by
// construction instead of leaving a suite that is green about the wrong key.
//
// ⚠ A spec that wants NATIVE TAB semantics has exactly two sanctioned forms:
// Tab while a typing target holds focus (blur/advance out of the field — see
// in-card-title.spec.ts) and Shift-Tab. A bare Tab anywhere else IS a flip.

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
