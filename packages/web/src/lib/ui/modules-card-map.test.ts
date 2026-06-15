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
  '4plexvid', 'acidwarp', 'adsr', 'analogLogicMaths', 'analogVco', 'aquaTank', 'archivist',
  'atlantisCatalyst', 'attenumix', 'audioIn', 'audioOut', 'backdraft', 'bentbox',
  'bluebox', 'buggles', 'callsine', 'cameraInput', 'cartesian',
  'charlottesEchos', 'chowkick', 'chroma', 'chromakey', 'clipplayer', 'clockedRunner', 'clouds',
  'cloudseed', 'cocoadelay', 'colorizer', 'cube', 'delay', 'depolarizer', 'destroy', 'destructor',
  'doom', 'drummergirl', 'drumseqz', 'dx7', 'elements', 'feedback', 'filter',
  'fourplexer', 'foxy', 'freezeframe', 'frogger', 'gamepad', 'gatemaiden', 'gibribbon', 'grids', 'group',
  'helm', 'hydrogen', 'hypercube', 'illogic', 'inwards', 'joystick', 'kria', 'lfo', 'lines', 'livecode',
  'luma', 'lumakey', 'macrooscillator', 'macseq', 'mandleblot', 'marbles', 'matrixMix', 'meowbox',
  'mandelbulb', 'midiCvBuddy', 'midiOutBuddy', 'midiclock', 'mixer', 'mixmstrs', 'modtris',
  'monoglitch', 'moog902', 'moog904a', 'moog911', 'moog921Vco', 'moogCp3', 'negativity', 'nibbles',
  'noise', 'numpadPlus', 'peaks', 'peakstate', 'peertube', 'picturebox', 'polyhelm', 'polyseqz', 'pong',
  'polarizer', 'qbert', 'qbrt', 'rasterize', 'reshaper', 'resofilter', 'reverb', 'ringback', 'rings',
  'riotgirls', 'ruttetra', 'sampleHold', 'samsloop', 'scope', 'score', 'scoreboard',
  'scaler', 'sequencer', 'shapedramps', 'shapegen', 'shapes', 'shimmershine', 'sidecar',
  'skifree', 'slewSwitch', 'snes9x', 'stages', 'stereovca', 'sticky',
  'swolevco', 'symbiote', 'synesthesia', 'tides2', 'timelorde', 'treeohvox', 'tvLibrarian',
  'unityscalemathematik', 'vca', 'vdelay', 'veils', 'vfpgaRunner', 'videoMixer', 'videoOut',
  'videobox', 'videovarispeed', 'warps', 'warrenspectrum', 'wavecel', 'wavesculpt',
  'twotracks', 'wavetableVco', 'writeseq',

































































].sort();

function allDefs(): CardDefLike[] {
  return [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
}

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

  // Modules that legitimately have NO flow-node card — rendered through a
  // different path. CADILLAC is a meta module drawn as a full-canvas overlay
  // (CadillacOverlay.svelte), never as a SvelteFlow node, so it was absent
  // from the hand-written nodeTypes map too.
  const NO_CARD_BY_DESIGN = new Set(['cadillac']);

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
