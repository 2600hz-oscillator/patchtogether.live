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
// ── THE CONTROLS (the owner's map, top to bottom on the scene column) ────────
//   0  reset board      4  rotate left
//   1  (nothing)        5  rotate right
//   2  (nothing)        6  move left
//   3  drop piece       7  move right
//
// ⚠ THE SCENE COLUMN HAS TWO ROW CONVENTIONS in this codebase and they disagree
// by construction: `decodeMidiMessage` hands back `ev.row` measured from the
// BOTTOM, while `SCENE_CCS` is written TOP-first. The owner's list is top to
// bottom, so this file indexes by the TOP-origin `sceneIndexForCc`, exactly as
// launchpad-control does, and never by `ev.row`.

import {
  connect as deviceConnect,
  bindUnit,
  unbindUnit,
  isUnitBound,
  midiAvailable,
  hasAccess,
  enumerateLaunchpadPorts,
  onKey,
  setFrame,
  clearUnit,
  emptyFrame,
  type LaunchpadPort,
} from '$lib/control/launchpad/launchpad-device.svelte';
import { padNote, SCENE_CCS, LP_HEIGHT } from '$lib/control/launchpad/launchpad-sysex';
import { sceneIndexForCc } from '$lib/control/launchpad/launchpad-map';
import {
  SEQTRIS_COLS,
  SEQTRIS_ROWS,
  SEQTRIS_PIECE_RGB,
  cellIndex,
  type SeqtrisInput,
  type SeqtrisPieceId,
} from '$lib/audio/modules/seqtris-engine';

/** The unit slot SEQTRIS claims. Single-device deployment, same as `startSingle`. */
const UNIT = 'L' as const;

/**
 * The owner's control map, TOP to BOTTOM of the scene-launch column. `null` is
 * a deliberately dead button — the spec says "nothing" for rows 1 and 2, and a
 * dead button is lit differently from a live one so the player can see it.
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
const RGB_DEAD: readonly [number, number, number] = [0, 0, 0]; // the two "nothing" buttons

function sceneRgb(index: number): readonly [number, number, number] {
  const action = seqtrisActionForScene(index);
  if (action === null) return RGB_DEAD;
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
  /** The CONNECT gesture. Grants Web MIDI, then lists devices. Never throws. */
  connect(): Promise<void>;
  /** Claim a listed port. Returns false when refused (already owned / gone). */
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
  /**
   * ⚠ NOT just `midiAvailable()`. That asks whether `navigator.requestMIDIAccess`
   * EXISTS, which is the right question only before anyone has asked for access.
   * Once a sysex MIDIAccess is in hand — granted earlier in the session, or
   * injected by the simulated device the tests and the e2e drive — the module
   * plainly CAN reach a Launchpad, and reporting "this browser has no Web MIDI"
   * over a live access object is simply false.
   */
  function supported(): boolean {
    return midiAvailable() || hasAccess();
  }

  let kind: SeqtrisLaunchpadStatusKind = supported() ? 'idle' : 'unsupported';
  let ports: readonly LaunchpadPort[] = [];
  let portName: string | null = null;
  let released = false;

  const unsubscribeKey = onKey((e) => {
    if (released || owner !== nodeId) return;
    if (e.unit !== UNIT) return;
    const ev = e.ev;
    if (ev.type !== 'scene' || ev.s !== 1) return;
    const index = sceneIndexForCc(ev.cc);
    if (index === null) return;
    const action = seqtrisActionForScene(index);
    if (action !== null) onInput(action);
  });

  function status(): SeqtrisLaunchpadStatus {
    return { kind, message: seqtrisStatusMessage(kind, portName), ports, portName };
  }

  return {
    status,

    async connect(): Promise<void> {
      if (!supported()) {
        kind = 'unsupported';
        return;
      }
      kind = 'listing';
      try {
        await deviceConnect();
      } catch {
        /* deviceConnect never throws, but a seam might */
      }
      if (released) return;
      ports = enumerateLaunchpadPorts();
      if (owner === nodeId) kind = 'bound';
      else kind = ports.length > 0 ? 'idle' : 'no-device';
    },

    bind(port: LaunchpadPort): boolean {
      if (released) return false;
      if (owner !== null && owner !== nodeId) {
        kind = 'claimed';
        return false;
      }
      if (!bindUnit(UNIT, port.inputId, port.outputId)) return false;
      owner = nodeId;
      portName = port.name;
      kind = 'bound';
      return true;
    },

    unbind(): void {
      if (owner !== nodeId) return;
      clearUnit(UNIT);
      unbindUnit(UNIT);
      owner = null;
      portName = null;
      kind = supported() ? 'idle' : 'unsupported';
    },

    paint(board: readonly (SeqtrisPieceId | null)[]): void {
      if (released || owner !== nodeId || !isUnitBound(UNIT)) return;
      const frame = emptyFrame();
      for (let row = 0; row < SEQTRIS_ROWS; row++) {
        for (let col = 0; col < SEQTRIS_COLS; col++) {
          const id = board[cellIndex(row, col)] ?? null;
          if (id === null) continue;
          // Board row 0 is the TOP; `padNote`'s y is measured from the BOTTOM.
          const rgb = SEQTRIS_PIECE_RGB[id];
          frame.leds.set(padNote(col, LP_HEIGHT - 1 - row), [rgb[0], rgb[1], rgb[2]]);
        }
      }
      for (let i = 0; i < SCENE_CCS.length; i++) {
        const rgb = sceneRgb(i);
        if (rgb === RGB_DEAD) continue; // omitted indices auto-blank
        frame.leds.set(SCENE_CCS[i]!, [rgb[0], rgb[1], rgb[2]]);
      }
      setFrame(UNIT, frame);
    },

    release(): void {
      if (released) return;
      released = true;
      unsubscribeKey();
      if (owner === nodeId) {
        clearUnit(UNIT);
        unbindUnit(UNIT);
        owner = null;
      }
    },
  };
}

/** Test seam — drops the module-scope claim between cases. */
export function __test_resetSeqtrisLaunchpadOwner(): void {
  owner = null;
}
