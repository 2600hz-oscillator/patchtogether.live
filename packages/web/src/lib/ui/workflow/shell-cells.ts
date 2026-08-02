// packages/web/src/lib/ui/workflow/shell-cells.ts
//
// The FAMILY / STATIC cell registry for the RACKLINE <ModuleShell>.
//
// A curated face ranks three kinds of control (curated-face.ts): a `param`
// (backed by a ParamDef — the shell paints a KnobConic or, for a declared
// press-pad, a momentary Button), a `family` (a declared ControlFamily) and a
// `static` (a card-only button/select keyed by the numbered legend). The first
// kind is generic; the other two are NOT — a preset roster, a file loader or a
// step grid each need their own live state + action, which no amount of def
// introspection can synthesize.
//
// Before this registry the shell rendered every family/static key as a DASHED
// LABEL ("the rich render is a P1 per-module concern"), which meant dx7's
// PRESET selector — its hero, `face.order[0]` — and its .syx import were
// UNREACHABLE under `?shell=1`: the DX7's voice could not be changed at all.
// So each such key now declares a small CELL SPEC here and the shell paints it
// with the SHARED primitive library (Selector / Button / Toggle), wired through
// the same card-kit contract the param cells use.
//
// THE BAR (module-face-lint + the faces-parity e2e both enforce it): every
// family/static key ranked by a STRICT_FACES module MUST resolve to a spec
// here. There is no dead-label fallback to fall back TO — an unregistered key
// renders as an explicitly INERT cell that fails both gates, so the inert-cell
// class cannot silently return.
//
// Reads are PURE projections off the live node (the shell owns reactivity via
// `nodeVersion(id)`); writes take the nodeId and mutate the graph store, so the
// specs stay declarative and the shell stays generic.

import type { Component } from 'svelte';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { testHooksEnabled } from '$lib/dev/test-hooks';
import Dx7OperatorMap from '$lib/ui/modules/dx7/Dx7OperatorMap.svelte';
import Dx7OpDetail from '$lib/ui/modules/dx7/Dx7OpDetail.svelte';
import type { FaceControl } from './curated-face';
import {
  DX7_SYX_ACCEPT,
  dx7PresetName,
  dx7SelectorOptions,
  loadDx7SyxFile,
  selectDx7Preset,
} from '$lib/ui/modules/dx7-patch-actions';
import {
  selectSixstrumPreset,
  sixstrumPresetName,
  sixstrumSelectorOptions,
} from '$lib/ui/modules/sixstrum-preset-actions';
import { clearCloudseedTail } from '$lib/ui/modules/cloudseed-preset-actions';
// ⚠ WAS `kickdrum-strike-actions`. The file was already generic — same key,
// same resolver, same wiring — so karplus's face renamed it rather than
// copying it. One implementation of "audition this struck voice".
// (This branch's `fireKickdrumStrike` import followed the rename; the old
// module no longer exists on main, so keeping it would not have compiled.)
import { fireManualStrike } from '$lib/ui/modules/manual-strike-actions';
// Snaredrum keeps its OWN module: it needs a held `setSnaredrumRoll` GATE
// alongside the one-shot, which the generic strike seam does not model.
import { fireSnaredrumHit, setSnaredrumRoll } from '$lib/ui/modules/snaredrum-strike-actions';

/** A dropdown over a NAMED roster that lives in node.data (not a param). */
export interface ShellSelectorCell {
  kind: 'selector';
  /** Small uppercase tag left of the value (the primitive's `label`). */
  tag: string;
  options: (node: ModuleNode | undefined) => SelectorOption<string>[];
  value: (node: ModuleNode | undefined) => string;
  onchange: (nodeId: string, value: string) => void;
}

/**
 * What a cell's action can reach BESIDES the graph. The graph is always
 * reachable from a nodeId alone; the live PatchEngine is not, because it rides
 * a Svelte context the shell owns and this registry is plain TypeScript.
 *
 * `engine` is typed STRUCTURALLY (just the `write` seam) so shell-cells never
 * pulls the whole PatchEngine import chain — the same discipline the file
 * header's circular-import note is about.
 */
export interface ShellCellEnv {
  engine: { write(node: ModuleNode, key: string, value: unknown): void } | null;
  /** The LIVE node (Y.Doc entry), or undefined before it resolves. */
  node: ModuleNode | undefined;
}

