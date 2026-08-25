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
import type { ModuleNode, ParamLandmark } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { entryAccept, entryReject, type EntryParse } from '$lib/ui/controls/text-entry-model';
import CartesianPadGrid from '$lib/ui/modules/cartesian/CartesianPadGrid.svelte';
import { testHooksEnabled } from '$lib/dev/test-hooks';
import WavecelWavetablePanel from '$lib/ui/modules/wavecel/WavecelWavetablePanel.svelte';
import {
  WAVECEL_WAV_ACCEPT,
  loadWavecelPreset,
  loadWavecelWavFile,
  selectWavecelSource,
  wavecelPresetOptions,
  wavecelPresetValue,
  wavecelSourceOptions,
  wavecelSourceValue,
} from '$lib/ui/modules/wavecel-table-actions';
import {
  MILK_ACCEPT,
  loadMilkFile,
  milkdropPresetOptions,
  milkdropPresetValue,
  selectMilkdropPreset,
} from '$lib/ui/modules/milkdrop-preset-actions';
import {
  FRAMETABLE_FILE_ACCEPT,
  loadFrametableFile,
  saveFrametableFile,
} from '$lib/ui/modules/frametable-file-actions';
import {
  loadVideocubeSlotFile,
  setVideocubeSlotLive,
} from '$lib/ui/modules/videocube-slot-actions';
import {
  selectVfpgaPreset,
  vfpgaPresetOptions,
  vfpgaPresetValue,
} from '$lib/ui/modules/vfpga-runner-face-actions';
import VfpgaModulationPanel from '$lib/ui/modules/VfpgaModulationPanel.svelte';
import Dx7OperatorMap from '$lib/ui/modules/dx7/Dx7OperatorMap.svelte';
import Dx7OpDetail from '$lib/ui/modules/dx7/Dx7OpDetail.svelte';
import AnalogVcoHeroPanel from '$lib/ui/modules/AnalogVcoHeroPanel.svelte';
import BlueboxToneBankPanel from '$lib/ui/modules/BlueboxToneBankPanel.svelte';
import ClapHeroPanel from '$lib/ui/modules/ClapHeroPanel.svelte';
import CubeHeroPanel from '$lib/ui/modules/cube/CubeHeroPanel.svelte';
import CubeTableStackPanel from '$lib/ui/modules/cube/CubeTableStackPanel.svelte';
import KriaGridPanel from '$lib/ui/modules/kria/KriaGridPanel.svelte';
import CloudsRingPanel from '$lib/ui/modules/CloudsRingPanel.svelte';
import CofefveEchoTrainPanel from '$lib/ui/modules/CofefveEchoTrainPanel.svelte';
import KickdrumHeroPanel from '$lib/ui/modules/KickdrumHeroPanel.svelte';
import MacrooscillatorHeroPanel from '$lib/ui/modules/MacrooscillatorHeroPanel.svelte';
import MarblesLoopPanel from '$lib/ui/modules/MarblesLoopPanel.svelte';
import PentemelodicaVoicesPanel from '$lib/ui/modules/PentemelodicaVoicesPanel.svelte';
import RingsCombPanel from '$lib/ui/modules/RingsCombPanel.svelte';
import SidecarTransferPanel from '$lib/ui/modules/SidecarTransferPanel.svelte';
import WarrensspectrumBankPanel from '$lib/ui/modules/WarrensspectrumBankPanel.svelte';
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
import {
  knobToRate,
  rateToKnob,
  formatRatePercent,
} from '$lib/audio/modules/samsloop-rate';
import { SAMSLOOP_RATE_LANDMARKS } from '$lib/audio/modules/samsloop';
import {
  downloadSamsloopSample,
  loadSamsloopAudioFile,
  samsloopBitsOptions,
  samsloopBitsValue,
  samsloopChannelsOptions,
  samsloopChannelsValue,
  samsloopRateOptions,
  samsloopRateValue,
  selectSamsloopBits,
  selectSamsloopChannels,
  selectSamsloopRate,
  toggleSamsloopRecord,
} from '$lib/ui/modules/samsloop-face-actions';
import {
  twotracksTransport,
  twotracksSaveTape,
} from '$lib/ui/modules/twotracks-face-actions';
import {
  exposeAuditionLedgerForTests,
  type AuditionSeam,
} from '$lib/ui/modules/audition-ledger';
// THE ONE audition seam, in both edge shapes: `fireManualStrike` for a
// `mode:'trigger'` cell, `setManualGate` for a `mode:'gate'` one. It briefly
// was two modules — kickdrum/karplus's generic one-shot file and a parallel
// `snaredrum-strike-actions` whose one-shot half was a copy down to the read-key
// string — and they are merged: a HELD audition is not a snaredrum concept, it
// is this file's own `mode:'gate'` on the other side of the same seam.
// ⚠ A cell's `mode` and the function it calls must AGREE. `manual-strike-wiring
// .test.ts` drives this registry and fails if they don't; nothing else can see
// it, because shell-cells.test.ts checks which HANDLER FIELD is present, not
// what the handler does.
import { fireManualStrike, setManualGate } from '$lib/ui/modules/manual-strike-actions';
import {
  kriaDirectionOptions,
  kriaDirectionValue,
  kriaLoopLengthOptions,
  kriaLoopLengthValue,
  kriaLoopStartOptions,
  kriaLoopStartValue,
  kriaMuteValue,
  kriaRootOptions,
  kriaRootValue,
  kriaScaleOptions,
  kriaScaleValue,
  kriaSetDirection,
  kriaSetLoopLength,
  kriaSetLoopStart,
  kriaSetMute,
  kriaSetRoot,
  kriaSetScale,
  kriaSetTimeDivision,
  kriaTimeDivisionOptions,
  kriaTimeDivisionValue,
} from '$lib/ui/modules/kria-cell-actions';
import {
  matrixmixSetXAxis,
  matrixmixSetYAxis,
  matrixmixXAxisOptions,
  matrixmixXAxisValue,
  matrixmixYAxisOptions,
  matrixmixYAxisValue,
} from '$lib/ui/modules/matrixmix-cell-actions';
import { midiclockConnect } from '$lib/ui/modules/midiclock-cell-actions';
import { es9Connect, es9Disconnect } from '$lib/ui/modules/es9-cell-actions';
import {
  midiLaneChannelValue,
  midiLaneClearCcA,
  midiLaneClearCcB,
  midiLaneConnect,
  midiLaneLearnCcA,
  midiLaneLearnCcB,
  midiLaneModeValue,
  midiLaneNoteText,
  midiLanePriorityOptions,
  midiLanePriorityValue,
  midiLaneRetrigValue,
  midiLaneSetChannel,
  midiLaneSetMode,
  midiLaneSetNote,
  midiLaneSetPriority,
  midiLaneSetRetrig,
} from '$lib/ui/modules/midi-lane-cell-actions';
import { midiLaneChannelChoices, parseNoteGateNote } from '$lib/audio/modules/midi-lane';
import {
  clockedRunnerDivisionOptions,
  clockedRunnerDivisionValue,
  setClockedRunnerDivision,
} from '$lib/ui/modules/clocked-runner-cell-actions';
import { runLivecodeNode } from '$lib/ui/modules/livecode-cell-actions';
import { launchpadConnectSingle, launchpadPair } from '$lib/ui/modules/launchpad-cell-actions';
import { push2Connect } from '$lib/ui/modules/push2-cell-actions';
import { electraSendToDevice } from '$lib/ui/modules/electra-cell-actions';
import { outToLaunchConnect } from '$lib/ui/modules/out-to-launch-cell-actions';
import { timelordeFaceTap } from '$lib/ui/modules/timelorde/face-tap';
import {
  WAVESCULPT_WAV_ACCEPT,
  loadWavesculptPreset,
  loadWavesculptWavFile,
  selectWavesculptFactoryTable,
  wavesculptOscSource,
  wavesculptPresetOptions,
  wavesculptPresetValue,
  wavesculptTableOptions,
} from '$lib/ui/modules/wavesculpt/wavetable-actions';

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
 *
 * ⚠ IT CARRIES `write` AND NOTHING ELSE. THERE IS NO `read`, AND THE ABSENCE
 * HAS MISLED THREE AGENTS IN A ROW, so it is spelled out here rather than left
 * to the signature. The sentence above is a good reason for a NARROW type and
 * is completely silent about WHICH methods are missing, so the interface reads
 * as "the engine, narrowed" rather than as "the write half of the engine".
 * Anyone reasoning from the prose concludes the engine is reachable from `env`,
 * and a platform ask to hand this same `env` to `ShellSelectorCell.options` was
 * drafted on exactly that belief — it would not have unblocked a single device
 * picker, because every one of them reaches its roster through a READ.
 *
 * **For anything other than a write, the route is `getActiveEngine()`**
 * (`$lib/audio/engine-ref`), which is consumed from plain `.ts` by the
 * module-owned action files this registry imports — see `fireManualStrike` and
 * `midiclockConnect`, both of which take a `nodeId` and no `env` at all. That
 * is not a workaround; it is the general route, and `env` is the narrow
 * convenience beside it.
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
/**
 * How faces-parity proves an ACTION cell's press actually DID something.
 *
 * ⚠ REQUIRED, and that is the point. Until 2026-08-02 the sweep's `action`
 * branch asserted `toBeEnabled()`, clicked, and asserted NO EFFECT — the only
 * cell kind in the whole gate with no probe, on the kind whose entire purpose
 * is to do something. A dead audition passed the face green. That is the
 * revision-only-probe pathology this file already outlaws for PANEL cells, one
 * kind over, in its terminal form.
 *
 * An audition writes NOTHING to the graph by design (manual-strike-actions.ts),
 * so `readParam`/`readData` — the two oracles every other branch uses — are
 * structurally unable to see it. The observable is the AUDITION LEDGER: the
 * seam records, per press, whether it resolved a callable off the live engine
 * handle and called it. See `$lib/ui/modules/audition-ledger` for the full
 * argument, including why audible RMS is the right bar elsewhere and not here.
 */
export interface ShellActionProbe {
  effect:
    | {
        /** The press must reach `seam` and report DELIVERED. */
        kind: 'audition';
        seam: AuditionSeam;
      }
    | { kind: 'data'; key: string; expect: 'changed' }
    | { kind: 'data-rev'; key: string }
    | {
        /**
         * The press must move a declared PARAM — the strongest observable an
         * action can have, because it is the module's own I/O contract rather
         * than a private view key or a counter.
         *
         * ⚠ IT IS NOT AN ALIAS OF `data`, and the difference is the point. A
         * `data` probe watches `node.data`, which is where a cell keeps state
         * the DEF does not know about; an action whose whole job is to write a
         * param would have to MIRROR its result onto `node.data` to be probed
         * that way, which is a second copy of a value that already has one home
         * — exactly the disagreement this file's other rules exist to prevent.
         */
        kind: 'param';
        paramId: string;
        expect: 'changed';
      };
  /**
   * How many presses the sweep must issue before the effect is expected.
   * Omitted = 1, which is every action shipped before this field.
   *
   * ⚠ IT EXISTS BECAUSE A ONE-PRESS PROBE ON A MULTI-PRESS CONTROL IS THE
   * SIXSTRUM DEFECT WEARING A GREEN TICK. TIMELORDE's TAP TEMPO delivers
   * NOTHING on the first press by design — `TapTempo` needs two timestamps to
   * have an interval, so it returns null and writes no param — so a single
   * click cannot distinguish "the controller is warming up" from "this button
   * is dead". The alternatives were both worse and both were considered: a
   * `data-rev` counter is refused BY NAME two paragraphs down (it passes on a
   * dead button that bumps it), and mirroring the locked tempo onto `node.data`
   * to satisfy a `data` probe would put a param's value in two places.
   *
   * ⚠ THE PRESSES ARE ISSUED AS ONE `clickCount` ACTION, NOT AS A LOOP, AND
   * THAT IS A CORRECTNESS REQUIREMENT RATHER THAN A SPEED ONE. `TapTempo`
   * starts a FRESH series after a ~2 s gap, so N separate `click()` calls —
   * each re-running its own actionability checks on a loaded CI runner — put a
   * wall-clock dependency inside a gate: a slow enough runner resets the series
   * and reads the param unchanged. One `clickCount: n` action dispatches the
   * presses inside a single input sequence with no interleaved await.
   */
  presses?: number;
}

