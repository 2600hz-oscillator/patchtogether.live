// packages/web/src/lib/ui/dock/dockable.ts
//
// DOCKING P2.5a — the DOCKABLE allowlist (owner answer Q3, plan §7):
// control-first (knob/fader-heavy modules a performer parks in a rail),
// PLUS scope, WORKFLOW racks only. Rollout is allowlist-FIRST as the plan,
// not the fallback (recommendation §2.4): the long tail — WebGL-context
// cards (wavesculpt/cube/hypercube/foxy: any edit churns the WebGL attest
// basis), Handle-in-body cards (bentbox/b3ntb0x), cards with in-card
// position:fixed overlays — earns its way in per audit, later.
//
// Every type here was checked against two constraints of the plain-mount
// rail host (DockCardHost):
//   1. no direct xyflow-context usage in the card (useStore / useSvelteFlow
//      / raw <Handle> in the card body) — ports flow through the shared
//      PatchPanel, which self-gates outside the provider;
//   2. controls are scale-proof (Knob/Fader drag deltas are pure
//      clientX/clientY — verified in the recommendation's audit).
//
// The PINNED M/E/C trio stays drawer-only permanently (owner Q2) — their
// pinned instances never appear here because docking targets CANVAS nodes;
// additional (non-pinned) instances of the same types ARE dockable.

/** Module types offered "Dock to …" in workflow racks. */
export const DOCKABLE_TYPES: ReadonlySet<string> = new Set([
  // Mixers / levels (non-pinned instances; the pinned MIXMSTRS is drawer-only).
  'mixer',
  'mixmstrs',
  'attenumix',
  'fader',
  // Sequencers (control-dense, the classic "park it in a rail" cards).
  'sequencer',
  'drumseqz',
  'polyseqz',
  'writeseq',
  'macseq',
  // Control surfaces / patch-control meta modules.
  'controlSurface',
  'electraControl',
  'clipplayer',
  'matrixMix',
  // Envelopes / modulation workhorses.
  'adsr',
  'lfo',
  // Scope (owner Q3 explicitly includes it; see the P2.5a scope-in-rail
  // assessment in the PR — a slim `dockscope` variant is a P2.5b candidate).
  'scope',
  // DOCKSCOPE (P2.5b): the pre-approved slim rail scope — dockable by
  // default (it exists FOR the rails; vector redraw stays crisp at every
  // dock zoom step, unlike scope's fixed 320×300 raster).
  'dockscope',
]);

/** Is `type` dockable? (Callers additionally gate on workflow mode and on
 *  the node not being a pinned singleton.) */
export function isDockableType(type: string | null | undefined): boolean {
  return !!type && DOCKABLE_TYPES.has(type);
}
