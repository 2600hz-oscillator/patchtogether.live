// doom-patchpanel-ports.test.ts
//
// Pins the PatchPanel section shape DoomCard hands off to the canonical
// PatchPanel component after the migration from inline <Handle> markup.
// The card has 45 handles (36 inputs + 9 outputs) — well past the legible
// inline threshold — and now collapses them under the standard corner
// trigger used by ~75 other cards.

import { describe, it, expect } from 'vitest';
import {
  buildDoomPatchPanelSections,
  DOOM_OUTPUT_PORTS,
  DOOM_BASE_GATE_LABELS,
} from './doom-patchpanel-ports';
import { doomDef } from '$lib/video/modules/doom';
import { CV_GATE_PORT_IDS, cvGatePortIdForSlot } from './doomkeys';

describe('buildDoomPatchPanelSections — shape contract', () => {
  it('emits 4 per-player sections (P1..P4) regardless of mySlot', () => {
    for (const slot of [null, 0, 1, 2, 3]) {
      const sections = buildDoomPatchPanelSections(slot);
      expect(sections).toHaveLength(4);
      expect(sections.map((s) => s.label.startsWith('Player '))).toEqual([true, true, true, true]);
    }
  });

  it('renders 36 input ports total (4 slots × 9 gates) with cable=cv', () => {
    const sections = buildDoomPatchPanelSections(0);
    const allInputs = sections.flatMap((s) => s.inputs);
    expect(allInputs).toHaveLength(4 * CV_GATE_PORT_IDS.length);
    expect(allInputs).toHaveLength(36);
    for (const input of allInputs) {
      expect(input.cable).toBe('cv');
      // Every input id is a real per-slot gate id (p1_up, p2_left, …, p4_enter).
      expect(input.id).toMatch(/^p[1-4]_(up|down|left|right|space|ctrl|alt|esc|enter)$/);
    }
  });

  it("labels the local player's section ' (you)' so the operator can spot their slot", () => {
    for (const me of [0, 1, 2, 3]) {
      const sections = buildDoomPatchPanelSections(me);
      for (const [idx, section] of sections.entries()) {
        if (idx === me) expect(section.label).toBe(`Player ${idx + 1} (you)`);
        else expect(section.label).toBe(`Player ${idx + 1}`);
      }
    }
  });

  it("labels NO section ' (you)' for a spectator (mySlot null)", () => {
    const sections = buildDoomPatchPanelSections(null);
    for (const section of sections) {
      expect(section.label).not.toMatch(/\(you\)/);
    }
  });

  it('renders the full output set on section 0 in def declaration order', () => {
    const sections = buildDoomPatchPanelSections(0);
    expect(sections[0]!.outputs).toBeDefined();
    // Output count == doomDef.outputs length (includes per-monster +
    // per-player death gates added in feat/doom-per-type-death-gates).
    expect(sections[0]!.outputs).toHaveLength(doomDef.outputs.length);
    // Subsequent sections carry no outputs (single right-column path).
    expect(sections[1]!.outputs).toBeUndefined();
    expect(sections[2]!.outputs).toBeUndefined();
    expect(sections[3]!.outputs).toBeUndefined();
    // Output ids match doomDef.outputs declaration order exactly so any
    // future def edit shows up here AND fails this test.
    expect(sections[0]!.outputs!.map((o) => o.id)).toEqual(doomDef.outputs.map((o) => o.id));
  });

  it('total handle count = 36 inputs + N outputs (one per doomDef output)', () => {
    const sections = buildDoomPatchPanelSections(0);
    const inputs = sections.flatMap((s) => s.inputs);
    const outputs = sections.flatMap((s) => s.outputs ?? []);
    expect(inputs.length).toBe(36);
    expect(outputs.length).toBe(doomDef.outputs.length);
  });

  it('uses the historical inline glyphs (↑↓←→) for cardinal direction labels', () => {
    expect(DOOM_BASE_GATE_LABELS.up).toContain('↑');
    expect(DOOM_BASE_GATE_LABELS.down).toContain('↓');
    expect(DOOM_BASE_GATE_LABELS.left).toContain('←');
    expect(DOOM_BASE_GATE_LABELS.right).toContain('→');
    expect(DOOM_BASE_GATE_LABELS.space).toContain('USE');
    expect(DOOM_BASE_GATE_LABELS.ctrl).toContain('FIRE');
    // ESC / ENTER (2026-05-29) — menu controls.
    expect(DOOM_BASE_GATE_LABELS.esc).toContain('ESC');
    expect(DOOM_BASE_GATE_LABELS.enter).toContain('ENTER');
  });

  it('output ports carry their cable types for PatchPanel color stripes', () => {
    // The default cable for an output without an explicit one is 'audio';
    // we pin the real types so an accidental drop of e.g. video → audio
    // shows up here.
    const cables = Object.fromEntries(DOOM_OUTPUT_PORTS.map((p) => [p.id, p.cable]));
    expect(cables['out']).toBe('video');
    expect(cables['audio_l']).toBe('audio');
    expect(cables['audio_r']).toBe('audio');
    expect(cables['evt_kill']).toBe('gate');
    expect(cables['evt_door']).toBe('gate');
    expect(cables['evt_gun_p1']).toBe('gate');
    expect(cables['evt_gun_p4']).toBe('gate');
  });

  it('input ids match the def-declared per-slot gate ids (no drift)', () => {
    const sections = buildDoomPatchPanelSections(0);
    const allInputIds = sections.flatMap((s) => s.inputs.map((p) => p.id));
    // Expected = same order as doomDef.inputs (slot-major, base-minor).
    const expected: string[] = [];
    for (const slot of [0, 1, 2, 3]) {
      for (const base of CV_GATE_PORT_IDS) {
        expected.push(cvGatePortIdForSlot(slot, base));
      }
    }
    expect(allInputIds).toEqual(expected);
    // And the def must agree.
    expect(allInputIds).toEqual(doomDef.inputs.map((p) => p.id));
  });
});
