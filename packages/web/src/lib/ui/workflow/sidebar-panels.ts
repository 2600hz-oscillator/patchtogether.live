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
import FilterResponsePanel from './panels/FilterResponsePanel.svelte';
import MeowboxFormantBankPanel from './panels/MeowboxFormantBankPanel.svelte';
import NoiseTapsPanel from './panels/NoiseTapsPanel.svelte';
import StereoCrossoverPanel from './panels/StereoCrossoverPanel.svelte';

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
