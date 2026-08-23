// packages/web/src/lib/ui/modules/moog993-face-model.ts
//
// The PURE model behind the MOOG 993 faceplate — HOW THE SWITCHBOARD IS
// PATCHED, which is the one thing none of its three switches can say.
//
// WHY IT EXISTS. The 993 is three independent 3-position routers, and its docs
// name TWO WAYS TO USE IT: *"A single source can drive all three outs at once,
// so it works as a 1→3 trigger multiple, or you can split the three outs
// between two clocks."* Which of those a player is currently in is a property
// of ALL THREE switches together — read any one of them and you cannot tell.
// That is the whole readout: it names the CONFIGURATION, not a value.
//
// It is a NAME rather than a number, deliberately. The owner ruling removed
// resting decimals from faces, and "three outs, one clock" is exactly the kind
// of fact a number fails to say. The three states it can report:
//
//   silent   — no output carries anything (every router OFF)
//   from 1   — every LIVE output carries source 1 (the 1→3 multiple)
//   from 2   — every live output carries source 2
//   split    — live outputs are drawn from BOTH sources (two clocks)
//
// ⚠ IT READS THROUGH THE MODULE'S OWN BANDING (`moog993RouteState`), not
// through a re-typed comparison. The routers select on a BANDED value (#1911:
// they used to select on exact float equality, and 149 of 201 dial positions
// delivered silence), so a readout comparing `=== 1` would disagree with the
// audio for exactly the values that bug was about. Asking the def's own
// function is what keeps the faceplate describing the routing the DSP performs.
//
// PURE: no DOM, no engine, no store, no fs.

import { moog993Def, moog993RouteState } from '$lib/audio/modules/moog993';

/** The router param ids, DERIVED from the def rather than typed out — a fourth
 *  router would join the readout on its own. */
export const MOOG993_ROUTE_IDS: readonly string[] = moog993Def.params
  .filter((p) => p.id.startsWith('route'))
  .map((p) => p.id);

/** A face readout's only window onto the node: param id → value, or undefined
 *  on a fresh node that has not written that key yet. */
type Read = (paramId: string) => number | undefined;

/** The banded state of every router, in def order. Falls back to each param's
 *  declared default — a fresh node has written nothing, and the readout runs on
 *  every render, so an undefined here must not become NaN downstream. */
export function moog993RouteStates(read: Read): number[] {
  return MOOG993_ROUTE_IDS.map((id) => {
    const raw = read(id);
    const def = moog993Def.params.find((p) => p.id === id)!;
    return moog993RouteState(typeof raw === 'number' ? raw : def.defaultValue);
  });
}

/**
 * How the switchboard is patched, as a name.
 *
 * TOTAL by construction: `moog993RouteState` clamps and rounds anything finite
 * and returns the declared default for anything that is not, so every input —
 * a fresh node, NaN, ±Infinity, a value far outside the range — lands on one of
 * the four names rather than throwing on a faceplate mid-drag.
 */
export function moog993RoutingText(read: Read): string {
  const live = moog993RouteStates(read).filter((s) => s !== 0);
  if (live.length === 0) return 'silent';
  const sources = new Set(live);
  if (sources.size > 1) return 'split';
  return sources.has(1) ? 'from 1' : 'from 2';
}
