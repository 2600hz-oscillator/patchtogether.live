// packages/web/src/lib/ui/modules/midiCvBuddy/midi-cv-buddy-status-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for the MIDI-CV-BUDDY device body's prose.
//
// ⚠ EVERY STRING THIS FILE CHECKS IS UNPAINTED. `StatusLed`'s `detail` reaches
// `aria-label` and `title` and never a text node, so a wrong sentence there is
// invisible to a VRT baseline and to a human reviewing one — it would ship
// green forever. That is precisely why it needs a test: the lamp's own
// correctness (lit vs dark) is a boolean the component owns, and the sentence
// beside it is prose that nothing else looks at.

import { describe, it, expect } from 'vitest';
import {
  midiCvBuddyDeviceDetail,
  midiCvBuddyDeviceName,
  midiCvBuddyErrorLine,
  midiCvBuddyNoteDetail,
} from './midi-cv-buddy-status-model';

const DEV = (id: string, name: string) => ({ id, name, state: 'connected' });

describe('midi-cv-buddy device name', () => {
  it('uses the port name when there is one', () => {
    expect(midiCvBuddyDeviceName(DEV('a', 'Keystep Pro'))).toBe('Keystep Pro');
  });

  it('falls back to the ID for a blank name — a blank row is UNPICKABLE', () => {
    // ⚠ THE ENGINE ALREADY FALLS BACK (`inp.name ?? id`), so this is the second
    // line of defence rather than the first — and it exists because an EMPTY
    // string survives that fallback where `null` does not. Web MIDI returns one
    // on some platforms, and two blank rows are indistinguishable to a player.
    expect(midiCvBuddyDeviceName(DEV('port-3', ''))).toBe('port-3');
    expect(midiCvBuddyDeviceName(DEV('port-3', '   '))).toBe('port-3');
  });
});

describe('midi-cv-buddy MIDI lamp detail', () => {
  it('distinguishes NOT ASKED from REFUSED before a grant', () => {
    // Two different facts a player acts on differently: one is "press the
    // button", the other is "this browser will never do it".
    const notAsked = midiCvBuddyDeviceDetail({
      connected: false, permissionDenied: false, devices: [], selectedDeviceId: null,
    });
    const refused = midiCvBuddyDeviceDetail({
      connected: false, permissionDenied: true, devices: [], selectedDeviceId: null,
    });
    expect(notAsked).toContain('press Connect MIDI');
    expect(refused).toContain('refused');
    expect(notAsked).not.toBe(refused);
  });

  it('NAMES THE DEVICE it is listening to, rather than counting devices', () => {
    // ⚠ A COUNT IS THE WRONG SHAPE HERE TWICE OVER. It is the construct the
    // ratchet rules train you to look at twice, and it is also the less useful
    // half: "3 inputs found" does not tell a player whether the keyboard under
    // their hands is the one THIS node is listening to, which is the whole
    // question a binder's status has to answer.
    const s = midiCvBuddyDeviceDetail({
      connected: true,
      permissionDenied: false,
      devices: [DEV('a', 'Keystep Pro'), DEV('b', 'Launchkey')],
      selectedDeviceId: 'b',
    });
    expect(s).toContain('Launchkey');
    expect(s).not.toContain('2');
  });

  it('distinguishes NO INPUTS from NONE SELECTED once connected', () => {
    const none = midiCvBuddyDeviceDetail({
      connected: true, permissionDenied: false, devices: [], selectedDeviceId: null,
    });
    const unpicked = midiCvBuddyDeviceDetail({
      connected: true, permissionDenied: false, devices: [DEV('a', 'Keystep')], selectedDeviceId: null,
    });
    expect(none).toContain('no MIDI inputs found');
    expect(unpicked).toContain('no input selected');
    expect(none).not.toBe(unpicked);
  });
});

describe('midi-cv-buddy NOTE lamp detail — the deleted readout, made honest', () => {
  it('says the NOTE and the VELOCITY while keys are held', () => {
    // Strictly the pair the card's two deleted readout rows printed.
    const s = midiCvBuddyNoteDetail({
      connected: true, heldCount: 1, lastNote: 60, lastVelocity: 100,
    });
    expect(s).toContain('C4');
    expect(s).toContain('100');
  });

  it('⚠ THE LATCH IS NAMED, not hidden — the dark-but-connected branch', () => {
    // The module keeps `lastNote` after every key is released ON PURPOSE, so a
    // downstream VCO holds its pitch through the gate's fall. That is a real
    // behaviour a player can be surprised by, and this branch is the only place
    // in the product that explains it. A branch that just said "no keys held"
    // would be correct and would have deleted the finding.
    const s = midiCvBuddyNoteDetail({
      connected: true, heldCount: 0, lastNote: 60, lastVelocity: 100,
    });
    expect(s).toContain('latched');
    expect(s).toContain('C4');
  });

  it('distinguishes NOTHING CONNECTED from NOTHING PLAYED', () => {
    // ⚠ THE WHOLE REASON THE LAMP EXISTS. The two ways this module disappoints
    // — nothing patched to the keyboard, and a channel filter aimed at a
    // channel the keyboard is not sending on — are BOTH perfectly silent, and
    // both look exactly like a correct module between notes. A dark lamp whose
    // detail could not tell them apart would be decoration.
    const unbound = midiCvBuddyNoteDetail({
      connected: false, heldCount: 0, lastNote: null, lastVelocity: 0,
    });
    const idle = midiCvBuddyNoteDetail({
      connected: true, heldCount: 0, lastNote: null, lastVelocity: 0,
    });
    expect(unbound).toContain('no MIDI device is connected');
    expect(idle).toContain('play a key');
    expect(unbound).not.toBe(idle);
  });

  it('NEGATIVE CONTROL: a chord reports how many keys, not just the winner', () => {
    // `heldCount` is what makes the lamp live at all, so it must reach the
    // sentence — otherwise the field could be dropped from the card state and
    // only the boolean would notice.
    expect(
      midiCvBuddyNoteDetail({ connected: true, heldCount: 3, lastNote: 64, lastVelocity: 90 }),
    ).toContain('3 keys held');
    expect(
      midiCvBuddyNoteDetail({ connected: true, heldCount: 1, lastNote: 64, lastVelocity: 90 }),
    ).toContain('1 key held');
  });
});

describe('midi-cv-buddy error line', () => {
  it('is ABSENT whenever nothing is wrong — which is what makes it permitted text', () => {
    // A faceplate may paint an ERROR precisely because a healthy module never
    // shows one. A branch that always returned a string would be a resting
    // sentence about state, which the ruling denies.
    expect(midiCvBuddyErrorLine({ permissionDenied: false })).toBe(null);
  });

  it('is present, and actionable, when the grant failed', () => {
    const s = midiCvBuddyErrorLine({ permissionDenied: true });
    expect(s).toBeTruthy();
    expect(s!).toContain('Chrome');
  });
});