export interface ShellActionCell {
  kind: 'action';
  label: string;
  title?: string;
  /** Press semantics. Omitted = 'trigger' (the one-shot shape). */
  mode?: 'trigger' | 'gate';
  /** REQUIRED — how the parity sweep proves the press was not a no-op. */
  probe: ShellActionProbe;
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
   * The observable effect.
   *
   *   `data`     — a path into `node.data` that must CHANGE (`opOn[1]`).
   *   `data-rev` — a monotonic revision counter that must ADVANCE.
   *   `text`     — the rendered text of ANOTHER element inside the panel
   *                (named by its own testid) that must change.
   *
   * ⚠ Prefer `data` where you can. A revision-only probe passes on a DEAD
   * button that bumps the counter without editing anything — the exact
   * green-but-broken class the whole gate exists to catch.
   *
   * ⚠ `text` EXISTS FOR THE PANEL AFFORDANCE THAT MUST NOT TOUCH `node.data`.
   * `node.data` rides the Y.Doc: it is shared with every collaborator and saved
   * with the patch. That is right for patch DESIGN (the DX7's 78 operator
   * values) and wrong for a private VIEW setting — one player zooming their own
   * plot must not re-zoom everyone else's screen and dirty the patch. Such a
   * panel keeps the setting in component state, and its probe names a
   * DIFFERENT element whose text the interaction must move: kick drum's window
   * button drives the plot's AXIS LABELS, which a dead button cannot change,
   * so the probe is stronger than a revision counter rather than weaker.
   * Naming the driven element itself would be the weak form — a button that
   * only relabels itself would pass — so `testid` here must not equal the
   * probe's `testid`, and shell-cells.test.ts fails it if it does.
   */
  effect:
    | { kind: 'data'; key: string; expect: 'changed' }
    | { kind: 'data-rev'; key: string }
    | { kind: 'text'; testid: string; expect: 'changed' };
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

/**
 * A FADER OVER A PARAM WHOSE CARD CONVERTS AT THE BOUNDARY — the general
 * mechanism, not a samsloop special case.
 *
 * ⚠ WHY THIS CANNOT BE A `paramCells` KIND. `paramCells` is
 * `Record<paramId, kind>`: a bare string. The thing that makes this cell work is
 * a PAIR OF FUNCTIONS, and they are module-specific, so there is nowhere in that
 * record to put them. This registry already carries components and closures
 * (`panel`, `selector`), so it is the seam that can hold them.
 *
 * ⚠ THE DEFECT IT EXISTS TO PREVENT, measured on samsloop.rate. That param is
 * declared `-2..+2 linear`, but `SamsloopCard.svelte` never renders it: it
 * renders KNOB SPACE `0..1` and converts at the edges with a PIECEWISE map
 * (`samsloop-rate.ts`, `k <= 0.5 -> -2 + 6k`, else `1 + 2(k - 0.5)`). The
 * consequence is geometric, not cosmetic: unity (+1) sits at the fader's
 * MIDPOINT, and five tick landmarks are placed against that. A generic
 * `paramCells: 'fader'` over the raw range draws the same param LINEARLY, which
 * moves unity from 1/2 to `(1 - -2) / 4 = 3/4` and scatters every landmark. That
 * is a FUNCTIONAL PARITY BREAK — the player's muscle memory for "no transpose"
 * lands a quarter of the control away — and it passes every gate we have,
 * because each one reads the ParamDef and the ParamDef is not what was drawn.
 *
 * ⚠ AND IT IS WHY `landmarks` ALONE COULD NOT FIX IT — the thing a reader is
 * most likely to assume. `ParamLandmark` is `{ value, label }` and `value` is in
 * PARAM UNITS with NO position field; a landmark's placement is derived by the
 * cell that draws it. Declaring landmarks on a linearly-drawn fader therefore
 * reproduces the break it was meant to prevent, correctly labelled.
 *
 * ⚠ SO: `landmarks` HERE ARE STILL PARAM UNITS. They are not knob positions and
 * this interface did not grow a position field. THE CELL does the warping — it
 * puts each landmark at `toKnob(value)`. Keeping them in param units is what
 * lets the same declaration stay true if the map is ever corrected, and what
 * lets a reader check a landmark against the def by reading it.
 *
 * ⚠ THE MAP MUST BE IMPORTED, NEVER RE-TYPED. This is the backdraft one-source
 * rule applied to a function instead of a number: the card and this cell must
 * convert identically or the two surfaces disagree about where unity is, and
 * nothing would catch it. samsloop's pair already ships as
 * `knobToRate`/`rateToKnob`; pass those, do not re-implement the arithmetic.
 * `warped-fader-source.test.ts` greps this file for a re-typed map literal.
 */
export interface ShellWarpedFaderCell {
  kind: 'warped-fader';
  /** Caption under the fader. */
  label: string;
  /** The ParamDef this renders — the value written to the graph is param units. */
  paramId: string;
  /** PARAM UNITS -> knob space [0,1]. Imported from the module's own map. */
  toKnob: (value: number) => number;
  /** Knob space [0,1] -> PARAM UNITS. The inverse; the cell writes this result. */
  fromKnob: (knob: number) => number;
  /**
   * Named waypoints, in PARAM UNITS (see the interface note). The cell places
   * each at `toKnob(value)`, so a non-linear map produces non-uniform spacing —
   * which is the point, and is what makes the placement match the card.
   */
  landmarks: readonly ParamLandmark[];
  /** Renders the value for `aria-valuetext`. Param units in, display text out. */
  format?: (value: number) => string;
}

/**
 * How faces-parity proves a TYPED string reached the graph.
 *
 * ⚠ TWO STRINGS, AND THE SECOND IS THE POINT. `accepts` proves the field is
 * live; `rejects` proves it is a VALIDATOR rather than a funnel. Without the
 * negative leg a cell that clamped every input to its nearest legal value would
 * pass the positive one perfectly — which is the backdraft class exactly (a
 * control writing what the contract forbids while the model quietly corrected
 * it, with every def-reading gate blind). Only the module knows what its own
 * domain excludes, so the refused string is declared per cell rather than
 * guessed by the sweep.
 *
 * ⚠ AND BOTH ARE CHECKED IN THE PURE LANE FIRST. `shell-cells.test.ts` runs
 * `parse(accepts).ok === true` and `parse(rejects).ok === false` over every
 * registered entry cell, so a probe whose strings are the wrong way round — or
 * whose `rejects` is quietly legal — fails in milliseconds instead of 25
 * minutes later on a CI shard.
 */
export interface ShellEntryProbe {
  /** A VALID string. The sweep types it and asserts the effect fires. */
  accepts: string;
  /** A string this field MUST refuse. Typed second; the sweep asserts the
   *  stored value did NOT move and the field reports itself invalid. */
  rejects: string;
  /** The observable. `node.data` is the right oracle for a typed field: unlike
   *  an audition it writes something durable by design, so the ledger's
   *  "delivered but invisible" problem does not arise here. */
  effect: { kind: 'data'; key: string; expect: 'changed' };
}

/**
 * A TYPED-ENTRY field — the cell whose CONTENT IS the control.
 *
 * ⚠ THIS IS THE ONE CELL PERMITTED TO PAINT A STRING AT REST, and the licence is
 * narrow. The resting-faceplate ruling forbids derived text in any shape because
 * such text RESTATES something a control already shows: a decimal under a dial
 * says what the angle says. A text field has no non-text form — its content is
 * not a readout OF the control, it IS the control — so it carries the
 * `'authored-entry'` role in `face-resting-text-source.test.ts`, and that role
 * is legal only on a cell that is genuinely user-writable. `onCommit` is
 * REQUIRED for exactly that reason: a display has no write, so it cannot claim
 * the role, and the gate checks the field is non-optional on this interface
 * rather than taking the declaration's word for it.
 *
 * ⚠ THE MODULE NEVER SEES RAW TEXT. `parse` is the ONE place validity is
 * decided; the shell calls it and hands `onCommit` a value that was already
 * accepted. A rejection writes NOTHING — it does not clamp, round, truncate or
 * substitute — so there is no code path in which a silent correction could live.
 * See `text-entry-model.ts` for why the reject sentinel is a tagged union and
 * not `null` (cartesian's empty box is a REST, which is an accepted value whose
 * stored form is null).
 *
 * ⚠ IMPORT THE VALIDATOR, NEVER RE-TYPE IT — the same one-source rule the warped
 * fader's `toKnob`/`fromKnob` obey, for the same reason: a card and a face that
 * parse differently both look correct and disagree about what the user typed,
 * and no runtime gate reads a grammar.
 */
export interface ShellEntryCell<T = unknown> {
  kind: 'entry';
  /** Caption under the field — a CONTROL CAPTION, an already-permitted role. */
  label: string;
  title?: string;
  /** The text the field shows at REST: the user's own stored content, round-
   *  tripped by the module. Never a formatter over a derived quantity. */
  text: (node: ModuleNode | undefined) => string;
  /** Text -> the module's stored form, or a REJECTION. */
  parse: (text: string) => EntryParse<T>;
  /** REQUIRED. Called ONLY with an accepted `parse` result. */
  onCommit: (nodeId: string, value: T) => void;
  placeholder?: string;
  maxLength?: number;
  /** REQUIRED — see ShellEntryProbe. */
  probe: ShellEntryProbe;
}

export type ShellCell =
  | ShellSelectorCell
  | ShellActionCell
  | ShellFileCell
  | ShellToggleCell
  | ShellPanelCell
  | ShellWarpedFaderCell
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry
  // is a heterogeneous map, so the union member must admit any stored form; the
  // per-cell `parse`/`onCommit` pair is still checked against ONE `T` at each
  // declaration site.
  | ShellEntryCell<any>;

/**
 * Per-module cell specs, keyed by module type then by the EXACT `face.order`
 * key (a family template `<familyId>-{n}`, or a legend static key). Keeping the
 * face key as the index means the face, the docs (`docs.controls`) and the
 * shell all address the control by the SAME string — a rename breaks all three
 * gates at once instead of silently un-rendering one of them.
 */
const SHELL_CELLS: Record<string, Record<string, ShellCell>> = {
  cartesian: {
    // THE 4×4 PAD GRID — the module itself, and the `TextEntry` primitive's
    // first adopter (#1509).
    //
    // ⚠ ONE PANEL, NOT FORTY-EIGHT GENERIC CELLS, and the first attempt was the
    // other thing. A face key is a PARAM id, a family TEMPLATE (`-{n}` literal,
    // ONE cell, no per-member index) or a legend STATIC (needs a committed
    // legend JSON cartesian does not have). Sixteen ranked pads therefore needs
    // forty-eight family ids, and `module-docs-lint`'s card-drift leg requires
    // each declared `testidPrefix` to appear in real UI source — MEASURED:
    // twelve face-only families fail it. Both escapes are refused by standing
    // rules. See `CartesianPadGrid.svelte`'s header for the full derivation.
    //
    // ⚠ MEASURED WIDTHS, kept because the next face author otherwise
    // rediscovers them (dock, 1220 px pane, CSS px): `selector` 168 ·
    // `entry` 72 · `action` 58 · `toggle` 52 · `knob` 40. Four selector cells
    // were 49% of a 1374 px band and pushed 220 px of the plate outside the
    // capture box; that is what sent this grid to a panel rather than to
    // `clusters`.
    //
    // ⚠ THE PROBE CLICKS A GATE, NOT A PITCH BOX. faces-parity drives a panel
    // with a click or a drag — it cannot type — so the honest observable here
    // is the gate toggle, which writes the same `node.data.cells` key. The
    // TYPED half is proven by `cartesian-face.spec.ts`, whose three legs
    // (accepts / REFUSES-without-clamping / clears-to-a-rest) are the reason
    // the parse contract is shaped the way it is. Naming a pitch box here and
    // clicking it would assert nothing at all.
    'cart-pitch-{n}': {
      kind: 'panel',
      label: 'pads',
      component: CartesianPadGrid,
      // Four columns of a ~72 px entry plus gate/chord buttons, with the 4 px
      // grid gaps and the pad's own 2 px padding — measured at 316 px, floored
      // just above so a narrow dock cannot squeeze a note name to ellipsis.
      minWidth: 320,
      probe: {
        testid: 'cart-face-gate-1',
        action: 'click',
        effect: { kind: 'data', key: 'cells', expect: 'changed' },
      },
    },
  },
  bluebox: {
    // THE TONE BANK — ten bars, one per oscillator, promoted into the hero slot
    // (`face.hero.cell`). A panel rather than a glyph because it is not a trace
    // of the output: it is a picture of the BANK, and this module's entire
    // design is that the bank has TEN slots for TWELVE keys, so two keys sharing
    // a tone drive ONE slot twice as hard instead of running two voices. The
    // `meter` glyph in the lane says how hot the sum is (the module's hazard,
    // and why the lane keeps it); only this says WHY {1,4} beats {1,5}.
    //
    // ⚠ THERE ARE NO `bluebox-key-*` CELLS. The twelve keys are the ParamDefs
    // the def already declares, rendered as momentary <Button>s via
    // `face.momentary` — the clap `strike` precedent — which keeps them inside
    // faces-parity's param multiset and makes `setMomentaryParam` the leak-proof
    // write path. Family cells would be a second implementation of controls the
    // def already owns.
    'bluebox-tonebank-{n}': {
      kind: 'panel',
      label: 'tone bank',
      component: BlueboxToneBankPanel,
      minWidth: 380,
      // A `text` probe on a DIFFERENT element, the clap/kickdrum reason: the bar
      // LABELLING is a private view setting in component state, so there is no
      // node.data key to watch. The button drives the caption row, which a dead
      // button cannot change — a stronger claim than a revision counter. That
      // the two modes can never render the SAME caption (which is what makes
      // this probe non-vacuous) is asserted in bluebox-face-model.test.ts.
      probe: {
        testid: 'bluebox-bank-label',
        action: 'click',
        effect: { kind: 'text', testid: 'bluebox-bank-axis', expect: 'changed' },
      },
    },
  },
  cofefve: {
    // THE ECHO TRAIN — the dry hit and the repeats this patch will actually
    // produce, promoted into the faceplate's hero slot (`face.hero.cell`).
    //
    // ⚠ A PANEL RATHER THAN THE GLYPH, and the reason is what the glyph can
    // honestly say here. `scope` on this module is a live trace of an INSERT's
    // output: a flat line on a silent rack, which is precisely the state a
    // player is in while setting a delay up. That is fine in a lane tile (it
    // says "the module is running") and useless at the dock, which is why
    // `face.hero.cell` suppresses `heroGlyph` there.
    //
    // ⚠ AND IT IS THE SURFACE THAT PAINTS A DEAD CONTROL AS DEAD. The WOW
    // ripple is drawn only above WOW AMOUNT 0 — greyed and captioned `wow off`
    // at the shipped default — so the picture states that the motion section is
    // asleep rather than drawing a steady train that reads as a working one.
    'cofefve-echo-{n}': {
      kind: 'panel',
      label: 'echo train',
      component: CofefveEchoTrainPanel,
      minWidth: 320,
      // A `text` probe on a DIFFERENT element, the clap/kickdrum/bluebox
      // reason: the plot's time WINDOW is a private view setting in component
      // state (zooming your own plot must not zoom every collaborator's screen
      // or dirty the patch), so there is no node.data key to watch. The button
      // drives the AXIS TICK ROW, which a dead button cannot change — a
      // stronger claim than a revision counter. That no two windows can render
      // the same tick row, which is what makes this probe non-vacuous, is
      // asserted over every pair in cofefve-face-model.test.ts.
      probe: {
        testid: 'cofefve-echo-window',
        action: 'click',
        effect: { kind: 'text', testid: 'cofefve-echo-axis', expect: 'changed' },
      },
    },
  },
  // WAVESCULPT — the wavetable strip, TWELVE cells: three control kinds for
  // each of four oscillators. Twelve rather than three because a control family
  // renders as ONE cell with no member index (see the def's controlFamilies
  // note), so each voice needs its own family per kind and each cell closes
  // over its own oscillator index.
  //
  // ⚠ EVERY WRITE GOES THROUGH `wavesculpt/wavetable-actions`, which
  // `WavesculptCard.svelte` also calls. The DX7 is the precedent for why: a
  // card that owned its own action shipped a faceplate that could not change
  // the voice at all. Sharing the writes is what stops the two surfaces
  // disagreeing about what "this oscillator holds table X" means.
  wavesculpt: {
    // ── OSC RED ─────────────────────────────────────────────────────────
    'wavesculpt-osc1-preset-{n}': {
      kind: 'selector',
      tag: 'red pre',
      options: () => wavesculptPresetOptions(),
      // ⚠ THIS USED TO BE `value: () => ''` — a constant, so the chip could
      // never move off the sentinel however many presets you picked. See
      // `wavesculptPresetValue`: the sweep caught it, and the legacy card's
      // native <select> had the affordance the faceplate lacked.
      value: (node) => wavesculptPresetValue(node, 0),
      onchange: (nodeId, value) => { if (value) void loadWavesculptPreset(nodeId, 0, value); },
    },
    'wavesculpt-osc1-table-{n}': {
      kind: 'selector',
      tag: 'red tbl',
      options: (node) => wavesculptTableOptions(node, 0),
      value: (node) => wavesculptOscSource(node, 0),
      onchange: (nodeId, value) => {
        // 'user' is the synthetic entry standing for an already-loaded table:
        // selecting it is a no-op, because there is nothing to re-point to.
        if (value.startsWith('factory:')) {
          selectWavesculptFactoryTable(nodeId, 0, value.slice('factory:'.length));
        }
      },
    },
    'wavesculpt-osc1-load-{n}': {
      kind: 'file',
      label: 'RED .wav…',
      title: 'Load your own .wav as the RED oscillator\'s wavetable (E352 single-cycle layout)',
      accept: WAVESCULPT_WAV_ACCEPT,
      onFile: (nodeId, file) => loadWavesculptWavFile(nodeId, 0, file),
    },
    // ── OSC GREEN ─────────────────────────────────────────────────────────
    'wavesculpt-osc2-preset-{n}': {
      kind: 'selector',
      tag: 'green pre',
      options: () => wavesculptPresetOptions(),
      // Same shape as OSC RED's — see `wavesculptPresetValue`.
      value: (node) => wavesculptPresetValue(node, 1),
      onchange: (nodeId, value) => { if (value) void loadWavesculptPreset(nodeId, 1, value); },
    },
    'wavesculpt-osc2-table-{n}': {
      kind: 'selector',
      tag: 'green tbl',
      options: (node) => wavesculptTableOptions(node, 1),
      value: (node) => wavesculptOscSource(node, 1),
      onchange: (nodeId, value) => {
        // 'user' is the synthetic entry standing for an already-loaded table:
        // selecting it is a no-op, because there is nothing to re-point to.
        if (value.startsWith('factory:')) {
          selectWavesculptFactoryTable(nodeId, 1, value.slice('factory:'.length));
        }
      },
    },
    'wavesculpt-osc2-load-{n}': {
      kind: 'file',
      label: 'GREEN .wav…',
      title: 'Load your own .wav as the GREEN oscillator\'s wavetable (E352 single-cycle layout)',
      accept: WAVESCULPT_WAV_ACCEPT,
      onFile: (nodeId, file) => loadWavesculptWavFile(nodeId, 1, file),
    },
    // ── OSC BLUE ─────────────────────────────────────────────────────────
    'wavesculpt-osc3-preset-{n}': {
      kind: 'selector',
      tag: 'blue pre',
      options: () => wavesculptPresetOptions(),
      // Same shape as OSC RED's — see `wavesculptPresetValue`.
      value: (node) => wavesculptPresetValue(node, 2),
      onchange: (nodeId, value) => { if (value) void loadWavesculptPreset(nodeId, 2, value); },
    },
    'wavesculpt-osc3-table-{n}': {
      kind: 'selector',
      tag: 'blue tbl',
      options: (node) => wavesculptTableOptions(node, 2),
      value: (node) => wavesculptOscSource(node, 2),
      onchange: (nodeId, value) => {
        // 'user' is the synthetic entry standing for an already-loaded table:
        // selecting it is a no-op, because there is nothing to re-point to.
        if (value.startsWith('factory:')) {
          selectWavesculptFactoryTable(nodeId, 2, value.slice('factory:'.length));
        }
      },
    },
    'wavesculpt-osc3-load-{n}': {
      kind: 'file',
      label: 'BLUE .wav…',
      title: 'Load your own .wav as the BLUE oscillator\'s wavetable (E352 single-cycle layout)',
      accept: WAVESCULPT_WAV_ACCEPT,
      onFile: (nodeId, file) => loadWavesculptWavFile(nodeId, 2, file),
    },
    // ── OSC ALPHA ─────────────────────────────────────────────────────────
    'wavesculpt-osc4-preset-{n}': {
      kind: 'selector',
      tag: 'alpha pre',
      options: () => wavesculptPresetOptions(),
      // Same shape as OSC RED's — see `wavesculptPresetValue`.
      value: (node) => wavesculptPresetValue(node, 3),
      onchange: (nodeId, value) => { if (value) void loadWavesculptPreset(nodeId, 3, value); },
    },
    'wavesculpt-osc4-table-{n}': {
      kind: 'selector',
      tag: 'alpha tbl',
      options: (node) => wavesculptTableOptions(node, 3),
      value: (node) => wavesculptOscSource(node, 3),
      onchange: (nodeId, value) => {
        // 'user' is the synthetic entry standing for an already-loaded table:
        // selecting it is a no-op, because there is nothing to re-point to.
        if (value.startsWith('factory:')) {
          selectWavesculptFactoryTable(nodeId, 3, value.slice('factory:'.length));
        }
      },
    },
    'wavesculpt-osc4-load-{n}': {
      kind: 'file',
      label: 'ALPHA .wav…',
      title: 'Load your own .wav as the ALPHA oscillator\'s wavetable (E352 single-cycle layout)',
      accept: WAVESCULPT_WAV_ACCEPT,
      onFile: (nodeId, file) => loadWavesculptWavFile(nodeId, 3, file),
    },
  },
  milkdrop: {
    // THE PRESET PICKER — the only surface on which the preset NAMES exist.
    // `presetSelect` addresses presets by INDEX, so without this cell a
    // faceplate could paint only an anonymous ~20-position control (the
    // `sampleHold` / `colourofmagic` defect). Options come from the ENGINE's
    // live list rather than a static roster, because the list grows with
    // in-session `.milk` imports and a frozen roster would be wrong the moment
    // anyone used the loader below.
    //
    // ⚠ IT WRITES `presetSelect`, the same param the PST fader, the PRESET CV
    // jack and the NEXT trigger drive — which is what keeps all four in sync and
    // what makes the choice persist with the patch.
    'milkdrop-preset-select-{n}': {
      kind: 'selector',
      tag: 'preset',
      options: (node) => milkdropPresetOptions(node?.id ?? ''),
      value: (node) => milkdropPresetValue(node),
      onchange: (nodeId, value) => selectMilkdropPreset(nodeId, value),
    },
    // The `.milk` importer — the same convert/append/crossfade action as the
    // card's hidden file input, status line included. Custom imports are
    // in-session only by design; the curated index is what the patch saves.
    'milkdrop-milk-input-{n}': {
      kind: 'file',
      label: 'Load .milk…',
      title: 'Import a Winamp Milkdrop .milk preset (appended to the picker for this session)',
      accept: MILK_ACCEPT,
      onFile: (nodeId, file) => loadMilkFile(nodeId, file),
    },
  },
  vfpgaRunner: {
    // THE BITSTREAM PICKER — this module's IDENTITY control, and the one cell
    // whose absence would make the faceplate a different module. VFPGA-RUNNER
    // is a HOST: it IS whichever `.vfpga` is loaded, and every other control on
    // the plate means something different per entry in this list. The card's
    // "load preset…" `<select>` is the only route to it, so promotion without
    // this cell would leave a module that can never leave its default program.
    //
    // ⚠ IT CALLS THE SHARED ACTION, not `setVfpgaSpec` directly. Loading a
    // bitstream is TWO writes — the node.data id (+ slot-default seeding) and
    // the `__reloadVfpga` engine pulse that disposes the running GL pipeline
    // and builds the new one. Doing only the first writes the id and leaves the
    // OLD effect compiled: a picker that looks like it works while the picture
    // never changes.
    'vfpga-preset-{n}': {
      kind: 'selector',
      tag: 'vfpga',
      options: () => vfpgaPresetOptions(),
      value: (node) => vfpgaPresetValue(node),
      onchange: (nodeId, value) => selectVfpgaPreset(nodeId, value),
    },
    // THE MODULATION RACK — a SCALE attenuverter + OFFSET + live trace per CV
    // role the loaded bitstream declares, then an activity lamp per gate role.
    //
    // ⚠ A PANEL BECAUSE NEITHER HALF IS PARAM-SHAPED. SCALE/OFFSET are
    // `node.data.cvInputs` (the shared TOYBOX shape), not ParamDefs, and the
    // ROSTER is dynamic — which strips exist is a property of the loaded
    // bitstream — so there is nothing static for the def to declare and no
    // generic cell kind that holds N pairs of continuous controls.
    //
    // ⚠ THE PROBE DRIVES **OFFSET**, NOT SCALE, AND THAT IS MEASURED RATHER
    // THAN ARBITRARY. faces-parity's drag is `move(cx, cy - 24)` — always
    // UPWARD, i.e. always toward the maximum. `DEFAULT_INPUT_SCALE` is +1,
    // which IS the top of the attenuverter's -1..+1 range, so a probe on SCALE
    // would drag a control that is already at its ceiling, read no change, and
    // fail on a perfectly live panel. OFFSET defaults to 0 at the BOTTOM of
    // 0..1, so the same gesture always moves it.
    'vfpga-cv-{n}': {
      kind: 'panel',
      // ⚠ NOT 'modulation' — the band above this cell is already headed
      // MODULATION, and the owner's caption ruling is explicit that a
      // per-control label is clutter when the section heading already conveys
      // it. Measured off the first dock capture, where the word printed twice,
      // ~10 px apart. This caption says what the cell CONTAINS, which the
      // heading does not.
      label: 'cv + gates',
      component: VfpgaModulationPanel,
      // Two knob columns + a 64px trace + the role caption, with room for the
      // widest role label the catalog ships ('RE-ROLL' / 'I-FRAME').
      minWidth: 260,
      probe: {
        testid: 'vfpga-offset-1',
        action: 'drag',
        effect: { kind: 'data', key: 'cvInputs', expect: 'changed' },
      },
    },
  },
  frametable: {
    // THE WAVETABLE FILE WORKFLOW — the two affordances promotion would
    // otherwise have deleted with `FrametableCard.svelte`, since `migrated(type)`
    // stops BOTH surfaces rendering a promoted module's card. The def's own
    // `explanation` advertises this workflow at length ("FRAMETABLE also SAVES +
    // LOADS real FILES"), so a face without them would ship documentation
    // describing controls that no longer exist — and no def-reading gate can see
    // that. Both call `$lib/ui/modules/frametable-file-actions`, which the card
    // now calls too, so the two surfaces cannot drift about what a `.frametable
    // .png` is.
    'frametable-file-input-{n}': {
      kind: 'file',
      label: 'Load table…',
      title: 'Import a .frametable.png atlas (a 10x6 = 60-tile contact sheet) into the ring, freezing it so the loaded table can be scanned',
      accept: FRAMETABLE_FILE_ACCEPT,
      onFile: (nodeId, file) => loadFrametableFile(nodeId, file),
    },
    // ⚠ THE FIRST `data` PROBE ON AN ACTION CELL IN THE TREE, and the reason is
    // that this action's whole effect is OUTSIDE the page. `ShellActionProbe`
    // has carried the shape since PF-14 ("a future action cell that edits
    // node.data instead of firing a seam") with no adopter; the five shipped
    // action cells are all AUDITIONS, whose observable is the audition ledger
    // because they deliberately write nothing at all.
    //
    // This one is the opposite case. It is not an audition — it touches no seam,
    // no engine-handle callable and no ConstantSource — it reads the ring back,
    // encodes a PNG and hands it to the browser. An `audition` record would be a
    // lie about what happened.
    //
    // ⚠ AND THE OBSERVABLE IS `frametableSave`, NOT `frametableFile`, WHICH THE
    // FIRST DRAFT OF THIS CELL GOT WRONG. `frametableFile` is the success-only
    // descriptor, and it is the stronger claim — but it is UNREACHABLE in the
    // sweep's scene, for a reason that is a property of the harness rather than
    // of this module. MEASURED on this branch: `spawnPatch` populates the graph
    // store and NEVER reconciles the engine, so with a frametable spawned and
    // its dock OPEN the video engine holds `nodes: []` and `rafId: null` — and
    // the same probe reports the same emptiness for `chroma`, an already-shipped
    // video face, which is what makes it a scene fact and not a frametable one.
    // With no engine node there is no ring to read, so NO honest probe of a real
    // save can pass there; asserting one would have been a gate that fails on
    // correct code.
    //
    // `frametableSave` is the outcome record every exit of `saveFrametableFile`
    // writes — `{ seq, ok, error }`, with `ok: false` KEPT — which is the
    // audition ledger's own principle applied to a disk write: "never pressed"
    // and "pressed and reached nothing" must stay distinguishable. So the probe
    // asserts the press RAN THE HANDLER AND REPORTED, which is exactly what the
    // FILE branch one kind over asserts of an import ("Either way the action RAN
    // — which is what 'not inert' means here"), and the content-level behaviour
    // stays with the bespoke spec, exactly as that branch leaves it to
    // `dx7-syx-load.spec.ts`. Here that spec is `frametable.spec.ts`, whose
    // SAVE→LOAD round-trip drives a REAL engine and asserts the atlas restores
    // the ring.
    'frametable-save-file-{n}': {
      kind: 'action',
      label: 'Save table',
      title: 'Write the current 60-frame ring to a lossless .frametable.png atlas file (FREEZE first to hold a specific 60 frames)',
      probe: { effect: { kind: 'data', key: 'frametableSave', expect: 'changed' } },
      onFire: (nodeId) => { void saveFrametableFile(nodeId); },
    },
  },
  videocube: {
    // THE THREE RING SLOTS — FLOOR, WALL, CEILING — each with the two controls
    // `VideocubeCard.svelte` gives it: point the ring back at its LIVE input, or
    // load a `.frametable.png` table into it. These six decide WHAT IS IN THE
    // CUBE, and promotion deletes the card that owns them, so without these
    // cells the faceplate would have thirty knobs over a solid whose contents
    // could not be chosen. All six call
    // `$lib/ui/modules/videocube-slot-actions`, which the card now calls too.
    //
    // ⚠ EVERY ONE OF THE SIX IS ENGINE-ONLY. Both actions hand a tagged element
    // to `attachExternalSource` and write NOTHING to the graph — v1 does not even
    // persist a descriptor, unlike FRAMETABLE — so `readParam`/`readData` are
    // structurally blind to the work. The `videocubeSlot` outcome record is what
    // makes a press observable, and it is the SECOND adopter of the pattern
    // `saveFrametableFile` established: written on EVERY press including the
    // failures, carrying which slot, which source and the outcome, so a dead
    // button writes nothing at all and a button that reached no engine writes
    // `ok: false` with the reason. One key for all six — `seq` is what
    // guarantees a change, and each probe snapshots immediately before its own
    // press.
    'videocube-a-live-{n}': {
      kind: 'action',
      label: 'FLOOR live',
      title: 'Point ring A (FLOOR) back at the video_a input and resume live capture — the way back from a loaded table',
      probe: { effect: { kind: 'data', key: 'videocubeSlot', expect: 'changed' } },
      onFire: (nodeId) => { setVideocubeSlotLive(nodeId, 'a'); },
    },
    'videocube-a-file-input-{n}': {
      kind: 'file',
      label: 'FLOOR table…',
      title: 'Load a .frametable.png atlas into ring A (FLOOR). Session-only in v1 — a reload returns the slot to LIVE',
      accept: FRAMETABLE_FILE_ACCEPT,
      onFile: (nodeId, file) => loadVideocubeSlotFile(nodeId, 'a', file),
    },
    'videocube-b-live-{n}': {
      kind: 'action',
      label: 'WALL live',
      title: 'Point ring B (WALL / connector) back at the video_b input and resume live capture',
      probe: { effect: { kind: 'data', key: 'videocubeSlot', expect: 'changed' } },
      onFire: (nodeId) => { setVideocubeSlotLive(nodeId, 'b'); },
    },
    'videocube-b-file-input-{n}': {
      kind: 'file',
      label: 'WALL table…',
      title: 'Load a .frametable.png atlas into ring B (WALL / connector). Session-only in v1',
      accept: FRAMETABLE_FILE_ACCEPT,
      onFile: (nodeId, file) => loadVideocubeSlotFile(nodeId, 'b', file),
    },
    'videocube-c-live-{n}': {
      kind: 'action',
      label: 'CEIL live',
      title: 'Point ring C (CEILING) back at the video_c input and resume live capture',
      probe: { effect: { kind: 'data', key: 'videocubeSlot', expect: 'changed' } },
      onFire: (nodeId) => { setVideocubeSlotLive(nodeId, 'c'); },
    },
    'videocube-c-file-input-{n}': {
      kind: 'file',
      label: 'CEIL table…',
      title: 'Load a .frametable.png atlas into ring C (CEILING). Session-only in v1',
      accept: FRAMETABLE_FILE_ACCEPT,
      onFile: (nodeId, file) => loadVideocubeSlotFile(nodeId, 'c', file),
    },
  },
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
  samsloop: {
    // ⚠ THE WARPED FADER'S FIRST CONSUMER, and the reason that cell exists. The
    // `rate` param is declared `-2..+2 linear`, but `SamsloopCard.svelte` has
    // never rendered it that way: it draws KNOB SPACE `0..1` and converts at the
    // edges with a PIECEWISE map. The consequence is geometric — unity (+1) sits
    // at the fader's MIDPOINT, and a generic linear fader would move it to 3/4
    // and scatter every landmark with it.
    //
    // ⚠ THE MAP IS IMPORTED, NEVER RE-TYPED. `knobToRate`/`rateToKnob` are the
    // module's own pair and the card calls the same two functions. This is the
    // backdraft one-source rule applied to a FUNCTION instead of a number: a
    // re-typed copy renders correctly, writes correct values and passes every
    // runtime assertion, right up until someone corrects the map in one place —
    // and then the two surfaces disagree about where unity is with nothing red.
    // `warped-fader-source.test.ts` greps this file for exactly that.
    //
    // ⚠ THE LANDMARKS STAY IN PARAM UNITS. `ParamLandmark` has no position
    // field; the cell places each at `toKnob(value)`. Declaring them as knob
    // positions would reproduce the break this cell exists to prevent, neatly
    // labelled.
    rate: {
      kind: 'warped-fader',
      label: 'rate',
      paramId: 'rate',
      toKnob: rateToKnob,
      fromKnob: knobToRate,
      landmarks: SAMSLOOP_RATE_LANDMARKS,
      format: formatRatePercent,
    },

    // The manual TRIGGER. ⚠ ITS SEAM ALREADY EXISTED: the card resolves
    // `manualTrigger` off the engine handle, which IS `MANUAL_STRIKE_KEY`, so
    // this is the canonical one-shot audition rather than a new path. An
    // audition writes NOTHING to the graph by design, so `readParam`/`readData`
    // are structurally blind to it and the ledger is the only observable.
    'samsloop-trigger-{n}': {
      kind: 'action',
      label: 'trigger',
      title: 'Start playback (one-shot plays once, loop starts the loop)',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
      onFire: (nodeId) => { fireManualStrike(nodeId); },
    },

    // The sample LOADER — the same decode-and-install action the card's file
    // input runs. ⚠ Its `{ status, error }` return is not decoration: the card
    // renders those two strings in `samsloop-upload-status` /
    // `samsloop-upload-error`, two affordances the def never declared, and the
    // `file` cell's contract carries them for free.
    'samsloop-wav-input-{n}': {
      kind: 'file',
      label: 'Load audio...',
      title: 'Load a sample (wav, mp3, m4a, ogg, flac, opus — up to 2 MB)',
      accept: 'audio/*',
      onFile: (nodeId, file) => loadSamsloopAudioFile(nodeId, file),
    },

    // ⚠ THE RECORDER, WHICH THE FACEPLATE SKILL RECORDED AS UNBUILDABLE. That
    // claim ("the shell has no recorder cell") was measured again here and is
    // WRONG: an `engine-message` audition is exactly this shape. Pressing REC
    // writes NOTHING to `node.data` — the take lives in a node-keyed registry
    // and commits once, on stop — so a `data` probe would fail on a perfectly
    // live button. What the press DOES do is resolve a callable off the live
    // engine handle and drive it, which is what the ledger witnesses.
    'samsloop-rec-{n}': {
      kind: 'action',
      label: 'rec',
      title: 'Start or stop recording into the sample buffer',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { toggleSamsloopRecord(nodeId); },
    },

    // Export the sample — the recording as a WAV, or an upload's ORIGINAL bytes
    // verbatim. ⚠ The seam is `file-export` rather than `engine-message`: an
    // export reaches no engine, and a probe watching `engine-message` here would
    // be satisfied by a REC press on the same node.
    'samsloop-download-{n}': {
      kind: 'action',
      label: 'export',
      title: 'Download the loaded or recorded sample',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'file-export' } },
      onFire: (nodeId) => { downloadSamsloopSample(nodeId); },
    },

