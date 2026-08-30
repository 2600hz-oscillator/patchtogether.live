// packages/web/src/lib/ui/modules/midiOutBuddy/midi-out-buddy-status-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for the MIDI-OUT-BUDDY device body's prose.
//
// ⚠ EVERY STRING THIS FILE CHECKS IS UNPAINTED. `StatusLed`'s `detail` reaches
// `aria-label` and `title` and never a text node, so a wrong sentence there is
// invisible to a VRT baseline and to a human reviewing one — it would ship
// green forever.
//
// ⚠ AND THE LANE LAMP IS THE ONE THAT MATTERS MOST. Its predicate and its
// sentence between them are the entire surviving form of the card's violet
// outline plus its `CH n != LANE m` badge, which the resting-text ruling
// removes from the plate. If either half silently stopped being right, the
// module would go back to routing MIDI off its lane with nothing on screen
// saying so — and every registry gate would stay green, because the cells would
// still read, write and re-project perfectly.

import { describe, it, expect } from 'vitest';
import {
  midiOutBuddyErrorLine,
  midiOutBuddyLaneDetail,
  midiOutBuddyLaneDiverged,
  midiOutBuddyPortDetail,
  midiOutBuddyPortName,
  midiOutBuddySendDetail,
} from './midi-out-buddy-status-model';

const PORT = (id: string, name: string) => ({ id, name, state: 'connected' });

describe('midi-out-buddy port name', () => {
  it('uses the port name when there is one', () => {
    expect(midiOutBuddyPortName(PORT('a', 'Prophet Rev2'))).toBe('Prophet Rev2');
  });

  it('falls back to the ID for a blank name — a blank row is UNPICKABLE', () => {
    // The engine already falls back (`o.name ?? id`); this is the second line
    // of defence, and it exists because an EMPTY string survives that fallback
    // where `null` does not.
    expect(midiOutBuddyPortName(PORT('port-3', ''))).toBe('port-3');
    expect(midiOutBuddyPortName(PORT('port-3', '  '))).toBe('port-3');
  });
});

describe('midi-out-buddy MIDI lamp detail', () => {
  it('distinguishes NOT ASKED from REFUSED before a grant', () => {
    const notAsked = midiOutBuddyPortDetail({
      connected: false, permissionDenied: false, devices: [], selectedDeviceId: null,
    });
    const refused = midiOutBuddyPortDetail({
      connected: false, permissionDenied: true, devices: [], selectedDeviceId: null,
    });
    expect(notAsked).toContain('press Connect MIDI');
    expect(refused).toContain('refused');
    expect(notAsked).not.toBe(refused);
  });

  it('NAMES THE PORT it is sending to, rather than counting ports', () => {
    // "3 outputs found" does not tell a player whether the synth they can hear
    // is the one this node is sending to, which is the whole question.
    const s = midiOutBuddyPortDetail({
      connected: true,
      permissionDenied: false,
      devices: [PORT('a', 'Prophet Rev2'), PORT('b', 'TR-8S')],
      selectedDeviceId: 'b',
    });
    expect(s).toContain('TR-8S');
    expect(s).not.toContain('2');
  });

  it('distinguishes NO OUTPUTS from NONE SELECTED once connected', () => {
    const none = midiOutBuddyPortDetail({
      connected: true, permissionDenied: false, devices: [], selectedDeviceId: null,
    });
    const unpicked = midiOutBuddyPortDetail({
      connected: true, permissionDenied: false, devices: [PORT('a', 'TR-8S')], selectedDeviceId: null,
    });
    expect(none).toContain('no MIDI outputs found');
    expect(unpicked).toContain('no output selected');
    expect(none).not.toBe(unpicked);
  });
});

