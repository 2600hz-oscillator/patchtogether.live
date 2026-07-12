// packages/web/src/lib/ui/modules-card-map.test.ts
//
// Guards for the GLOB-DRIVEN module-card resolver that replaced the
// hand-maintained `nodeTypes` import-list in Canvas.svelte.
//
//  1. Every registered module (audio/video/meta) resolves to a real card
//     component — so no module silently loses its card after the switch to
//     the glob + convention. EXPECTED_NODE_TYPES is the exact set the
//     hand-written map covered at the time of the migration; the glob must
//     reproduce it (no module dropped, none spuriously added).
//  2. The convention helper is correct (PascalCase(type)+Card).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Side-effect barrel imports so the registries are populated.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import { buildNodeTypes, conventionalCardName, type CardDefLike } from './modules-card-map';

// The exact module-type set the hand-written Canvas `nodeTypes` map covered
// at the time the glob resolver replaced it. The migration must be lossless:
// the glob-built map must resolve a card for every one of these (no more, no
// fewer). When you add a NEW module, add its type id here too — that's the
// one intentional touch (a single line in a test), NOT a shared registry edit.
const EXPECTED_NODE_TYPES = [
  '4plexvid', 'acidwarp', 'adsr', 'analogLogicMaths', 'analogVco', 'archivist',
  'attenumix', 'audioIn', 'audioOut', 'backdraft', 'bentbox',
  'blood', 'bluebox', 'buggles', 'callsine', 'cameraInput', 'cartesian',
  'charlottesEchos', 'chroma', 'chromakey', 'clap', 'clipplayer', 'clockedRunner', 'clouds',
  'cloudseed', 'cofefve', 'colorizer', 'colourofmagic', 'cube', 'delay', 'depolarizer', 'destroy', 'destructor',
  'dockscope',
  'doom', 'drummergirl', 'drumseqz', 'dx7', 'es9', 'fader', 'feedback', 'filter',
  'featurecv',
  'fourplexer', 'foxy', 'freezeframe', 'frogger', 'gamepad', 'gatemaiden', 'gibribbon', 'graphicEq', 'group',
  'hypercube', 'illogic', 'inwards', 'joystick', 'karplus', 'kickdrum', 'kria', 'lfo', 'lines', 'livecode', 'loopback',
  'ninelives',
  'luma', 'lumakey', 'lushgarden', 'macrooscillator', 'macseq', 'mandleblot', 'mappy', 'marbles', 'matrixMix', 'meowbox',
  'mandelbulb', 'midiCvBuddy', 'midiOutBuddy', 'midiclock', 'mixer', 'mixmstrs', 'modtris',
  'monoglitch', 'moog902', 'moog904a', 'moog911', 'moog921Vco', 'moogCp3', 'nibbles',
  'noise', 'numpadPlus', 'onetonine', 'painter', 'peakstate', 'peertube', 'picturebox', 'polyseqz', 'pong',
  'polarizer', 'posterbox', 'qbrt', 'rasterize', 'reshaper', 'resofilter', 'reverb', 'ringback', 'rings',
  'ruttetra', 'sampleHold', 'samsloop', 'scope', 'score', 'scoreboard',
  'scaler', 'sequencer', 'shapedramps', 'shapegen', 'shapes', 'shimmershine', 'sidecar', 'sourcery', 'spectrograph',
  'skifree', 'slewSwitch', 'snaredrum', 'stereovca', 'sticky',
  'tidyVco', 'tomtom',
  'swolevco', 'synesthesia', 'tempest', 'timelorde', 'treeohvox', 'tvLibrarian',
  'launchpadControlLeft',
  'unityscalemathematik', 'vca', 'vdelay', 'vfpgaRunner', 'videoMixer', 'videoOut',
  'videobox', 'videovarispeed', 'warrenspectrum', 'wavecel', 'wavesculpt',
  'twotracks', 'wavetableVco', 'writeseq', 'textmarquee', 'tiler', 'spirographs',
  'milkdrop',















































































































































































].sort();

function allDefs(): CardDefLike[] {
  return [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
}

// Modules that legitimately have NO flow-node card — rendered through a
// different path. CADILLAC is a meta module drawn as a full-canvas overlay
// (CadillacOverlay.svelte), never as a SvelteFlow node, so it was absent
// from the hand-written nodeTypes map too. Shared by the resolver test and
// the patch-surface invariant below.
const NO_CARD_BY_DESIGN = new Set(['cadillac']);

// The card component sources live next to this test in ./modules/*.svelte.
const CARDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'modules');

// A def carries its port arrays; the card resolver only needs `type`/`card`,
// so widen it here to count ports for the patch-surface invariant.
type PortfulDef = CardDefLike & {
  inputs?: readonly unknown[];
  outputs?: readonly unknown[];
};