/**
 * An ACTION button, in one of the TWO shapes the repo's own port vocabulary
 * already distinguishes ($lib/audio/gate-trigger `EdgeSemantic`):
 *
 *   mode 'trigger' (the default) — a one-shot. Fires `onFire` ONCE on the press
 *     edge and ignores the release. dx7's loader, kickdrum's STRIKE,
 *     cloudseed's engine gestures.
 *   mode 'gate' — a MOMENTARY pad. Fires `onGate(nodeId, true, env)` on press
 *     and `onGate(nodeId, false, env)` on release, so a HELD action
 *     (snaredrum's ROLL audition, which runs the two-hand engine only while the
 *     level is high) has a representation at all.
 *
 * The two shapes are NOT interchangeable and the module must pick the one its
 * seam actually is: a gate consumer driven by a click would open and never
 * close. `shell-cells.test.ts` asserts each cell declares exactly the handler
 * its mode needs, so a `mode:'gate'` cell carrying only `onFire` cannot ship.
 *
 * The primitive underneath is the SAME `<Button>` in both cases — it already
 * carries `momentary` + `onGate` + `aria-pressed` (the `face.momentary`
 * press-pad path uses them) — so this is a new DECLARATION, not a new control,
 * and faces-parity's closed `data-cell-control` union is untouched.
 *
 * BOTH handlers take the same `env` as the one-shot: an action's press
 * semantics and what it can REACH are orthogonal, and a held gesture that
 * needed the engine handle would otherwise be the one shape that could not
 * have it.
 */
export interface ShellActionCell {
  kind: 'action';
  label: string;
  title?: string;
  /** Press semantics. Omitted = 'trigger' (the one-shot shape). */
  mode?: 'trigger' | 'gate';
  /** Required for mode 'trigger'. Fired once on the press edge. `env` carries
   *  the engine handle for actions that are ENGINE gestures rather than graph
   *  edits (a buffer flush, a re-seed) — a nodeId alone can only reach the
   *  store. */
  onFire?: (nodeId: string, env: ShellCellEnv) => void;
  /** Required for mode 'gate'. Fired true on press, false on release. */
  onGate?: (nodeId: string, high: boolean, env: ShellCellEnv) => void;
}

/** A FILE-import button: opens a picker, hands the chosen file to `onFile`,
 *  and shows the returned status/error line under the button. */
export interface ShellFileCell {
  kind: 'file';
  label: string;
  title?: string;
  accept: string;
  onFile: (nodeId: string, file: File) => Promise<{ status: string | null; error: string | null }>;
}

/** A 0/1 LATCHING switch backed by node.data (a param-backed toggle is a
 *  `param` cell, not this). */
export interface ShellToggleCell {
  kind: 'toggle';
  label: string;
  value: (node: ModuleNode | undefined) => boolean;
  onchange: (nodeId: string, on: boolean) => void;
}

// ── PANEL cells (PF-14) ─────────────────────────────────────────────────────
//
// The escape hatch for a control that IS NOT one of the shared primitives: a
// live SVG operator map, a draggable envelope editor — a bespoke component
// with its own internal affordances. The generic kinds above cover "a roster",
// "a button", "a file", "a switch"; a panel covers "a picture you edit".
//
// TWO HARD RULES, both learned from what the faces gates actually assert:
//
//  1. **A panel must NEVER emit `data-testid="control-<paramId>"`.**
//     faces-parity asserts EXACT MULTISET EQUALITY between the dock's
//     `control-*` testids and the def's param ids. A panel edits `node.data`,
//     not params, so any `control-` testid inside it reads as an EXTRA control
//     with no def backing and fails the whole face. Panel internals use their
//     own testid namespace.
//
//  2. **A panel declares an OPERABILITY PROBE.** Every other cell kind has a
//     natural interaction the parity sweep already knows how to drive (drag
//     the knob, click the switch, pick from the roster). A bespoke panel does
//     not, and the alternative to declaring one is special-casing the module
//     inside the e2e — which is exactly the registry-driven property
//     (STRICT_FACES enumerates itself) that makes every future face auto-enrol
//     with zero test edits. So the module DECLARES how to poke it and what
//     must change, and the sweep stays generic.

