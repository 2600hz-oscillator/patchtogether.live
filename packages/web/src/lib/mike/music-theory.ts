// packages/web/src/lib/mike/music-theory.ts
//
// Mike's tiny in-house music theory. Just enough to sound "musical not
// chaotic" — a major scale picker + a clock-finder heuristic. No
// external library: a couple of constant arrays and a graph walk.
//
// Pitch convention here is "semitone offset from C4 as a real number"
// (no specific Hz mapping). Mike's driver converts to whatever the
// downstream sequencer module's `pitchN` param expects via its catalog
// param min/max — we just produce a number that's in-key.

/** Major scale intervals in semitones from the root. */
export const MAJOR_SCALE_STEPS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];

/** Pentatonic scale (used by Mike for simpler / safer melodies). */
export const PENTATONIC_SCALE_STEPS: readonly number[] = [0, 2, 4, 7, 9];

/** Common natural-minor scale. */
export const MINOR_SCALE_STEPS: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

export type ScaleName = 'major' | 'minor' | 'pentatonic';

const SCALES: Record<ScaleName, readonly number[]> = {
  major: MAJOR_SCALE_STEPS,
  minor: MINOR_SCALE_STEPS,
  pentatonic: PENTATONIC_SCALE_STEPS,
};

/** All twelve chromatic root-note offsets (0=C, 1=C#, ..., 11=B). */
export const CHROMATIC_ROOTS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export interface Key {
  /** Root pitch class (0=C, 1=C#, ..., 11=B). */
  root: number;
  scale: ScaleName;
}

/**
 * Generate a sequence of `count` in-key semitone offsets within roughly
 * an octave span around `centerSemitone`. Notes are chosen pseudo-
 * randomly via the supplied `rand` callback (a SeededRng.next()-style
 * function returning [0,1)).
 *
 * Mike calls this with the rack's seed-derived rng so a re-spawn at
 * the same seed produces the same melody.
 */
export function generateInKeyNotes(
  key: Key,
  count: number,
  centerSemitone: number,
  rand: () => number,
): number[] {
  const steps = SCALES[key.scale];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const step = steps[Math.floor(rand() * steps.length)]!;
    // Drop into an octave +/- 1 around the center for variety without
    // going off the playable range of a typical VCO.
    const octaveOffset = (Math.floor(rand() * 3) - 1) * 12;
    out.push(centerSemitone + key.root + step + octaveOffset);
  }
  return out;
}

/**
 * Pick a chord-tone-only melody (root, third, fifth — the safest
 * choices for "sounds tonal"). Useful for the first melody Mike adds
 * to a fresh rack: a four-note arpeggio that establishes the key.
 */
export function generateChordToneMelody(
  key: Key,
  count: number,
  centerSemitone: number,
  rand: () => number,
): number[] {
  const steps = SCALES[key.scale];
  // Indices 0, 2, 4 of the scale = root, third, fifth in a 7-note scale.
  // For pentatonic (5 notes) we just walk every other note which lands
  // on root/third/fifth equivalents too.
  const chordIdxs = steps.length >= 5 ? [0, 2, 4] : [0, 1, 2];
  const chordTones = chordIdxs.map((i) => steps[i % steps.length]!);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const tone = chordTones[Math.floor(rand() * chordTones.length)]!;
    const octaveOffset = (Math.floor(rand() * 2)) * 12;
    out.push(centerSemitone + key.root + tone + octaveOffset);
  }
  return out;
}

/** Pick a key deterministically via the rng — favors C / G / D / A / F
 *  (common, harmonious choices) over the chromatic outliers. */
export function pickKey(rand: () => number): Key {
  // Bias toward C / G / D / A / F (offsets 0, 7, 2, 9, 5) — the keys
  // that an entry-level patcher would reach for. Other keys are
  // legal but show up less often.
  const friendlyRoots = [0, 0, 7, 7, 2, 9, 5];
  const root = friendlyRoots[Math.floor(rand() * friendlyRoots.length)]!;
  // Mike prefers major + pentatonic for "happy" rack vibes; minor sometimes.
  const scaleRoll = rand();
  const scale: ScaleName = scaleRoll < 0.55 ? 'major' : scaleRoll < 0.85 ? 'pentatonic' : 'minor';
  return { root, scale };
}

/** Verify a semitone offset is on-key. Exported for unit tests. */
export function isInKey(semitone: number, key: Key): boolean {
  const steps = SCALES[key.scale];
  // Bring the semitone into the [0, 11] pitch-class window.
  const pc = ((semitone - key.root) % 12 + 12) % 12;
  return steps.includes(pc);
}

// ---------------- Clock-source discovery ----------------
//
// Looks at the current patch view and returns a handle the driver can
// patch into so Mike's new melody line is clocked by the existing rack.
//
// Order of preference:
//   1. TIMELORDE's `1x` / `1/2` / `1/4` gate outputs — purpose-built clock dividers.
//   2. Any existing sequencer's `clock` INPUT — Mike can tap the same
//      cable by reading from the upstream source.
//   3. If neither, returns null and the driver falls back to spawning
//      its own clock (TIMELORDE).

export interface NodeRef {
  id: string;
  type: string;
}

export interface EdgeRef {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

export interface ClockSource {
  /** Node that emits the gate signal. */
  nodeId: string;
  /** Port id on that node where the gate emerges. */
  portId: string;
}

/**
 * Find an existing clock source in the patch graph. Returns null if no
 * suitable source exists — caller (Mike's driver) then spawns a
 * TIMELORDE of its own.
 */
export function findClockSource(
  nodes: ReadonlyArray<NodeRef>,
  edges: ReadonlyArray<EdgeRef>,
): ClockSource | null {
  // Preferred: a TIMELORDE node — emit on a sensible default division.
  const timelorde = nodes.find((n) => n.type === 'timelorde');
  if (timelorde) {
    return { nodeId: timelorde.id, portId: '1x' };
  }
  // Fallback: walk the edges for a wire targeting a sequencer's `clock`
  // input. Re-using the source side of that edge means Mike's new
  // sequencer shares the same upstream clock.
  for (const e of edges) {
    if (e.target.portId !== 'clock') continue;
    const tgtNode = nodes.find((n) => n.id === e.target.nodeId);
    if (!tgtNode) continue;
    if (!isSequencerType(tgtNode.type)) continue;
    return { nodeId: e.source.nodeId, portId: e.source.portId };
  }
  return null;
}

const SEQUENCER_TYPES = new Set([
  'sequencer',
  'polyseqz',
  'drumseqz',
  'macseq',
  'sequencerPages',
  'riotgirls',
  'drummergirl',
]);

export function isSequencerType(type: string): boolean {
  return SEQUENCER_TYPES.has(type);
}
