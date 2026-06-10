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

export type AssignKind = 'cc' | 'note';

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
  /** The value setter (CC only). */
  onchange?: (v: number) => void;
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
  /** Recompute the surface + electra snapshots (call when a menu opens). */
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
  /** Register the live setter (call onMount). */
  register(): void;
  /** Drop the live setter (call onDestroy). Cancels an in-flight learn for this control. */
  unregister(): void;
}

/** Build the shared reactive MIDI-assign block for one control. Call inside a
 *  component's `<script>` so the runes bind to that component's reactive scope. */
export function makeMidiAssignable(args: MidiAssignableArgs): MidiAssignable {
  const { kind } = args;

  // Local bump kept for the legacy click-handler path; the bindingsRune() read
  // below is what makes an engine-completed learn (injected CC/NOTE) reactive.
  let bindingTick = $state(0);

  let surfaces = $state<SurfaceEntry[]>([]);
  let electras = $state<ElectraEntry[]>([]);

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
    if (!m || !p) { surfaces = []; electras = []; return; }
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
  }

  function register(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') {
      registerGateSetter(m, p, { onGate: (h) => args.onGate?.(h) });
    } else {
      registerSetter(m, p, { min: args.min ?? 0, max: args.max ?? 1, onchange: (v) => args.onchange?.(v) });
    }
  }

  function unregister(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') unregisterGateSetter(m, p);
    else unregisterSetter(m, p);
    if (learning) cancelLearn();
  }

  function learn(): void {
    const m = args.moduleId, p = args.paramId;
    if (!m || !p) return;
    if (kind === 'note') {
      void beginNoteLearn({ moduleId: m, paramId: p, onGate: (h) => args.onGate?.(h) });
    } else {
      void beginLearn({ moduleId: m, paramId: p, min: args.min ?? 0, max: args.max ?? 1, onchange: (v) => args.onchange?.(v) });
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
    refresh,
    learn,
    forget,
    sendToSurface,
    removeFromSurface,
    assignElectra,
    clearElectra,
    register,
    unregister,
  };
}

export { isCcBinding, isNoteBinding };
