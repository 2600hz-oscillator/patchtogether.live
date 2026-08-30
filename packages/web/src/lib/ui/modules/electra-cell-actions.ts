// packages/web/src/lib/ui/modules/electra-cell-actions.ts
//
// SEND TO ELECTRA, as a face cell — and the OUTCOME STORE the faceplate needs
// because a cell cannot own component state.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// `ElectraConnectButton.svelte` kept the whole flash in COMPONENT-LOCAL `$state`
// (`status`, `detail`, and the `ElectraAutoconfig` instance itself). A ranked
// ACTION cell is rendered by the SHARED shell, its `onFire` is a plain function
// in this file, and the surface that shows the outcome is a different component
// again. So the flash and its outcome need a home OUTSIDE both. This is the
// `launchpad-cell-actions.ts` / `camera-status-registry` shape: a named seam
// that OWNS the gesture and publishes what it did, so a face can show it.
//
// ⚠ THE STORE IS GLOBAL, NOT PER-NODE, AND THAT IS A CORRECTION rather than a
// convenience. The button's variables were per-component, but the thing they
// describe is not: `ElectraAutoconfig.run()` is already idempotent ACROSS
// instances through the module-scope `liveAutoconfig` (`electra/autoconfig.ts`),
// and there is ONE Electra One on the end of the cable. Two surfaces could
// therefore print two different answers about the same hardware, and the newer
// of them was not necessarily the one you were looking at. Scoping the store the
// way the device layer is already scoped makes that unrepresentable — and it is
// what lets the legacy card and the faceplate share ONE flash rather than
// running two.
//
// ⚠ THE AUTOCONFIG INSTANCE MOVES HERE WITH IT, AND THAT PRESERVES A SHIPPED-BUG
// GUARD rather than dropping one. `ElectraConnectButton.svelte:36-42` stopped the
// PREVIOUS orchestrator before every new run, because "its inbound listeners +
// feedback pump hold the OLD allocation table, and leaving them live makes one
// hardware twist write two params (the row-2↔row-3 ElectraControl crosstalk)" —
// with a named regression at `electra/autoconfig.test.ts`. `send()` below does
// the same `stop()` in the same place. What CHANGES is that the reference no
// longer dies with a component: the drawer body and the lane cell have different
// unmount lifetimes from the card, and a teardown keyed on whichever surface
// happened to render is the `card-unmount-kills-node-resources` class
// (#1531/#1574/#1583) pointed at a MIDI device. Module scope is the fix, not a
// regression: the guard now runs on the run that needs it instead of on whoever
// unmounted last.
//
// ⚠ THE AUDITION RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE AWAIT — the rule
// `launchpad-cell-actions.ts` and `midiclock-cell-actions.ts` both state, for the
// same reason. `run()` sits on `requestMIDIAccess`, which can hang for as long as
// the browser feels like when it declines to show its own prompt. `delivered` is
// not about that OUTCOME; it is about whether the press reached a seam that could
// act, which is knowable the instant the capability is read.
//
// ⚠ WHAT `delivered: false` MEANS HERE. This module is `domain: 'meta'` — no
// ports, no factory, no engine node — so unlike the five action cells that
// resolve a callable off the live ENGINE handle, its seam is the Web MIDI
// capability the whole Electra pipeline sits on. With no
// `navigator.requestMIDIAccess` there is nothing behind the button at all, which
// is the autoconfig's own first branch (`broker.connect()` → `{ ok: false, reason:
// 'no-midi-access' }`). A press on a browser without Web MIDI reaches nothing, is
// RECORDED as `delivered: false`, and is the permanent NEGATIVE CONTROL in
// `electra-cell-actions.test.ts` — which is what stops the probe being the
// vacuous "this function was called" it would otherwise be.
//
// ⚠ `engine-message` IS THE SEAM NAME, with the stretch stated, exactly as
// `launchpad-cell-actions.ts` states it: the ledger's five members are three
// struck-voice `manual-*` seams, a `file-export`, and `engine-message` — the "a
// command was dispatched to a live handle" member. That is what this is, the
// handle being the MIDI broker rather than an AudioWorklet. A sixth member for
// one module would be new machinery for no new discriminating power.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { webMidiSupported } from '$lib/audio/midi-access';
import { ElectraAutoconfig } from '$lib/electra/autoconfig';
import { buildLiveHost } from '$lib/electra/host';
import luaSource from '$lib/electra/lua-bundle';
import {
  setElectraDisplayBindings,
  clearElectraDisplayBindings,
} from '$lib/midi/midi-learn.svelte';
import { recordAudition } from '$lib/ui/modules/audition-ledger';

/**
 * What the last flash reported.
 *
 * The button's own vocabulary (`ElectraConnectButton.svelte:27`) minus nothing:
 * every member is reachable and every member changes what the surface says.
 */
export type ElectraFlashStatus = 'idle' | 'connecting' | 'ready' | 'no-device' | 'error';

export interface ElectraFlashOutcome {
  status: ElectraFlashStatus;
  /**
   * The one-line reason, for the ACCESSIBLE NAME — never painted.
   *
   * ⚠ THIS FIELD IS THE FIX FOR A LIVE DEFECT, not new decoration. The button
   * computed `detail` on four paths (`res.reason`, a caught exception's
   * `message`, and both success arms) and rendered it on NONE — its template
   * printed only the five status words. So a flash that failed DISCARDED its own
   * reason, including a thrown error's text, and "no MIDI" and "the device
   * rejected the preset" were the same two words on screen. Painting it is not
   * the fix (that is a fifth resting-derived-text mechanism, refused by the
   * 2026-08-19 ruling); `aria-label` / `title` is exactly where the ruling puts
   * this class — speakable and assertable, unpainted.
   */
  detail: string;
}