describe('midi-out-buddy SEND lamp detail — the deleted NOTE row', () => {
  it('names the sounding note AND the channel', () => {
    const s = midiOutBuddySendDetail({ connected: true, channel: 10, activeNote: 60 });
    expect(s).toContain('C4');
    expect(s).toContain('10');
  });

  it('⚠ NAMES THE CHANNEL EVEN WHEN IDLE — the two silences are different', () => {
    // "Nothing is happening" and "everything is happening on a channel your
    // synth is not listening to" are the two states this module is most often
    // in, and they are indistinguishable without the number. An idle branch
    // that omitted it would be the shape that ships a green face over a silent
    // module.
    expect(midiOutBuddySendDetail({ connected: true, channel: 10, activeNote: null }))
      .toContain('10');
  });

  it('distinguishes NOTHING CONNECTED from NOTHING SOUNDING', () => {
    const unbound = midiOutBuddySendDetail({ connected: false, channel: 1, activeNote: null });
    const idle = midiOutBuddySendDetail({ connected: true, channel: 1, activeNote: null });
    expect(unbound).toContain('no MIDI output is connected');
    expect(idle).toContain('waiting for a gate');
    expect(unbound).not.toBe(idle);
  });
});

describe('midi-out-buddy LANE lamp — the card\'s violet badge, made unpainted', () => {
  it('is LIT exactly when the module is in a lane and routes elsewhere', () => {
    expect(midiOutBuddyLaneDiverged({ laneChannel: 3, channel: 7 })).toBe(true);
  });

  it('NEGATIVE CONTROL: it is DARK on a matching lane and on no lane at all', () => {
    // A lamp lit on "an override exists" rather than on the two numbers
    // disagreeing would be a permanent warning on any module whose channel was
    // ever touched, and a lamp lit off-lane would warn about a divergence from
    // nothing.
    expect(midiOutBuddyLaneDiverged({ laneChannel: 3, channel: 3 })).toBe(false);
    expect(midiOutBuddyLaneDiverged({ laneChannel: null, channel: 7 })).toBe(false);
  });

  it('the DIVERGED sentence names BOTH numbers and HOW TO UNDO IT', () => {
    // ⚠ THIS IS THE CARD'S `title` ATTRIBUTE, CARRIED OVER RATHER THAN
    // RE-INVENTED. A two-state picture structurally cannot say which two
    // numbers disagree, so if the detail lost either the warning would tell a
    // player something is wrong and nothing about what.
    const s = midiOutBuddyLaneDetail({ laneChannel: 3, channel: 7 });
    expect(s).toContain('7');
    expect(s).toContain('3');
    expect(s).toContain('Set CH back to 3');
  });

  it('the three states are THREE DIFFERENT SENTENCES, none of them empty', () => {
    // ⚠ THE UN-DIVERGED BRANCHES ARE NOT FILLER. A lamp with no `detail`
    // announces only its caption, and "LANE, off" is ambiguous between "it
    // follows its lane" and "it has no lane" — two different facts a player
    // acts on differently.
    const noLane = midiOutBuddyLaneDetail({ laneChannel: null, channel: 7 });
    const following = midiOutBuddyLaneDetail({ laneChannel: 3, channel: 3 });
    const diverged = midiOutBuddyLaneDetail({ laneChannel: 3, channel: 7 });
    expect(new Set([noLane, following, diverged]).size).toBe(3);
    for (const s of [noLane, following, diverged]) expect(s.length).toBeGreaterThan(20);
    expect(noLane).toContain('not in a channel lane');
    expect(following).toContain('following lane 3');
  });
});

describe('midi-out-buddy error line', () => {
  it('is ABSENT whenever nothing is wrong — which is what makes it permitted text', () => {
    expect(midiOutBuddyErrorLine({ accessMessage: '' })).toBe(null);
    expect(midiOutBuddyErrorLine({ accessMessage: '   ' })).toBe(null);
  });

  it('passes the shared seam\'s message through UNCHANGED', () => {
    // ⚠ IT STAYS LOUD, and the legacy card's own comment is why: the
    // suppressed-prompt case used to produce NO message at all, and a one-line
    // hint swap was something a user reading a dead button did not register.
    // `midiOutcomeMessage` is the seam that always yields a nameable outcome,
    // so this function must not summarise, truncate or re-word it.
    const m = 'The browser did not show a MIDI prompt. Check site permissions and try again.';
    expect(midiOutBuddyErrorLine({ accessMessage: m })).toBe(m);
  });
});
