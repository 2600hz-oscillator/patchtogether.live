// packages/web/src/lib/ui/workflow/sidebar-panels.ts
//
// PF-20 — the REGISTRY for `custom` dock-sidebar blocks.
//
// The other two sidebar kinds (`presets`, `readouts`) are pure
// data the shared renderer paints. `custom` is the escape hatch for the picture
// only the module can draw — a crossover split, a routing map, a scale ring —
// and it resolves THROUGH HERE so the escape hatch stays generic: a def
// declares a string id, never a component, so `face` remains serialisable data
// and the shell never imports a module.
//
// The precedent is PF-14's `ShellPanelCell` (shell-cells.ts), and the same two
// hard rules carry over:
//
//  1. A panel must NEVER emit `data-testid="control-<paramId>"`. faces-parity
//     asserts exact multiset equality between the dock's `control-*` testids
//     and the def's param ids, so a control-shaped testid inside a panel reads
//     as an unbacked extra control. (A sidebar panel is additionally rendered
//     OUTSIDE the ModuleShell subtree the gate scopes to, so it is doubly out
//     of reach — but the rule is stated because the day someone moves the
//     sidebar inside the shell, only this comment stands between them and a
//     red parity gate.)
//  2. A panel READS; it does not own state. It takes a nodeId and derives
//     everything from the live node + def.
//
// Adding a panel is: write the component, register it here, declare the id on a
// face. `module-face-lint` fails a `custom` block naming an unregistered id, so
// a typo cannot ship as a blank column.

import type { Component } from 'svelte';
import type { ParamDef } from '$lib/graph/types';
import AnalogLogicMathsTransferPanel from './panels/AnalogLogicMathsTransferPanel.svelte';
import FeaturecvMapsPanel from './panels/FeaturecvMapsPanel.svelte';
import FilterResponsePanel from './panels/FilterResponsePanel.svelte';
import IllogicRoutingPanel from './panels/IllogicRoutingPanel.svelte';
import MeowboxFormantBankPanel from './panels/MeowboxFormantBankPanel.svelte';
import NoiseTapsPanel from './panels/NoiseTapsPanel.svelte';
import StereoCrossoverPanel from './panels/StereoCrossoverPanel.svelte';
import SvfResponsePanel from './panels/SvfResponsePanel.svelte';

/** The props every sidebar panel takes: the node it describes, plus whatever
 *  primitives its block DECLARED. Keeping the module's numbers in the
 *  declaration rather than in the component is what makes a panel reusable —
 *  the picture is generic, the frequencies are the module's. */
export interface SidebarPanelProps {
  nodeId: string;
  props?: Readonly<Record<string, string | number>>;
  /**
   * The def's params.
   *
   * ⚠ A panel that reads a param MUST resolve the def DEFAULT when
   * `node.params` has no entry — that map is a sparse overlay of what has been
   * TOUCHED, not the module's state. Reading it bare made the crossover panel
   * print `WIDTH 0%` beside a dial reading 0.20 on a fresh spawn.
   */
  params?: readonly ParamDef[];
}

