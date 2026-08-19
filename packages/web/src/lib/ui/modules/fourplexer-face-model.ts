// packages/web/src/lib/ui/modules/fourplexer-face-model.ts
//
// The PURE model behind the 4PLEXER faceplate — the arithmetic for its three
// derived readouts.
//
// WHY A MODEL FOR FOUR IDENTICAL DIALS. Because every question a player has
// about a router is a question about the WHOLE MAP, and each dial can only
// answer for itself. `sel2` reads `IN 1`; what it cannot say is that IN 2 is
// now reaching nothing, or that IN 1 is now arriving at three outputs at once.
// Both of those are properties of the four selectors TOGETHER, and both change
// the moment any one of them moves:
//
//   FAN     one input carried by several outputs. Free to do, easy to do by
//           accident, and the reason a patch suddenly has three copies of the
//           same signal where it expected three different ones.
//   IDLE    an input carried by NO output. The cable is plugged in, the source
//           is running, and nothing downstream hears it. On a module whose
//           four inputs all look identical from the outside this is the single
//           most expensive thing to debug, and no dial hints at it.
//
// ⚠ AND THE READOUTS ARE INVARIANT TO A CHANGE THAT MOVES EVERY DIAL. Any
// PERMUTATION of the four selectors — a completely different patch, four knobs
// in four new positions — is still a bijection, so it fans nothing and idles
// nothing and both readouts correctly stay at `none`. That is the permanent
// negative control in fourplexer-face-model.test.ts, and it is the one a
// "does the number move when I turn the knob" review would fail.
//
// PURE: no DOM, no engine, no store. Every function is a pure function of the
// four live selector values.

import {
  FOURPLEXER_INPUTS,
  FOURPLEXER_SELECTORS,
  fourplexerClampSelector,
} from '$lib/audio/fourplexer-select';

/** The live routing map: for each OUTPUT, the 0-based INPUT index it carries.
 *  Index `i` of the array is `out{i+1}`. */
export type FourplexerRouting = readonly number[];

/** Read the four selectors off a live reader, falling back to the def's own
 *  staggered defaults. (`node.params` is a SPARSE overlay of what has been
 *  TOUCHED, so reading it bare prints the wrong map on a fresh spawn.)
 *
 *  Every value goes through `fourplexerClampSelector` — the SAME normaliser the
 *  factory and the worklet use — so a corrupt saved value reads on the face
 *  exactly as it routes in the audio graph, rather than the two disagreeing. */
export function fourplexerRouting(read: (paramId: string) => number | undefined): FourplexerRouting {
  return FOURPLEXER_SELECTORS.map((sel) => {
    const v = read(sel.id);
    return fourplexerClampSelector(typeof v === 'number' && Number.isFinite(v) ? v : sel.defaultValue);
  });
}

/** How many outputs carry each input. Index `i` = `in{i+1}`. */
export function fourplexerInputLoad(routing: FourplexerRouting): readonly number[] {
  const load = new Array<number>(FOURPLEXER_INPUTS).fill(0);
  for (const inputIdx of routing) if (load[inputIdx] !== undefined) load[inputIdx] += 1;
  return load;
}

/** 1-based input labels, in input order, for every input NO output carries. */
export function fourplexerIdleInputs(routing: FourplexerRouting): readonly number[] {
  const load = fourplexerInputLoad(routing);
  const out: number[] = [];
  load.forEach((n, i) => {
    if (n === 0) out.push(i + 1);
  });
  return out;
}

/** 1-based input labels paired with their count, for every input carried by
 *  MORE THAN ONE output, busiest first (ties by input order). */
export function fourplexerFannedInputs(
  routing: FourplexerRouting,
): readonly { input: number; outputs: number }[] {
  const load = fourplexerInputLoad(routing);
  const out: { input: number; outputs: number }[] = [];
  load.forEach((n, i) => {
    if (n > 1) out.push({ input: i + 1, outputs: n });
  });
  return out.sort((a, b) => b.outputs - a.outputs || a.input - b.input);
}

/** TRUE when every output carries a different input — the shipped state, and
 *  the only one in which neither hazard readout has anything to report. */
export function fourplexerIsBijection(routing: FourplexerRouting): boolean {
  return new Set(routing).size === routing.length;
}

// ── WHAT THE FACEPLATE PRINTS ───────────────────────────────────────────────

/** THE MAP, as one line: the input each output carries, in output order.
 *  `1·2·3·4` is the shipped straight-through. */
export function fourplexerMapText(routing: FourplexerRouting): string {
  return routing.map((i) => i + 1).join('·');
}

/** THE FAN. `none` when every output carries a different input. */
export function fourplexerFanText(routing: FourplexerRouting): string {
  const fanned = fourplexerFannedInputs(routing);
  if (fanned.length === 0) return 'none';
  return fanned.map((f) => `IN ${f.input} x${f.outputs}`).join(', ');
}

/** THE IDLE INPUTS. `none` when every input reaches at least one output. */
export function fourplexerIdleText(routing: FourplexerRouting): string {
  const idle = fourplexerIdleInputs(routing);
  if (idle.length === 0) return 'none';
  return idle.map((i) => `IN ${i}`).join(', ');
}
