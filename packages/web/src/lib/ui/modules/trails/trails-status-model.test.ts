// packages/web/src/lib/ui/modules/trails/trails-status-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for every string and every lamp state the
// TRAILS bodies can produce — including the ones that are never painted.
//
// ⚠ WHY A UNIT FILE AND NOT A BASELINE. Under the resting-text ruling the BOUND
// sentence lives on `aria-label` and `title`, where a VRT baseline cannot see it
// and a human reviewing one cannot read it. And the lamp's whole state is a
// COLOUR, which no gate in this repo reads. So both are decided here, in pure
// functions a test can call, exactly as `ptzcam-status-model.test.ts` and
// `midiclock-status-model.test.ts` do for the binders next door.
//
// ⚠ AND IT MATTERS MORE HERE THAN ON MOST FACES, because of what CI cannot
// reach: no runner has a Bela Trails on USB or a granted MIDI origin, so every
// behavioural gate on the binding stops at `idle` or (through the mock)
// `no-port`. Four of the six status kinds are unreachable end to end. What is
// left to hold structurally is what this file pins.

import { describe, it, expect } from 'vitest';
import type { TrailsStatus, TrailsStatusKind } from '$lib/midi/trails-device';
import {
  TRAILS_MON_IDLE_TEXT,
  TRAILS_PRE_CONNECT_HINT,
  trailsCountersLine,
  trailsIsBound,
  trailsIsProblem,
  trailsLamp,
} from './trails-status-model';

/** Every kind the device layer can report. Typed as the union so a new kind
 *  added to `trails-device.ts` reddens HERE (a `TrailsStatusKind` that is not in
 *  this list is a compile error) rather than falling silently into whichever
 *  branch happens to catch it. */
const ALL_KINDS: readonly TrailsStatusKind[] = [
  'idle',
  'unsupported',
  'denied',
  'no-prompt',
  'no-port',
  'bound',
];

function status(kind: TrailsStatusKind, message = `msg:${kind}`): TrailsStatus {
  return { kind, message, portNames: kind === 'bound' ? ['Bela Trails'] : [] };
}

describe('trails status model — the FAULT predicate', () => {
  it('is exhaustive over every kind, and splits them 4 / 2', () => {
    // ⚠ THE SPLIT IS THE ASSERTION, not the predicate's shape. `idle` is not a
    // fault (nothing has been asked for yet) and `bound` is not; the other four
    // are. A tidy that folded `no-prompt` in with `idle` — both are "the browser
    // did not say yes" — would delete the one sentence that tells a player their
    // prompt was SUPPRESSED rather than never raised, and every registry gate
    // would stay green.
    const faults = ALL_KINDS.filter(trailsIsProblem);
    expect(faults).toEqual(['unsupported', 'denied', 'no-prompt', 'no-port']);
    expect(ALL_KINDS.filter((k) => !trailsIsProblem(k))).toEqual(['idle', 'bound']);
  });

  it('is EXACTLY the fault predicate every surface has ever used', () => {
    // The expression this replaced, spelled out rather than referenced:
    // `status.kind !== 'bound' && status.kind !== 'idle'`. It was inlined in a
    // component once, and pinning it here is what stops a re-expression drifting
    // — a player must not get two verdicts about one device.
    for (const kind of ALL_KINDS) {
      expect(trailsIsProblem(kind), kind).toBe(kind !== 'bound' && kind !== 'idle');
    }
  });

  it('`bound` is the only lit-and-well state', () => {
    expect(ALL_KINDS.filter(trailsIsBound)).toEqual(['bound']);
  });
});

describe('trails status model — the LAMP keeps all THREE of the card LED states', () => {
  // ⚠ THE DEFECT THIS BLOCK EXISTS FOR, and it is invisible to every other gate
  // in the repo. `StatusLed` styles the tone ONLY on the lit lamp
  // (`.status-led.warn.lit .lamp`); an UNLIT lamp is `var(--border)` whatever
  // the tone. So the obvious port of the card — `lit={bound}` with
  // `tone={problem ? 'warn' : 'accent'}` — renders a FAULT pixel-identically to
  // a module nobody has pressed CONNECT on, silently deleting one of the card's
  // three LED states (grey `#555` / amber `#d98a3a` / green `#4caf7d`). No gate
  // reads a colour, so nothing else in the tree could catch it.

  it('IDLE is DARK — the resting state stays quiet', () => {
    const lamp = trailsLamp(status('idle'));
    expect(lamp.lit).toBe(false);
    expect(lamp.tone).toBe('accent');
  });

  it('every FAULT is LIT and WARN — the card\'s amber LED, preserved', () => {
    for (const kind of ALL_KINDS.filter(trailsIsProblem)) {
      const lamp = trailsLamp(status(kind));
      expect(lamp.lit, `${kind} lights the lamp`).toBe(true);
      expect(lamp.tone, `${kind} is amber`).toBe('warn');
    }
  });

  it('BOUND is LIT and ACCENT — and is the only state that is', () => {
    const lamp = trailsLamp(status('bound'));
    expect(lamp.lit).toBe(true);
    expect(lamp.tone).toBe('accent');
    const litAccent = ALL_KINDS.filter((k) => {
      const l = trailsLamp(status(k));
      return l.lit && l.tone === 'accent';
    });
    expect(litAccent).toEqual(['bound']);
  });

  it('NEGATIVE CONTROL: no two kinds share a (lit, tone) pair across the fault line', () => {
    // The three visual states must remain three. A regression that made `idle`
    // lit, or a fault accent, would collapse two of them into one picture.
    const pairs = new Map<string, TrailsStatusKind[]>();
    for (const kind of ALL_KINDS) {
      const l = trailsLamp(status(kind));
      const key = `${l.lit}:${l.tone}`;
      pairs.set(key, [...(pairs.get(key) ?? []), kind]);
    }
    expect([...pairs.keys()].sort()).toEqual(['false:accent', 'true:accent', 'true:warn']);
  });
});

