// packages/web/src/lib/ui/modules/push2Control/push2-binder-status-model.test.ts
//
// EVERY STRING THE PUSH 2 FACEPLATE BODY CAN PRODUCE, READ IN THE UNIT LANE.
//
// ⚠ THIS FILE EXISTS BECAUSE THE DOCK BASELINE PHOTOGRAPHS EXACTLY ONE OF THEM.
// The card's status region had nine branches; most need hardware, a permission
// decision or a browser without WebUSB to reach, and a VRT capture can reach
// none of those (see the scene's own note in `_shell-faces.ts` — the
// unreachability is structural, not incidental). A pure model is the only place
// the other eight are observable at all.
//
// It also holds the two DELETIONS honest. The resting-text ruling moved four of
// the card's sentences off the plate; a finding that moves to `aria-label` and
// is then never asserted has quietly lapsed, which is the failure mode
// CLAUDE.md names when it says "deleting a readout deletes a finding". The two
// legs that matter:
//
//   * WHICH clip-player this Push drives — `push2BoundDetail` must actually
//     carry the node id, and two different bindings must produce two different
//     strings. On a rack with several clip-players that id is the only thing
//     distinguishing them.
//   * WHERE IN THE LANE the card flip is — `push2FlipValue` must distinguish a
//     one-module lane from a six-module lane, which is precisely what the
//     deleted `i/N` badge said and what a picture of eight bars cannot.

import { describe, expect, it } from 'vitest';
import type { Push2BinderView } from './push2-binder-status-model';
import {
  PUSH2_VIEWS,
  push2BindLabel,
  push2BindVisible,
  push2BoundDetail,
  push2EmptyLine,
  push2ErrorLine,
  push2FlipValue,
  push2PushDetail,
  push2ScreenDetail,
  push2ScreenTone,
  push2UsbLine,
  push2ViewName,
  push2ViewSegVisible,
} from './push2-binder-status-model';

/** The FRESH-SPAWN state — the one a dock baseline actually captures. */
const RESTING: Push2BinderView = {
  supported: true,
  connected: false,
  usbOk: true,
  displayOn: false,
  displayStatus: 'idle',
  boundNode: null,
  hasClip: false,
  view: 'clip',
  outcome: 'idle',
};

function v(over: Partial<Push2BinderView> = {}): Push2BinderView {
  return { ...RESTING, ...over };
}

describe('push2 binder — the resting state (what the baseline sees)', () => {
  it('paints NO error, NO empty line, NO bind control and NO view segment', () => {
    // Everything the VRT scene photographs, asserted here so a change to the
    // picture is red in the unit lane BEFORE anyone re-reads a PNG.
    expect(push2ErrorLine(RESTING)).toBeNull();
    expect(push2UsbLine(RESTING)).toBeNull();
    expect(push2EmptyLine(RESTING), 'not connected ⇒ nothing to say about clip-players').toBeNull();
    expect(push2BindVisible(RESTING)).toBe(false);
    expect(push2ViewSegVisible(RESTING)).toBe(false);
  });

  it('all three lamps are DARK, and none of them is a fault', () => {
    expect(RESTING.connected, 'PUSH').toBe(false);
    expect(RESTING.displayOn, 'SCREEN').toBe(false);
    expect(RESTING.boundNode, 'BOUND').toBeNull();
    // ⚠ AN UNLIT SCREEN LAMP IS NOT A FAULT. The display "degrades to nothing"
    // by design, so a warn tone on the default path would be a lie in the
    // opposite direction from the one the ruling usually guards against.
    expect(push2ScreenTone(RESTING)).toBe('accent');
  });
});

describe('push2 binder — the ERROR lines (absent whenever nothing is wrong)', () => {
  it('is null in every state where nothing has failed', () => {
    expect(push2ErrorLine(RESTING)).toBeNull();
    expect(push2ErrorLine(v({ connected: true, outcome: 'connected' }))).toBeNull();
    expect(push2ErrorLine(v({ outcome: 'connecting' }))).toBeNull();
  });

  it('names the capability failure BEFORE the permission failure before the device failure', () => {
    // Ordered by how early the failure stops the player: a browser with no Web
    // MIDI at all cannot produce the other two.
    expect(push2ErrorLine(v({ supported: false, outcome: 'no-device' }))).toMatch(/isn’t available/);
    expect(push2ErrorLine(v({ outcome: 'no-midi' }))).toMatch(/permission prompt/);
    expect(push2ErrorLine(v({ outcome: 'no-device' }))).toMatch(/No Push 2 detected/);
  });

  it('the WebUSB line is INDEPENDENT of the MIDI ones — the two failures are orthogonal', () => {
    // A perfectly working Push on a browser with no WebUSB costs the on-device
    // picture and nothing else, so this cannot be folded into the error above.
    expect(push2UsbLine(v({ connected: true, usbOk: false }))).toMatch(/No WebUSB/);
    expect(push2ErrorLine(v({ connected: true, usbOk: false })), 'MIDI is fine').toBeNull();
  });

  it('does NOT answer the WebUSB question before a device is even bound', () => {
    expect(push2UsbLine(v({ connected: false, usbOk: false })), 'nobody asked yet').toBeNull();
  });
});

