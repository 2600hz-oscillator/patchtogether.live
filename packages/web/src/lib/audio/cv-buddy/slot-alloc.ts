// packages/web/src/lib/audio/cv-buddy/slot-alloc.ts
//
// PURE, framework-free ES-9 SLOT ALLOCATOR for CV Buddy (Part A).
//
// CV Buddy instances hand their note CV out to the ES-9's physical DC-coupled
// output jacks. There are only so many jacks, so the instances share them by a
// DETERMINISTIC, COLLAB-CONVERGENT rule: sort the CV Buddy node ids ASCENDING
// (an id-sort every peer computes identically from the converged Yjs snapshot,
// like singleton-cleanup's lex tie-break) and assign fixed slot triples:
//
//   index 0  → pitch=1 gate=2 vel=3  + OWNS the transport signals: RUN on jack 7
//                                       + the CLOCK on jack 8
//   index 1  → pitch=4 gate=5 vel=6
//   index ≥2 → INERT (no slots — the card shows "no free ES-9 slots")
//
// All EIGHT jacks are used: 1-3 + 4-6 are the two note sets, jack 7 = RUN (a
// gate that is HIGH while the transport is playing) and jack 8 = CLOCK (PPQN
// pulses). RUN + CLOCK are single-source — only the id-smallest ("owner")
// instance drives them; if the owner is deleted the new id-smallest inherits
// BOTH jack 7 and jack 8. Patch RUN + CLOCK into a Pam's New Workout to
// translate the rack's run/stop + clock to Pam's.
//
// Per-slot ES-9 CLASS (the out{N}_class param the es9 module reads — see es9.ts):
//   pitch slots {1,4} → PITCH (1 V/oct)
//   gate slots {2,5} + run slot {7} + clock slot {8} → GATE (0/+5 V)
//   vel slots {3,6}  → CV (±5 V)
//
// PURITY: no Svelte / Yjs / worklet imports. The reconciler
// (graph/cv-buddy-es9-reconcile.ts) consumes these plans and writes the live
// store; the card reads them to show which slots it owns. Unit-tested against
// plain fixtures (slot-alloc.test.ts).

/** ES-9 signal-class ids — mirror es9.ts ES9_CLASS_* (0=audio, 1=cv, 2=pitch,
 *  3=gate). Duplicated locally (a one-line literal set) so this module stays
 *  dependency-free — importing es9.ts would pull in its worklet `?url` import. */
export const ES9_AUDIO = 0;
export const ES9_CV = 1;
export const ES9_PITCH = 2;
export const ES9_GATE = 3;

/** Every ES-9 physical output slot CV Buddy can drive — all eight (jack 7 =
 *  RUN, jack 8 = CLOCK). */
export const CV_BUDDY_MANAGED_SLOTS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** One CV Buddy instance's slot allocation. */
export interface CvBuddyAlloc {
  /** ES-9 jack (1..8) the instance's pitch CV drives (PITCH class). */
  pitchSlot: number;
  /** ES-9 jack the instance's gate drives (GATE class). */
  gateSlot: number;
  /** ES-9 jack the instance's velocity CV drives (CV class). */
  velSlot: number;
  /** True only for the id-smallest instance — it drives RUN + the clock. */
  ownsClock: boolean;
  /** ES-9 jack the RUN gate rides (7) for the owner, else null. */
  runSlot: number | null;
  /** ES-9 jack the clock rides (8) for the owner, else null. */
  clockSlot: number | null;
}

/**
 * Allocate ES-9 slots to CV Buddy instances by ASCENDING node-id order.
 *
 * The caller passes the CV Buddy node ids; this sorts them (the id-sort is
 * authoritative + collab-convergent) and returns a Map with an entry for the
 * first TWO instances only:
 *   - index 0 → {1,2,3} + ownsClock, RUN on 7, CLOCK on 8
 *   - index 1 → {4,5,6}
 * Index ≥2 gets NO entry (inert — the card reports "no free ES-9 slots"). The
 * returned Map therefore has at most two entries.
 */
export function allocateCvBuddySlots(nodeIds: readonly string[]): Map<string, CvBuddyAlloc> {
  const out = new Map<string, CvBuddyAlloc>();
  const sorted = [...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted[0] !== undefined) {
    out.set(sorted[0], {
      pitchSlot: 1,
      gateSlot: 2,
      velSlot: 3,
      ownsClock: true,
      runSlot: 7,
      clockSlot: 8,
    });
  }
  if (sorted[1] !== undefined) {
    out.set(sorted[1], {
      pitchSlot: 4,
      gateSlot: 5,
      velSlot: 6,
      ownsClock: false,
      runSlot: null,
      clockSlot: null,
    });
  }
  return out;
}

/** The ES-9 target port + signal class for a given slot. `class` is the
 *  out{N}_class value the reconciler writes onto the es9 node's params. */
export function slotToEs9(slot: number): { port: string; class: number } {
  const cls =
    slot === 1 || slot === 4
      ? ES9_PITCH
      : slot === 2 || slot === 5 || slot === 7 || slot === 8
        ? ES9_GATE // gates: note-gates {2,5}, RUN {7}, CLOCK {8}
        : ES9_CV; // {3, 6}
  return { port: `out${slot}`, class: cls };
}

/** Union of every slot claimed across an allocation map (pitch/gate/vel + the
 *  owner's run + clock slots). */
function slotsOf(map: ReadonlyMap<string, Partial<CvBuddyAlloc>>): Set<number> {
  const s = new Set<number>();
  const add = (v: number | null | undefined) => {
    if (typeof v === 'number') s.add(v);
  };
  for (const a of map.values()) {
    add(a.pitchSlot);
    add(a.gateSlot);
    add(a.velSlot);
    add(a.runSlot);
    add(a.clockSlot);
  }
  return s;
}

/**
 * Slots claimed in `prev` but NOT in `next` — the jacks a re-allocation frees
 * (an instance removed, or a lower-id instance removed so a survivor shifts its
 * triple). The reconciler resets these jacks' es9 class back to audio(0) so the
 * DC-coupled jack fades to 0 V instead of HOLDING its last CV voltage.
 * Returns an ascending, de-duplicated slot list. PURE.
 */
export function slotsToReset(
  prev: ReadonlyMap<string, Partial<CvBuddyAlloc>>,
  next: ReadonlyMap<string, Partial<CvBuddyAlloc>>,
): number[] {
  const prevS = slotsOf(prev);
  const nextS = slotsOf(next);
  return [...prevS].filter((slot) => !nextS.has(slot)).sort((a, b) => a - b);
}