    // The three RECORD-FORMAT switches. They are `node.data`, not params — they
    // ride the Yjs envelope and are frozen for a take's duration — so they are
    // selectors rather than param cells. The rosters are DERIVED from the
    // module's own tables; the card paints the same strings.
    'samsloop-chan-{n}': {
      kind: 'selector',
      tag: 'chan',
      options: () => samsloopChannelsOptions(),
      value: (node) => samsloopChannelsValue(node),
      onchange: (nodeId, value) => selectSamsloopChannels(nodeId, value),
    },
    'samsloop-bits-{n}': {
      kind: 'selector',
      tag: 'bits',
      options: () => samsloopBitsOptions(),
      value: (node) => samsloopBitsValue(node),
      onchange: (nodeId, value) => selectSamsloopBits(nodeId, value),
    },
    'samsloop-rate-select-{n}': {
      kind: 'selector',
      tag: 'rate',
      options: () => samsloopRateOptions(),
      value: (node) => samsloopRateValue(node),
      onchange: (nodeId, value) => selectSamsloopRate(nodeId, value),
    },
  },
  wavecel: {
    // THE HERO PICTURE — the loaded wavetable as a 3D stack or a single-frame
    // scope, with the frame MORPH points at highlighted and SPREAD's read
    // window picked out across its neighbours.
    //
    // ⚠ A PANEL RATHER THAN A `fullViewBody` EXTENSION, and `analogVco` above
    // is the sibling that decides it rather than `rasterize`. All three are
    // audio defs whose picture the shell cannot draw generically — but
    // rasterize's raster is PRODUCED inside `read('imageData')`, so its surface
    // must carry a per-frame push and has no probe of its own. This one is
    // DERIVED: the table comes from `node.data`, the read position from the
    // params and the CV taps, and nothing reads an AnalyserNode. That is the
    // `analogvco-cycle` shape, including why its glyph cannot serve — a
    // `hero.cell` suppresses the dock glyph so a knob-INVARIANT live trace
    // never sits beside a knob-DERIVED picture.
    //
    // ⚠ THE PROBE READS THIS PANEL'S OWN SUBJECT. The view mode is a PRIVATE
    // component-state preference (the card holds it the same way at
    // `WavecelCard.svelte:54`, and both video OUTPUTS render their own view
    // regardless of it), so there is no node.data key to watch — the
    // `analogvco-cycle` situation exactly. The difference from a bad `text`
    // probe is WHOSE caption it reads: this button lives INSIDE the panel and
    // its caption IS the panel's current view, so a dead panel cannot produce
    // the change. A probe reading some other control's caption could not say
    // that, which is why rasterize declined a panel entirely.
    'wavecel-viz-toggle-{n}': {
      kind: 'panel',
      label: 'wavetable',
      component: WavecelWavetablePanel,
      minWidth: 320,
      // ⚠ A `data` PROBE, AND THE GATE IS WHAT MADE IT ONE. The first draft
      // named a `text` witness on the toggle's own caption; `shell-cells`
      // refused it — *"a control that only relabels itself is indistinguishable
      // from a dead one"*. Correct, and it is the reason the view mode moved to
      // `node.data`: the probe now watches the STATE THE PICTURE IS DRAWN FROM,
      // so a panel that has stopped rendering cannot satisfy it. `data` over
      // `data-rev` per the registry's own rule — a revision counter passes on a
      // dead control that merely bumps it.
      probe: {
        testid: 'wavecel-viz-toggle-1',
        action: 'click',
        effect: { kind: 'data', key: 'vizMode', expect: 'changed' },
      },
    },
    // The wavetable SOURCE — which factory table (or the user upload) is
    // loaded. Drives the SAME `node.data.wavetableSource` write the card's
    // <select> does (wavecel-table-actions), which the factory's poll loop
    // picks up and re-posts to the worklet.
    'wavecel-source-select-{n}': {
      kind: 'selector',
      tag: 'table',
      options: (node) => wavecelSourceOptions(node),
      value: (node) => wavecelSourceValue(node),
      onchange: (nodeId, value) => selectWavecelSource(nodeId, value),
    },
    // The built-in preset loader. ⚠ IT REPORTS REAL STATE, unlike the card's
    // `<select>`, which blanks itself the instant a load finishes and so never
    // shows what it loaded. `faces-parity` refuses that shape by name — it
    // picks an option and asserts the selection CHANGED, because a selector
    // that always reads the same thing is indistinguishable from a dead one.
    // The panel picture is the did-it-take feedback the card's reset was
    // standing in for.
    'wavecel-preset-select-{n}': {
      kind: 'selector',
      tag: 'preset',
      options: () => wavecelPresetOptions(),
      value: (node) => wavecelPresetValue(node),
      onchange: (nodeId, value) => { void loadWavecelPreset(nodeId, value); },
    },
    // The WAV importer — the same parse-and-write action as the card's file
    // input. ⚠ Its `{ status, error }` return is not decoration: the card
    // renders those two strings in `wavecel-upload-status` /
    // `wavecel-upload-error`, two affordances the def never declared, and the
    // `file` cell's contract carries them for free.
    'wavecel-wav-input-{n}': {
      kind: 'file',
      label: 'Load WAV...',
      title: 'Import a wavetable WAV (E352-style single-cycle frames)',
      accept: WAVECEL_WAV_ACCEPT,
      onFile: (nodeId, file) => loadWavecelWavFile(nodeId, file),
    },
  },
  analogVco: {
    // THE HERO PICTURE — one cycle of all five wave taps, drawn from the LIVE
    // knobs through the DSP's own tap laws, four as thin ghosts and MORPH in
    // the domain hue.
    //
    // ⚠ A PANEL RATHER THAN THE GLYPH, and the reason is a real defect in what
    // the glyph can say here. `glyphBinding` resolves any glyph + a primary
    // audio output to `live-audio`, and `primaryAudioOutPortId` takes the FIRST
    // declared audio output = `saw` — the one tap no control on this face
    // changes. That is fine at mini/compact (a live trace of the module
    // running) and wrong at the dock, which is exactly why `face.hero.cell`
    // suppresses `heroGlyph` there: a knob-INVARIANT trace beside a
    // knob-DERIVED picture teaches that they are the same thing.
    'analogvco-cycle-{n}': {
      kind: 'panel',
      label: 'single cycle · five taps',
      component: AnalogVcoHeroPanel,
      minWidth: 380,
      // A `text` probe on a DIFFERENT element: the plotted window is a PRIVATE
      // view setting in component state, so there is no node.data key to watch.
      // The button drives the axis caption, which prints the period the knobs
      // currently imply — a dead button cannot change it.
      probe: {
        testid: 'analogvco-cycle-window',
        action: 'click',
        effect: { kind: 'text', testid: 'analogvco-cycle-axis', expect: 'changed' },
      },
    },
  },
  clap: {
    // THE HERO VISUALISATION — the burst train and the room tail, promoted into
    // the faceplate's hero slot (`face.hero.cell`). A panel rather than a glyph
    // because it is not a trace of the output: it is a picture of the PATCH,
    // computed from the live knobs through the worklet's own control laws, so
    // it says what the voice WILL do before anything strikes it — which is what
    // a `scope` glyph on a silent rack cannot do, and why that glyph is
    // suppressed at the dock for a face that brings its own picture.
    //
    // ⚠ THERE IS NO `clap-strike` CELL. clap's audition is the `strike`
    // ParamDef the def already declares, rendered as a momentary <Button> via
    // `face.momentary` — the canonical press-param (graph/types cites
    // "tomtom/clap `strike`"), which keeps the pad inside faces-parity's param
    // multiset and makes `setMomentaryParam` the leak-proof write path. A
    // family cell here would be a second implementation of a control the def
    // already owns.
    'clap-hero-{n}': {
      kind: 'panel',
      label: 'burst + room',
      component: ClapHeroPanel,
      minWidth: 380,
      // A `text` probe on a DIFFERENT element, for the kickdrum reason: the
      // plot window is a PRIVATE view setting in component state, so there is
      // no node.data key to watch. The button drives the axis labels, which a
      // dead button cannot change — a stronger claim than a revision counter.
      probe: {
        testid: 'clap-graph-window',
        action: 'click',
        effect: { kind: 'text', testid: 'clap-graph-axis', expect: 'changed' },
      },
    },
  },
  cube: {
    // THE HERO PICTURE — cube's whole visualisation, promoted into the
    // faceplate's hero slot, and the SAME component the legacy card mounts
    // rather than a reduction of it.
    //
    // ⚠ THAT IDENTITY IS THE POINT. cube is "a solid and a cut": three
    // wavetables stacked into a 3-D density field, read by one movable plane
    // whose 256 samples ARE the waveform. The only surface anywhere that shows
    // the cut INSIDE the solid is the volume render, so a hero that reduced it
    // to a 2-D silhouette would be a second, weaker renderer to keep in step
    // with the DSP — the drift class this file's rule 1 exists for, one level
    // up. `cube/CubeVizSurface.svelte` is the one renderer; the card and this
    // hero are two mounts of it.
    //
    // THE PROBE IS THE ORBIT DRAG, and it is stronger than a data key would
    // be. The gesture writes `view_rot_x/y` — real params, which a panel probe
    // cannot observe (`readData` sees `node.data`, and `readParam` is not one
    // of the panel effects) — so the witness is the caption that PRINTS those
    // angles. A dead drag cannot move a printed angle, and the two testids
    // differ, which shell-cells.test.ts requires precisely so a control that
    // only relabels itself cannot pass.
    'cube-view-{n}': {
      kind: 'panel',
      label: 'the solid + the cut',
      component: CubeHeroPanel,
      minWidth: 320,
      probe: {
        testid: 'cube-3d-viz',
        action: 'drag',
        effect: { kind: 'text', testid: 'cube-hero-cam', expect: 'changed' },
      },
    },
    // THE THREE WAVETABLE SLOTS. Without this cell the shell face could not
    // change cube's tables AT ALL — they ride `node.data`, not params, so no
    // param cell can reach them. That is the DX7 defect verbatim (its PRESET
    // selector was `face.order[0]` and unreachable under `?shell=1`), which is
    // why this registry exists.
    'cube-table-stack-{n}': {
      kind: 'panel',
      label: 'floor · wall · ceiling',
      component: CubeTableStackPanel,
      minWidth: 300,
      // ⚠ A `data` PROBE, not a revision counter — it asserts the slot's SOURCE
      // actually changed. `cube-stack-floor-1` is the roster's second entry,
      // and cube-face-model.test.ts asserts that entry is NOT the floor's
      // default table, so the probe cannot be satisfied by a no-op write.
      probe: {
        testid: 'cube-stack-floor-1',
        action: 'click',
        effect: { kind: 'data', key: 'floor.source', expect: 'changed' },
      },
    },
  },
  clouds: {
    // THE RING BUFFER — two seconds of tape, the window POSITION reads from,
    // and one bar per concurrent grain. Promoted into the hero slot
    // (`face.hero.cell`).
    //
    // ⚠ A PANEL BECAUSE THE CONTROL IT EXPLAINS CANNOT BE A NUMBER. POSITION
    // moves the output waveform ENTIRELY (max|Δ| 0.99 against a marked source)
    // while moving its level by 0.17 dB, so every RMS-based instrument in the
    // repo — and three of the spec's own passes — reports it dead. What it
    // does is pick a PLACE on the tape, and a place wants a picture. The
    // `meter` glyph stays exactly right at the lane tiers (an insert's hazard
    // is how hot the wet cloud runs); `face.hero.cell` suppresses it at the
    // dock, where this says strictly more.
    //
    // ⚠ AND IT HAS NO CLOCK, DELIBERATELY. The one quantity a live write head
    // would need — the worklet's `fillLevel` — is not an AudioParam and is
    // never posted, so there is nothing honest to poll; anything derived from
    // `AudioContext.currentTime` would make the VRT baseline a race against
    // boot latency. Every pixel is a pure function of the six macros. The two
    // facts a moving head would have shown are printed as NUMBERS instead
    // (`silent for` / `full level at`, sidebar), where they are true without a
    // clock and MOVE with SIZE.
    'clouds-buffer-{n}': {
      kind: 'panel',
      label: 'the ring · 2 s of tape',
      component: CloudsRingPanel,
      minWidth: 380,
      // A `text` probe on a DIFFERENT element, the kickdrum/bluebox reason: the
      // axis MODE is private view state (component state, never node.data —
      // relabelling your own picture must not relabel a collaborator's screen
      // or dirty the patch), so there is no key to watch. The button drives the
      // axis row, whose captions carry a UNIT SUFFIX that differs
      // unconditionally between the two modes — asserted across the whole SIZE
      // travel in clouds-face-model.test.ts, so the probe cannot go vacuous at
      // some setting where the two labellings happen to coincide.
      probe: {
        testid: 'clouds-ring-scale',
        action: 'click',
        effect: { kind: 'text', testid: 'clouds-ring-axis', expect: 'changed' },
      },
    },
  },
  marbles: {
    // THE TWO LOOPS + THE QUANTISER RULER — promoted into the hero slot
    // (`face.hero.cell`).
    //
    // ⚠ A PANEL BECAUSE THE THREE THINGS IT SHOWS CANNOT BE KNOB POSITIONS.
    // LENGTH and X LENGTH are BIT-EXACTLY inert at DÉJÀ VU 0 (the shipped
    // default), so a dial reading `8` describes a loop that does not exist;
    // DÉJÀ VU's own maximum is its MIDDLE, so its position tells you nothing
    // about how locked the module is; and SCALE is inert below STEPS 0.536, so
    // the selected scale name is not evidence that any of it is in use. A row
    // that draws ONE slot, a fill that peaks at mid-travel, and a ruler with no
    // solid ticks say all three without a caption.
    //
    // ⚠ AND IT HAS NO CLOCK — no playhead, no analyser, no rAF. marbles
    // FREE-RUNS, so anything time-derived would make the VRT baseline a race
    // against boot latency. Every pixel is a pure function of the params
    // (`marblesLoopPlan`), which makes the tile deterministic on a running
    // graph, a frozen one and a silent rack alike — a stronger guarantee than
    // #1420's freeze, which this picture therefore does not depend on. (The
    // `meter` glyph at the LANE tiers does, and marbles is a witness for it.)
    'marbles-loop-{n}': {
      kind: 'panel',
      label: 'loops',
      component: MarblesLoopPanel,
      minWidth: 320,
      // A `text` probe on a DIFFERENT element, the clouds/kickdrum/bluebox
      // reason: the slot LABELLING is private view state (component state,
      // never node.data — relabelling your own picture must not relabel a
      // collaborator's screen or dirty the patch), so there is no key to watch.
      // The button drives the axis row, whose two labellings can NEVER coincide
      // — `time` always carries a unit suffix and `step` never does, asserted
      // over every slot at every rate in marbles-face-model.test.ts — so the
      // probe cannot go vacuous at some setting where they happen to agree.
      probe: {
        testid: 'marbles-loop-mode',
        action: 'click',
        effect: { kind: 'text', testid: 'marbles-loop-axis', expect: 'changed' },
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
      onFire: (nodeId, env) => { clearCloudseedTail(env, nodeId); },
      // The tank flush is an ENGINE MESSAGE, not a graph edit — there is no
      // param and no node.data to watch, which is exactly why this cell could
      // sit behind an assertion-free click for as long as it did.
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
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
      // ⚠ THIS IS THE CELL THE MISSING PROBE COST MOST. karplus's dock PLUCK
      // animates its press flash off the CLICK, not off `fireManualStrike`'s
      // return value (the legacy card honours it) — so the button flashed on a
      // string that was never plucked, and the sweep asserted only that the
      // button was enabled. `delivered` is precisely the boolean being thrown
      // away (face-redo ledger defect #22).
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
    },
  },
  rings: {
    // THE PICKUP COMB — the 24-partial bank under its cosine pickup, coloured
    // by which output tap each partial lands in, over the POSITION dial's whole
    // travel. Rank 7 on the face, the first rank a panel may legally hold.
    //
    // It is the one thing about this module def introspection cannot
    // synthesise, and the one surface that is ALIVE AT REST: rings is bit-
    // silent until struck (measured peak exactly 0.000e+0 on both taps with
    // nothing patched), so its `scope` glyph draws a flat line on a fresh
    // spawn while this picture already shows the body it is about to ring.
    'rings-comb-{n}': {
      kind: 'panel',
      label: 'pickup comb',
      component: RingsCombPanel,
      minWidth: 380,
      // A `text` probe for the ClapHeroPanel reason: the view flip is PRIVATE
      // component state (flipping your own plot must not re-draw a
      // collaborator's), so there is no node.data key to watch. The caption
      // names the view AND counts the partials the comb is suppressing, so a
      // dead button cannot change it.
      probe: {
        testid: 'rings-comb-view',
        action: 'click',
        effect: { kind: 'text', testid: 'rings-comb-caption', expect: 'changed' },
      },
    },
    // THE AUDITION, and on this module it is the difference between a
    // faceplate and a photograph. RINGS is a BODY, not a voice: with nothing
    // patched and nothing struck the output is not quiet, it is exactly zero
    // — the Float32Arrays are untouched — and before this PR the module could
    // not be struck from ANY surface. The legacy card had a MODEL button, six
    // faders and a jack field, and no way to make a sound.
    //
    // Fires the SAME host-side trigger source the card's new STRUM button
    // fires (manual-strike-actions → the factory's `manualTrigger` read key),
    // so there is one implementation and not two. `mode: 'trigger'` because
    // the DSP edge-detects STRUM and ignores how long the level stays high —
    // the port declares `edge: 'trigger'` and this honours it.
    'rings-strum-{n}': {
      kind: 'action',
      label: 'strum',
      title: 'Audition: strike the resonator once (identical to a strum rising edge)',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
    },
  },
  macrooscillator: {
    // THE HERO PICTURE — a short window of the CURRENT engine at the CURRENT
    // macros, OUT solid and AUX a ghost at ONE shared gain, computed from the
    // live knobs through the module's own pure-math mirror.
    //
    // ⚠ A PANEL RATHER THAN THE GLYPH, for a reason specific to this module.
    // The `scope` glyph is an analyser on `out`, and `out` is SILENT on five of
    // the fourteen engines with nothing patched into TRIG — plus it can never
    // show AUX, which is where half this module's confusion lives. The glyph
    // stays exactly right at mini/compact (a live trace of a running voice);
    // `face.hero.cell` suppresses it at the dock, where the derived picture
    // says strictly more.
    'macro-hero-{n}': {
      kind: 'panel',
      label: 'engine · out + aux',
      component: MacrooscillatorHeroPanel,
      minWidth: 380,
      // A `text` probe on a DIFFERENT element: the vertical scale is a PRIVATE
      // view setting in component state, so there is no node.data key to watch.
      // The button drives the caption (which prints the display gain), and a
      // dead button cannot change it.
      probe: {
        testid: 'macro-hero-scale',
        action: 'click',
        effect: { kind: 'text', testid: 'macro-hero-caption', expect: 'changed' },
      },
    },
    // THE AUDITION. Five of the fourteen engines initialise their excitation or
    // envelopes to ZERO (STRING/KICK/SNARE/HIHAT) or decay unconditionally and
    // never restart (FM 6OP), so with nothing patched into TRIG they are not
    // quiet, they are SILENT — and the dock offered six controls over a module
    // more than a third of which could not be sounded.
    //
    // Fires the SAME host-side trigger source the legacy card's button fires
    // (manual-strike-actions → the factory's `manualTrigger` read key), so
    // there is one implementation, not two. It takes the nodeId and not the
    // `env` handle: `fireManualStrike` resolves the live engine itself through
    // `getActiveEngine()`, which is what lets a Svelte card with no
    // ShellCellEnv share it.
    'macro-strike-{n}': {
      kind: 'action',
      label: 'strike',
      title:
        'Audition: strike the engine once (identical to a TRIG rising edge). Five of the fourteen engines are silent until something strikes them.',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
      // REQUIRED. An audition writes nothing to the graph, so `readParam` /
      // `readData` are structurally blind to it — the observable is the
      // audition ledger, which records per press whether the seam resolved a
      // callable off the live engine handle AND called it. `toBeEnabled()` +
      // `click()` pass on a dead button; this does not.
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
    },
  },
  kickdrum: {
    // THE HERO VISUALISATION — the amplitude + pitch-sweep graph and the output
    // meter beside it, promoted into the faceplate's hero slot (`face.hero
    // .cell`).
    //
    // A panel rather than a glyph because it is not a trace of the output: it
    // is a picture of the PATCH, computed from the live knob values through the
    // worklet's own envelope/frequency laws (kickdrum-face-model), so it says
    // what the voice WILL do before anything has struck it — which is exactly
    // what a `scope` glyph on a silent rack cannot do, and why that glyph is
    // suppressed at the dock for a face that brings its own picture.
    //
    // ⚠ THIS IS THE ONLY BESPOKE CELL THIS FACE NEEDS. Its sibling draft also
    // declared a `kickdrum-chain` panel for the right sidebar; the sidebar is
    // now DECLARED data on the face (`face.sidebar`) and painted by the shared
    // FaceSidebar, because a context column is something every faceplate wants
    // and a per-module component for it is how faces drift apart.
    'kickdrum-hero-{n}': {
      kind: 'panel',
      label: 'envelope + sweep',
      component: KickdrumHeroPanel,
      minWidth: 380,
      // The plot WINDOW is the panel's one writable affordance and its probe.
      //
      // ⚠ IT IS A `text` PROBE ON A DIFFERENT ELEMENT, deliberately. The window
      // is a PRIVATE VIEW setting — it lives in component state, not
      // `node.data`, so zooming your own plot does not re-zoom every
      // collaborator's screen or dirty the patch. So the probe drives the
      // button and asserts the AXIS LABELS moved: the axis is computed from the
      // window through the warp, and a dead button cannot change it. That is a
      // stronger claim than a revision counter, not a weaker one.
      probe: {
        testid: 'kickdrum-graph-window',
        action: 'click',
        effect: { kind: 'text', testid: 'kickdrum-graph-axis', expect: 'changed' },
      },
    },
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
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
    },
  },
  snaredrum: {
    // THE AUDITION, in TWO pads — because this voice has TWO strike inputs with
    // DIFFERENT declared edge semantics, and one button for both would be the
    // face contradicting the def about the thing the module exists for.
    // Both drive host-side ConstantSources on the module's own worklet inputs
    // (manual-strike-actions → the engine handle's read keys), so they write
    // NOTHING to the graph and a patched cable keeps working alongside them.
    'snaredrum-hit-{n}': {
      kind: 'action',
      label: 'hit',
      title: 'Audition: one snare hit (identical to a trigger_in rising edge)',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
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
      onGate: (nodeId, high) => { setManualGate(nodeId, high); },
      // A gate audition is asserted on BOTH edges by the sweep — the open must
      // deliver AND the close must deliver. A roll that opens and never closes
      // is the worst failure this seam has (manual-gate-latch.ts), and a
      // one-edge probe would be blind to exactly it.
      probe: { effect: { kind: 'audition', seam: 'manual-gate' } },
    },
  },
  meowbox: {
    // THE AUDITION. meowbox is BIT-SILENT with nothing patched — `g = 0` ⇒
    // `ampEnv = 0` ⇒ both channels are exactly zero — so without this the dock
    // offers four knobs over a voice that cannot be heard at all, and its `scope`
    // glyph is a flat line on every screenshot.
    //
    // ⚠ `mode: 'gate'`, NOT a one-shot, and this is the module's own most
    // mis-documented fact turned into an affordance. `ampEnv` is
    // `en.adsr(0.005, 0.05, 0.4, …)` (meowbox.dsp:109) — it SUSTAINS at 0.4 while
    // the gate is high and releases on the fall. The shared TRIGGER_PULSE_S is
    // 5 ms, so `fireManualStrike` here would release the envelope 5 ms into a
    // 400 ms tail and audition a blip rather than a meow. The def's `docs.inputs
    // .gate` claimed the opposite ("responds to the edge, not how long the level
    // stays up") until this PR; the port now declares `edge: 'gate'` and the pad
    // is the shape the port says it is.
    //
    // The factory answers `manualGate` and DELIBERATELY NOT `manualTrigger`
    // (see its `read`), so a caller reaching for the one-shot gets `undefined`
    // and the ledger records `delivered: false` rather than silently doing the
    // wrong thing.
    'meowbox-meow-{n}': {
      kind: 'action',
      mode: 'gate',
      label: 'meow',
      title: 'Audition: HOLD to gate the voice (identical to holding the gate input high)',
      onGate: (nodeId, high) => { setManualGate(nodeId, high); },
      // A gate audition is asserted on BOTH edges by the sweep — the open must
      // deliver AND the close must deliver. A gate that opens and never closes is
      // the worst failure this seam has, and a one-edge probe would be blind to
      // exactly it.
      probe: { effect: { kind: 'audition', seam: 'manual-gate' } },
    },
  },
  treeohvox: {
    // THE AUDITION, and this one was ORDERED BY THE DEF. `treeohvox.ts:125-137`
    // carries a note addressed to whoever authors this faceplate: its card's
    // gate pad reaches the dock ONLY while the module has no `face`, because an
    // un-faced dock full view renders the legacy card. The moment a face lands,
    // the dock renders the face instead and the pad disappears unless the face
    // ranks a gate cell of its own. That is the sixstrum defect verbatim — the
    // card's STRUM button always worked while the FACE offered twenty controls
    // over an instrument that could not be sounded — and this cell is the
    // instruction being carried out.
    //
    // MEASURED (#1658): with nothing patched and every pressable on the card
    // clicked, `audio_out` peaked at exactly 0.000e+0 over 145 frames, while
    // the same analyser read 3.390e-1 the moment a gate reached `gate_in`.
    //
    // ⚠ `mode: 'gate'`, and the def is emphatic about why. `gate_in` declares
    // `edge: 'gate'` and the processor acts on BOTH edges — rising starts the
    // note, FALLING ends it, so gate length IS note length. The shared one-shot
    // is a 5 ms pulse, which would end every auditioned note 5 ms after it
    // began. The factory answers `manualGate` and DELIBERATELY NOT
    // `manualTrigger`, so a caller reaching for the one-shot gets `undefined`
    // and the ledger records `delivered: false` — the honest answer, and
    // distinguishable from a press that never happened.
    //
    // ⚠ AND IT SOUNDS AN UN-ACCENTED NOTE, by design. The gate ConstantSource
    // is connected to worklet input 1 alone; driving the shared `silence`
    // source instead would also drive PITCH and ACCENT, transposing the voice
    // and latching an accent on every audition. So ACCENT does nothing on this
    // surface, which is the measured reason the face ranks it dock-only.
    'treeohvox-gate-{n}': {
      kind: 'action',
      mode: 'gate',
      label: 'gate',
      title: 'Audition: HOLD to sound the voice (identical to holding gate_in high)',
      onGate: (nodeId, high) => { setManualGate(nodeId, high); },
      // Both edges, for the reason the siblings give: a gate that opens and
      // never closes is a note that never ends, and a one-edge probe is blind
      // to exactly it.
      probe: { effect: { kind: 'audition', seam: 'manual-gate' } },
    },
  },
  pentemelodica: {
    // THE FIVE-VOICE PICTURE, promoted into the hero slot. It exists because
    // this faceplate is TABBED (eight bands trip DOCK_TAB_MIN_BANDS), so four
    // of the five voice strips are hidden at any moment and this is the ONE
    // place the whole instrument is visible.
    'pentemelodica-voices-{n}': {
      kind: 'panel',
      label: 'five voices',
      component: PentemelodicaVoicesPanel,
      minWidth: 420,
      // A `text` probe on a DIFFERENT element: the lane SELECTION is private
      // view state (component state, not node.data — a rack-mate must not have
      // their panel yanked), so there is no key to watch. Clicking lane 2 must
      // change the detail line, which is computed from the selected voice's
      // params. ⚠ At DEFAULTS all five voices are byte-identical, which is why
      // the detail line leads with the voice NUMBER — the probe has to fire on
      // a freshly spawned module, where nothing else about voice 1 and voice 2
      // differs.
      probe: {
        testid: 'pentemelodica-hero-lane-2',
        action: 'click',
        effect: { kind: 'text', testid: 'pentemelodica-hero-detail', expect: 'changed' },
      },
    },
  },
  sidecar: {
    // THE STATIC GAIN COMPUTER, as a picture — the follow-up the sidecar face
    // deferred (queue Q1b), and the one surface on this module that can carry a
    // SHAPE.
    //
    // ⚠ WHY A PANEL AND NOT A FIFTH READOUT. The face already prints four
    // derived values, and each answers one question at ONE operating point
    // because `FaceReadoutValue` is `(read) => string`. Three of the audit's
    // four findings (#1657) are not values:
    //   · THRESHOLD prints -18.00 dB while ducking begins at -27.02 dBFS, and
    //     the gap is TWO independent terms — the `|aL|+|aR|` detector sum
    //     (6.02 dB) and half the knee. `onset` prints their SUM; only two ticks
    //     on one axis say which of them moved.
    //   · RATIO's non-linearity is a slope, not a number.
    //   · Every main level that is not full scale, i.e. every real kick.
    //
    // ⚠ NOT PROMOTED TO `hero.cell`, and that is a decision rather than an
    // oversight. A hero cell MOVES its key into the hero slot and SUPPRESSES
    // the shell glyph at the dock — so it would demote THRESHOLD (the dial the
    // picture exists to explain) and drop the output meter. It ranks 7, the
    // first rank a panel can legally hold, and paints in the `detect` band.
    //
    // ⚠ IT EDITS NOTHING — no Knob, no Fader, no `control-<paramId>` testid,
    // no graph write. The cursor is a private VIEW setting in component state
    // (the dx7 operator-map rule: a rack-mate reading their own kick's level
    // must not drag yours, and a patch must not go dirty because someone
    // looked at it).
    'sidecar-curve-{n}': {
      kind: 'panel',
      label: 'transfer curve',
      component: SidecarTransferPanel,
      minWidth: 340,
      // A `text` probe, and it is the STRONG form available to a read-only
      // panel rather than a concession. There is no `node.data` key to watch
      // because there is deliberately nothing written; the alternative weak
      // form — a revision counter — would pass on a dead cursor that bumped it.
      // The caption reports the LEVEL under the pointer plus the reduction, the
      // sidechain's output and ENV at that level, all recomputed through the
      // shipping gain computer, so a plot that stopped tracking cannot change
      // it. The witness is a DIFFERENT element than the one driven (shell-cells
      // refuses `testid === effect.testid`): a control that only relabels
      // itself is a dead control.
      //
      // The cursor RESTS at full scale (the readouts' own `@ FS` reference), so
      // a click at the plot's centre — which is what the sweep does — lands 30 dB
      // away from it and the caption cannot fail to move for a rounding reason.
      probe: {
        testid: 'sidecar-curve-plot',
        action: 'click',
        effect: { kind: 'text', testid: 'sidecar-curve-cursor', expect: 'changed' },
      },
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
    // THE AUDITION, RECOVERED — the cell whose ABSENCE is the whole reason for
    // the sixstrum face re-do. The legacy card's ⟋ STRUM button drives
    // `read('manualTrigger')` on the factory handle; this registry held only the
    // preset selector and `face.order` had no strike key, so under `?shell=1`
    // the dock offered twenty controls over a voice that could not be sounded
    // at all. (Two repo comments — this file's karplus note and
    // manual-strike-actions' header — asserted the opposite; both are true
    // again now.)
    //
    // Fires the SAME host-side trigger source the card fires
    // (manual-strike-actions), so there is one implementation, not two. STRUM
    // #1 is normalled to all six, so a single press barres the whole chord,
    // rolled by STRUM and DIR — a complete performance gesture, not a test tone.
    'sixstrum-strum-{n}': {
      kind: 'action',
      label: 'strum',
      title: 'Audition: strum all six strings once (identical to a strum1 rising edge)',
      onFire: (nodeId) => { fireManualStrike(nodeId); },
      probe: { effect: { kind: 'audition', seam: 'manual-strike' } },
    },
  },
  warrensspectrum: {
    // THE 8-BAND FILTERBANK — and on this module the panel is not an
    // enrichment, it is the PRECONDITION for promoting the face at all.
    //
    // The bank's forty values (8 bands × cutoff/res/type/pan/send) live in
    // `node.data.wsBands`, deliberately NOT as ParamDefs: forty params would be
    // forty doc blobs and forty face cells, and the module's own plan calls one
    // addressable strip "the only honest way to fit this module". The
    // consequence is that the bank has exactly ONE editor — and until this cell
    // existed that editor was `WarrensspectrumCard.svelte`, which
    // `migrated(type)` removes from the lane AND the dock. Promoting without it
    // would have made the filterbank unreachable, which is the samsloop
    // failure with a live bank instead of an absent sample.
    //
    // ⚠ A PANEL, NOT A SELECTOR OR A GRID, because the thing being edited is a
    // PICTURE: eight bars whose height is each band's send into the main bus,
    // whose position is its cutoff, and whose collective pan is the ONLY stage
    // in the whole chain that makes a stereo image (`WsFilterBank.setPan` —
    // everything ahead of it, both engines included, is mono). No shared
    // primitive says that.
    //
    // ⚠ NOT the hero. `resynthLevel` — the bank's crossfade — defaults to 0
    // (divergence 4: adding the bank must not re-voice a rack saved before it
    // existed), so at spawn `finishSample` returns before the eight SVFs are
    // touched. A hero cell that is inert the moment the module appears is the
    // inertness-at-spawn refusal; it ranks immediately after its own enabler
    // instead.
    'ws-filterbank-{n}': {
      kind: 'panel',
      label: 'filterbank',
      component: WarrensspectrumBankPanel,
      minWidth: 380,
      // A `data` probe, not `data-rev` — the strong form. `wsBands` carries its
      // own revision counter (`wsBandsRev`, which the factory polls), so the
      // weak probe was available and is deliberately not used: a dead fader
      // that bumped the counter without editing a band would pass it. Dragging
      // the SEND fader must move band 1's actual send value.
      //
      // Band 1 is the panel's selection at mount (selection is component state,
      // the dx7 rule), so the probe addresses the band the faders are wired to
      // without the sweep having to click first.
      probe: {
        testid: 'ws-bank-fader-send',
        action: 'drag',
        effect: { kind: 'data', key: 'wsBands[0].send', expect: 'changed' },
      },
    },
  },

  timelorde: {
    // TAP TEMPO — set the rack's master tempo by ear.
    //
    // ⚠ AN ACTION, NOT A `face.momentary` PAD, and the distinction is not
    // stylistic. `momentary` is for a 0/1 press-PARAM that returns to rest (the
    // clap `strike` shape, ORed with a trigger input in the worklet). TAP is not
    // a param at all — it is a CALL into a `TapTempo` controller that, from the
    // second tap onward, writes the ordinary `bpm` param through the same
    // `setNodeParam` path the BPM control uses.
    //
    // ⚠ THE PROBE IS THE INTERESTING PART, AND THE OBVIOUS ONE IS VACUOUS. An
    // `audition` probe asks the ledger whether a callable resolved off the live
    // ENGINE HANDLE; TAP never touches the engine, so that probe would pass on a
    // dead button. `data-rev` is refused by name in this file (it passes on a
    // dead button that bumps a counter). And `data` would mean mirroring the
    // locked tempo onto `node.data` — a param's value in two places.
    //
    // So: a `param` probe on `bpm`, pressed TWICE. `TapTempo` needs two
    // timestamps to have an interval and returns null on the first press BY
    // DESIGN, so a single-press probe reads `bpm` unchanged and cannot tell "the
    // controller is warming up" from "this button is dead" — which is the
    // sixstrum defect exactly. Both fields (`kind: 'param'` and `presses`) were
    // added for this cell; see ShellActionProbe for the argument and for why the
    // presses are issued as one `clickCount` action rather than a loop.
    //
    // ⚠ WHATEVER GAP THE SWEEP HAPPENS TO PUT BETWEEN THE TWO PRESSES IS FINE,
    // and it is worth saying why rather than leaving a reader to worry: two
    // presses `n` ms apart lock `60000/n`, clamped to 10..300. A fast harness
    // pins 300, a slow one pins 10 — both are "changed", so the probe is honest
    // either way. The ONE hazard is a gap past `TAP_RESET_MS`, which starts a
    // fresh series and writes nothing; that is what the single-action press
    // requirement removes.
    'timelorde-tap-{n}': {
      kind: 'action',
      label: 'tap',
      mode: 'trigger',
      title:
        'Tap twice in time to set the tempo (Space taps it too while TIMELORDE is selected). '
        + 'Inactive while an external clock is patched into CLOCK IN — the measured tempo owns the BPM then.',
      probe: { presses: 2, effect: { kind: 'param', paramId: 'bpm', expect: 'changed' } },
      onFire: (nodeId) => { timelordeFaceTap(nodeId); },
    },
  },
  kria: {
    // THE STEP GRID — 7 lanes × 16 steps for the selected track, plus the
    // sixteen pattern slots on the same surface. This IS the module: its two
    // params (`bpm`, `running`) are both FALLBACKS that do nothing in the
    // default rack, because the auto-spawned TIMELORDE drives playback. So the
    // only two controls the PARAM system knows about are the two least
    // important controls on the instrument, and everything a player actually
    // plays lives in `node.data` — which is exactly the gap this registry
    // exists to close (the DX7 defect verbatim).
    //
    // ⚠ RANKED FIRST, VIA `face.hero.cell`, AND THAT COMBINATION IS LOAD-BEARING.
    // `module-face-lint` refuses a panel SELECTED at a lane tier (a panel
    // declares its own minWidth; a lane knob column is 46 px), which made a
    // panel's first legal rank 7 — unreachable for a module with three rankable
    // keys. PF-22's `laneOrder` drops `face.hero.cell` from the LANE roster
    // only, so a hero picture costs no lane rank and may rank first. kria is
    // named in PF-22's own comment as one of the two modules the old arithmetic
    // locked out of having a faceplate at all.
    //
    // ⚠ A `data` PROBE, NOT `data-rev`, and it is aimed at a cell that is live
    // in the SHIPPED default state. A fresh kria selects track 0 and the TRIG
    // lane (`coerceLane` defaults there), and step 0 / row 6 is the trig lane's
    // one lit row — so the probe's click toggles `trig[0]` on the default
    // surface with no setup. It watches the whole lane array rather than one
    // index so the assertion cannot be satisfied by a write that lands on a
    // different step.
    'kria-cell-{n}': {
      kind: 'panel',
      label: 'the grid',
      component: KriaGridPanel,
      // Sixteen columns is what makes this wide, and nothing else: 16 cells at
      // 16 px plus 15 two-px gaps plus the plate's own padding. Width EARNED by
      // a picture-you-edit, not spent on gray space.
      minWidth: 320,
      probe: {
        testid: 'kria-cell-0-6',
        action: 'click',
        effect: { kind: 'data', key: 'patterns.0.tracks.0.trig', expect: 'changed' },
      },
    },

    // ── THE TRACK BANDS. Every cell below reads and writes the SELECTED track,
    // which is why the selection lives in `node.data`: a cell's `value(node)`
    // receives the node and nothing else.
    'kria-loop-start-{n}': {
      kind: 'selector',
      tag: 'FROM',
      options: () => kriaLoopStartOptions(),
      value: (node) => kriaLoopStartValue(node),
      onchange: (nodeId, v) => kriaSetLoopStart(nodeId, v),
    },
    'kria-loop-length-{n}': {
      kind: 'selector',
      tag: 'LEN',
      options: () => kriaLoopLengthOptions(),
      value: (node) => kriaLoopLengthValue(node),
      onchange: (nodeId, v) => kriaSetLoopLength(nodeId, v),
    },
    'kria-time-division-{n}': {
      kind: 'selector',
      tag: 'DIV',
      options: () => kriaTimeDivisionOptions(),
      value: (node) => kriaTimeDivisionValue(node),
      onchange: (nodeId, v) => kriaSetTimeDivision(nodeId, v),
    },
    'kria-direction-{n}': {
      kind: 'selector',
      tag: 'DIR',
      options: () => kriaDirectionOptions(),
      value: (node) => kriaDirectionValue(node),
      onchange: (nodeId, v) => kriaSetDirection(nodeId, v),
    },
    'kria-mute-{n}': {
      kind: 'toggle',
      label: 'mute',
      value: (node) => kriaMuteValue(node),
      onchange: (nodeId, on) => kriaSetMute(nodeId, on),
    },

    // ── SCALE + ROOT are PATTERN-level: one setting for all four tracks.
    // `scale` was PRINTED on the card as a read-only text tag and editable
    // nowhere but a monome grid; `root` was not on the card at all.
    'kria-scale-{n}': {
      kind: 'selector',
      tag: 'SCALE',
      options: () => kriaScaleOptions(),
      value: (node) => kriaScaleValue(node),
      onchange: (nodeId, v) => kriaSetScale(nodeId, v),
    },
    'kria-root-{n}': {
      kind: 'selector',
      tag: 'ROOT',
      options: () => kriaRootOptions(),
      value: (node) => kriaRootValue(node),
      onchange: (nodeId, v) => kriaSetRoot(nodeId, v),
    },
  },

  // ── TWOTRACKS — two tape decks, eight non-param affordances ───────────────
  //
  // Four per reel, all of them messages rather than writes: the transport
  // one-shots and the tape export. The implementations live in
  // `twotracks-face-actions.ts` and the LEGACY CARD calls the same ones, so the
  // face and the card cannot drift about what a press does.
  //
  // ⚠ EVERY TRANSPORT CELL IS `mode: 'trigger'`, NOT `'gate'`. REC / PLAY /
  // STOP fire ONCE on the rising edge — they are commands, not held states — and
  // a `gate` consumer driven by a click would open and never close.
  //
  // ⚠ WHY THESE ARE AUDITIONS AND NOT `data` PROBES, since `transportState_a` is
  // right there on `node.data` and the registry says to prefer `data`. Measured:
  // that key is written when the WORKLET POSTS BACK, and the worklet posts from
  // `process()`. faces-parity boots `/rack` without passing the audio gate, so
  // the context never runs, `process()` is never called and no transport state
  // is ever mirrored — a `data` probe would be RED on a perfectly live button.
  // The audition asks what the runner can answer: did the press reach the seam.
  // The stronger claim is `twotracks.spec.ts`'s, and it drives real audio.
  twotracks: {
    // ── Reel A ──
    'twotracks-rec-a-{n}': {
      kind: 'action',
      label: 'rec',
      title: 'Record onto reel A from the head of the tape (layers instead of erasing when OVERDUB is on)',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'a', 'rec'); },
    },
    'twotracks-play-a-{n}': {
      kind: 'action',
      label: 'play',
      title: "Roll reel A from the loop window's START",
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'a', 'play'); },
    },
    'twotracks-stop-a-{n}': {
      kind: 'action',
      label: 'stop',
      title: 'Halt reel A — the tape is kept',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'a', 'stop'); },
    },
    // ⚠ `file-export`, NOT `engine-message`, AND THE ADJACENCY IS WHY. SAVE TAPE
    // sits in the SAME REEL BLOCK as REC on the SAME NODE, so a probe watching
    // `engine-message` here would be satisfied by somebody pressing REC — the
    // export could be completely dead and the gate would stay green. This is the
    // exact case samsloop's export comment warns about, and this module is the
    // layout it warns about.
    'twotracks-save-a-{n}': {
      kind: 'action',
      label: 'save tape',
      title: "Export reel A's take as a stereo 48 kHz 16-bit WAV",
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'file-export' } },
      onFire: (nodeId) => { twotracksSaveTape(nodeId, 'a'); },
    },
    // ── Reel B ──
    'twotracks-rec-b-{n}': {
      kind: 'action',
      label: 'rec',
      title: 'Record onto reel B from the head of the tape (layers instead of erasing when OVERDUB is on)',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'b', 'rec'); },
    },
    'twotracks-play-b-{n}': {
      kind: 'action',
      label: 'play',
      title: "Roll reel B from the loop window's START",
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'b', 'play'); },
    },
    'twotracks-stop-b-{n}': {
      kind: 'action',
      label: 'stop',
      title: 'Halt reel B — the tape is kept',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { twotracksTransport(nodeId, 'b', 'stop'); },
    },
    'twotracks-save-b-{n}': {
      kind: 'action',
      label: 'save tape',
      title: "Export reel B's take as a stereo 48 kHz 16-bit WAV",
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'file-export' } },
      onFire: (nodeId) => { twotracksSaveTape(nodeId, 'b'); },
    },
  },

  // ── MATRIXMIX — the first META-DOMAIN face, and the zero-param case ────────
  //
  // Two cells, and they are the module's ENTIRE control surface: matrixMix
  // declares `inputs: []`, `outputs: []`, `params: []` and binds to no engine.
  // Its only persisted state is which two modules the cross-point grid is
  // looking at.
  //
  // ⚠ THESE ARE WHY THE FACE IS WORTH BUILDING AT ALL. A face that ranks
  // NOTHING is legal — `module-face-lint` puts it out of scope by name — and it
  // paints a BLANK lane tile, which is strictly worse than the placeholder it
  // replaces. These two answer the only question anybody has about a matrix node
  // at a glance (WHICH TWO MODULES) without opening the dock, which today costs
  // a full-view open because an un-migrated matrixMix renders a placeholder.
  //
  // ⚠ AND THEY REACH THE LANE, CHECKED RATHER THAN ASSUMED — it would be easy to
  // assume a shell cell is a dock thing, which would collapse the whole
  // argument. Only the `panel` kind is dock-only, by the NAMED rule in
  // `panelCellKeys` ("a 280 px SVG has no business being SELECTED into a 46 px
  // lane knob column"). `laneOrder` drops exactly two things — a declared
  // `hero.cell` and each `xyPads` entry's `x` key — and matrixMix declares
  // neither, so its full `order` survives to every tier. `matrixmix-face-model`
  // asserts the cells are PRESENT at every lane tier rather than that the face
  // merely resolves: the `joystick` shape is a face that ranks controls and
  // renders zero of them, and a two-cell face at the tightest tier is exactly
  // what could become that.
  //
  // ⚠ THE ROSTER IS A FUNCTION, NOT A LIST, AND THAT IS THE POINT. `options` is
  // evaluated per render against the LIVE patch, which is what makes a runtime
  // roster expressible as a face cell at all — see matrixmix-cell-actions.ts
  // for why the shipped "no shell face can render it" claim about cameraInput's
  // device picker does not generalise (the constraint is where the roster LIVES,
  // not that it is derived at runtime).
  matrixMix: {
    'matrixmix-x-{n}': {
      kind: 'selector',
      tag: 'X',
      options: (node) => matrixmixXAxisOptions(node),
      value: (node) => matrixmixXAxisValue(node),
      onchange: (nodeId, v) => matrixmixSetXAxis(nodeId, v),
    },
    'matrixmix-y-{n}': {
      kind: 'selector',
      tag: 'Y',
      options: (node) => matrixmixYAxisOptions(node),
      value: (node) => matrixmixYAxisValue(node),
      onchange: (nodeId, v) => matrixmixSetYAxis(nodeId, v),
    },
  },
  midiclock: {
    // CONNECT MIDI — the permission gesture, and the reason this module's face
    // is worth more than a re-skin. Web MIDI shows NO device until the browser
    // consents, so before this press midiclock has no stream, no device roster,
    // and four jacks sitting at rest: it is the first thing to do, on a module
    // that otherwise looks broken. Until promotion the only button that could
    // do it lived on the legacy card, and the default shell paints an
    // un-migrated module as a lane PLACEHOLDER — so granting access meant
    // finding and opening the dock full view first. An `action` cell is not
    // dock-restricted (only `panel` is, by `panelCellKeys`), so ranking this
    // key puts the gesture on the lane tile where the module is met.
    //
    // ⚠ IT TAKES ONLY A nodeId AND IGNORES `env`, deliberately — the
    // `fireManualStrike` idiom this file already documents twice. The gesture
    // needs a READ off the live handle (`read(node, 'card-api')`) and
    // `ShellCellEnv.engine` carries `write` and nothing else, so `env` could
    // not serve it even if it were passed. `getActiveEngine()` is the general
    // route and the module-owned action file resolves it there.
    'midiclock-connect-{n}': {
      kind: 'action',
      label: 'Connect MIDI…',
      title: 'Grant this site access to Web MIDI (one-time per origin), then pick a device in the dock',
      mode: 'trigger',
      // ⚠ AN AUDITION, NOT A `data` PROBE, AND NOT A STATE READ. The obvious
      // observable is `getState().connected` flipping false→true — and it is
      // the WRONG one, for the reason the twotracks block one entry up gives
      // about `transportState_a`: it depends on the machine, not the button. No
      // CI runner has a MIDI device or an origin that has granted MIDI, so
      // `connected` can never flip there and the probe would be RED on a
      // perfectly live control. The audition asks what the runner CAN answer —
      // did the press resolve a callable off the live engine handle and call it
      // — which is exactly the caller→seam gap this ledger exists to close.
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiclockConnect(nodeId); },
    },
  },

  // ── ES-9 — the HARDWARE LINK, and the only cells on a 22-PARAM face ───────
  //
  // Everything else this module has is an ordinary `ParamDef` that has been in
  // `contract-lock.txt` since it shipped. These two are the whole of what the
  // face needed a registry entry for, and they are here for the midiclock
  // reason one block up with one difference worth stating: this module is not
  // waiting on a browser PERMISSION, it is waiting on a PROCESS. The
  // es9-bridge companion app must be running on this machine, because Chromium
  // can only reach an ES-9's first stereo pair through getUserMedia. So there
  // is no prompt to grant and no roster to pick from — one bridge, one device,
  // `maxInstances: 1` — and the gesture is simply "dial the helper".
  //
  // ⚠ TWO CELLS WITH STATIC CAPTIONS, NOT ONE THAT FLIPS. The legacy card
  // renders CONNECT *or* DISCONNECT depending on state, and a single cell whose
  // label followed suit would be a caption that changes — the exact shape
  // `StatusLed`'s contract refuses at the call site, for the same reason: a
  // caption is the STATIC name of the thing, and a reader who has to re-read it
  // to know what state they are in is reading a readout. Both cells are always
  // present and neither is dead out of state: `restartEs9Bridge` on a node with
  // no entry CREATES one ("Connect must CONNECT — silently doing nothing here
  // is half of what made the button look dead", `bridge-owner.ts`), and
  // `stopEs9Bridge` on an already-stopped client is a no-op.
  es9: {
    'es9-connect-{n}': {
      kind: 'action',
      label: 'Connect',
      title: 'Dial the es9-bridge companion app on this machine and bring the hardware link up',
      mode: 'trigger',
      // ⚠ AN AUDITION, NOT A `data` PROBE. The connection lives in a
      // module-level registry keyed by node id, on GRAPH lifetime — it is not
      // a param and not a `node.data` key — so `readParam` and `readData` are
      // structurally blind to both gestures and a `data` probe would pass on a
      // dead button. And the obvious state read (`hasEs9Bridge` flipping) is
      // the WRONG observable for the midiclock reason: no CI runner has an
      // es9-bridge process listening, so it depends on the machine rather than
      // on the button. The audition asks what the runner CAN answer — did the
      // press resolve the live engine and this node, and reach the owner.
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { es9Connect(nodeId); },
    },
    'es9-disconnect-{n}': {
      kind: 'action',
      label: 'Disconnect',
      title: 'Drop the hardware link without deleting the node — frees the ES-9 for another client',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { es9Disconnect(nodeId); },
    },
  },

  // ── MIDI LANE — a ZERO-PARAM face, and the `entry` cell's FIRST adopter ────
  //
  // Every control this module has lives on `node.data`, so all ten of them are
  // static cells rather than params. That is what a zero-param face looks like
  // when the module genuinely has controls: `order: []` would have been legal
  // and would have painted a blank tile.
  //
  // ⚠ THE NOTE FIELD IS AN `entry` CELL, NOT A 128-OPTION ROSTER, and the
  // choice is forced from three directions rather than preferred:
  //
  //   1. `face-migration-inventory.test.ts`'s TYPED-ENTRY leg asks whether a
  //      faced module whose CARD types carries typed entry on its FACE, and
  //      answers it with `shellCellKindsFor(type)` — `'entry'` or `'panel'`.
  //      `MidiLaneCard.svelte` mounts `<input type="number">`, and the card
  //      SURVIVES promotion under `?shell=legacy`, so a roster here leaves that
  //      leg RED with no way to green it except editing the legacy card.
  //   2. WIDTH. Measured on the dock: `selector` 168 px, `entry` 72 px. Compact
  //      is the default and width must be earned; a roster earns none here.
  //   3. RANGE PARITY. A roster labelled by `noteNameForMidi` would carry 31
  //      BLANK labels — the speller returns `''` outside MIDI 12..108 — while
  //      the card's input reaches all of 0..127. The typed field reaches every
  //      value the card reaches and adds note names on top.
  //
  // ⚠ AND IT CLOSES A REAL GAP. `ShellEntryCell` shipped with #1509 alongside
  // its `TextEntry` primitive, its `ModuleShell` render branch and its pure-lane
  // probe check, and until this module NOTHING REGISTERED ONE — the branch was
  // reachable only through this registry. That is the `warped-fader` shape this
  // file warns about one screen down (a cell kind, a render branch and a source
  // gate that no control could reach), caught before it aged.
  midiLane: {
    // CONNECT — the same gesture, the same argument and the same probe as
    // midiclock's, one block up. This module is equally inert before the grant:
    // no device is visible, so all seven jacks sit at rest.
    'midi-lane-connect-{n}': {
      kind: 'action',
      label: 'Connect MIDI…',
      title: 'Grant this site access to Web MIDI (one-time per origin), then pick a device in the dock',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiLaneConnect(nodeId); },
    },
    // CHANNEL — a FIXED 17-entry roster (ALL + 1..16), built from
    // `MIDI_CHANNEL_COUNT` rather than written out. It is the one control the
    // module is really about, so it ranks second and reaches the lane tile.
    'midi-lane-channel-{n}': {
      kind: 'selector',
      tag: 'CH',
      options: () => midiLaneChannelChoices(),
      value: (node) => midiLaneChannelValue(node),
      onchange: (nodeId, v) => midiLaneSetChannel(nodeId, v),
    },
    // MODE — two states, and a SELECTOR rather than a TOGGLE deliberately.
    // MONO and POLY are two named alternatives, not an on/off: neither is the
    // absence of the other, and a switch would have to pick one as "off" and
    // print nothing for it.
    'midi-lane-mode-{n}': {
      kind: 'selector',
      tag: 'MODE',
      options: () => [
        { value: 'mono', label: 'MONO', title: 'PITCH and GATE follow one winning note' },
        { value: 'poly', label: 'POLY', title: 'PITCH and GATE stay quiet; take the chord off POLY' },
      ],
      value: (node) => midiLaneModeValue(node),
      onchange: (nodeId, v) => midiLaneSetMode(nodeId, v),
    },
    // THE BY-NOTE GATE'S NOTE — see the block header above.
    'midi-lane-note-{n}': {
      kind: 'entry',
      label: 'NOTE',
      title: 'Which note fires the NOTE jack — a note name (c2) or a MIDI number (0..127)',
      placeholder: 'c2',
      // Long enough for the longest accepted string (`a#-1` is 4, `127` is 3)
      // with room for a typo before the parser is consulted.
      maxLength: 8,
      text: (node) => midiLaneNoteText(node),
      // ⚠ IMPORTED, NEVER RE-TYPED. The grammar lives beside the engine that
      // consumes it so the card and the face cannot disagree about what the
      // user typed — the same one-source rule the warped fader's map obeys.
      parse: (t) => {
        const n = parseNoteGateNote(t);
        return n === null ? entryReject<number>() : entryAccept(n);
      },
      onCommit: (nodeId, v) => { midiLaneSetNote(nodeId, v); },
      probe: {
        // A note the module does NOT default to, so a write is visible against
        // the default 36 (GM kick). 38 is the GM snare.
        accepts: '38',
        // ⚠ THE REJECT LEG IS THE POINT, AND THIS STRING IS CHOSEN RATHER THAN
        // PICKED. `128` is one past the top of the 7-bit note space and is
        // EXACTLY what the engine's own `setNoteGateNote` would silently clamp
        // to 127. A cell that clamped would pass the `accepts` leg perfectly;
        // only this leg separates a validator from a funnel.
        rejects: '128',
        effect: { kind: 'data', key: 'noteGateNote', expect: 'changed' },
      },
    },
    // VOICE PRIORITY — three named behaviours, from the module's own
    // `VoicePriority` union so a roster entry the engine has no branch for is a
    // COMPILE error rather than a dead option.
    'midi-lane-priority-{n}': {
      kind: 'selector',
      tag: 'PRIO',
      options: () => midiLanePriorityOptions(),
      value: (node) => midiLanePriorityValue(node),
      onchange: (nodeId, v) => midiLaneSetPriority(nodeId, v),
    },
    // RETRIGGER — a genuine on/off (the gate either dips on a new note or it
    // does not), so a toggle is the honest primitive and the 52 px one.
    'midi-lane-retrig-{n}': {
      kind: 'toggle',
      label: 'RETRIG',
      value: (node) => midiLaneRetrigValue(node),
      onchange: (nodeId, on) => midiLaneSetRetrig(nodeId, on),
    },
    // ── THE CC TAPS ────────────────────────────────────────────────────────
    //
    // ⚠ FOUR CELLS, NOT TWO ROSTERS. The obvious-looking shape is a 129-entry
    // "which CC number" picker per tap; it is the wrong one twice over. It is
    // the DENSE-ROSTER trap (168 px each, and 129 options is a scroll rather
    // than a choice), and more importantly it is not what the module does:
    // which physical control sends which number is a property of the DEVICE,
    // so the affordance the card offers — and the only one that works without
    // the manual in your other hand — is "arm, then wiggle the thing".
    //
    // ⚠ AND CLEAR STAYS ITS OWN CELL. With no number picker there is no `NONE`
    // option for it to collapse into, so dropping it would delete the only way
    // to unassign a tap — a parity loss, not a simplification.
    //
    // ⚠ THE `WIGGLE…` CAPTION FLIP IS NOT PORTED. `ShellActionCell.label` is a
    // plain string, and a caption that changes with state is the shape the
    // resting-text ruling denies. The armed state is carried by the CC lamps in
    // the device strip, whose `detail` says which tap is listening; the
    // instruction the flipped caption used to give lives in `title` and in the
    // family's `docs.controls` prose. A real reduction at rest, named.
    'midi-lane-learn-a-{n}': {
      kind: 'action',
      label: 'LEARN A',
      title: 'Arm CC tap A — the next controller number that arrives on this lane binds to it',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiLaneLearnCcA(nodeId); },
    },
    'midi-lane-clear-a-{n}': {
      kind: 'action',
      label: 'CLEAR A',
      title: 'Unassign CC tap A so no controller drives the CC A jack',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiLaneClearCcA(nodeId); },
    },
    'midi-lane-learn-b-{n}': {
      kind: 'action',
      label: 'LEARN B',
      title: 'Arm CC tap B — the next controller number that arrives on this lane binds to it',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiLaneLearnCcB(nodeId); },
    },
    'midi-lane-clear-b-{n}': {
      kind: 'action',
      label: 'CLEAR B',
      title: 'Unassign CC tap B so no controller drives the CC B jack',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { midiLaneClearCcB(nodeId); },
    },
  },

  // ── LAUNCHPAD CONTROL — the SECOND meta-domain face, and the first whose
  //    whole control surface is gestures ────────────────────────────────────
  //
  // Two handshakes over one physical Novation pair: SINGLE binds one unit whose
  // role the dock's VIEW segment flips, PAIR runs the press-a-pad L/R split.
  // They are the module's only always-meaningful controls — BIND is a no-op
  // until a clip-player exists and the VIEW segment does not exist in pair mode,
  // so both live in the extension body (see that file).
  //
  // ⚠ BOTH LABELS ARE STATIC, AND THAT IS HONEST HERE RATHER THAN A COMPROMISE.
  // The legacy card flipped its captions to `Re-pair Launchpads` /
  // `Re-connect single` once a deployment was live, and `ShellActionCell.label`
  // is a plain string so a cell cannot. Nothing is lost, because the ACTION does
  // not change: pressing either one re-runs the same handshake from the top,
  // exactly as the card's second press did. That is the discriminator midiclock
  // states from the other side ("a fixed label because its action never
  // changes"), and it is why BIND — where the two presses do OPPOSITE things —
  // is not a cell.
  //
  // ⚠ THEY TAKE ONLY A nodeId AND IGNORE `env`. This module is `domain: 'meta'`
  // — no ports, no factory, no engine node — so `ShellCellEnv.engine` has
  // nothing to offer it. The gestures reach the launchpad-device singleton,
  // which is the module's actual handle.
  //
  // ⚠ AN AUDITION, AND `delivered: false` IS REACHABLE. See the header of
  // `$lib/ui/modules/launchpad-cell-actions.ts`: the press is recorded as
  // delivered when Web MIDI exists to be reached and NOT delivered when it does
  // not, which is the card's own first branch and the one condition under which
  // both buttons are genuinely wired to nothing. A `data` probe was not an
  // option in any case — this module writes to `node.data` zero times and must
  // keep doing so; every piece of its state is per-machine `localStorage` or
  // the device itself, deliberately (a physical device attached to one person's
  // machine is not a shared fact).
  launchpadControlLeft: {
    'launchpad-control-single-{n}': {
      kind: 'action',
      label: 'Connect single',
      title: 'Bind ONE Launchpad — the dock’s view segment flips it between the clip matrix and the command deck',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { launchpadConnectSingle(nodeId); },
    },
    'launchpad-control-pair-{n}': {
      kind: 'action',
      label: 'Pair Launchpads',
      title: 'Run the press-a-pad handshake over TWO Launchpads — the one you press becomes the LEFT (matrix) unit',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { launchpadPair(nodeId); },
    },
  },

  // ── PUSH 2 CONTROL — the THIRD meta-domain face, and the second device
  //    binder whose whole ranked surface is ONE gesture ───────────────────────
  //
  // The module is completely inert until Web MIDI is granted, and it declares
  // no ports at all — so before promotion its entire surface was reachable only
  // through the dock. This cell is what puts the gesture on the lane tile.
  //
  // ⚠ THE LABEL IS THE STATIC LITERAL `Connect Push 2`, WHERE THE CARD FLIPPED
  // TO `Re-connect Push 2` ONCE LIVE — and nothing is lost, because the ACTION
  // does not change. `connect()` does not branch: it calls `connectPush()` and
  // auto-binds, identically, in both states, so the `Re-` prefix carried one
  // bit about the MODULE'S STATE and nothing about the gesture. That is the
  // discriminator `midiclock` states from the other side ("a fixed label
  // because its action never changes"); the state bit is the PUSH lamp's job in
  // the extension body. BIND, by contrast, is NOT a cell precisely because its
  // two presses do OPPOSITE things.
  //
  // ⚠ IT TAKES ONLY A nodeId AND IGNORES `env`. This module is `domain: 'meta'`
  // — no ports, no factory, no engine node — so `ShellCellEnv.engine` has
  // nothing to offer it. The gesture reaches the push2-control singleton, which
  // is the module's actual handle.
  //
  // ⚠ AN AUDITION, AND `delivered: false` IS REACHABLE. See the header of
  // `$lib/ui/modules/push2-cell-actions.ts`: the press is recorded as delivered
  // when Web MIDI exists to be reached and NOT delivered when it does not,
  // which is the card's own first branch and the one condition under which the
  // button is genuinely wired to nothing. A `data` probe was not an option in
  // any case — this module writes to `node.data` ZERO times and must keep doing
  // so; the selected lane is `localStorage` and every other piece of its state
  // is a module-level rune or the device itself, deliberately (a physical
  // device attached to one person's machine is not a shared fact).
  push2Control: {
    'push2-control-connect-{n}': {
      kind: 'action',
      label: 'Connect Push 2',
      title: 'Grant this site Web MIDI and bind an Ableton Push 2 — pads, encoders and the eight lane buttons. The 960×160 screen is a separate WebUSB permission in the dock.',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { push2Connect(nodeId); },
    },
  },

  // ── ELECTRA CONTROL — the FOURTH meta-domain face, and the only one whose
  //    gesture leaves the browser carrying the rack's OWN LAYOUT ──────────────
  //
  // SEND TO ELECTRA generates a 3-page `.epr` preset plus a Lua bundle from the
  // whole rack and pushes them to a physical Electra One over sysex. Until
  // promotion the only button that could do it lived on the legacy card, and the
  // module is the `E` of the workflow pin trio — canvas-hidden, drawer-only — so
  // the gesture was reachable ONLY by opening the bottom drawer. An `action`
  // cell is not dock-restricted (only `panel` is, by `panelCellKeys`), so
  // ranking this key is what puts the flash on the lane tile of any canvas
  // instance as well.
  //
  // ⚠ IT IS THE ONE RANKED CELL BECAUSE IT IS THE ONLY ADDRESSABLE ONE, not
  // because the others lost a ranking argument. Every other control on this
  // module is a proxy of a param on a DIFFERENT node, and a face key resolves
  // only to a param on THIS def, a `<familyId>-{n}` template (one cell, no
  // per-member index — #1509), or a legend static. Thirty-six proxies and
  // thirty-six rename fields are unaddressable at any rank; they are the
  // extension body.
  //
  // ⚠ THE LABEL IS THE STATIC LITERAL `Send to Electra`, WHERE THE BUTTON
  // FLIPPED THROUGH FIVE WORDS (`Send to Electra` / `Configuring…` / `Electra ✓`
  // / `No MIDI`), AND NOTHING IS LOST — because the ACTION does not change.
  // Every press runs the same flow: stop the previous orchestrator, build a
  // host, run the autoconfig. The four other words carried the module's STATE,
  // not the gesture, and `ShellActionCell.label` is a plain string that cannot
  // say which of several things it is about to do. That is the discriminator
  // midiclock states from the other side ("a fixed label because its action
  // never changes"); the state bit lives on the extension body's status line and
  // on the accessible name, where the resting-text ruling puts it.
  //
  // ⚠ IT TAKES ONLY A nodeId AND IGNORES `env`. This module is `domain: 'meta'`
  // — no ports, no factory, no engine node — so `ShellCellEnv.engine` has
  // nothing to offer it. The gesture reaches the Electra broker + autoconfig,
  // which is the module's actual handle, and `getActiveEngine()` is how the host
  // reads the rack (the general route the module-owned action file resolves).
  //
  // ⚠ AN AUDITION, AND `delivered: false` IS REACHABLE. See the header of
  // `$lib/ui/modules/electra-cell-actions.ts`: the press is recorded as
  // delivered when Web MIDI exists to be reached and NOT delivered when it does
  // not, which is the autoconfig's own first branch (`broker.connect()` → `{ ok:
  // false, reason: 'no-midi-access' }`) and the one condition under which the
  // button is genuinely wired to nothing. A `data` probe was not an option in
  // any case: this node's `data.slots` is not touched by a flash at all — the
  // preset is generated FROM it and pushed outward — so a `data` probe would
  // fail on a perfectly live button, and a `data-rev` probe is the dead-button
  // hazard this file warns about two entries up.
  electraControl: {
    'electra-connect-button-{n}': {
      kind: 'action',
      label: 'Send to Electra',
      title: 'Generate a 3-page Electra One preset (Control Surface / MixMaster / System) from this rack and push it to a connected Electra. Asks for MIDI access on first click.',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { electraSendToDevice(nodeId); },
    },
  },

  // ── OUT TO LAUNCH — the FIRST VIDEO module whose ranked surface is a device
  //    gesture, and the fourth binder to reach this registry ────────────────
  //
  // The module drives nothing at all until a Launchpad is bound, and before
  // promotion BOTH halves of that binding were dock-only: `outToLaunch` is not
  // in `NON_SHELL_LANE_TYPES`, so its lane render was a `placeholder` and its
  // card existed only inside the dock full view. This cell moves the half that
  // needs a privilege onto the lane tile.
  //
  // ⚠ THIS CELL DOES NOT COMPLETE THE BINDING, WHERE THE THREE BEFORE IT DID.
  // `launchpadConnectSingle` binds, `push2Connect` auto-binds, `midiclockConnect`
  // attaches; this one grants a permission and enumerates. The full argument for
  // ranking it anyway is on `outToLaunchConnect` — in short, it is the only half
  // the browser gesture-gates, the other half is a per-machine roster that no
  // cell kind can express, and promotion therefore widens reach without
  // narrowing it anywhere.
  //
  // ⚠ AN AUDITION, AND `delivered: false` IS REACHABLE. The press is recorded as
  // delivered when Web MIDI exists to be reached and NOT delivered when it does
  // not — the card's own first branch, and the one condition under which the
  // button is genuinely wired to nothing. A `data` probe was never an option:
  // `bindMonitor` writes to `node.data` ZERO times by design, because the claim
  // lives in the device layer's node-keyed `monitors` map so that ONE map
  // arbitrates across both consumers of a physical surface.
  outToLaunch: {
    'out-to-launch-connect-{n}': {
      kind: 'action',
      label: 'Connect Launchpad',
      title: 'Grant this site Web MIDI and list the Launchpads attached to this machine — pick one on the faceplate to drive its 81 LEDs with the video',
      mode: 'trigger',
      probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      onFire: (nodeId) => { outToLaunchConnect(nodeId); },
    },
  },
  // ── THE CODE-BUFFER PAIR ───────────────────────────────────────────────
  //
  // LIVECODE and the CLOCKED RUNNER it spawns. Both declare `params: []`,
  // `inputs: []` and `outputs: []`, so every key their faces can rank arrives as
  // a family — and both have exactly ONE affordance that is not a text document,
  // which is what these two entries are. The buffers themselves ride each
  // module's `fullViewBody`, because `resolveFaceControl` resolves a key to a
  // param, a `-{n}` family or a legend static and a document is none of the
  // three.
  clockedRunner: {
    // THE DIVISION — the only thing about a runner that is a SETTING rather
    // than a program, and the only one that means anything on a 192 px lane
    // tile (a callback body is unreadable there; a rate is one word).
    //
    // ⚠ A SELECTOR, NOT A SEGMENTED PARAM, and the SELECTABILITY trap is not
    // what decides it. That trap is about a few-state DISCRETE PARAM drawn as a
    // knob — two reachable positions across the dial's whole travel — and there
    // is no param here at all: the division is `node.data`, written by the
    // runtime when `clocked()` spawns the runner and re-read by the factory on
    // every tick. What decides it is width and parity: nine divisions as a
    // segmented cell is toward the top of that kind's 94.3-430.9 px range,
    // a `selector` is a flat 168, and the LEGACY CARD's own affordance is a
    // `<select>` — so the parity-correct primitive and the narrow one coincide.
    'clocked-runner-division-{n}': {
      kind: 'selector',
      tag: 'DIV',
      options: () => clockedRunnerDivisionOptions(),
      value: (node) => clockedRunnerDivisionValue(node),
      onchange: (nodeId, v) => setClockedRunnerDivision(nodeId, v),
    },
  },
  livecode: {
    // RUN — and on this module the cell is not a convenience, it is where the
    // module's only behaviour now lives. `livecodeDef.factory` returns a no-op
    // handle, so every evaluation LIVECODE ever performed happened inside
    // `LivecodeCard.svelte`; `migrated(type)` stops both surfaces rendering a
    // promoted module's card, so leaving the gesture there would have deleted
    // the module. See `$lib/ui/modules/livecode-cell-actions.ts`.
    //
    // ⚠ A `data` PROBE, NOT AN AUDITION, because no seam is touched. An
    // audition witnesses "the press resolved a callable off the live engine
    // handle and called it"; a LIVECODE run compiles a string and writes the
    // patch graph, reaching no engine handle at all, so an `audition` record
    // would be a lie about what happened. This is `frametable-save-file`'s
    // situation one module over, and `lastRun` is the same shape as
    // `frametableSave`: an outcome record every exit writes, with `ok: false`
    // KEPT, so "never pressed" and "pressed and threw" stay distinguishable.
    //
    // ⚠ AND IT IS NOT A `data-rev` IN DISGUISE. `seq` is one FIELD of the
    // record rather than the observable: the probe compares the whole
    // `{ seq, ok, error, mutations, log }`, so a button that bumped a counter
    // and evaluated nothing would still have to fabricate an outcome to pass.
    // `seq` is there so a SECOND run of an identical script is observably a
    // second run, which a pure outcome record could not express.
    'livecode-run-{n}': {
      kind: 'action',
      label: 'Run',
      title: 'Evaluate the script and apply what it produced to the rack, in one undoable step',
      mode: 'trigger',
      probe: { effect: { kind: 'data', key: 'lastRun', expect: 'changed' } },
      onFire: (nodeId) => { runLivecodeNode(nodeId); },
    },
  },
};

