// THE LINNSTRUMENT'S NON-PARAM GESTURES, as one plain-TypeScript seam called
// by BOTH surfaces — the ranked action cells (`linnstrument-connect-{n}`,
// `linnstrument-center-{n}`, `linnstrument-panic-{n}`) and the shell
// extension's pads body. A second surface is a call, never a copy
// (module-surfaces: one-shot behaviour lives in one action seam).
//
// ⚠ EVERY GESTURE GOES THROUGH THE RUNTIME'S REDUCER. Center and Panic are
// `ControlIntent`s dispatched into the same `reduceControls` the hardware
// edges and the DOM pads feed, so the face can never disagree with the CV or
// the LEDs (records/ui-specification.md:18). The pads' `set_pair` rides the
// same door; when the engine handle is not up yet the pad falls through to a
// plain param write, which reaches the SAME reducer through `setParam` once
// the handle exists — both paths end in one place.
//
// ⚠ CONNECT IS A USER GESTURE the DEVICE LAYER owns (Web MIDI consent —
// trails-device.ts:9-24: never called from a factory). The runtime holds a
// connector seam (`setLinnstrumentConnector`) the device layer registers into;
// this file calls whatever is registered and records the audition HONESTLY —
// `delivered: false` when this node's handle was not there, or when nothing is
// registered, because a press that reached no seam is a different failure from
// a press that never happened. Called SYNCHRONOUSLY: an `await` above the MIDI
// request spends the user activation and Chromium then refuses to prompt.
//
// ⚠ It takes a nodeId and resolves the engine itself — `ShellCellEnv.engine`
// is typed as `{ write(...) }` with no `read`, and these gestures need
// `read(node, 'card-api')` (the ptzcam / trails idiom).

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { mutateNode, setNodeParam } from '$lib/graph/mutate';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorId } from '$lib/midi/linnstrument/types';
import type { LinnstrumentCardApi, LinnTargets } from '$lib/audio/modules/linnstrument';
import { linnstrumentConnector, positionParamId, selectorParamId } from '$lib/audio/modules/linnstrument-runtime';

/** The live card-api handle for a linnstrument node, or null when the engine
 *  is not up / the node is gone / the handle does not answer the read key. */
export function linnstrumentApi(nodeId: string): LinnstrumentCardApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as LinnstrumentCardApi | undefined) ?? null;
}

/**
 * Grant Web MIDI and bind the LinnStrument through the registered connector.
 * Returns whether the press reached THIS node's seam with a connector to call.
 */
export function linnstrumentConnect(nodeId: string): boolean {
  const api = linnstrumentApi(nodeId);
  const connector = linnstrumentConnector();
  if (!api || !connector) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    // Not a no-op on the fallback: the browser is still asked when a
    // connector exists, exactly as trails' app-level fallback does.
    if (connector) void connector();
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  void api.connect();
  return true;
}

/** Center every SELECTED pair — a reducer intent, so only the selected pairs
 *  move and the finger is left alone. */
export function linnstrumentCenter(nodeId: string): boolean {
  const api = linnstrumentApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.dispatch({ kind: 'center' });
  return true;
}

/** Panic — every note on both buses off now; XY, selection and pointer retained. */
export function linnstrumentPanic(nodeId: string): boolean {
  const api = linnstrumentApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.dispatch({ kind: 'panic' });
  return true;
}

/** Move ONE pair directly (the DOM pad). Through the reducer when the handle
 *  is up; otherwise a plain param write that reaches the same reducer later. */
export function linnstrumentSetPair(nodeId: string, selector: SelectorId, x: number, y: number): boolean {
  const api = linnstrumentApi(nodeId);
  if (api) {
    api.dispatch({ kind: 'set_pair', selector, x, y });
    return true;
  }
  setNodeParam(nodeId, positionParamId(selector, 'x'), x);
  setNodeParam(nodeId, positionParamId(selector, 'y'), y);
  return false;
}

/** Flip ONE selector (the DOM pad's toggle) through the same door. */
export function linnstrumentSetSelector(nodeId: string, selector: SelectorId, on: boolean): boolean {
  const api = linnstrumentApi(nodeId);
  if (api) {
    api.dispatch({ kind: 'set_selector', selector, on });
    return true;
  }
  setNodeParam(nodeId, selectorParamId(selector), on ? 1 : 0);
  return false;
}

/** Flush the runtime's staged param commits — the pad's gesture end. */
export function linnstrumentFlush(nodeId: string): void {
  linnstrumentApi(nodeId)?.flush();
}

/** D15 (RECOMMENDATION, opt-in): bind or unbind the joystick node whose
 *  `pos_x`/`pos_y` mirror one selector's pair. `node.data.targets` is durable
 *  patch state; a deleted target is simply an unresolvable id the mirroring
 *  write declines, so nothing dangles. */
export function linnstrumentSetTarget(nodeId: string, selector: SelectorId, targetId: string | null): void {
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    const data = live.data as { targets?: LinnTargets };
    const targets: LinnTargets = { ...(data.targets ?? {}) };
    if (targetId) targets[selector] = targetId;
    else delete targets[selector];
    if (Object.keys(targets).length) data.targets = targets;
    else delete data.targets;
  });
}

/** The current target bindings on a node (empty when unbound). */
export function linnstrumentTargets(node: ModuleNode | undefined): LinnTargets {
  const t = (node?.data as { targets?: unknown } | undefined)?.targets;
  if (!t || typeof t !== 'object') return {};
  const out: LinnTargets = {};
  for (const s of ['r', 'g', 'b'] as const) {
    const v = (t as Record<string, unknown>)[s];
    if (typeof v === 'string' && v) out[s] = v;
  }
  return out;
}
