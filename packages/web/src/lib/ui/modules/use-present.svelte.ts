// use-present.svelte.ts
//
// Svelte-5-runes wrapper around present-window's startPresent, shared by the
// video cards (VideoOutCard / B3ntb0xCard) so the "Present on second display"
// wiring is authored once. Tracks live sessions reactively (so the menu can show
// "Stop presenting"), resolves each target screen's rect from the existing
// fullscreen controller, and guarantees teardown.
//
// MULTI-DISPLAY: holds ONE session PER screen id (a Map), so a multi-projector
// venue can light up every display. `present(id)` adds/replaces that screen's
// popup while leaving the others running; `presentAll(ids)` fans a popup out to
// every given display IN ONE CALL (one user gesture → one window.open per
// screen — the Window Management API's companion-window provision lets a single
// activation open the set; any the popup-blocker still refuses are skipped, not
// fatal). Because each present popup is sized to cover its whole display, this
// path needs NO Fullscreen API — so it never triggers the browser's "is now full
// screen" overlay (see presentation-fullscreen-plan). `stop()` tears down all;
// `stop(id)` tears down one.
//
// A card creates one instance, hands it a getter for the OUTPUT canvas + the
// fullscreen controller (for getScreenRect), and calls present / presentAll /
// stop. Call dispose() from onDestroy so a deleted card never leaves a popup
// open or a blit loop running.

import type { FullscreenController } from './use-fullscreen.svelte';
import { startPresent, type PresentSession, type StartPresentArgs } from './present-window';

export interface PresentController {
  /** Reactive: is at least one present popup currently open? Drives the menu's
   *  "Stop presenting" item. */
  readonly isPresenting: boolean;
  /** Reactive: how many present popups are open (across displays). */
  readonly presentingCount: number;
  /** Open a present popup on the display behind `screenId`, fed the canvas.
   *  Keeps any OTHER displays' popups running; replaces this screen's if already
   *  presenting. Returns false if there's no canvas or the popup is blocked. */
  present(screenId: string): boolean;
  /** Open a popup on EACH given display in one call (one user gesture). Skips
   *  displays already presenting + any the popup-blocker refuses. Returns the
   *  number of NEW popups opened. */
  presentAll(screenIds: string[]): number;
  /** Close popups + stop blit loops. With a screenId, just that display; with
   *  no argument, ALL of them. Safe to call when idle. */
  stop(screenId?: string): void;
  /** Tear down on unmount (closes every open popup + stops the blit loops). */
  dispose(): void;
}

export interface CreatePresentArgs {
  /** Returns the live OUTPUT <canvas> to mirror (null until mounted). */
  getCanvas: () => HTMLCanvasElement | null;
  /** The card's fullscreen controller — used for getScreenRect(screenId). */
  fullscreen: Pick<FullscreenController, 'getScreenRect'>;
  /** Test seam — defaults to the real startPresent. */
  start?: (args: StartPresentArgs) => PresentSession | null;
}

export function createPresent(args: CreatePresentArgs): PresentController {
  const start = args.start ?? startPresent;
  // One live session per screen id.
  const sessions = new Map<string, PresentSession>();
  let presentingCount = $state(0);
  // Poll the sessions' `closed` (a popup may be closed by the user via the OS
  // window button) so the count flips back without a card interaction.
  let poll: ReturnType<typeof setInterval> | null = null;

  function syncCount() {
    // Prune any session whose popup the user closed directly.
    for (const [id, s] of sessions) {
      if (s.closed) sessions.delete(id);
    }
    presentingCount = sessions.size;
    if (sessions.size === 0 && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  function ensurePoll() {
    if (!poll && typeof setInterval === 'function') {
      poll = setInterval(syncCount, 600);
    }
  }

  /** Open (or replace) the popup for one screen. Returns true if a popup opened. */
  function openOne(screenId: string): boolean {
    const canvas = args.getCanvas();
    if (!canvas) return false;
    // Replace this screen's existing session (keep the others).
    const existing = sessions.get(screenId);
    if (existing) {
      existing.stop();
      sessions.delete(screenId);
    }
    const rect = args.fullscreen.getScreenRect(screenId);
    const next = start({ canvas, rect });
    if (!next) return false; // popup blocked.
    sessions.set(screenId, next);
    return true;
  }

  function stop(screenId?: string) {
    if (screenId === undefined) {
      for (const s of sessions.values()) s.stop();
      sessions.clear();
    } else {
      const s = sessions.get(screenId);
      if (s) {
        s.stop();
        sessions.delete(screenId);
      }
    }
    syncCount();
  }

  return {
    get isPresenting() {
      return presentingCount > 0;
    },
    get presentingCount() {
      return presentingCount;
    },
    present(screenId: string): boolean {
      const ok = openOne(screenId);
      if (ok) {
        presentingCount = sessions.size;
        ensurePoll();
      }
      return ok;
    },
    presentAll(screenIds: string[]): number {
      let opened = 0;
      for (const id of screenIds) {
        if (sessions.has(id)) continue; // already lit on this display.
        if (openOne(id)) opened++;
      }
      if (opened > 0) {
        presentingCount = sessions.size;
        ensurePoll();
      }
      return opened;
    },
    stop,
    dispose() {
      stop();
    },
  };
}