describe('trails status model — what is SPOKEN and what is PAINTED', () => {
  it('the whole sentence reaches `detail` for EVERY kind, bound included', () => {
    // ⚠ THE BOUND SENTENCE IS THE ONE DELETION IN THE PROMOTION. `Bound to Bela
    // Trails — streaming X / Y / gate.` was a derived state sentence outside any
    // control, which the 2026-08-19 rulings delete fleet-wide; it survives on
    // `detail`, which `StatusLed` puts on `aria-label` + `title` and never in a
    // text node. If `detail` ever stopped carrying it the port names would leave
    // the product entirely and no baseline would show a difference.
    for (const kind of ALL_KINDS) {
      expect(trailsLamp(status(kind)).detail, kind).toBe(`msg:${kind}`);
    }
  });

  it('the ERROR LINE is present for a fault and ABSENT whenever nothing is wrong', () => {
    // Painted text is permitted here precisely BECAUSE it is absent at rest.
    for (const kind of ALL_KINDS) {
      const lamp = trailsLamp(status(kind));
      expect(lamp.errorLine, kind).toBe(trailsIsProblem(kind) ? `msg:${kind}` : null);
    }
  });

  it('the HINT is the EMPTY state only — never beside an error, never when bound', () => {
    // ⚠ BOTH HALVES. A hint painted beside a fault would be two instructions
    // disagreeing; a hint painted while bound would be instructional copy on a
    // surface that is no longer empty, which is not what the licence covers.
    expect(trailsLamp(status('idle')).hint).toBe(TRAILS_PRE_CONNECT_HINT);
    for (const kind of ALL_KINDS.filter((k) => k !== 'idle')) {
      expect(trailsLamp(status(kind)).hint, kind).toBeNull();
    }
    // …and never both at once, for any kind.
    for (const kind of ALL_KINDS) {
      const l = trailsLamp(status(kind));
      expect(l.errorLine !== null && l.hint !== null, `${kind} paints only one line`).toBe(false);
    }
  });

  it('NO ENGINE HANDLE reads as the EMPTY state, not as a fault', () => {
    // A node whose engine handle is still being built has nothing wrong with it,
    // and a body that painted `role="alert"` during the reconciler's own window
    // would cry wolf on every rack boot — the one place this surface is
    // guaranteed to be mounted before the handle exists.
    const lamp = trailsLamp(null);
    expect(lamp.lit).toBe(false);
    expect(lamp.errorLine).toBeNull();
    expect(lamp.hint).toBe(TRAILS_PRE_CONNECT_HINT);
    expect(lamp.detail).toBe(TRAILS_PRE_CONNECT_HINT);
  });

  it('the hint is INSTRUCTIONAL — it names the gesture and does not measure anything', () => {
    // The licence is "instructional copy in an EMPTY state". A line that named a
    // count or a state word would be a readout wearing a hint's clothes.
    expect(TRAILS_PRE_CONNECT_HINT).toMatch(/Connect Trails/);
    expect(TRAILS_PRE_CONNECT_HINT).not.toMatch(/\d/);
  });
});

describe('trails status model — the MON counters line', () => {
  it('is the card\'s line VERBATIM, ratio and all', () => {
    // `TrailsCard.svelte:414-416`: `loops {n} · edges {a/b/c/d}`. It stays a LINE
    // rather than four lamps because it is read as a RATIO between two counters
    // that must advance together — the loop-retrigger defect is exactly "does the
    // gate strike once per repetition" — and no boolean lamp can express "these
    // two numbers moved by the same amount".
    expect(trailsCountersLine({ loopRestarts: 12, gateEdges: [12, 0, 0, 0] })).toBe(
      'loops 12 · edges 12/0/0/0',
    );
  });

  it('reads ZERO rather than blank with no engine handle', () => {
    // A blank where a zero belongs makes "nothing has happened" and "the readout
    // is broken" look alike, on the one panel whose job is telling them apart.
    expect(trailsCountersLine(null)).toBe('loops 0 · edges 0/0/0/0');
  });

  it('the MON placeholder names the SURFACE\'S condition, not a measurement', () => {
    // The samsloop `NO SAMPLE LOADED` shape, and the card's string verbatim.
    expect(TRAILS_MON_IDLE_TEXT).toContain('MIDI monitor idle');
    expect(TRAILS_MON_IDLE_TEXT).toContain('CONNECT');
  });
});