/** How faces-parity DRIVES a panel, and what it asserts actually moved. */
export interface ShellPanelProbe {
  /** A testid INSIDE the panel (never a `control-<paramId>` — see rule 1). */
  testid: string;
  /** The natural interaction for that element. */
  action: 'click' | 'drag';
  /**
   * The observable effect. `data` names a path into `node.data` that must
   * CHANGE (`opOn[1]`); `data-rev` names a monotonic revision counter that must
   * ADVANCE.
   *
   * ⚠ Prefer `data` where you can. A revision-only probe passes on a DEAD
   * button that bumps the counter without editing anything — the exact
   * green-but-broken class the whole gate exists to catch.
   */
  effect:
    | { kind: 'data'; key: string; expect: 'changed' }
    | { kind: 'data-rev'; key: string };
}

/** A BESPOKE panel: the module's own component, rendered inside a shell cell. */
export interface ShellPanelCell {
  kind: 'panel';
  /** Caption under the panel in the dock faceplate. */
  label: string;
  /** The component. Receives the nodeId and owns its own state + writes. */
  component: Component<{ nodeId: string }>;
  /** Minimum painted width in px — the panel's own design floor (a 280 px
   *  operator map cannot usefully shrink). Emitted as `--panel-min-w`. */
  minWidth: number;
  /** How the parity sweep proves the panel is alive (see rule 2). */
  probe: ShellPanelProbe;
}

export type ShellCell =
  | ShellSelectorCell
  | ShellActionCell
  | ShellFileCell
  | ShellToggleCell
  | ShellPanelCell;

/**
 * Per-module cell specs, keyed by module type then by the EXACT `face.order`
 * key (a family template `<familyId>-{n}`, or a legend static key). Keeping the
 * face key as the index means the face, the docs (`docs.controls`) and the
 * shell all address the control by the SAME string — a rename breaks all three
 * gates at once instead of silently un-rendering one of them.
 */
