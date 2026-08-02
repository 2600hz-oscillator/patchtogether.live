// packages/web/src/lib/ui/modules/kickdrum-preset-actions.ts
//
// KICK DRUM's PRESET RECALL — the five voices the design mock lists down the
// right sidebar (DEEP CLUB 50 Hz / TECHNO PUNCH hard / 909 CLASSIC 62 Hz /
// SUB BOOM 38 Hz / LO-FI THUMP crush), and the mock's own requirement that they
// SELECT rather than decorate.
//
// THE STAMP goes through the NORMAL param commit path (`setNodeParam`), exactly
// as sixstrum's mode recall does: every recalled value is an ordinary param
// write, so it is undoable, shared over collab, pushed to the worklet by the
// same code a hand-turned knob uses, and instantly editable afterwards. A
// preset here is a STARTING POINT, never a lock.
//
// WHY THE CHOSEN ID IS ALSO WRITTEN TO `node.data`. sixstrum can read its
// active preset back off a single param (`tuning` IS the mode), so it stores
// nothing. This voice has no such param — five presets differ across two dozen
// values — so "which row is highlighted" is genuinely new state, and it is
// stored on `node.data.kickPreset` (the dx7 `data.preset` shape). Two
// consequences worth stating:
//
//   * The highlight is a record of the last RECALL, not a claim that the patch
//     is still pristine. Turning TUNE afterwards leaves DEEP CLUB lit, which is
//     what a hardware preset button does and what a producer expects.
//   * It gives the sidebar panel a `node.data` OPERABILITY PROBE
//     (shell-cells `ShellPanelProbe`), which is the difference between a panel
//     the faces-parity sweep can prove alive and one it can only look at.
//
// Reads are pure projections off a node; the caller owns reactivity (the shell
// via `nodeVersion(id)`).

import { mutateNode, setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { KICKDRUM_PRESETS, kickdrumPreset } from './kickdrum-face-model';

/** Which preset a node last RECALLED, or undefined for an untouched voice. */
export function kickdrumPresetId(node: ModuleNode | undefined): string | undefined {
  const v = (node?.data as { kickPreset?: unknown } | undefined)?.kickPreset;
  return typeof v === 'string' && kickdrumPreset(v) ? v : undefined;
}

/** The display name of the active preset, or `—` when none has been recalled. */
export function kickdrumPresetLabel(node: ModuleNode | undefined): string {
  return kickdrumPreset(kickdrumPresetId(node))?.label ?? '—';
}

/** The roster as <Selector> options (the shell's generic roster primitive). */
export function kickdrumSelectorOptions(): SelectorOption<string>[] {
  return KICKDRUM_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    title: `${p.label} · ${p.note} — stamps ${Object.keys(p.values).length} calibrated values`,
  }));
}

/**
 * RECALL a preset by id.
 *
 * Unknown ids are a NO-OP rather than a fallback to the first entry: a stale
 * saved slot (a preset removed in a later build) must not silently overwrite
 * twenty-five of the player's knobs with a voice they did not ask for.
 *
 * ORDER IS LOAD-BEARING. The params are stamped FIRST and the id recorded
 * SECOND, so an observer that reacts to `data.kickPreset` (the sidebar
 * highlight, the parity probe) can never see the new name over the old sound.
 */
export function selectKickdrumPreset(nodeId: string, id: string): void {
  const preset = kickdrumPreset(id);
  if (!preset) return;
  for (const [k, v] of Object.entries(preset.values)) setNodeParam(nodeId, k, v);
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    live.data.kickPreset = preset.id;
  });
}

// ── The hero graph's WINDOW, the one piece of view state the panel owns ─────
//
// The graph plots a FIXED time window on purpose (see kickdrumGraph): an
// auto-scaled window would render every tail as the same picture, making the
// drawing invariant to the very quantity its caption is about. A fixed window
// then needs a way to see a tail that outruns it — SUB BOOM's is over 700 ms —
// so the panel carries a two-position zoom, and it lives on `node.data` rather
// than in component `$state` because the dock pane and the lane tile are two
// mounts of the same module and a zoom that reset on expand would be a bug.

/** The two window lengths, ms. 600 covers the default voice; 1200 covers the
 *  longest tail the def's own `sub_decay` maximum can produce. */
export const KICK_GRAPH_WINDOWS_MS = [600, 1200] as const;

/** The plotted window for a node, in ms (defaults to the short view). */
export function kickdrumGraphWindowMs(node: ModuleNode | undefined): number {
  const v = (node?.data as { kickGraphWindow?: unknown } | undefined)?.kickGraphWindow;
  return typeof v === 'number' && (KICK_GRAPH_WINDOWS_MS as readonly number[]).includes(v)
    ? v
    : KICK_GRAPH_WINDOWS_MS[0];
}

/** Flip to the other window length. */
export function toggleKickdrumGraphWindow(nodeId: string, node: ModuleNode | undefined): void {
  const cur = kickdrumGraphWindowMs(node);
  const next = cur === KICK_GRAPH_WINDOWS_MS[0] ? KICK_GRAPH_WINDOWS_MS[1] : KICK_GRAPH_WINDOWS_MS[0];
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    live.data.kickGraphWindow = next;
  });
}
