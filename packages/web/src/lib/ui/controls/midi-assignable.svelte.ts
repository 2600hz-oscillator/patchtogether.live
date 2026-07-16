// packages/web/src/lib/ui/controls/midi-assignable.svelte.ts
//
// SHARED reactive factory behind every MIDI-assignable control — the single
// place the CC-vs-NOTE branch lives. Knob.svelte + Fader.svelte (kind:'cc') and
// MidiAssignButton.svelte / the gate-input row (kind:'note') all consume it, so
// the learn FSM, the bound-state badge, the surface "Send to …" list, and the
// Electra slot flyout are written once.
//
// Runes ($state/$derived/$effect) live in this `.svelte.ts` module so they work
// inside a Svelte 5 component's reactive scope when the consumer spreads the
// returned getters into its own template. The factory returns plain getter
// functions (NOT $derived values) so a consumer can read them reactively from
// its own markup without re-deriving.

import {
  beginLearn,
  beginNoteLearn,
  cancelLearn,
  registerSetter,
  unregisterSetter,
  registerGateSetter,
  unregisterGateSetter,
  getBinding,
  clearBinding,
  learnSpecRune,
  noteLearnSpecRune,
  bindingsRune,
  isCcBinding,
  isNoteBinding,
  type MidiBinding,
} from '$lib/midi/midi-learn.svelte';
import { patch } from '$lib/graph/store';
import { createCcCommit, type CcCommit } from './cc-commit';
import { getCcBatcher } from './cc-batch-store';
import { useEngine, type EngineContext } from '$lib/audio/engine-context';
import type { ModuleNode } from '$lib/graph/types';
import {
  listControlSurfaces,
  readSurfaceData,
  hasBinding as surfaceHasBinding,
  addBindingToSurface,
  removeBindingFromSurface,
} from '$lib/graph/control-surface';
import {
  listElectraControls,
  readElectraData,
  slotForBinding,
  assignSlotToElectra,
  clearSlot,
} from '$lib/graph/electra-control';
import { mutateNode, setNodeParam } from '$lib/graph/mutate';
import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
import {
  clipIndex,
  readClip,
  findAutomationTrack,
  removeAutomationTrack,
  type ClipPlayerData,
  type AutomationClipRecord,
} from '$lib/audio/modules/clip-types';
import { ensureAutomationTrack, plainAutomationClip } from '$lib/audio/modules/clip-automation';

export type AssignKind = 'cc' | 'note';

/** A clip-player in the rack that HAS an automation clip — a "Assign to
 *  automation lane" target for the control menu. */
export interface AutomationEntry {
  nodeId: string;
  name: string;
}

/** The automation clip a clip-player node designates, resolved to its flat clip
 *  index + record + display name, or null (no pointer / not an automation clip). */
function automationClipOf(
  node: { data?: unknown } | undefined,
): { idx: number; name: string; rec: AutomationClipRecord } | null {
  const data = node?.data as ClipPlayerData | undefined;
  const ptr = data?.automation?.clip;
  if (!ptr || typeof ptr.lane !== 'number' || typeof ptr.slot !== 'number') return null;
  const idx = clipIndex(ptr.slot, ptr.lane);
  const rec = readClip(data, idx);
  if (!rec || rec.kind !== 'automation') return null;
  const label = (data as { label?: unknown } | undefined)?.label;
  const name = typeof label === 'string' && label ? label : 'clip player';
  return { idx, name, rec };
}

export interface MidiAssignableArgs {
  /** Patch-graph node id. */
  moduleId: string | undefined;
  /** Param id on that node (for buttons: the synthetic action id, e.g. 'play'). */
  paramId: string | undefined;
  /** 'cc' for continuous controls (knob/fader); 'note' for gates/buttons. */
  kind: AssignKind;
  // ── kind:'cc' ──
  /** Continuous range — the CC's 0..127 maps to [min,max]. CC only. */
  min?: number;
  max?: number;
  /** The value setter (CC only). Called at COALESCED cadence for streaming
   *  CC input (see register()): the store commit rides createCcCommit, so a
   *  250 msg/s hardware twist lands ~7 durable writes/s + a settled final
   *  value instead of 250 full snapshot/reconciler cascades per second. */
  onchange?: (v: number) => void;
  /** Per-MESSAGE transient visual hook (CC only): called with the scaled
   *  value on EVERY inbound CC so the control keeps tracking in real time
   *  while store commits are coalesced. Knob/Fader feed their local
   *  liveValue from this (the drag-guard pattern). */
  onTransient?: (v: number) => void;
  // ── kind:'note' ──
  /** Driven on every matching NOTE: true on note-on, false on note-off. NOTE only. */
  onGate?: (high: boolean) => void;
  /** The control kind for surface/Electra representation. 'button' for card
   *  buttons (→ Electra pad); omitted/'knob' for continuous controls + gate
   *  inputs (→ fader). */
  controlType?: 'knob' | 'button';
}

