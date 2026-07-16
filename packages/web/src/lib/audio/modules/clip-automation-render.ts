// packages/web/src/lib/audio/modules/clip-automation-render.ts
//
// Per-machine, IN-MEMORY automation RENDER STATE for the clip player — the
// recording node's active automation clip + a beat countdown to its OWN loop
// wrap, for the 🟡🟡🔴🔴 recordist pre-roll flash. Render state (the launchpad
// LED paint + the card mirror read it), so it lives here, NOT on the synced
// Y.Doc: publishing a countdown every scheduler tick into the store would be the
// per-frame ydoc.update storm (see cv-modulation-live-store-write). Mirrors
// clip-playhead.ts: the factory tick updates it; consumers read it; cleared on
// dispose.
//
// The pure helpers (automationCountdownColor / automationCountdownOn) map a beat
// count + beat phase to the countdown colour + pulse, so both the launchpad LED
// paint and the card mirror derive the SAME flash from one source, and it
// unit-tests with no engine.

/** Published automation render state for a clip-player node. Absent/null = no
 *  countdown (not armed, or the automation clip isn't launched). */
export interface AutomationRenderState {
  /** The designated automation clip's (lane, slot) — its grid cell / arm pad. */
  lane: number;
  slot: number;
  /** Record-armed (the synced arm flag) → the countdown is active. */
  recording: boolean;
  /** Beats until THIS clip's OWN loop wrap (from its own lengthSteps × laneDur ÷
   *  the transport's seconds-per-beat — clip-relative, NEVER the song bar). */
  beatsToLoopEnd: number;
  /** Phase 0..1 within the current (wrap-relative) beat, for the on-beat pulse. */
  beatPhase: number;
}

const states = new Map<string, AutomationRenderState | null>();

/** Publish node `nodeId`'s automation render state (or null = no countdown). */
export function setAutomationRender(nodeId: string, state: AutomationRenderState | null): void {
  states.set(nodeId, state);
}

/** Read node `nodeId`'s automation render state (null when none / not armed). */
export function getAutomationRender(nodeId: string): AutomationRenderState | null {
  return states.get(nodeId) ?? null;
}

/** Drop a node's automation render state (call on factory dispose). */
export function clearAutomationRender(nodeId: string): void {
  states.delete(nodeId);
}

/** TEST-ONLY: clear every node's render state. */
export function __resetAutomationRender(): void {
  states.clear();
}

// ---------------------------------------------------------------------------
// PURE countdown helpers (shared by the launchpad LED paint + the card mirror)
// ---------------------------------------------------------------------------

/** How many beats back from the clip wrap the countdown starts flashing. */
export const AUTOMATION_COUNTDOWN_BEATS = 4;

/**
 * The countdown colour for `beatsRemaining` beats before THIS clip's own wrap:
 *   4,3 beats → 'yellow' · 2,1 beats → 'red' · outside (0, 4] → null.
 * `ceil` buckets the continuous countdown onto its beat markers (e.g. 2.5 beats
 * remaining is still inside the "3rd beat" bucket → yellow; 2.0 → red). PURE.
 */
export function automationCountdownColor(beatsRemaining: number): 'yellow' | 'red' | null {
  if (!(beatsRemaining > 0) || beatsRemaining > AUTOMATION_COUNTDOWN_BEATS) return null;
  const n = Math.ceil(beatsRemaining); // 4,3 → yellow · 2,1 → red
  return n >= 3 ? 'yellow' : 'red';
}

/**
 * The on/off phase of the beat-synced pulse (bright ON the beat, dim between).
 * `beatPhase` is 0..1 within the current beat; bright for the first `duty` of it.
 * PURE.
 */
export function automationCountdownOn(beatPhase: number, duty = 0.5): boolean {
  const p = ((beatPhase % 1) + 1) % 1; // normalise into [0,1)
  return p < duty;
}