let outcome: ElectraFlashOutcome = { status: 'idle', detail: '' };
const listeners = new Set<() => void>();

/** The current flash outcome. */
export function electraFlashOutcome(): ElectraFlashOutcome {
  return outcome;
}

/** Subscribe to outcome changes. Returns the unsubscribe — a surface that
 *  subscribed without releasing is the node-resource-leak class. */
export function onElectraFlash(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function setOutcome(status: ElectraFlashStatus, detail: string): void {
  outcome = { status, detail };
  for (const l of listeners) l();
}

/** TEST SEAM: forget the outcome. Never called from app code. */
export function __resetElectraFlash(): void {
  outcome = { status: 'idle', detail: '' };
  listeners.clear();
  auto = null;
}

/**
 * The device seam the gesture reaches.
 *
 * INJECTABLE so both the delivered=true and the delivered=false legs are
 * exercised in the unit lane with no browser, no Web MIDI and no hardware. A
 * probe whose false branch is unreachable is the vacuity the audition ledger
 * exists to prevent, and "the CI runner has no Electra" is not a way to reach it
 * — the CAPABILITY is present on the runner, only the hardware is not.
 */
export interface ElectraFlashSeam {
  midiAvailable(): boolean;
  /** Build + run one autoconfig, returning what it reported. */
  run(): Promise<{ ok: boolean; isElectra: boolean; reason?: string }>;
  /** Register the generated CC map for the bound-BADGE only (display-only). */
  publishBindings(): void;
  /** Tear the previous orchestrator down before a new run (the crosstalk guard). */
  stopPrevious(): void;
}

let auto: ElectraAutoconfig | null = null;

const LIVE_SEAM: ElectraFlashSeam = {
  midiAvailable: webMidiSupported,
  stopPrevious: () => { auto?.stop(); },
  run: async () => {
    const host = buildLiveHost({ getEngine: () => getActiveEngine(), luaSource });
    auto = new ElectraAutoconfig(host);
    return auto.run();
  },
  publishBindings: () => {
    // Display-only + device-lifetime, NOT the dispatched/persisted midi-learn
    // namespace — importing into `bindings` double-dispatched every param AND
    // its newest-wins collision repair silently evicted the user's manual
    // MIDI-learn mappings on a shared channel-0 address. See
    // `midi-learn.svelte.ts:145`. Verbatim from the button.
    const learnable = (auto?.allocations ?? [])
      .filter((a) => a.role === 'rw')
      .map((a) => ({ key: a.key, channel: 0, cc: a.number, learnedAt: Date.now() }));
    setElectraDisplayBindings(learnable);
  },
};

/** Drop the display-only bound badges. The surfaces that mount the button call
 *  this on unmount, exactly as the button always did. */
export function clearElectraBadges(): void {
  clearElectraDisplayBindings();
}

/**
 * SEND TO ELECTRA — generate the 3-page preset from the whole rack and push it.
 *
 * Returns whether the press reached the seam, and records that. Mirrors
 * `ElectraConnectButton.svelte:31-74` branch for branch.
 *
 * `opts.recordPress: false` is the AUTO-RECONNECT arm (#2248): the same flash,
 * fired by the load/hot-plug machine instead of a finger. The audition ledger
 * records what a PRESS did — an automatic flash presses nothing, so writing a
 * `delivered` record for it would make "the button reached the seam" assertable
 * from a run where no button was ever touched. Everything else (the outcome
 * store, the crosstalk `stopPrevious`, the binding badges) is deliberately
 * identical, so the two entry points can never disagree about the hardware.
 */
export function electraSendToDevice(
  nodeId: string,
  seam: ElectraFlashSeam = LIVE_SEAM,
  opts: { recordPress?: boolean } = {},
): boolean {
  const recordPress = opts.recordPress !== false;
  if (outcome.status === 'connecting') return false;
  if (!seam.midiAvailable()) {
    if (recordPress) recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    setOutcome('no-device', 'no-midi-access');
    return false;
  }
  if (recordPress) recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  setOutcome('connecting', '');
  // The crosstalk guard, in the same place the button had it.
  seam.stopPrevious();
  void seam
    .run()
    .then((res) => {
      if (!res.ok) {
        setOutcome(res.reason === 'no-midi-access' ? 'no-device' : 'error', res.reason ?? 'failed');
        return;
      }
      seam.publishBindings();
      // ⚠ THE BRANCH THAT WAS DEAD IS NOW REAL. The button read
      // `status = res.isElectra ? 'ready' : 'ready'` — both arms identical,
      // under the comment "uploaded either way" — and the only other reader of
      // `isElectra` was the `detail` string, which nothing rendered. So
      // `res.isElectra` had NO observable effect anywhere in the UI. The upload
      // genuinely does happen either way, so `ready` is the right status for
      // both; what differs is whether the device CONFIRMED its identity, and
      // that now reaches the accessible name instead of being discarded.
      setOutcome('ready', res.isElectra ? 'Electra configured' : 'configured (device unconfirmed)');
    })
    // ⚠ A REJECTION IS AN OUTCOME, NOT A CRASH. `run()` sits on
    // `requestMIDIAccess`, which REJECTS when the user refuses the prompt or the
    // browser blocks sysex — the ordinary path, not an exceptional one. Without
    // this the refusal becomes an unhandled rejection: the plate keeps saying
    // "connecting" forever, and every e2e in the suite that watches `pageerror`
    // reddens on a user declining a permission.
    .catch((e: unknown) => {
      setOutcome('error', e instanceof Error ? e.message : String(e));
    });
  return true;
}
