// use-present.svelte.ts
//
// Svelte-5-runes wrapper around present-window's startPresent, shared by the
// video cards (VideoOutCard / B3ntb0xCard) so the "Present on second display"
// wiring is authored once. Tracks the live session reactively (so the menu can
// show "Stop presenting"), resolves the target screen's rect from the existing
// fullscreen controller, and guarantees teardown.
//
// A card creates one instance, hands it a getter for the OUTPUT canvas + the
// fullscreen controller (for getScreenRect), and calls present(screenId) /
// stop(). Call dispose() from onDestroy so a deleted card never leaves a popup
// open or a blit loop running.

import type { FullscreenController } from './use-fullscreen.svelte';
import { startPresent, type PresentSession } from './present-window';

export interface PresentController {
  /** Reactive: is a present popup currently open? Drives the menu's
   *  "Stop presenting" item + suppresses a second present. */
  readonly isPresenting: boolean;
  /** Open a present popup on the display behind `screenId`, fed the canvas.
   *  No-op (and returns false) if there's no canvas or the popup is blocked.
   *  Replaces any existing session. */
  present(screenId: string): boolean;
  /** Close the popup + stop the blit loop. Safe to call when idle. */
  stop(): void;
  /** Tear down on unmount (closes any open popup + stops the blit loop). */
  dispose(): void;
}

export interface CreatePresentArgs {
  /** Returns the live OUTPUT <canvas> to mirror (null until mounted). */
  getCanvas: () => HTMLCanvasElement | null;
  /** The card's fullscreen controller — used for getScreenRect(screenId). */
  fullscreen: Pick<FullscreenController, 'getScreenRect'>;
}

export function createPresent(args: CreatePresentArgs): PresentController {
  let session: PresentSession | null = null;
  let isPresenting = $state(false);
  // Poll the session's `closed` (the popup may be closed by the user via the
  // OS window button) so isPresenting flips back without a card interaction.
  let poll: ReturnType<typeof setInterval> | null = null;

  function clearPoll() {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  function syncFromSession() {
    if (session && session.closed) {
      session = null;
      isPresenting = false;
      clearPoll();
    }
  }

  function stop() {
    session?.stop();
    session = null;
    isPresenting = false;
    clearPoll();
  }

  return {
    get isPresenting() {
      return isPresenting;
    },
    present(screenId: string): boolean {
      const canvas = args.getCanvas();
      if (!canvas) return false;
      // Only one popup at a time — replace any existing session.
      if (session) stop();
      const rect = args.fullscreen.getScreenRect(screenId);
      const next = startPresent({ canvas, rect });
      if (!next) return false;
      session = next;
      isPresenting = true;
      // Watch for the user closing the popup window directly.
      poll = setInterval(syncFromSession, 600);
      return true;
    },
    stop,
    dispose() {
      stop();
    },
  };
}
