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
//   FULL  (cvBuddy)      takes THREE jacks: pitch + gate + vel
//   MINI  (cvBuddyMini)  takes TWO:         pitch + gate  (no velocity)
//
// Jacks 1-6 are the note pool, handed out greedily in ascending-id order; jacks
// 7 (RUN) and 8 (CLOCK) belong to the id-smallest instance of EITHER kind. An
// instance that does not fit in what remains of 1-6 is INERT (no entry — the
// card shows "no free ES-9 slots").
//
//   2 × FULL            → {1,2,3} {4,5,6}        + 7,8   (unchanged from before mini)
//   3 × MINI            → {1,2} {3,4} {5,6}      + 7,8
//   1 × MINI            → {1,2}                  + 7,8 → jacks 3,4,5,6 FREE for audio
//   1 FULL + 1 MINI     → {1,2,3} {4,5}          + 7,8 → jack 6 free
//
// ⚠ ONE allocator for BOTH kinds, deliberately. Two independent allocators would
// each think they owned jack 1, and two modules driving one physical DC-coupled
// jack is silently wrong VOLTAGE at the hardware — no error, just a wrong note.
//
// All EIGHT jacks are used: 1-3 + 4-6 are the two note sets, jack 7 = RUN (a
// gate that is HIGH while the transport is playing) and jack 8 = CLOCK (PPQN
// pulses). RUN + CLOCK are single-source — only the id-smallest ("owner")
// instance drives them; if the owner is deleted the new id-smallest inherits
// BOTH jack 7 and jack 8. Patch RUN + CLOCK into a Pam's New Workout to
// translate the rack's run/stop + clock to Pam's.
//
// Per-slot ES-9 CLASS (the out{N}_class param the es9 module reads — see es9.ts):
// Per-slot ES-9 CLASS is derived from the ROLE the slot was allocated for, not
// from its number — with mixed full/mini layouts jack 4 can be a pitch, a gate
// or a velocity depending on what came before it. `slotToEs9` therefore takes
// the role explicitly; deriving it from the number (as it used to) would set
// the wrong voltage class on a mixed rack.
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

/** The note-CV pool. 7 and 8 are reserved for RUN + CLOCK and never handed out
 *  as note jacks, which is what keeps "3 minis and still have a clock" true. */
export const CV_BUDDY_NOTE_SLOTS: readonly number[] = [1, 2, 3, 4, 5, 6];

/** How many note jacks each kind consumes. */
export const CV_BUDDY_SLOT_COST = { full: 3, mini: 2 } as const;

/** Which CV Buddy variant an instance is. */
export type CvBuddyKind = keyof typeof CV_BUDDY_SLOT_COST;

/** One instance, as the allocator sees it. */
export interface CvBuddyInstance {
  id: string;
  kind: CvBuddyKind;
}

/** One CV Buddy instance's slot allocation. */
export interface CvBuddyAlloc {
  /** ES-9 jack (1..8) the instance's pitch CV drives (PITCH class). */
  pitchSlot: number;
  /** ES-9 jack the instance's gate drives (GATE class). */
  gateSlot: number;
  /** ES-9 jack the instance's velocity CV drives (CV class), or NULL for a
   *  MINI, which has no velocity output at all. */
  velSlot: number | null;
  /** Which variant this allocation was computed for. */
  kind: CvBuddyKind;
  /** True only for the id-smallest instance — it drives RUN + the clock. */
  ownsClock: boolean;
  /** ES-9 jack the RUN gate rides (7) for the owner, else null. */
  runSlot: number | null;
  /** ES-9 jack the clock rides (8) for the owner, else null. */
  clockSlot: number | null;
  /** ES-9 physical INPUT jack pair (1-based) carrying this instance's hardware
   *  AUDIO RETURN (Part B) — the modular voice the CV note drives comes BACK in
   *  here. index 0 → [1,2], index 1 → [3,4]. The es9 node exposes these as its
   *  OUTPUT ports `in{N}` (es9.ts). The lane reconciler wires them to the
   *  column's chain head. Distinct jacks from the OUTPUT slots above. */
  inPair: readonly [number, number];
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
export function allocateCvBuddySlots(
  instances: readonly (string | CvBuddyInstance)[],
): Map<string, CvBuddyAlloc> {
  // Back-compat: a bare id list means "all FULL", which is exactly what every
  // caller meant before mini existed.
  const norm: CvBuddyInstance[] = instances.map((x) =>
    typeof x === 'string' ? { id: x, kind: 'full' } : x,
  );
  const out = new Map<string, CvBuddyAlloc>();
  const sorted = [...norm].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let cursor = 0; // index into CV_BUDDY_NOTE_SLOTS
  let ownerAssigned = false;
  for (const inst of sorted) {
    const need = CV_BUDDY_SLOT_COST[inst.kind];
    // Not enough of the note pool left → INERT. Skipping (rather than stopping)
    // is deliberate: a MINI can still fit in a 2-jack gap that a FULL could not,
    // so a later smaller instance is not punished for an earlier larger one.
    if (cursor + need > CV_BUDDY_NOTE_SLOTS.length) continue;

    const pitchSlot = CV_BUDDY_NOTE_SLOTS[cursor]!;
    const gateSlot = CV_BUDDY_NOTE_SLOTS[cursor + 1]!;
    const velSlot = inst.kind === 'full' ? CV_BUDDY_NOTE_SLOTS[cursor + 2]! : null;
    cursor += need;

    // RUN + CLOCK go to the FIRST instance that actually got note jacks — of
    // either kind. Tying them to "index 0" instead would silently lose the
    // clock if the id-smallest instance happened to be inert.
    const ownsClock = !ownerAssigned;
    if (ownsClock) ownerAssigned = true;

    // Hardware AUDIO RETURN input pair, one per allocated instance in order.
    const inIdx = out.size;
    out.set(inst.id, {
      pitchSlot,
      gateSlot,
      velSlot,
      kind: inst.kind,
      ownsClock,
      runSlot: ownsClock ? 7 : null,
      clockSlot: ownsClock ? 8 : null,
      inPair: [inIdx * 2 + 1, inIdx * 2 + 2] as const,
    });
  }
  return out;
}

/** The ES-9 target port + signal class for a given slot. `class` is the
 *  out{N}_class value the reconciler writes onto the es9 node's params. */
export type CvBuddySlotRole = 'pitch' | 'gate' | 'vel' | 'run' | 'clock';

/** The ES-9 port name for a jack. Role-INDEPENDENT — a jack is `out{N}`
 *  whatever it carries — so callers that only need the port do not have to
 *  invent a role they do not have. */
export function es9PortForSlot(slot: number): string {
  return `out${slot}`;
}

export function slotToEs9(slot: number, role: CvBuddySlotRole): { port: string; class: number } {
  // ⚠ ROLE-DRIVEN, not number-driven. This used to read the class off the jack
  // NUMBER ({1,4}=pitch, {2,5,7,8}=gate, else CV), which only held because the
  // layout was always two FULL triples. With mini in the mix jack 4 can be a
  // pitch, a gate or a velocity, and a number-derived class would put the wrong
  // voltage range on a real output.
  const cls =
    role === 'pitch' ? ES9_PITCH
    : role === 'gate' || role === 'run' || role === 'clock' ? ES9_GATE
    : ES9_CV;
  return { port: es9PortForSlot(slot), class: cls };
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