/** id → component. Keys are the strings a face's `custom` block declares. */
const SIDEBAR_PANELS: Readonly<Record<string, Component<SidebarPanelProps>>> = {
  // The MAGNITUDE RESPONSE of a resonant filter: the selected mode's curve at
  // the live cutoff/resonance, with the CV REACH window shaded behind it.
  // Generic across any def that declares the four param ids through the
  // block's `props` (see the component). It exists because the module's
  // `scope` glyph is a live trace of an INSERT's output — a flat line on a
  // silent rack — so the face had no picture that was alive at rest.
  'filter-response': FilterResponsePanel as unknown as Component<SidebarPanelProps>,
  // The STEREO CROSSOVER picture: below the split the signal is summed to
  // mono, above it the sides open by WIDTH. Generic across any def that
  // declares a crossover frequency + a width param through the panel's own
  // param-id resolution (see the component).
  'stereo-crossover': StereoCrossoverPanel as unknown as Component<SidebarPanelProps>,

  // THE FORMANT BANK: three resonance peaks over the four source partials on a
  // log axis, each peak drawn at its EFFECTIVE `a·Q` height.
  //
  // ⚠ IT IS A SIDEBAR BLOCK RATHER THAN A `hero.cell` FOR A STRUCTURAL REASON,
  // and it is worth stating here because it is the general answer to a wall two
  // faces have now hit. `module-face-lint` refuses a PANEL cell SELECTED at a
  // lane tier and the 'full' lane cap is SIX, so a panel's first legal rank is 7
  // — which a module with fewer than six other rankable keys can never reach.
  // meowbox has four params plus one audition. drummergirl (five params, no
  // audition) deferred its picture entirely over this. A `custom` sidebar block
  // carries NO `face.order` key and therefore no rank, so the constraint does
  // not apply to it at all.
  //
  // Not generic YET, and it says so rather than pretending: the component reads
  // meowbox's own thirteen-table crossfade. The day a second three-formant voice
  // wants this picture, the tables move behind a declared prop the way
  // `stereo-crossover` takes `splitHz`/`widthParam` — do that then, not now, on
  // one module's guess about the next one.
  'formant-bank': MeowboxFormantBankPanel as unknown as Component<SidebarPanelProps>,

  // THE THREE TAPS: white / pink / brown drawn as spectra RELATIVE to the white
  // tap on a log ruler, over a level ladder at the live LEVEL.
  //
  // ⚠ A SIDEBAR BLOCK FOR THE STRUCTURAL REASON ABOVE, IN ITS MOST EXTREME
  // FORM. A panel's first legal rank is 7 and NOISE HAS EXACTLY ONE RANKABLE
  // CONTROL, so no amount of re-ranking could ever put this picture in
  // `face.hero.cell`. meowbox reached the wall with five keys; noise cannot
  // approach it. The `custom` block carries no `face.order` key at all, which
  // is what makes a picture possible on the smallest module in the registry.
  //
  // ⚠ AND IT IS DRAWN, NEVER TRACED. NOISE is FREE-RUNNING — all three tables
  // start at factory time — so a live analyser would repaint every frame and
  // make the dock baseline a race against boot latency. Every point is a pure
  // function of the generators' own coefficients (`noise-face-model`), pinned
  // against a Welch PSD of the shipping generators in the unit lane.
  //
  // Not generic yet, and it says so: the component reads NOISE's own three-tap
  // model. moog903a and moog923 build their tables from the SAME
  // `noiseGenerators`, so they are the plausible second and third adopters —
  // widen it behind declared props then, not now, on one module's guess.
  'noise-taps': NoiseTapsPanel as unknown as Component<SidebarPanelProps>,

  // A TPT STATE-VARIABLE FILTER's delivered response: the selected tap's curve
  // at the live cutoff/resonance, complex-crossfaded with the dry path by MIX,
  // over the CUTOFF CV window.
  //
  // ⚠ IT DRAWS PHASE IN ALLPASS, and that is the reason it exists rather than a
  // detail of it. An SVF's allpass tap has unity magnitude at EVERY frequency
  // and EVERY resonance (measured span 0.00 dB across the whole dial), so a
  // magnitude-only picture draws a flat line for the one mode whose knob is
  // hardest to understand — a picture certifying that a live control is dead.
  //
  // Not fully generic yet, and it says how far: the param IDS come through the
  // block's `props` (pentemelodica's fourth tap is the same real notch and is
  // the plausible second adopter), but the DAMPING LAW `k = 2 − 2·res` is
  // resofilter's, imported from its DSP lib through `resofilter-face-model`.
  // Widen that behind a declared prop when a second module wants the picture —
  // not now, on one module's guess about the next one.
  'svf-response': SvfResponsePanel as unknown as Component<SidebarPanelProps>,

  // THE THREE FEATURE MAPS: one rail per CV output on the LIVE POLARITY's
  // range, with the rack's own generators marked where each lands.
  //
  // ⚠ IT EXISTS BECAUSE PROMOTION REMOVES A LIVE METER, AND IT IS DELIBERATELY
  // NOT THAT METER. `FeaturecvCard.svelte` pumps three bars off a worklet
  // `snapshot` each rAF; measured, that snapshot is the extractor's UNSMOOTHED,
  // always-UNIPOLAR target, so the bars disagree with the jacks they name (the
  // PUNCH bar reads 0.145 where the PUNCH jack sits at −0.703 at the shipped
  // BIPOLAR default) and are invariant to ATTACK and RELEASE. Rebuilding them
  // would have promoted a third, disagreeing view. Every point here is DRAWN
  // from the constants the worklet inlines, so the tile is deterministic on a
  // running graph, a frozen one and a silent rack alike — the `noise-taps`
  // argument, arrived at from the opposite direction (noise is free-running and
  // could not be traced; featurecv COULD be traced and should not be).
  //
  // Not generic yet, and it says so: the component reads featurecv's own three
  // feature maps. `synesthesia` publishes per-band versions of the same three
  // quantities and is the plausible second adopter; widen it behind declared
  // props then, not now, on one module's guess about the next one.
  'featurecv-maps': FeaturecvMapsPanel as unknown as Component<SidebarPanelProps>,

  // ILLOGIC's ROUTING MAP: four input lines, each through an attenuverter
  // triangle into the two mix buses, with a SECOND, lighter set of taps leaving
  // the RAW lines UPSTREAM of the triangles and running to the boolean jacks.
  //
  // ⚠ IT EXISTS FOR A FACT THAT IS UNPRINTABLE BY EVERY OTHER SURFACE ON THE
  // MODULE. Measured through the shipping factory: sweeping any attenuverter
  // its full −1 → +1 travel moves AND / NAND / OR / NOT by bit-exactly
  // 0.0000e+0, because the logic block thresholds the inputs BEFORE the
  // attenuverters. Four of ten jacks are behind none of the four knobs. A card
  // showing four faders above ten jacks says the opposite by implication, and
  // no readout, meter or knob label can correct it — only a drawing in which
  // the boolean taps visibly branch upstream.
  //
  // The second thing it draws is the RANKING: channels 1–2 are added in DIFF
  // and tapped by the logic block, channels 3–4 are subtracted there and reach
  // no boolean jack, which is why four apparently interchangeable knobs have an
  // intrinsic order (the `moog914` argument — an axis the module itself
  // supplies).
  //
  // DRAWN, never traced: every mark is the live params plus the structural
  // routing, so the tile is deterministic on a running graph, a frozen one and
  // a silent rack alike.
  //
  // Not generic yet, and it says so: the row set and the DIFF polarity come
  // from `illogic-face-model`. `analogLogicMaths` and the `moog9xx`
  // attenuverter family are the plausible second adopters; widen it behind
  // declared props then, not now, on one module's guess about the next one.
  'illogic-routing': IllogicRoutingPanel as unknown as Component<SidebarPanelProps>,
  // THE TRANSFER CURVE for ANALOGLOGICMATHS — one drawing for the one thing its
  // four readouts state but cannot show: SUM BENDS AND DIFF DOES NOT, and it is
  // the STRAIGHT line that crosses the ±1 rail. Both curves are traced under the
  // SAME common-mode drive the `sum` and `diff` readouts are stated at, so the
  // picture and the numbers beside it cannot disagree.
  //
  // This module's `glyph` is 'none' (five `cv` outputs, no `audio`, so
  // `primaryAudioOutPortId` returns null), which means the shell paints no tile
  // — the panel is the face's only picture.
  //
  // DRAWN, never traced: every mark is a pure function of the two live dial
  // values, so the tile is deterministic on a running graph, a frozen one and a
  // silent rack alike.
  //
  // Not generic yet, and it says so: the curve set and the clipped/linear split
  // come from `analog-logic-maths-face-model`. `sidecar`'s deferred
  // transfer-curve panel (queue Q1b) is the obvious second adopter; widen it
  // behind declared props then, not now, on one module's guess about the next.
  'alm-transfer': AnalogLogicMathsTransferPanel as unknown as Component<SidebarPanelProps>,
};

/** The component for a declared `custom` panel id, or `null`. */
export function sidebarPanelFor(panelId: string): Component<SidebarPanelProps> | null {
  return SIDEBAR_PANELS[panelId] ?? null;
}

/** Every registered panel id — the roster module-face-lint checks a declared
 *  `custom` block against. */
export function sidebarPanelIds(): string[] {
  return Object.keys(SIDEBAR_PANELS).sort();
}
