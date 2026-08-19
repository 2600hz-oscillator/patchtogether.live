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
import AnalogVcoHeroPanel from '$lib/ui/modules/AnalogVcoHeroPanel.svelte';
import BlueboxToneBankPanel from '$lib/ui/modules/BlueboxToneBankPanel.svelte';
import ClapHeroPanel from '$lib/ui/modules/ClapHeroPanel.svelte';
import CubeHeroPanel from '$lib/ui/modules/cube/CubeHeroPanel.svelte';
import CubeTableStackPanel from '$lib/ui/modules/cube/CubeTableStackPanel.svelte';
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
    | { kind: 'data-rev'; key: string };
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
export function exposeShellPanelProbesForTests(): void {
  if (!testHooksEnabled()) return;
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellPanelProbes = shellPanelProbes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellActionModes = shellActionModes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__shellActionProbes = shellActionProbes();
  exposeAuditionLedgerForTests();
}