export interface SurfaceEntry { id: string; name: string; bound: boolean }
export interface ElectraEntry { id: string; name: string; assignedSlot: number | null }

export interface MidiAssignable {
  /** The persisted binding for this control (CC or NOTE), or undefined. */
  readonly binding: MidiBinding | undefined;
  /** True while THIS control is the in-flight learn target (pulsing border). */
  readonly learning: boolean;
  /** Human label for the current binding, e.g. "CH 1 · CC 7" / "CH 1 · NOTE 60". */
  readonly bindingLabel: string | undefined;
  /** Short badge text, e.g. "CC 7" / "NOTE 60". */
  readonly badge: string | undefined;
  /** Snapshot of control surfaces this control can be sent to (recompute on open). */
  readonly surfaces: SurfaceEntry[];
  /** Snapshot of ElectraControls this control can be assigned to (recompute on open). */
  readonly electras: ElectraEntry[];
  /** Snapshot of clip-players with an automation clip this control can be sent
   *  to (recompute on open). */
  readonly automations: AutomationEntry[];
  /** True when this control is already a track in some automation clip. */
  readonly automated: boolean;
  /** Recompute the surface + electra + automation snapshots (call when a menu opens). */
  refresh(): void;
  /** Enter learn mode (CC or NOTE per `kind`). */
  learn(): void;
  /** Forget the binding. */
  forget(): void;
  /** Send/remove this control to/from a control surface. */
  sendToSurface(surfaceId: string): void;
  removeFromSurface(surfaceId: string): void;
  /** Assign/clear this control on an ElectraControl slot. */
  assignElectra(electraId: string, slot: number): void;
  clearElectra(electraId: string, slot: number): void;
  /** Add this control as a track in the given clip-player's automation clip. */
  assignAutomation(clipPlayerNodeId: string): void;
  /** Remove this control's track from whichever automation clip holds it. */
  removeAutomation(): void;
  /** Register the live setter (call onMount). */
  register(): void;
  /** Drop the live setter (call onDestroy). Cancels an in-flight learn for this control. */
  unregister(): void;
  /** True while a CC stream is actively driving this control (between the
   *  first message and the trailing settle commit). Controls gate their
   *  store→visual follow on this — mirroring the `dragging` guard — so the
   *  knob never snaps back to a stale store value mid-stream. */
  readonly ccActive: boolean;
}

/** Build the shared reactive MIDI-assign block for one control. Call inside a
 *  component's `<script>` so the runes bind to that component's reactive scope. */
