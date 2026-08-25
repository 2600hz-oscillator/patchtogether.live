// packages/web/src/lib/ui/modules/launchpadControl/launchpad-binder-status-model.test.ts
//
// THE PERMANENT LEGS FOR THE LAUNCHPAD BINDER'S STRINGS.
//
// ⚠ MOST OF WHAT THIS FILE ASSERTS IS NEVER PAINTED, and that is the reason it
// exists rather than a limitation of it. The card's nine-branch status line
// became two `StatusLed` `detail`s, i.e. two `aria-label`s. A VRT baseline
// cannot see an accessible name and neither can a human reviewing one, so an
// `aria-label` that says the wrong thing is invisible to every gate the face
// otherwise has. This is where it is visible.
//
// The legs that matter are the INVARIANCE ones. It is easy to write two lamp
// details that both move when the binding changes and call it correct; the
// question a reviewer cannot answer by eye is whether each one is blind to the
// thing the OTHER lamp is for.

import { describe, it, expect } from 'vitest';
import type { SingleView } from '$lib/control/launchpad/launchpad-map';
import {
  LAUNCHPAD_VIEWS,
  launchpadBindLabel,
  launchpadBindVisible,
  launchpadClipDetail,
  launchpadEmptyLine,
  launchpadErrorLine,
  launchpadLinkDetail,
  launchpadPairingLine,
  launchpadViewName,
  launchpadViewSegVisible,
  type LaunchpadBinderView,
} from './launchpad-binder-status-model';
import type { LaunchpadGestureOutcome } from '../launchpad-cell-actions';

/** A freshly spawned module on a browser that HAS Web MIDI and no device: the
 *  state the VRT baseline photographs, and the one every player meets first. */
const FRESH: LaunchpadBinderView = {
  supported: true,
  paired: false,
  single: false,
  pairing: false,
  view: 'grid',
  boundNode: null,
  hasClip: false,
  outcome: 'idle',
};

const v = (over: Partial<LaunchpadBinderView>): LaunchpadBinderView => ({ ...FRESH, ...over });

const OUTCOMES: readonly LaunchpadGestureOutcome[] = [
  'idle', 'pairing', 'paired', 'no-midi', 'one-unit', 'no-device',
];
const VIEWS: readonly SingleView[] = ['grid', 'clip', 'arranger', 'control'];

describe('launchpad binder — the LINK lamp says what is BOUND, and only that', () => {
  it('distinguishes all four device states', () => {
    expect(launchpadLinkDetail(FRESH)).toBe('no Launchpad bound');
    expect(launchpadLinkDetail(v({ pairing: true }))).toMatch(/pairing/);
    expect(launchpadLinkDetail(v({ paired: true }))).toMatch(/two Launchpads bound/);
    expect(launchpadLinkDetail(v({ paired: true, single: true }))).toMatch(/one Launchpad bound/);
    expect(launchpadLinkDetail(v({ supported: false }))).toMatch(/not available/);
  });

  it('⚠ NEGATIVE CONTROL: it is INVARIANT to the clip binding — the two lamps do not restate each other', () => {
    // The failure this catches is the plausible one: a single "status" sentence
    // copied into both lamps, so LINK dark + CLIP lit is unreachable and the
    // second lamp adds nothing. LINK is about the DEVICE; whether a clip-player
    // is attached is the CLIP lamp's entire subject.
    const bound = v({ paired: true, single: true, boundNode: 'n7', hasClip: true });
    const unbound = v({ paired: true, single: true, boundNode: null, hasClip: true });
    expect(launchpadLinkDetail(bound)).toBe(launchpadLinkDetail(unbound));
    // …and the CLIP detail is NOT invariant to it, which is what makes the leg
    // above a measurement rather than a tautology about constant strings.
    expect(launchpadClipDetail(bound)).not.toBe(launchpadClipDetail(unbound));
  });

  it('names the single-unit ROLE, which the lamp picture cannot carry', () => {
    const seen = new Set(
      VIEWS.map((view) => launchpadLinkDetail(v({ paired: true, single: true, view }))),
    );
    expect(seen.size, 'four roles must produce four distinct sentences').toBe(VIEWS.length);
  });
});

describe('launchpad binder — the CLIP lamp carries the node id the ruling took off the plate', () => {
  it('names the bound clip-player', () => {
    expect(launchpadClipDetail(v({ paired: true, boundNode: 'n7' }))).toContain('n7');
  });

  it('⚠ THE FINDING THAT LOST ITS PAINTED SURFACE: two clip-players are distinguishable', () => {
    // The card printed this id in the LANE. On a rack with two clip-players it
    // is the only thing separating them, so if the detail collapsed to a
    // constant "driving a clip-player" the removal really would have deleted a
    // finding rather than relocated it.
    expect(launchpadClipDetail(v({ paired: true, boundNode: 'n7' })))
      .not.toBe(launchpadClipDetail(v({ paired: true, boundNode: 'n9' })));
  });

  it('the three UNBOUND cases are three different facts', () => {
    const noDevice = launchpadClipDetail(FRESH);
    const canBind = launchpadClipDetail(v({ paired: true, hasClip: true }));
    const nothingToBind = launchpadClipDetail(v({ paired: true, hasClip: false }));
    expect(new Set([noDevice, canBind, nothingToBind]).size).toBe(3);
  });
});

