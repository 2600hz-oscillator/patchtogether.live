// packages/web/src/lib/ui/modules/sixstrum-preset-actions.test.ts
//
// The browser-free pre-gate for SIX STRUM's guitar / bass / harp PRESET RECALL
// — the ONE implementation the classic card's MODE knob and the RACKLINE shell's
// PRESET cell both call.
//
// What it pins (the properties that make it a RECALL rather than a relabelled
// tuning switch, and that keep the two call sites honest):
//   1. a recall stamps the WHOLE calibrated knob state, not just `tuning`;
//   2. every stamped key is a REAL sixstrum param (an orphan key would write a
//      phantom param nothing reads — a silent no-op recall);
//   3. it writes through the normal mutate seam, so it is UNDOABLE and shared;
//   4. the recalled values stay editable (a preset is a starting point);
//   5. the name↔index projection the shell chip and the card readout share.
// The DOM-level twin is e2e/tests/faces-parity.spec.ts ("sixstrum PRESET is a
// RECALL, not a relabelled tuning switch").

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import { sixstrumDef } from '$lib/audio/modules/sixstrum';
import {
  SIXSTRUM_MODE_NAMES,
  SIXSTRUM_MODE_PRESETS,
  applySixstrumPreset,
  selectSixstrumPreset,
  sixstrumModeIndex,
  sixstrumModeName,
  sixstrumPresetName,
  sixstrumSelectorOptions,
} from './sixstrum-preset-actions';

const NID = 'sixstrum-preset-test-node';

function makeNode(): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'sixstrum',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

const params = () => patch.nodes[NID]!.params as Record<string, number>;

beforeEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  undoManager.stopCapturing();
});

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
});

describe('sixstrum presets — the roster is REAL knob state', () => {
  it('every stamped key is a declared sixstrum param', () => {
    const declared = new Set(sixstrumDef.params.map((p) => p.id));
    const orphans: string[] = [];
    for (const [i, preset] of SIXSTRUM_MODE_PRESETS.entries()) {
      for (const key of Object.keys(preset)) {
        if (!declared.has(key)) orphans.push(`${SIXSTRUM_MODE_NAMES[i]}: '${key}'`);
      }
    }
    expect(orphans.join('\n'), 'preset writes a param that does not exist — a silent no-op').toBe('');
  });

  it('every stamped value is inside its param range', () => {
    const byId = new Map(sixstrumDef.params.map((p) => [p.id, p]));
    const bad: string[] = [];
    for (const [i, preset] of SIXSTRUM_MODE_PRESETS.entries()) {
      for (const [key, v] of Object.entries(preset)) {
        const p = byId.get(key)!;
        if (v < p.min || v > p.max) bad.push(`${SIXSTRUM_MODE_NAMES[i]}.${key}=${v} ∉ [${p.min},${p.max}]`);
      }
    }
    expect(bad.join('\n'), 'preset value out of the param range').toBe('');
  });

  it('all three modes stamp the SAME key set, and its `tuning` names the mode', () => {
    const keys = SIXSTRUM_MODE_PRESETS.map((p) => Object.keys(p).sort().join(','));
    expect(new Set(keys).size, 'the three modes are the same knobs at different values').toBe(1);
    for (const [i, preset] of SIXSTRUM_MODE_PRESETS.entries()) {
      expect(preset.tuning, `${SIXSTRUM_MODE_NAMES[i]} recalls its own string set`).toBe(i);
    }
  });
});

