// packages/web/src/lib/ui/modules/backdraft/panic.ts
//
// BACKDRAFT PANIC — the ONE reset implementation, with two triggers: the
// faceplate's PANIC button (BackdraftOutputBody.svelte) calls it directly, and
// a rising edge on the `panic` gate input reaches it through the panic hook
// ($lib/video/panic-hook.ts, registered at engine boot in Canvas.svelte).
//
// WHAT RESETS: every USER-SETTABLE param — every ParamDef the def does not
// declare `noUserControl` — back to its `defaultValue`. Derived from the def
// both ways (never a hand list), so a param added later is IN until someone
// declares it out.
//
// WHAT IS DELIBERATELY UNTOUCHED, and why each is not a "setting":
//   * EDGES / PATCHING — never read, never written. Panic zeroes the module's
//     own state, not the player's wiring; a CV cable modulating a param keeps
//     modulating it, riding on the restored default base (the CV bridge is
//     additive around the manual base and re-centres on it every tick —
//     engine.ts tickCvBridges, #2236 — so resetting the BASE moves the centre
//     and the modulation carries on around it).
//   * noUserControl params (delayClock, the *Gate mirrors, panicGate itself,
//     freeze) — raw bridge swings and a VRT determinism latch, not settings a
//     player set; writing panicGate from panic would also re-trigger the very
//     edge detector that fired it.
//   * node.data — `fullFrame` and `previewCollapsed` are VIEW state (how big
//     the preview shows / SCREEN ON-OFF itself — the owner placed PANIC beside
//     that button, not over it), `name`/`controlColor` are identity.
//   * position / lane membership / detach — layout, owned by the rack.
//
// UNDO: the doc write is ONE `ydoc.transact` tagged LOCAL_ORIGIN (mutateNode's
// default), so a panic is a single undoable action — Cmd-Z restores the whole
// pre-panic state in one step.
//
// THE ENGINE PUSH (step 2) exists because gate-driven flips are ENGINE-LOCAL:
// a rising edge on mirror_x_gate flips the handle's `params.mirrorX` without
// ever writing the doc, so after a flip the doc can already hold the default
// and the in-place skip in step 1 writes nothing — and the reconciler, which
// only reacts to doc changes, would never push the param back. Re-asserting
// the base through VideoEngine.setParam resets that engine-local state AND
// re-records `baseParams`, which is the value live CV re-centres on.

import { backdraftDef } from '$lib/video/modules/backdraft';
import { noUserControlIds } from '$lib/ui/workflow/no-user-control';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { getActiveEngine } from '$lib/audio/engine-ref';
import type { ModuleNode, ParamDef } from '$lib/graph/types';
import type { VideoEngine } from '$lib/video/engine';

/** The params PANIC resets, with their targets — derived from the def minus
 *  its own noUserControl declaration. Pure; exported for the tests. */
export function backdraftPanicTargets(): ReadonlyArray<Pick<ParamDef, 'id' | 'defaultValue'>> {
  const hidden = noUserControlIds(backdraftDef);
  return backdraftDef.params.filter((p) => !hidden.has(p.id));
}

/**
 * Reset every user-settable backdraft param to its def default.
 *
 * Returns false (a no-op) when `nodeId` is absent or not a backdraft — the
 * gate hook fires on any node the panic cable targets, so the type check
 * lives here rather than in every trigger.
 */
export function backdraftPanic(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node || node.type !== 'backdraft') return false;

  const targets = backdraftPanicTargets();

  // 1. The doc, in ONE LOCAL_ORIGIN transaction → one undo step. Unchanged
  //    values are skipped in place so a panic on an already-default rack
  //    writes nothing and adds no undo churn — an ABSENT key already means
  //    the default (the spawn path leaves `params` empty).
  mutateNode(nodeId, (live) => {
    // In-place write on the LIVE node INSIDE mutateNode's origin-tagged
    // transact — the sanctioned multi-field seam (the cloudseed preset-recall
    // shape), not a bare store write.
    for (const p of targets) {
      if ((live.params[p.id] ?? p.defaultValue) !== p.defaultValue) {
        live.params[p.id] = p.defaultValue; // guard:allow-raw-write
      }
    }
  });

  // 2. The engine base — resets gate-flipped engine-local state the skip
  //    above never writes, and re-records the base live CV rides on. Absent
  //    engine (unit tests, pre-boot) the doc reset above still stands.
  const eng = getActiveEngine();
  if (eng?.hasDomain('video')) {
    const ve = eng.getDomain<VideoEngine>('video');
    for (const p of targets) ve.setParam(nodeId, p.id, p.defaultValue);
  }
  return true;
}