describe('launchpad binder — an ERROR is ABSENT whenever nothing is wrong', () => {
  it('the resting state prints no error at all', () => {
    expect(launchpadErrorLine(FRESH)).toBeNull();
    expect(launchpadErrorLine(v({ outcome: 'paired' }))).toBeNull();
    expect(launchpadErrorLine(v({ outcome: 'pairing' }))).toBeNull();
    expect(launchpadErrorLine(v({ outcome: 'idle' }))).toBeNull();
  });

  it('each failure names itself, and the four are distinct', () => {
    const lines = [
      launchpadErrorLine(v({ supported: false })),
      launchpadErrorLine(v({ outcome: 'no-midi' })),
      launchpadErrorLine(v({ outcome: 'one-unit' })),
      launchpadErrorLine(v({ outcome: 'no-device' })),
    ];
    expect(lines.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(lines).size, 'four failures must not print one message').toBe(4);
  });

  it('TOTALITY: every outcome resolves to a string or null, on both capability branches', () => {
    for (const outcome of OUTCOMES) {
      for (const supported of [true, false]) {
        const line = launchpadErrorLine(v({ outcome, supported }));
        expect(line === null || line.length > 0, `${outcome}/${supported}`).toBe(true);
      }
    }
  });

  it('⚠ THE UNSUPPORTED BRANCH WINS OVER THE OUTCOME — a browser with no Web MIDI never blames the hardware', () => {
    // "No Launchpad detected — plug one in" is actively misleading on a browser
    // that could not have seen a Launchpad in the first place.
    expect(launchpadErrorLine(v({ supported: false, outcome: 'no-device' })))
      .toBe(launchpadErrorLine(v({ supported: false, outcome: 'idle' })));
  });
});

describe('launchpad binder — the two SENTENCES that survive, and their conditions', () => {
  it('the pairing instruction does not exist at rest', () => {
    expect(launchpadPairingLine(FRESH)).toBeNull();
    expect(launchpadPairingLine(v({ paired: true }))).toBeNull();
    expect(launchpadPairingLine(v({ pairing: true }))).toMatch(/press any pad/);
    // …and not on a browser that cannot pair at all.
    expect(launchpadPairingLine(v({ pairing: true, supported: false }))).toBeNull();
  });

  it('the PRE-CONNECT empty state is the whole content of the plate, and it goes when a device arrives', () => {
    // midiclock's shape one module over: before a handshake there is nothing on
    // this surface but the two dark lamps, so a placeholder naming the missing
    // condition is what stops "no device yet" and "the body failed to mount"
    // being the same picture — which matters here, because the fresh-spawn
    // state is exactly what the dock VRT baseline photographs.
    expect(launchpadEmptyLine(FRESH)).toMatch(/Connect a Launchpad/);
    expect(launchpadEmptyLine(v({ paired: true, hasClip: true }))).toBeNull();
    expect(launchpadEmptyLine(v({ paired: true, boundNode: 'n7' }))).toBeNull();
  });

  it('the EMPTY-STATE line is REPLACED by the control the moment there is one', () => {
    // The empty-state discriminator: it names the surface's own condition and
    // vanishes when the surface exists. Here the "surface" is the BIND control,
    // so the two must be exclusive — a plate showing both would be an
    // instruction about a button next to it.
    const empty = v({ paired: true, hasClip: false });
    expect(launchpadEmptyLine(empty)).toMatch(/Add a clip-player/);
    expect(launchpadBindVisible(empty)).toBe(false);

    const filled = v({ paired: true, hasClip: true });
    expect(launchpadEmptyLine(filled)).toBeNull();
    expect(launchpadBindVisible(filled)).toBe(true);
  });

  it('the two empty states are DIFFERENT lines — the missing thing is named, not "something is missing"', () => {
    expect(launchpadEmptyLine(FRESH)).not.toBe(launchpadEmptyLine(v({ paired: true })));
    // …and neither survives a handshake in flight, where the transient
    // instruction owns the strip.
    expect(launchpadEmptyLine(v({ pairing: true }))).toBeNull();
  });
});

describe('launchpad binder — the two body controls appear exactly where the card put them', () => {
  it('BIND needs a device AND something to bind', () => {
    expect(launchpadBindVisible(FRESH)).toBe(false);
    expect(launchpadBindVisible(v({ hasClip: true }))).toBe(false); // no device
    expect(launchpadBindVisible(v({ paired: true, hasClip: true }))).toBe(true);
    expect(launchpadBindVisible(v({ paired: true, boundNode: 'n7' }))).toBe(true);
  });

  it('BIND names the action it will PERFORM, and the two names differ', () => {
    expect(launchpadBindLabel(v({ boundNode: null }))).toMatch(/^Bind/);
    expect(launchpadBindLabel(v({ boundNode: 'n7' }))).toMatch(/^Unbind/);
  });

  it('the four-role segment exists only in SINGLE mode', () => {
    expect(launchpadViewSegVisible(v({ paired: true, single: true }))).toBe(true);
    // In PAIR mode the roles are fixed by the hardware split, so a roster there
    // would be a control with nothing to choose.
    expect(launchpadViewSegVisible(v({ paired: true, single: false }))).toBe(false);
    expect(launchpadViewSegVisible(v({ single: true }))).toBe(false); // not bound
  });

  it('the roster is the DEVICE\'s own four roles, each with a distinct caption and a distinct name', () => {
    expect(LAUNCHPAD_VIEWS.map((o) => o.id)).toEqual([...VIEWS]);
    expect(new Set(LAUNCHPAD_VIEWS.map((o) => o.label)).size).toBe(LAUNCHPAD_VIEWS.length);
    expect(new Set(VIEWS.map(launchpadViewName)).size).toBe(VIEWS.length);
  });

  it('TOTALITY: every role has a name (a missing arm would render `undefined` into an aria-label)', () => {
    for (const view of VIEWS) {
      expect(typeof launchpadViewName(view), view).toBe('string');
      expect(launchpadViewName(view).length, view).toBeGreaterThan(0);
    }
  });
});
