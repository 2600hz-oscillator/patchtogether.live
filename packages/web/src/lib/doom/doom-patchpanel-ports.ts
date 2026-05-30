// doom-patchpanel-ports.ts
//
// Builds the PortDescriptor section list DoomCard hands to PatchPanel after
// the migration off inline <Handle> markup (PR feat/doom-card-patchpanel-
// migration). Extracted from DoomCard.svelte so the shape contract — 28
// inputs split into 4 per-player sections + 9 outputs on the first section
// — is unit-testable without rendering Svelte.
//
// Each input section is one player (P1..P4); the local viewer's section gets
// a " (you)" suffix so the operator can read which gates drive THEIR marine
// at a glance. This replaces the inline #353 per-slot visual emphasis
// (.hidden-slot-port CSS class) — under PatchPanel every gate is still in
// the DOM (so cross-peer cables resolve + the io-spec invariant holds),
// just collapsed under the canonical corner trigger until the user opens
// the panel.
//
// Outputs (video OUT + stereo audio + 6 SP event gates) ride on the first
// section so PatchPanel's sectioned-output path picks them all up in the
// single right-column.
//
// Cheats section (2026-05-29): a final 5th section carries the two cheat-gate
// inputs (IDDQD / IDKFA). A rising edge on either gate injects the classic
// 5-char DOOM cheat code into the local player's WASM key queue (50 ms per
// char; god mode and all-keys/weapons/full-ammo respectively). The section is
// global (not per-player) because the cheats apply to the local viewer's
// `players[consoleplayer]` — same scope as if the player typed them into the
// card's keyboard-focused canvas.

import { CV_GATE_PORT_IDS, cvGatePortIdForSlot, DOOM_MP_SLOTS, type CvGatePortId } from '$lib/doom/doomkeys';
import { MONSTER_KILL_PORTS, PLAYER_DEATH_PORTS } from '$lib/doom/doom-death-ports';
import type { PortDescriptor } from '$lib/ui/patch-panel-labels';

/** Verbose labels for the 9 base gates — mirrors the historical inline glyphs
 *  (↑↓←→) for the cardinals, full-word for the action keys. ESC / ENTER added
 *  2026-05-29 so the in-game pause menu (ESCAPE) + select (ENTER) can be
 *  driven via CV. */
export const DOOM_BASE_GATE_LABELS: Record<CvGatePortId, string> = {
  up: '↑ UP',
  down: '↓ DOWN',
  left: '← LEFT',
  right: '→ RIGHT',
  space: 'SPACE (USE)',
  ctrl: 'CTRL (FIRE)',
  alt: 'ALT (STRAFE)',
  esc: 'ESC (MENU)',
  enter: 'ENTER (SELECT)',
};

/** Cheat-gate input ports — the IDDQD (god mode) + IDKFA (all keys/weapons/
 *  full ammo) gate handles. Rising edges trigger one 5-char keypress injection
 *  per gate (see packages/web/src/lib/doom/cheat-sequence.ts). Labels are
 *  uppercase-monospace to mirror the cheat strings the original game expects. */
export const DOOM_CHEAT_INPUTS: PortDescriptor[] = [
  { id: 'iddqd_in', label: 'IDDQD', cable: 'cv' },
  { id: 'idkfa_in', label: 'IDKFA', cable: 'cv' },
];

/** Output port descriptors — flat list rendered in the panel's right column.
 *  Order matches doomDef.outputs so a smoke test against the def can pin it.
 *  feat/doom-per-type-death-gates: per-monster-type kill rows + per-player
 *  death rows append after the legacy event gates. */
export const DOOM_OUTPUT_PORTS: PortDescriptor[] = [
  { id: 'out', label: 'OUT (VIDEO)', cable: 'video' },
  { id: 'audio_l', label: 'A-L', cable: 'audio' },
  { id: 'audio_r', label: 'A-R', cable: 'audio' },
  { id: 'evt_kill', label: 'KILL', cable: 'gate' },
  { id: 'evt_door', label: 'DOOR', cable: 'gate' },
  { id: 'evt_gun_p1', label: 'GUN1', cable: 'gate' },
  { id: 'evt_gun_p2', label: 'GUN2', cable: 'gate' },
  { id: 'evt_gun_p3', label: 'GUN3', cable: 'gate' },
  { id: 'evt_gun_p4', label: 'GUN4', cable: 'gate' },
  // Per-monster-type kill gates (typed alongside the any-monster KILL row).
  ...MONSTER_KILL_PORTS.map((p) => ({ id: p.portId, label: p.label, cable: 'gate' as const })),
  // Per-player death gates (P1..P4 die).
  ...PLAYER_DEATH_PORTS.map((p) => ({ id: p.portId, label: p.label, cable: 'gate' as const })),
];

export interface DoomPatchPanelSection {
  label: string;
  inputs: PortDescriptor[];
  outputs?: PortDescriptor[];
}

/** Build the sectioned PortDescriptor list DoomCard hands to PatchPanel.
 *
 *  @param mySlot The local viewer's active slot (0..3) or null when
 *                spectating. The matching section gets a " (you)" label
 *                suffix; all four sections always render so every gate is
 *                reachable (and so the io-spec invariant + cross-peer
 *                cable anchoring still hold).
 *
 *  Sections returned (in render order):
 *    1..4) Per-player CV gates (P1..P4) — 7 inputs each (movement + action + menu).
 *      First section also carries the 9 outputs.
 *    5)    Cheats — IDDQD / IDKFA. Global gates (act on the local player); a
 *          rising edge synthesises the 5-char cheat keypress sequence into
 *          the WASM key queue.
 */
export function buildDoomPatchPanelSections(mySlot: number | null): DoomPatchPanelSection[] {
  const playerSections: DoomPatchPanelSection[] = DOOM_MP_SLOTS.map((slot) => {
    const isLocal = slot === mySlot;
    const section: DoomPatchPanelSection = {
      label: `Player ${slot + 1}${isLocal ? ' (you)' : ''}`,
      inputs: CV_GATE_PORT_IDS.map((base) => ({
        id: cvGatePortIdForSlot(slot, base as CvGatePortId),
        label: DOOM_BASE_GATE_LABELS[base as CvGatePortId],
        cable: 'cv',
      })),
    };
    // Outputs live on the FIRST section so PatchPanel's sectioned-output
    // path renders them in the single right column.
    if (slot === 0) section.outputs = DOOM_OUTPUT_PORTS;
    return section;
  });
  const cheatSection: DoomPatchPanelSection = {
    label: 'Cheats',
    inputs: DOOM_CHEAT_INPUTS,
  };
  return [...playerSections, cheatSection];
}
