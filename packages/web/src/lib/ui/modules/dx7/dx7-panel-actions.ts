// packages/web/src/lib/ui/modules/dx7/dx7-panel-actions.ts
//
// The WRITES behind the operator map + detail panel (dx7 PR 6).
//
// Every one of these is a single `mutateNode` transaction, for the same two
// reasons PR 5's preset stamp is: undo becomes ONE step, and collab sends ONE
// message instead of a burst the peer applies half-way.
//
// These helpers live HERE and not in `$lib/graph/mutate.ts` because they are
// purely module UI, not general graph mutation. (`mutate.ts` was also a
// collab-attest basis file, so adding to it reddened that attest and forced a
// re-attest; the attest was deleted 2026-08-17.)
//
// Every edit bumps `voiceRev`. The dx7 factory polls that counter and sends a
// NON-DESTRUCTIVE `{type:'voice'}` message, so an operator tweak morphs a held
// note instead of hard-retriggering it.

import { mutateNode } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import {
  dx7EditVoice,
  dx7OpOn,
  dx7PresetVoice,
  dx7VoiceRev,
} from '$lib/ui/modules/dx7-patch-actions';
import { copyEg, deepUnwrapVoice, setOpField, type Dx7OpField } from '$lib/audio/dx7-voice-edit';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import type { ModuleNode } from '$lib/graph/types';

export const DX7_OP_COUNT = 6;

/** The voice the panels edit — the edit buffer, falling back to the preset. */
export function dx7PanelVoice(node: ModuleNode | undefined): DX7Voice {
  return dx7EditVoice(node);
}

/** Per-operator mute flags, always length 6, missing entries reading as ON. */
export function dx7PanelOpOn(node: ModuleNode | undefined): boolean[] {
  return dx7OpOn(node);
}

/** Flip one operator's ON/OFF flag. */
export function dx7ToggleOp(nodeId: string, op: number): void {
  if (!Number.isInteger(op) || op < 0 || op >= DX7_OP_COUNT) return;
  mutateNode(nodeId, (live) => {
    const flags = dx7OpOn(live);
    flags[op] = !flags[op];
    if (!live.data) live.data = {};
    live.data.opOn = flags;
    live.data.voiceRev = dx7VoiceRev(live) + 1;
  });
}

/**
 * Set one operator field through `setOpField`, which RECOMPUTES the derived
 * values (`coarse`/`fine` → `ratio` + `fixedHz`, `detune` → `detuneFactor`).
 *
 * ⚠ Never write `op.coarse` directly from a component. The engine plays
 * `ratio`, so a direct write moves the pitch row and leaves the sound where it
 * was — a control lying about its own value, which is exactly the card-vs-def
 * failure class in CLAUDE.md.
 */
export function dx7SetOpField(
  nodeId: string,
  op: number,
  field: Dx7OpField,
  value: number | boolean,
): void {
  mutateNode(nodeId, (live) => {
    const next = setOpField(dx7EditVoice(live), op, field, value);
    if (!live.data) live.data = {};
    live.data.voice = next;
    live.data.voiceRev = dx7VoiceRev(live) + 1;
  });
}

/** Copy operator `from`'s envelope onto operator `to`. */
export function dx7CopyEgTo(nodeId: string, from: number, to: number): void {
  if (from === to) return;
  mutateNode(nodeId, (live) => {
    const next = copyEg(dx7EditVoice(live), from, to);
    if (!live.data) live.data = {};
    live.data.voice = next;
    live.data.voiceRev = dx7VoiceRev(live) + 1;
  });
}

/**
 * Throw away the edit buffer and go back to the stored preset.
 *
 * Re-stamps `params.algorithm`/`params.feedback` too: those are the
 * AUTHORITATIVE values the factory sends, so reverting only `data.voice` would
 * leave the engine wired to the edited algorithm while the panel drew the
 * original — the two halves of the same revert disagreeing.
 */