describe('conventionalCardName()', () => {
  it('PascalCases the type and appends Card', () => {
    expect(conventionalCardName('analogVco')).toBe('AnalogVcoCard');
    expect(conventionalCardName('reverb')).toBe('ReverbCard');
    expect(conventionalCardName('moog921Vco')).toBe('Moog921VcoCard');
  });
});

describe('buildNodeTypes() (glob-driven card map)', () => {
  const nodeTypes = buildNodeTypes(allDefs());
  const resolved = Object.keys(nodeTypes).sort();

  it('resolves a card for exactly the expected module-type set (lossless migration)', () => {
    const dropped = EXPECTED_NODE_TYPES.filter((t) => !(t in nodeTypes));
    expect(dropped, `modules that lost their card: ${dropped.join(', ')}`).toEqual([]);
  });

  it('every resolved entry is a renderable component', () => {
    for (const [type, comp] of Object.entries(nodeTypes)) {
      expect(comp, `${type} card component`).toBeTruthy();
    }
  });

  it('every registered module (with a card) is covered — no straggler missing a card', () => {
    // A registered def whose card can't be resolved would silently render as
    // SvelteFlow's default node. Catch that here. (EXPECTED set == the cards
    // that exist today; any NEW registered module must ship a card + be added
    // to EXPECTED_NODE_TYPES.)
    const registered = allDefs()
      .map((d) => d.type)
      .filter((t) => !NO_CARD_BY_DESIGN.has(t))
      .sort();
    const missingCard = registered.filter((t) => !(t in nodeTypes));
    expect(
      missingCard,
      `registered modules without a resolvable card: ${missingCard.join(', ')}`,
    ).toEqual([]);
    // And the resolved set should not contain anything NOT registered.
    const extra = resolved.filter((t) => !registered.includes(t));
    expect(extra, `cards resolved for unregistered types: ${extra.join(', ')}`).toEqual([]);
  });
});

// LIGHTWEIGHT source-level invariant on the card patch surface.
//
// Post-#767 hard standard: a module card exposes its I/O through the shared
// drill-down <PatchPanel> (the yellow rear panel) — NOT raw side <Handle>
// jacks bolted onto the card. This guards that standard cheaply, at the
// source level, WITHOUT rendering every card (no per-module spec, no e2e):
// read each card's .svelte source once and assert two things.
//
//   (1) The card TEMPLATE renders no raw `<Handle>` tag. (We judge the
//       template, not the whole file: the migration convention documents the
//       ban in a `// NO raw <Handle> jacks` comment + type-only imports whose
//       names carry the word "Handle" — neither is a rendered jack, so a
//       whole-file substring scan would false-positive.)
//   (2) A card whose def declares ports (inputs+outputs > 0) references the
//       shared <PatchPanel> — i.e. its jacks live in the panel.
describe('card patch-surface invariants', () => {
  // Genuinely port-less special cases that correctly have NO PatchPanel and NO
  // jacks: a live-code editor, a clocked sub-runner, a paper sticky note. They
  // carry zero ports, so they draw neither a rear patch panel nor any handles.
  const NO_PATCH_PANEL_BY_DESIGN = new Set(['clockedRunner', 'livecode', 'sticky']);

  it('cards route I/O through PatchPanel and never render a raw <Handle> jack', () => {
    const rawJackOffenders: string[] = [];
    const missingPanelOffenders: string[] = [];

    for (const def of allDefs()) {
      const type = def.type;
      if (NO_CARD_BY_DESIGN.has(type)) continue;

      const cardName = def.card ?? conventionalCardName(type);
      const cardPath = join(CARDS_DIR, `${cardName}.svelte`);
      // A def with no resolvable card is caught by the resolver test above;
      // this invariant only judges cards that actually exist on disk.
      if (!existsSync(cardPath)) continue;

      const src = readFileSync(cardPath, 'utf8');
      // Strip <script> blocks + HTML comments so documentation prose (which
      // spells out the `<Handle>` ban) can't false-positive — judge the
      // rendered template only.
      const template = src
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');

      // (1) No raw jack rendered anywhere in the template.
      if (/<Handle[\s/>]/.test(template)) {
        rawJackOffenders.push(`${cardName} (${type})`);
      }

      // (2) A card with ports must route them through the shared PatchPanel.
      const portful = def as PortfulDef;
      const portCount = (portful.inputs?.length ?? 0) + (portful.outputs?.length ?? 0);
      if (portCount > 0 && !NO_PATCH_PANEL_BY_DESIGN.has(type) && !/PatchPanel/.test(src)) {
        missingPanelOffenders.push(`${cardName} (${type}, ${portCount} ports)`);
      }
    }

    expect(
      rawJackOffenders,
      `cards rendering a raw <Handle> jack instead of the shared PatchPanel: ${rawJackOffenders.join(', ')}`,
    ).toEqual([]);
    expect(
      missingPanelOffenders,
      `cards declaring ports but never referencing PatchPanel: ${missingPanelOffenders.join(', ')}`,
    ).toEqual([]);
  });
});