const SHELL_CELLS: Record<string, Record<string, ShellCell>> = {
  dx7: {
    // The voice selector — the single control that defines the sound. Drives
    // the SAME `node.data.preset` write the legacy Dx7Card's <select> does
    // (dx7-patch-actions), which the factory polls and re-sends as a patch.
    'dx7-preset-select-{n}': {
      kind: 'selector',
      tag: 'preset',
      options: (node) => dx7SelectorOptions(node),
      value: (node) => dx7PresetName(node),
      onchange: (nodeId, value) => selectDx7Preset(nodeId, value),
    },
    // The cartridge loader — same parse/append/auto-select action as the card's
    // hidden file input, status line included.
    'dx7-syx-input-{n}': {
      kind: 'file',
      label: 'Load .syx bank',
      title: 'Import a Yamaha DX7 cartridge dump (voices are APPENDED to the roster)',
      accept: DX7_SYX_ACCEPT,
      onFile: (nodeId, file) => loadDx7SyxFile(nodeId, file),
    },
    // THE OPERATOR VIEW (dx7 PR 6). The algorithm diagram IS the operator
    // view — one live map plus one detail panel, rather than six Dexed strips
    // or six `OP n` pages (which would re-create the hardware's OPERATOR
    // SELECT, the affordance this design exists to kill).
    'dx7-operator-map-{n}': {
      kind: 'panel',
      label: 'operators',
      component: Dx7OperatorMap,
      minWidth: 280,
      // ⚠ Asserts `opOn[1]` CHANGED, not merely that `voiceRev` advanced. A
      // revision-only probe passes on a DEAD mute button that bumps the
      // counter without muting anything — exactly the green-but-broken class
      // the parity gate exists to catch.
      probe: {
        testid: 'dx7-op-onoff-2',
        action: 'click',
        effect: { kind: 'data', key: 'opOn[1]', expect: 'changed' },
      },
    },
    'dx7-op-detail-{n}': {
      kind: 'panel',
      label: 'operator detail',
      component: Dx7OpDetail,
      minWidth: 560,
      // Dragging an envelope handle has no single `node.data` key to name —
      // it rewrites a rate AND a level inside `data.voice` — so this one is
      // legitimately a `data-rev` probe.
      probe: {
        testid: 'dx7-eg-point-2',
        action: 'drag',
        effect: { kind: 'data-rev', key: 'voiceRev' },
      },
    },
  },
  cloudseed: {
    // CLEAR TAIL — the one gesture this reverb has that is not a value. It
    // flushes every delay line, diffuser, shelf and lowpass in the tank
    // (`clearBuffers`, which the worklet has always handled and the host had
    // never sent), so a ~60 s tail stops on the spot without touching a single
    // setting. Nothing is stored and nothing is undoable: it is the engine's
    // state that moves, not the patch's — which is exactly why it is a control
    // FAMILY rather than a 47th ParamDef.
    'cloudseed-clear-{n}': {
      kind: 'action',
      label: 'Clear tail',
      title: 'Flush the reverb tank — stops the tail instantly (changes no setting; not undoable)',
      onFire: (_nodeId, env) => clearCloudseedTail(env),
    },
  },
  karplus: {
    // THE PLUCK. karplus has NO exciter and NO envelope generator — a noise
    // burst is fired into a recirculating delay-line string and everything you
    // hear is that burst dying — so with nothing patched into trigger_in the
    // module is not quiet, it is MUTE, and the dock full-view offered nine
    // controls over a voice that could not be heard at all.
    //
    // Fires the SAME host-side trigger source the legacy card's PLUCK button
    // fires (manual-strike-actions → the factory's `manualTrigger` read key),
    // so there is one implementation, not two. Not a param: it writes nothing
    // to the graph (see that module's header), which is also why `strike` is
    // not a ParamDef here — a persisted 0/1 for a one-shot, plus a ninth
    // parameterDescriptor the worklet does not have.
    //
    // It takes the nodeId and NOT the `env` handle cloudseed's clear uses:
    // `fireManualStrike` resolves the live engine itself through
    // `getActiveEngine()`, which is what lets the card and the shell share one
    // implementation (a Svelte component has no ShellCellEnv to pass).
    'karplus-strike-{n}': {
      kind: 'action',
      label: 'pluck',
      title: 'Audition: pluck the string once (identical to a trigger_in rising edge)',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
    },
  },
  kickdrum: {
    // THE AUDITION. A kick with nothing patched into trigger_in is SILENT, so
    // without this the dock full-view offers 25 controls over a voice you
    // cannot hear — while tomtom, karplus and sixstrum can all be auditioned.
    // Fires the SAME host-side trigger source the legacy card's STRIKE button
    // fires (manual-strike-actions), so there is one implementation, not two.
    // Not a param: it writes nothing to the graph (see that module's header).
    'kickdrum-strike-{n}': {
      kind: 'action',
      label: 'strike',
      title: 'Audition: hit the drum once (identical to a trigger_in rising edge)',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
    },
  },
  snaredrum: {
    // THE AUDITION, in TWO pads — because this voice has TWO strike inputs with
    // DIFFERENT declared edge semantics, and one button for both would be the
    // face contradicting the def about the thing the module exists for.
    // Both drive host-side ConstantSources on the module's own worklet inputs
    // (snaredrum-strike-actions → the engine handle's read keys), so they write
    // NOTHING to the graph and a patched cable keeps working alongside them.
    'snaredrum-hit-{n}': {
      kind: 'action',
      label: 'hit',
      title: 'Audition: one snare hit (identical to a trigger_in rising edge)',
      onFire: (nodeId) => { fireSnaredrumHit(nodeId); },
    },
    // ⚠ MOMENTARY, not a click. `gate_in` is declared edge:'gate' — the
    // two-hand roll engine runs only WHILE the level is high — so a one-shot
    // button would open a roll that never stops. The held-gate leak paths (the
    // pane closing mid-hold, a hidden tab) are handled in the actions module.
    'snaredrum-roll-{n}': {
      kind: 'action',
      mode: 'gate',
      label: 'roll',
      title: 'Audition: HOLD to run the two-hand roll (identical to holding gate_in high)',
      onGate: (nodeId, high) => { setSnaredrumRoll(nodeId, high); },
    },
  },
  sixstrum: {
    // The guitar / bass / harp PRESET RECALL. Unlike dx7's, its state is not a
    // `node.data` slot — the three modes ARE knob states, so a pick stamps all
    // fourteen calibrated params through the normal commit path and the chip
    // reads back off the `tuning` the instrument ended up in
    // (sixstrum-preset-actions, the SAME stamp the classic card's MODE knob
    // fires). The raw `tuning` param keeps its own cell right below: the
    // recall moves the whole panel, the param only swaps the string set.
    'sixstrum-preset-{n}': {
      kind: 'selector',
      tag: 'preset',
      options: () => sixstrumSelectorOptions(),
      value: (node) => sixstrumPresetName(node),
      onchange: (nodeId, value) => selectSixstrumPreset(nodeId, value),
    },
  },
};