export function dx7RevertVoice(nodeId: string): void {
  mutateNode(nodeId, (live) => {
    const preset = dx7PresetVoice(live);
    if (!preset) return;
    const voice = deepUnwrapVoice(preset);
    if (!live.data) live.data = {};
    live.data.voice = voice;
    live.data.opOn = Array.from({ length: DX7_OP_COUNT }, () => true);
    live.data.voiceRev = dx7VoiceRev(live) + 1;
    live.params.algorithm = voice.algorithm;
    live.params.feedback = voice.feedback;
  });
}

/**
 * Append the edit buffer to `node.data.userPatches` under `name` and select it.
 *
 * Without STORE an edited voice can NEVER be saved or exported — the edit
 * buffer is the only copy and the next preset pick destroys it. That is why
 * the plan calls the patch-safety cluster non-optional.
 *
 * The name is trimmed to the DX7's own 10 characters; a blank or duplicate
 * name is rejected (returns false) rather than silently overwriting.
 */
export function dx7StoreVoice(nodeId: string, rawName: string): boolean {
  const name = String(rawName ?? '').trim().slice(0, 10);
  if (!name) return false;
  const node = patch.nodes[nodeId];
  const existing = ((node?.data as { userPatches?: DX7Voice[] } | undefined)?.userPatches ?? []).map(
    (v) => String((v as { name?: string }).name ?? ''),
  );
  if (existing.includes(name)) return false;

  mutateNode(nodeId, (live) => {
    const voice = { ...deepUnwrapVoice(dx7EditVoice(live)), name };
    if (!live.data) live.data = {};
    const list = ((live.data as { userPatches?: DX7Voice[] }).userPatches ?? []).slice();
    list.push(voice);
    live.data.userPatches = list;
    live.data.preset = name;
    live.data.voice = voice;
    live.data.voiceRev = dx7VoiceRev(live) + 1;
    live.params.algorithm = voice.algorithm;
    live.params.feedback = voice.feedback;
  });
  return true;
}

/**
 * The canonical FM-learning entry point: one carrier at full level, five silent
 * modulators, algorithm 1. `INIT + op mute` is how you learn what an operator
 * does, so this is a feature rather than a reset button.
 */
export function dx7InitVoice(nodeId: string): void {
  mutateNode(nodeId, (live) => {
    const voice = dx7InitVoiceData();
    if (!live.data) live.data = {};
    live.data.voice = voice;
    live.data.preset = DX7_INIT_NAME;
    live.data.opOn = Array.from({ length: DX7_OP_COUNT }, () => true);
    live.data.voiceRev = dx7VoiceRev(live) + 1;
    live.params.algorithm = voice.algorithm;
    live.params.feedback = voice.feedback;
  });
}

export const DX7_INIT_NAME = 'INIT VOICE';

/** The INIT voice, as pure data (exported so the unit test can pin it). */
export function dx7InitVoiceData(): DX7Voice {
  const op = (level: number) => ({
    r: [99, 99, 99, 99] as [number, number, number, number],
    l: [99, 99, 99, 0] as [number, number, number, number],
    level,
    coarse: 1,
    fine: 0,
    detune: 7,
    ratio: 1,
    detuneFactor: 1,
    velocitySens: 0,
    fixedMode: false,
    fixedHz: 0,
    // Keyboard scaling / rate scaling left at the DX7's own INIT defaults.
    breakPoint: 39,
    leftDepth: 0,
    rightDepth: 0,
    leftCurve: 0,
    rightCurve: 0,
    rateScale: 0,
    ampModSens: 0,
  });
  return {
    name: DX7_INIT_NAME,
    algorithm: 1,
    feedback: 0,
    // op1 (index 0) is algorithm 1's carrier; the rest sit at level 0 so the
    // INIT voice is a plain sine until you raise one.
    operators: [op(99), op(0), op(0), op(0), op(0), op(0)],
    pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
    lfo: { speed: 35, delay: 0, pmd: 0, amd: 0, sync: true, wave: 0, pms: 0 },
    transpose: 24,
    oscSync: true,
  } as unknown as DX7Voice;
}