export function makeMidiAssignable(args: MidiAssignableArgs): MidiAssignable {
  const { kind } = args;

  // Local bump kept for the legacy click-handler path; the bindingsRune() read
  // below is what makes an engine-completed learn (injected CC/NOTE) reactive.
  let bindingTick = $state(0);

  // ── Streaming-CC coalescing (the MIDI-CC render-starvation fix) ──
  //
  // The setter registered with midi-learn used to be the RAW card onchange:
  // every CC message = one ydoc.transact = one full snapshot/flowNodes/
  // reconciler cascade — at 100–300 msg/s (an Electra encoder twist) that
  // starves the video rAF loop. The rAF coalescer (createDragCommit) only
  // ever protected the pointer-drag path; MIDI bypassed it entirely.
  //
  // The CC dispatch now rides a createCcCommit pump: per message it pushes
  // the value TRANSIENTLY (engine handle write + the consumer's onTransient
  // visual hook — both zero-Y.Doc, the gamepad/#719 pattern) and coalesces
  // the durable onchange commit (leading edge + ≥150 ms gaps + a 200 ms
  // trailing settle flush, so the final value always converges for collab
  // peers / persistence / undo). Undo stays LOCAL_ORIGIN via the card's own
  // onchange; store.ts's captureTimeout (500 ms) merges a twist into ONE
  // undo item. NOTE-path gate setters are NOT coalesced — gates are edges.
  //
  // Engine access: makeMidiAssignable runs during component init, so Svelte
  // context is available; non-component callers (unit tests) fall back to a
  // null engine (transient push disabled, commits still coalesce).
  let engineCtx: EngineContext = { get: () => null };
  try {
    engineCtx = useEngine();
  } catch {
    /* outside component init — no engine context */
  }

  let ccActive = $state(false);
  let pump: CcCommit | null = null;

  function pushTransient(v: number): void {
    args.onTransient?.(v);
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    // Touch-suspend cross-wire (task #183): an inbound MIDI CC is a live grab —
    // suspend this param's clip-automation playback (CC wins) via the SAME seam
    // a screen drag hits. Fires per message so suspension is immediate; cleared
    // at the loop wrap during recording / by the re-enable indicator otherwise.
    notifyAutomationTouch({ nodeId: m, paramId: p });
    const engine = engineCtx.get();
    if (!engine) return;
    const node = patch.nodes[m] as ModuleNode | undefined;
    if (!node) return;
    try {
      // Params-backed modules: the same handle-local write the reconciler
      // makes, so the post-settle reconciler re-push of the identical value
      // is idempotent. TOYBOX layer/combine-qualified ids land on its
      // render-local clone (toybox.ts setParam). Unknown params/domains are
      // harmless — the settled commit still converges everything.
      engine.setParam(node, p, v);
    } catch {
      /* no engine mapping for this param — durable commit still lands */
    }
  }

  function ccPump(): CcCommit {
    if (!pump) {
      pump = createCcCommit({
        commit: (v) => args.onchange?.(v),
        transient: (v) => pushTransient(v),
        onActiveChange: (a) => {
          ccActive = a;
          // Automation touch-RELEASE: the stream went cold (settleMs after the
          // last CC = the "hand off the knob" for a device with no pointer-up),
          // so end this param's automation override — the mirror of the grab
          // pushTransient fires per message. See notifyAutomationRelease.
          if (!a) {
            const m = args.moduleId, p = args.paramId;
            if (m && p) notifyAutomationRelease({ nodeId: m, paramId: p });
          }
        },
        // Shared two-lane batcher: the card onchange routes to setNodeParam
        // (& friends) under LOCAL_ORIGIN — the UNDOABLE lane. N twisted
        // knobs now share ≤1 tracked transaction per 150ms window instead
        // of N independent commit streams.
        lane: 'undoable',
        batcher: getCcBatcher(),
      });
    }
    return pump;
  }

  let surfaces = $state<SurfaceEntry[]>([]);
  let electras = $state<ElectraEntry[]>([]);
  let automations = $state<AutomationEntry[]>([]);
  let automated = $state(false);

  const binding = $derived.by<MidiBinding | undefined>(() => {
    void bindingTick;
    void bindingsRune();
    if (!args.moduleId || !args.paramId) return undefined;
    return getBinding(args.moduleId, args.paramId);
  });

  const learning = $derived.by<boolean>(() => {
    if (!args.moduleId || !args.paramId) return false;
    const ls = kind === 'note' ? noteLearnSpecRune() : learnSpecRune();
    return !!ls && ls.moduleId === args.moduleId && ls.paramId === args.paramId;
  });

  const bindingLabel = $derived.by<string | undefined>(() => {
    const b = binding;
    if (!b) return undefined;
    if (isCcBinding(b)) return `CH ${b.channel + 1} · CC ${b.cc}`;
    return `CH ${b.channel + 1} · NOTE ${b.note}`;
  });

  const badge = $derived.by<string | undefined>(() => {
    const b = binding;
    if (!b) return undefined;
    if (isCcBinding(b)) return `CC ${b.cc}`;
    return `NOTE ${b.note}`;
  });

  function refresh(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) { surfaces = []; electras = []; automations = []; automated = false; return; }
    surfaces = listControlSurfaces(patch.nodes).map((s) => ({
      id: s.id,
      name: s.name,
      bound: surfaceHasBinding(readSurfaceData(patch.nodes[s.id]), m, p),
    }));
    electras = listElectraControls(patch.nodes).map((e) => ({
      id: e.id,
      name: e.name,
      assignedSlot: slotForBinding(readElectraData(patch.nodes[e.id]), m, p),
    }));
    // AUTOMATION targets: every clip-player node that HAS an automation clip.
    // `automated` = this control is already a track in one of them.
    const list: AutomationEntry[] = [];
    let isAuto = false;
    for (const [nid, node] of Object.entries(patch.nodes)) {
      const clip = automationClipOf(node);
      if (!clip) continue;
      list.push({ nodeId: nid, name: clip.name });
      if (findAutomationTrack(clip.rec, { nodeId: m, paramId: p })) isAuto = true;
    }
    automations = list;
    automated = isAuto;
  }

  /** Add this control as a track in the clip-player's automation clip, then
   *  reassign the WHOLE clip PLAIN through the graph mutate seam (never a live
   *  Y.Array splice — [[yjs-save-load-real-ydoc]]). No-op when the player has no
   *  automation clip, or the sanity cap (MAX_AUTOMATION_TRACKS) is already hit. */
  function assignAutomation(clipPlayerNodeId: string): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    const node = patch.nodes[clipPlayerNodeId];
    const clip = automationClipOf(node);
    if (!clip) return;
    const { rec: next, track } = ensureAutomationTrack(clip.rec, { nodeId: m, paramId: p });
    if (!track) return; // at the sanity cap — nothing added
    const plain = plainAutomationClip(next);
    mutateNode(clipPlayerNodeId, (live) => {
      if (!live.data) live.data = {};
      const data = live.data as ClipPlayerData;
      if (!data.clips) data.clips = {};
      data.clips[String(clip.idx)] = plain;
    });
  }

  /** Remove this control's track from whichever automation clip holds it, then
   *  release the param to its current store value (a one-shot no-op commit so
   *  the engine stops seeing an automation write). Whole-clip PLAIN reassign. */
  function removeAutomation(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    for (const [nid, node] of Object.entries(patch.nodes)) {
      const clip = automationClipOf(node);
      if (!clip) continue;
      if (!findAutomationTrack(clip.rec, { nodeId: m, paramId: p })) continue;
      const plain = plainAutomationClip(removeAutomationTrack(clip.rec, { nodeId: m, paramId: p }));
      mutateNode(nid, (live) => {
        const data = live.data as ClipPlayerData | undefined;
        if (!data?.clips) return;
        data.clips[String(clip.idx)] = plain;
      });
      // Release the param to its live value (MVP: a one-shot no-op set).
      const cur = patch.nodes[m]?.params?.[p];
      if (typeof cur === 'number') setNodeParam(m, p, cur);
      break;
    }
  }

  function register(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') {
      registerGateSetter(m, p, { onGate: (h) => args.onGate?.(h) });
    } else {
      // Coalesced: dispatch → pump.push (transient per message, durable
      // commit coalesced) — never the raw onchange (the CC-storm bug).
      registerSetter(m, p, { min: args.min ?? 0, max: args.max ?? 1, onchange: (v) => ccPump().push(v) });
    }
  }

  function unregister(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') unregisterGateSetter(m, p);
    else unregisterSetter(m, p);
    // Unconditional flush: a value the stream already applied transiently
    // must reach the store even if the card unmounts mid-twist.
    pump?.dispose();
    pump = null;
    if (learning) cancelLearn();
  }

  function learn(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') {
      void beginNoteLearn({ moduleId: m, paramId: p, onGate: (h) => args.onGate?.(h) });
    } else {
      // beginLearn re-registers the setter (registerSetter inside) — route it
      // through the SAME pump or a completed learn would silently restore the
      // raw uncoalesced onchange until the next remount.
      void beginLearn({ moduleId: m, paramId: p, min: args.min ?? 0, max: args.max ?? 1, onchange: (v) => ccPump().push(v) });
    }
    bindingTick++;
  }

  function forget(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    clearBinding(m, p);
    bindingTick++;
  }

  function sendToSurface(surfaceId: string): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    addBindingToSurface(surfaceId, m, p, args.controlType);
  }
  function removeFromSurface(surfaceId: string): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    removeBindingFromSurface(surfaceId, m, p);
  }
  function assignElectra(electraId: string, slot: number): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    assignSlotToElectra(electraId, slot, m, p);
  }
  function clearElectra(electraId: string, slot: number): void {
    clearSlot(electraId, slot);
  }

  return {
    get binding() { return binding; },
    get learning() { return learning; },
    get bindingLabel() { return bindingLabel; },
    get badge() { return badge; },
    get surfaces() { return surfaces; },
    get electras() { return electras; },
    get automations() { return automations; },
    get automated() { return automated; },
    refresh,
    learn,
    forget,
    sendToSurface,
    removeFromSurface,
    assignElectra,
    clearElectra,
    assignAutomation,
    removeAutomation,
    register,
    unregister,
    get ccActive() { return ccActive; },
  };
}

export { isCcBinding, isNoteBinding };
