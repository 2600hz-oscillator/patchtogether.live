// packages/web/src/lib/audio/seqtris-launchpad.ts
//
// SEQTRIS ↔ Novation Launchpad: the CONNECT gesture, the port claim, the six
// scene-button game controls and the LED picture of the board.
//
// SHAPE — this is the ptz-midi / out-to-launch binder shape, not a card: the
// game runs in the module factory whether or not a faceplate is mounted, so the
// claim, the key subscription and the LED writes all live beside the factory
// and a card is only a window onto them. A component lifecycle hook must never
// release the hardware (#1728) — `release()` is called from the factory's
// `dispose`, which is the node's death, and `unbind()` only from a user gesture.
//
// ⚠ WHY THE L/R UNIT PATH AND NOT `bindMonitor`. `bindMonitor` is OUTPUT-ONLY —
// its binding record holds no input and there is no `onKey` on it, because OUT
// TO LAUNCH only ever paints. SEQTRIS is played ON the Launchpad, so it needs
// the input half too, which is exactly what `bindUnit` + `onKey` give (the same
// path LAUNCHPAD CONTROL's `startSingle` takes).
//
// ⚠ CONSEQUENCE, AND IT IS REAL: the L slot is one slot. A SEQTRIS holding it
// and a LAUNCHPAD CONTROL bound to the same device would both receive every
// press, because `onKey` listeners are a shared Set. This module refuses a
// SECOND SeqTris (the `owner` token below) but it cannot refuse LAUNCHPAD
// CONTROL, so the docs say plainly: unbind the clip launcher before you play.
//
// ── ⚠ THE DEVICE MODULE IS LOADED LAZILY, AND THAT IS A HARD CONSTRAINT ──────
// `launchpad-device.svelte.ts` declares `let statusVersion = $state(0)` at
// module scope. A rune only exists once the Svelte compiler has been through
// the file — and the ART harness runs the AUDIO REGISTRY under plain vitest
// with no Svelte plugin. A static import here therefore reaches SEQTRIS's def,
// reaches the registry, and throws `ReferenceError: $state is not defined`
// while loading three unrelated CV scenarios. (Measured on this PR. The other
// Launchpad-facing modules dodge it by accident: LAUNCHPAD CONTROL is a META
// def and OUT TO LAUNCH is a VIDEO def, and the ART harness loads neither.)
//
// So: `import type` only at the top — type imports are erased — and the real
// module arrives through `import()` inside `connect()`, which is a user gesture
// and already async. Everything device-touching no-ops until it lands, which is
// exactly the behaviour an unbound module should have anyway.
//
// The same constraint rules out `launchpad-map`, which imports the rune file
// for `emptyFrame`. Its `sceneIndexForCc` is a two-line `indexOf` over
// `SCENE_CCS`, so it is re-derived below against the CC roster in
// `launchpad-sysex` — a file with ZERO imports of its own.
//
// ── THE CONTROLS (the owner's map, top to bottom on the scene column) ────────
//   0  reset board      4  rotate left
//   1  (nothing)        5  rotate right
//   2  (nothing)        6  move left
//   3  drop piece       7  move right

import { padNote, SCENE_CCS, LP_HEIGHT } from '$lib/control/launchpad/launchpad-sysex';
import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  SEQTRIS_COLS,
  SEQTRIS_ROWS,
  SEQTRIS_PIECE_RGB,
  cellIndex,
  type SeqtrisInput,
  type SeqtrisPieceId,
} from '$lib/audio/modules/seqtris-engine';

export type { LaunchpadPort };

/** The unit slot SEQTRIS claims. Single-device deployment, same as `startSingle`. */
const UNIT = 'L' as const;

type DeviceModule = typeof import('$lib/control/launchpad/launchpad-device.svelte');

/** Module-scope so the dynamic import is paid once per page, not per node. */
let devicePromise: Promise<DeviceModule> | null = null;
function loadDevice(): Promise<DeviceModule> {
  devicePromise ??= import('$lib/control/launchpad/launchpad-device.svelte');
  return devicePromise;
}

/**
 * Web MIDI capability WITHOUT importing the device module — the same predicate
 * `webMidiAvailable` uses, re-derived here because asking the question must not
 * drag a rune-bearing module into a non-Svelte runtime (see the header).
 */