/**
 * Cell kinds a PARAM control may resolve.
 *
 * ⚠ EXACTLY ONE, AND THE LIST EXISTS SO IT STAYS THAT WAY. Every other kind
 * here edits `node.data` and carries no `paramId`; handing one to a param
 * control would render a cell that writes somewhere the control does not point.
 * `warped-fader` is the only kind that BINDS A PARAM — it is a param cell whose
 * geometry the generic renderer cannot express — so it is the only one allowed
 * to cross.
 */
const PARAM_CELL_KINDS: ReadonlySet<string> = new Set(['warped-fader']);

/**
 * The cell spec for a curated control, or `null` when the module declares none
 * for that key (→ the shell renders an explicitly INERT cell, which both the
 * unit lint and the faces-parity e2e fail on). Pure.
 *
 * ⚠ THIS USED TO REFUSE EVERY `param` CONTROL OUTRIGHT — *"a param control never
 * routes here, the shell handles those generically"* — and that was TRUE until a
 * param-shaped cell kind existed. #2144 added `warped-fader`, which binds a
 * `paramId` by definition, and added its renderer branch to `ModuleShell`
 * WITHOUT touching this function. The result was a cell type, a render branch
 * and a source gate that **no control could ever reach**: the branch was dead
 * code from the day it merged.
 *
 * ⚠ NOTHING WAS RED. `module-face-lint`, the dock render-plan parity check and
 * `faces-parity` all passed, because a `warped-fader` param still resolves to a
 * perfectly valid GENERIC cell — it just renders the param LINEARLY, which is
 * precisely the geometry the cell exists to prevent. On samsloop that put unity
 * at 3/4 of the fader instead of the midpoint. The gate set could not see it
 * because every member asks "does this control render and operate", and it did.
 * The VRT dock baseline is what showed it: a KNOB where a fader was declared.
 */