describe('push2 binder — the ONE surviving status sentence is an EMPTY STATE', () => {
  // Two of the card's sentences looked alike and the ruling turns on their
  // condition. This pair is the whole argument, asserted.
  it('appears only when there is NOTHING in the rack to bind to', () => {
    expect(push2EmptyLine(v({ connected: true, hasClip: false }))).toMatch(/Add a clip-player/);
  });

  it('is REPLACED BY THE BIND CONTROL the moment a clip-player exists', () => {
    const withClip = v({ connected: true, hasClip: true });
    expect(push2EmptyLine(withClip), 'the surface exists now').toBeNull();
    expect(push2BindVisible(withClip), 'and it is this').toBe(true);
    // The card ALSO printed "Push 2 ✓ — hit Bind to drive your clip-player."
    // in exactly this state, which is a readout of a button three rows up.
    // There is no function here that can produce it.
  });

  // ⚠ THIS LEG FOUND A REAL DEFECT AND IS KEPT AS ITS REGRESSION. The state
  // `hasClip: false, boundNode: 'cp'` is reachable — DELETE the clip-player
  // while the Push is driving it and the patch-read goes null while the
  // module-level binding rune does not — and it painted "add a clip-player to
  // drive" NEXT TO a live `Unbind clip-player` button. The fix is in
  // `push2EmptyLine`'s condition, not in this assertion.
  it('never coexists with the BIND control — the two are mutually exclusive over EVERY combination', () => {
    for (const hasClip of [false, true]) {
      for (const boundNode of [null, 'cp']) {
        const s = v({ connected: true, hasClip, boundNode });
        expect(
          push2EmptyLine(s) !== null && push2BindVisible(s),
          `empty line and BIND both shown (hasClip=${hasClip}, bound=${boundNode})`,
        ).toBe(false);
      }
    }
  });

  it('a STALE binding keeps UNBIND reachable rather than falling back to the empty state', () => {
    // The specific state above, named. Telling a player to "add a clip-player"
    // while the Push still believes it is driving one leaves them no route to
    // clear the binding.
    const stale = v({ connected: true, hasClip: false, boundNode: 'cp' });
    expect(push2EmptyLine(stale)).toBeNull();
    expect(push2BindVisible(stale)).toBe(true);
    expect(push2BindLabel(stale)).toBe('Unbind clip-player');
  });
});

describe('push2 binder — BIND is two ACTIONS, which is why it is not a cell', () => {
  it('names which of the two it will fire', () => {
    expect(push2BindLabel(v({ boundNode: null }))).toBe('Bind to clip-player');
    expect(push2BindLabel(v({ boundNode: 'cp' }))).toBe('Unbind clip-player');
  });

  it('the two captions DIFFER — `ShellActionCell.label` is a plain string and could not', () => {
    expect(push2BindLabel(v({ boundNode: null }))).not.toBe(push2BindLabel(v({ boundNode: 'cp' })));
  });
});