function webMidiPresent(): boolean {
  return (
    typeof navigator !== 'undefined'
    && typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}

/**
 * The scene-launch button index for a CC, TOP-ORIGIN (0 = top).
 *
 * ⚠ THE SCENE COLUMN HAS TWO ROW CONVENTIONS in this codebase and they disagree
 * by construction: `decodeMidiMessage` hands back `ev.row` measured from the
 * BOTTOM, while `SCENE_CCS` is written TOP-first. The owner's control list is
 * top to bottom, so this is the index that must be used — reading `ev.row`
 * instead would invert the whole controller and every button would still
 * "work".
 */
export function seqtrisSceneIndexForCc(cc: number): number | null {
  const i = SCENE_CCS.indexOf(cc as (typeof SCENE_CCS)[number]);
  return i >= 0 ? i : null;
}

/**
 * The owner's control map, TOP to BOTTOM of the scene-launch column. `null` is
 * a deliberately dead button — the spec says "nothing" for rows 1 and 2, and a
 * dead button is left DARK on the hardware so the player can see it is dead.
 */
export const SEQTRIS_SCENE_ACTIONS: readonly (SeqtrisInput | null)[] = [
  'reset',
  null,
  null,
  'drop',
  'rotateLeft',
  'rotateRight',
  'moveLeft',
  'moveRight',
];

/** The game action a scene button (0 = top … 7 = bottom) performs, or null. */
export function seqtrisActionForScene(index: number): SeqtrisInput | null {
  if (!Number.isInteger(index) || index < 0 || index >= SEQTRIS_SCENE_ACTIONS.length) return null;
  return SEQTRIS_SCENE_ACTIONS[index] ?? null;
}

/** Colours for the scene column, so the six live controls read as controls. */
const RGB_CONTROL: readonly [number, number, number] = [0, 60, 90]; // dim blue
const RGB_RESET: readonly [number, number, number] = [90, 20, 0]; // amber-red
const RGB_DROP: readonly [number, number, number] = [100, 100, 100]; // white

/** `null` = leave the pad dark (an omitted index auto-blanks on the device). */
function sceneRgb(index: number): readonly [number, number, number] | null {
  const action = seqtrisActionForScene(index);
  if (action === null) return null;
  if (action === 'reset') return RGB_RESET;
  if (action === 'drop') return RGB_DROP;
  return RGB_CONTROL;
}

export type SeqtrisLaunchpadStatusKind =
  | 'unsupported'
  | 'idle'
  | 'listing'
  | 'no-device'
  | 'claimed'
  | 'bound';

export interface SeqtrisLaunchpadStatus {
  readonly kind: SeqtrisLaunchpadStatusKind;
  readonly message: string;
  readonly ports: readonly LaunchpadPort[];
  readonly portName: string | null;
}

/**
 * PURE status prose — separated from the binder so the message a player reads
 * can be unit-tested without a MIDI stack.
 */
export function seqtrisStatusMessage(
  kind: SeqtrisLaunchpadStatusKind,
  portName: string | null,
): string {
  switch (kind) {
    case 'unsupported':
      return 'This browser has no Web MIDI, so a Launchpad cannot be reached. Play with the on-screen buttons.';
    case 'listing':
      return 'Asking the browser for MIDI access…';
    case 'no-device':
      return 'No Launchpad found. Plug one in and press CONNECT again.';
    case 'claimed':
      return 'Another SEQTRIS is holding the Launchpad. Unbind that one first.';
    case 'bound':
      return `Playing on ${portName ?? 'the Launchpad'}. The right-hand scene buttons are the game controls.`;
    case 'idle':
    default:
      return 'Not connected. CONNECT grants Web MIDI and lists the Launchpads on this machine.';
  }
}

/**
 * Module-scope claim token. The device layer arbitrates OUTPUTS across units and
 * monitors, but two SeqTris nodes would both bind unit L and both receive every
 * press through the shared `onKey` set — so the second one is refused here, by
 * name, where the reason is legible.
 */
let owner: string | null = null;

export interface SeqtrisLaunchpadBinding {
  status(): SeqtrisLaunchpadStatus;
  /** The CONNECT gesture. Loads the device layer, grants Web MIDI, then lists
   *  devices. Never throws. */
  connect(): Promise<void>;
  /** Claim a listed port. Returns false when refused (already owned / gone /
   *  CONNECT has not run). */
  bind(port: LaunchpadPort): boolean;
  /** USER gesture only — never a component lifecycle hook. */
  unbind(): void;
  /** Push the board (plus the control column) onto the pads. No-op when unbound. */
  paint(board: readonly (SeqtrisPieceId | null)[]): void;
  /** The node is gone. Releases the claim if this node held it. */
  release(): void;
}

/**
 * Build the per-node binding. `onInput` is called with the game action for every
 * scene-button PRESS (rising edge only — a held scene button must not repeat,
 * which is the same edge discipline the CV `clock` port declares).
 */
export function acquireSeqtrisLaunchpad(
  nodeId: string,
  onInput: (input: SeqtrisInput) => void,
): SeqtrisLaunchpadBinding {
  let dev: DeviceModule | null = null;
  let unsubscribeKey: (() => void) | null = null;
  let kind: SeqtrisLaunchpadStatusKind = webMidiPresent() ? 'idle' : 'unsupported';
  let ports: readonly LaunchpadPort[] = [];
  let portName: string | null = null;
  let released = false;

  /**
   * ⚠ NOT just "does `requestMIDIAccess` exist". That is the right question only
   * before anyone has asked for access. Once a sysex MIDIAccess is in hand —
   * granted earlier in the session, or injected by the simulated device the
   * tests and the e2e drive — the module plainly CAN reach a Launchpad, and
   * reporting "this browser has no Web MIDI" over a live access object is false.
   */
  function supported(): boolean {
    if (dev) return dev.midiAvailable() || dev.hasAccess();
    return webMidiPresent();
  }

  function attach(mod: DeviceModule): void {
    dev = mod;
    unsubscribeKey ??= mod.onKey((e) => {
      if (released || owner !== nodeId) return;
      if (e.unit !== UNIT) return;
      const ev = e.ev;
      if (ev.type !== 'scene' || ev.s !== 1) return;
      const index = seqtrisSceneIndexForCc(ev.cc);
      if (index === null) return;
      const action = seqtrisActionForScene(index);
      if (action !== null) onInput(action);
    });
  }

  function status(): SeqtrisLaunchpadStatus {
    return { kind, message: seqtrisStatusMessage(kind, portName), ports, portName };
  }

  return {
    status,

    async connect(): Promise<void> {
      kind = 'listing';
      let mod: DeviceModule;
      try {
        mod = await loadDevice();
      } catch {
        // No Svelte runtime / chunk unavailable: the hardware is simply out of
        // reach here. The on-screen controls still play the game.
        kind = 'unsupported';
        return;
      }
      if (released) return;
      attach(mod);
      if (!supported()) {
        kind = 'unsupported';
        return;
      }
      try {
        await mod.connect();
      } catch {
        /* mod.connect never throws, but a seam might */
      }
      if (released) return;
      ports = mod.enumerateLaunchpadPorts();
      if (owner === nodeId) kind = 'bound';
      else kind = ports.length > 0 ? 'idle' : 'no-device';
    },

    bind(port: LaunchpadPort): boolean {
      if (released || !dev) return false;
      if (owner !== null && owner !== nodeId) {
        kind = 'claimed';
        return false;
      }
      if (!dev.bindUnit(UNIT, port.inputId, port.outputId)) return false;
      owner = nodeId;
      portName = port.name;
      kind = 'bound';
      return true;
    },

    unbind(): void {
      if (!dev || owner !== nodeId) return;
      dev.clearUnit(UNIT);
      dev.unbindUnit(UNIT);
      owner = null;
      portName = null;
      kind = supported() ? 'idle' : 'unsupported';
    },

    paint(board: readonly (SeqtrisPieceId | null)[]): void {
      if (released || !dev || owner !== nodeId || !dev.isUnitBound(UNIT)) return;
      const frame = dev.emptyFrame();
      for (let row = 0; row < SEQTRIS_ROWS; row++) {
        for (let col = 0; col < SEQTRIS_COLS; col++) {
          const id = board[cellIndex(row, col)] ?? null;
          if (id === null) continue;
          // Board row 0 is the TOP; `padNote`'s y is measured from the BOTTOM.
          // Getting this backwards renders the game upside down on the hardware
          // while the card looks perfect.
          const rgb = SEQTRIS_PIECE_RGB[id];
          frame.leds.set(padNote(col, LP_HEIGHT - 1 - row), [rgb[0], rgb[1], rgb[2]]);
        }
      }
      for (let i = 0; i < SCENE_CCS.length; i++) {
        const rgb = sceneRgb(i);
        if (rgb === null) continue; // omitted indices auto-blank
        frame.leds.set(SCENE_CCS[i]!, [rgb[0], rgb[1], rgb[2]]);
      }
      dev.setFrame(UNIT, frame);
    },

    release(): void {
      if (released) return;
      released = true;
      unsubscribeKey?.();
      unsubscribeKey = null;
      if (dev && owner === nodeId) {
        dev.clearUnit(UNIT);
        dev.unbindUnit(UNIT);
        owner = null;
      }
    },
  };
}

/** Test seam — drops the module-scope claim between cases. */
export function __test_resetSeqtrisLaunchpadOwner(): void {
  owner = null;
}