export function shellCellFor(moduleType: string, ctl: FaceControl): ShellCell | null {
  const cell = SHELL_CELLS[moduleType]?.[ctl.key] ?? null;
  if (!cell) return null;
  // A param control takes only a param-shaped cell; everything else takes only
  // the non-param kinds. Both directions, so neither can silently borrow the
  // other's renderer.
  const isParamCell = PARAM_CELL_KINDS.has(cell.kind);
  if (ctl.kind === 'param') return isParamCell ? cell : null;
  return isParamCell ? null : cell;
}

/**
 * Is the cell this module registers under `faceKey` a PARAM-SHAPED one?
 *
 * Gate helper for the reachability sweep in `shell-cells.test.ts`: a module can
 * declare a param cell and rank its param, and every other gate stays green
 * while the shell renders the generic control — so the declaration has to be
 * checked against the real resolver. Pure.
 */
export function paramShapedCellKind(moduleType: string, faceKey: string): boolean {
  const cell = SHELL_CELLS[moduleType]?.[faceKey];
  return !!cell && PARAM_CELL_KINDS.has(cell.kind);
}

/** Every module type that registers at least one cell spec (gate helper). */
export function typesWithShellCells(): string[] {
  return Object.keys(SHELL_CELLS).sort();
}

/** The registered face keys for one module type (gate helper). */
export function shellCellKeys(moduleType: string): string[] {
  return Object.keys(SHELL_CELLS[moduleType] ?? {}).sort();
}