/**
 * The cell spec for a curated FAMILY / STATIC control, or `null` when the
 * module declares none for that key (→ the shell renders an explicitly INERT
 * cell, which both the unit lint and the faces-parity e2e fail on). A `param`
 * control never routes here — the shell handles those generically. Pure.
 */
export function shellCellFor(moduleType: string, ctl: FaceControl): ShellCell | null {
  if (ctl.kind === 'param') return null;
  return SHELL_CELLS[moduleType]?.[ctl.key] ?? null;
}

/** Every module type that registers at least one cell spec (gate helper). */
export function typesWithShellCells(): string[] {
  return Object.keys(SHELL_CELLS).sort();
}

/** The registered face keys for one module type (gate helper). */
export function shellCellKeys(moduleType: string): string[] {
  return Object.keys(SHELL_CELLS[moduleType] ?? {}).sort();
}

/**
 * The face keys one module registers as PANEL cells. Used by the face-lint
 * rule that keeps a panel DOCK-ONLY: a 280 px SVG has no business being
 * SELECTED into a 46 px lane knob column, and relying on
 * `PLATE_COLS * PLATE_MAX_ROWS` to truncate it is not a guard — it is a
 * coincidence that a future cap bump silently removes. Pure.
 */
export function panelCellKeys(moduleType: string): string[] {
  const specs = SHELL_CELLS[moduleType] ?? {};
  return Object.keys(specs)
    .filter((k) => specs[k]?.kind === 'panel')
    .sort();
}

/**
 * Every declared panel PROBE, `moduleType → faceKey → probe`. Pure projection.
 *
 * ⚠ PUBLISHED FROM THE SHELL LAYER, NOT FROM `__moduleSpecs`.
 * `$lib/dev/module-specs` projects the MODULE REGISTRY and is imported by the
 * registration barrels (`audio/modules/index.ts`), so teaching it about
 * shell-cells would create a live import cycle:
 *   audio/modules/index → dev/module-specs → workflow/shell-cells
 *     → ui/modules/dx7-patch-actions → audio/modules/dx7 → …
 * The probes are shell metadata anyway — they describe how the SHELL renders a
 * control, not what the module IS — so they ride their own window global,
 * exposed when ModuleShell (the only consumer of this registry) is imported.
 */
export function shellPanelProbes(): Record<string, Record<string, ShellPanelProbe>> {
  const out: Record<string, Record<string, ShellPanelProbe>> = {};
  for (const [type, specs] of Object.entries(SHELL_CELLS)) {
    for (const [key, spec] of Object.entries(specs)) {
      if (spec.kind !== 'panel') continue;
      (out[type] ??= {})[key] = spec.probe;
    }
  }
  return out;
}

/**
 * Every declared ACTION cell's press MODE, `moduleType → faceKey → mode`.
 *
 * ⚠ PUBLISHED BECAUSE A DOM-DERIVED ANSWER IS SELF-BLINDING, and that was
 * measured, not theorised. faces-parity used to decide "is this a held pad?"
 * by asking the button whether it had `aria-pressed` — which `Button.svelte`
 * emits only when it is `momentary`. So DELETING `momentary` from the shell's
 * action branch made the gate pad a one-shot AND made the check that would have
 * caught it evaporate: the sweep silently fell back to `click()` and reported
 * 21 passed. The instrument was invariant to the exact dimension under test.
 *
 * Reading the DECLARATION instead makes the two sides independent: the def says
 * `mode:'gate'`, the DOM must therefore show a momentary pad, and a shell that
 * stops rendering one is a MISMATCH rather than a different code path. Same
 * shape (and the same reason) as `shellPanelProbes` above.
 */
export function shellActionModes(): Record<string, Record<string, 'trigger' | 'gate'>> {
  const out: Record<string, Record<string, 'trigger' | 'gate'>> = {};
  for (const [type, specs] of Object.entries(SHELL_CELLS)) {
    for (const [key, spec] of Object.entries(specs)) {
      if (spec.kind !== 'action') continue;
      (out[type] ??= {})[key] = spec.mode ?? 'trigger';
    }
  }
  return out;
}

/** Expose the shell-layer metadata the faces-parity e2e reads (dev/autotest
 *  builds only — the same `testHooksEnabled()` gate `__moduleSpecs` uses). */
export function exposeShellPanelProbesForTests(): void {
  if (!testHooksEnabled()) return;
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellPanelProbes = shellPanelProbes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellActionModes = shellActionModes();
}