describe('applySixstrumPreset — a RECALL, not a tuning switch', () => {
  it('stamps the whole calibrated state (tuning AND the other knobs)', () => {
    makeNode();
    applySixstrumPreset(NID, 1); // BASS

    // the string set it names…
    expect(params().tuning).toBe(1);
    // …and everything else the mode IS.
    expect(params().register, 'the bass sits an octave down').toBe(-12);
    expect(params().ring, 'with a long dark ring').toBe(6);
    expect(params().strumSpread, 'and a near-block strum').toBe(0.07);
    expect(params().quality, 'voiced as power chords').toBe(6);
    // no key of the preset is left behind
    for (const [k, v] of Object.entries(SIXSTRUM_MODE_PRESETS[1]!)) {
      expect(params()[k], `bass preset stamped '${k}'`).toBe(v);
    }
  });

  it('a second recall REPLACES the first (guitar → harp lands harp)', () => {
    makeNode();
    applySixstrumPreset(NID, 0);
    expect(params().register).toBe(0);
    applySixstrumPreset(NID, 2);
    for (const [k, v] of Object.entries(SIXSTRUM_MODE_PRESETS[2]!)) {
      expect(params()[k], `harp preset stamped '${k}'`).toBe(v);
    }
  });

  it('the recall is UNDOABLE and the knobs stay editable afterwards', () => {
    makeNode();
    applySixstrumPreset(NID, 1);
    expect(params().ring).toBe(6);
    // close the capture window so the recall and the edit below are two
    // SEPARATE undo entries (the UndoManager otherwise coalesces writes made
    // inside its 500 ms capture timeout, exactly as it does for a knob gesture)
    undoManager.stopCapturing();

    // a preset is a STARTING POINT — the next knob turn commits over it
    setNodeParam(NID, 'ring', 3.25);
    expect(params().ring).toBe(3.25);

    // …and the whole stamp is on the undo stack (it went through the normal
    // mutate seam, so it is shared over collab too)
    undoManager.undo(); // the manual edit
    expect(params().ring).toBe(6);
    undoManager.undo(); // the recall
    expect(params().register, 'undo unwinds the recall itself').not.toBe(-12);
  });

  it('clamps + rounds an off-grid index instead of throwing', () => {
    makeNode();
    applySixstrumPreset(NID, 9.5);
    expect(params().tuning, 'past the end → the last mode').toBe(2);
    applySixstrumPreset(NID, -4);
    expect(params().tuning, 'before the start → the first mode').toBe(0);
  });

  it('a missing node is a safe no-op', () => {
    expect(() => applySixstrumPreset('no-such-node', 1)).not.toThrow();
    expect(patch.nodes['no-such-node']).toBeUndefined();
  });
});

describe('selectSixstrumPreset — the shell selector value space', () => {
  it('recalls by NAME', () => {
    makeNode();
    selectSixstrumPreset(NID, 'harp');
    expect(params().tuning).toBe(2);
    expect(params().register).toBe(7);
  });

  it('IGNORES an unknown name (never stamps guitar over the user’s knobs)', () => {
    makeNode();
    setNodeParam(NID, 'ring', 4.5);
    selectSixstrumPreset(NID, 'sitar');
    expect(params().ring, 'an unknown mode changes nothing').toBe(4.5);
    expect(params().register).toBeUndefined();
  });

  it('the roster options round-trip through the name projection', () => {
    const opts = sixstrumSelectorOptions();
    expect(opts.map((o) => o.value)).toEqual([...SIXSTRUM_MODE_NAMES]);
    makeNode();
    for (const opt of opts) {
      selectSixstrumPreset(NID, String(opt.value));
      expect(sixstrumPresetName(patch.nodes[NID] as ModuleNode), `chip reads back '${opt.value}'`).toBe(opt.value);
    }
  });
});

describe('the name projection shared by the card readout and the shell chip', () => {
  it('maps an index to its mode name, clamping out-of-range', () => {
    expect(sixstrumModeName(0)).toBe('guitar');
    expect(sixstrumModeName(1)).toBe('bass');
    expect(sixstrumModeName(2)).toBe('harp');
    expect(sixstrumModeName(1.4), 'a mid-drag value rounds').toBe('bass');
    expect(sixstrumModeName(-1)).toBe('guitar');
    expect(sixstrumModeIndex(7)).toBe(2);
  });

  it('an un-parameterized node reads as the default mode', () => {
    expect(sixstrumPresetName(undefined)).toBe('guitar');
    makeNode();
    expect(sixstrumPresetName(patch.nodes[NID] as ModuleNode)).toBe('guitar');
  });
});