describe('push2 binder — the LAMP details carry the deleted sentences', () => {
  it('PUSH names every connection state, and no two share a string', () => {
    const states: Push2BinderView[] = [
      RESTING,
      v({ supported: false }),
      v({ connected: true }),
      v({ outcome: 'connecting' }),
      v({ outcome: 'no-device' }),
      v({ outcome: 'no-midi' }),
    ];
    const details = states.map(push2PushDetail);
    expect(new Set(details).size, `a lamp detail that repeats says less than it claims: ${details.join(' | ')}`)
      .toBe(states.length);
  });

  // ⚠ THE FINDING THE DELETED `Driving clip-player {id} — {VIEW} view.` CARRIED.
  // `maxInstances: 1` means one Push and potentially many clip-players, so
  // "bound" without "to what" is materially less useful.
  it('BOUND carries WHICH clip-player, and two bindings produce two strings', () => {
    expect(push2BoundDetail(v({ boundNode: 'cp-a' }))).toContain('cp-a');
    expect(push2BoundDetail(v({ boundNode: 'cp-a' }))).not.toBe(push2BoundDetail(v({ boundNode: 'cp-b' })));
    expect(push2BoundDetail(v({ boundNode: null }))).toMatch(/Not driving/);
  });

  it('BOUND also carries the active VIEW — the other half of the deleted sentence', () => {
    expect(push2BoundDetail(v({ boundNode: 'cp', view: 'grid' })))
      .not.toBe(push2BoundDetail(v({ boundNode: 'cp', view: 'arranger' })));
  });

  it('SCREEN carries the raw status the card put in a parenthesis', () => {
    expect(push2ScreenDetail(v({ displayStatus: 'connecting' }))).toContain('connecting');
    expect(push2ScreenDetail(v({ displayOn: true }))).toMatch(/open over WebUSB/);
    expect(push2ScreenDetail(v({ usbOk: false }))).toMatch(/WebUSB unavailable/);
  });

  it('SCREEN TONE separates a FAULT from a mere absence, IN COLOUR', () => {
    // The distinction row 14's parenthesis was making badly.
    expect(push2ScreenTone(v({ displayStatus: 'denied' })), 'the player asked and was refused').toBe('warn');
    expect(push2ScreenTone(v({ displayStatus: 'failed' })), 'the open failed').toBe('warn');
    for (const s of ['idle', 'connecting', 'connected', 'unsupported'] as const) {
      expect(push2ScreenTone(v({ displayStatus: s })), `${s} is not a fault`).toBe('accent');
    }
  });
});

describe('push2 binder — the FLIP position, the finding that moved to an accessible name', () => {
  // ⚠ WITHOUT THIS, a lane with one module and a lane with six are the same
  // picture, and the ‹ › buttons give no sign they have anywhere to go.
  it('a one-module lane and a six-module lane produce DIFFERENT strings', () => {
    const one = push2FlipValue({ title: 'tidy vco', index: 1, count: 1 });
    const six = push2FlipValue({ title: 'tidy vco', index: 1, count: 6 });
    expect(one).not.toBe(six);
    expect(six).toContain('6');
  });

  it('the POSITION within the lane is carried, not just the size', () => {
    expect(push2FlipValue({ title: 'x', index: 2, count: 6 }))
      .not.toBe(push2FlipValue({ title: 'x', index: 5, count: 6 }));
  });

  it('an EMPTY lane says so rather than naming a module that is not there', () => {
    expect(push2FlipValue({ title: '', index: null, count: null, empty: 'no-modules' }))
      .toMatch(/empty/i);
    // The states the push card model can actually produce, all handled.
    for (const e of ['no-lane', 'no-modules', 'no-controls'] as const) {
      expect(push2FlipValue({ title: 't', index: null, count: null, empty: e })).toBeTruthy();
    }
  });

  it('falls back to the bare title when there is no position to report', () => {
    expect(push2FlipValue({ title: 'tidy vco', index: null, count: null })).toBe('tidy vco');
  });
});

describe('push2 binder — the view roster', () => {
  it('is the DEF\'S roster, so the body and the legacy card cannot drift apart', () => {
    // One place, imported by both. A roster re-typed in a `.svelte` file is
    // invisible to every runtime gate, which is why it lives on the def.
    expect(PUSH2_VIEWS.map((x) => x.id)).toEqual(['grid', 'clip', 'arranger', 'control']);
  });

  it('every option has a SPEAKABLE name distinct from its two-to-four letter tag', () => {
    for (const opt of PUSH2_VIEWS) {
      const name = push2ViewName(opt.id);
      expect(name.length, `${opt.id} needs a real name`).toBeGreaterThan(opt.label.length);
      expect(name).not.toBe(opt.label);
    }
    expect(new Set(PUSH2_VIEWS.map((o) => push2ViewName(o.id))).size).toBe(PUSH2_VIEWS.length);
  });

  it('the segment exists only once a device is connected', () => {
    expect(push2ViewSegVisible(v({ connected: false }))).toBe(false);
    expect(push2ViewSegVisible(v({ connected: true }))).toBe(true);
  });
});