/** The KINDS one module registers, deduped and sorted. Used by the typed-entry
 *  parity leg in `face-migration-inventory.test.ts`, which asks whether a face
 *  carries the affordance its card has — a question about kinds, not keys.
 *  Pure. */
export function shellCellKindsFor(moduleType: string): string[] {
  const specs = SHELL_CELLS[moduleType] ?? {};
  return [...new Set(Object.values(specs).map((c) => c.kind))].sort();
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

/**
 * Every declared ACTION cell's PROBE, `moduleType → faceKey → probe`. Same
 * shape and the same reason as `shellPanelProbes`: the sweep stays
 * registry-driven off `STRICT_FACES` instead of growing a per-module branch,
 * and the module declares what its press must be observed to do.
 */
export function shellActionProbes(): Record<string, Record<string, ShellActionProbe>> {
  const out: Record<string, Record<string, ShellActionProbe>> = {};
  for (const [type, specs] of Object.entries(SHELL_CELLS)) {
    for (const [key, spec] of Object.entries(specs)) {
      if (spec.kind !== 'action') continue;
      (out[type] ??= {})[key] = spec.probe;
    }
  }
  return out;
}

/** Expose the shell-layer metadata the faces-parity e2e reads (dev/autotest
 *  builds only — the same `testHooksEnabled()` gate `__moduleSpecs` uses). */
/**
 * Every declared ENTRY probe, `moduleType → faceKey → probe`. Pure projection,
 * published to the page for the faces-parity sweep exactly like the panel and
 * action probes beside it — the sweep needs the module's own `accepts` /
 * `rejects` strings, because only the module knows what its domain excludes.
 */
export function shellEntryProbes(): Record<string, Record<string, ShellEntryProbe>> {
  const out: Record<string, Record<string, ShellEntryProbe>> = {};
  for (const [type, specs] of Object.entries(SHELL_CELLS)) {
    for (const [key, cell] of Object.entries(specs)) {
      if (cell.kind !== 'entry') continue;
      (out[type] ??= {})[key] = cell.probe;
    }
  }
  return out;
}

export function exposeShellPanelProbesForTests(): void {
  if (!testHooksEnabled()) return;
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellEntryProbes = shellEntryProbes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellPanelProbes = shellPanelProbes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellActionModes = shellActionModes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellActionProbes = shellActionProbes();
  exposeAuditionLedgerForTests();
}
