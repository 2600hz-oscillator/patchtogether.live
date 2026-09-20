import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({ subscribe: () => () => {}, usingWorker: false, dispose: () => {} }),
}));
import { patch, ydoc } from '$lib/graph/store';
import { defaultNoteClip, laneAutomationArmed, readClip, type ClipPlayerData, type AudioClipRecord } from '$lib/audio/modules/clip-types';
import { clipboardClip, clearClipboard } from '$lib/audio/modules/clip-clipboard';
import { clipplayerInspectClip } from '$lib/ui/modules/clipplayer/clipplayer-face-selection.svelte';
import { setClipplayerAudioTarget, toggleClipplayerLaneRecArm, pasteClipplayerClip } from '$lib/ui/modules/clipplayer/clipplayer-face-actions';
import { clipplayerAudioFeedback } from '$lib/ui/modules/clipplayer/clipplayer-audio-feedback.svelte';
import { installSimulatedLaunchpadSingle, installSimulatedLaunchpad, __test_resetLaunchpad } from './launchpad-device.svelte';
import { bindLaunchpadToClip, __test_resetBinding, __test_setDeployment, setLaunchpadView, __test_mode } from './launchpad-control.svelte';
import { AUDIO_ENTRY, AUDIO_COLOR, paintAudioMatrix } from './launchpad-audio-map';
import { SCENE_CCS, padNote } from './launchpad-sysex';

const CP = 'audio-cp';
const take = (): AudioClipRecord => ({ kind: 'audio', mediaId: 'take-original', lengthSteps: 16, frames: 96000, sampleRate: 48000, channels: 2, format: 'pcm-f32', takeAt: 1234, loop: true });
const data = () => patch.nodes[CP]!.data as ClipPlayerData;
beforeEach(() => {
  __test_resetBinding(); __test_resetLaunchpad(); clearClipboard();
  __test_setDeployment('single', 'grid');
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  patch.nodes[CP] = { id: CP, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: { clips: { '0': { ...defaultNoteClip(), steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }] }, '2': take() }, playing: [0] } } as never;
});

describe('AUDIO shared recording actions and hardware routing', () => {
  it('freezes destination and writer at arm, independent of later editor inspection', () => {
    expect(setClipplayerAudioTarget(CP, 0, 3)).toBeNull();
    expect(toggleClipplayerLaneRecArm(CP, 0)).toBeNull();
    clipplayerInspectClip(CP, 5);
    expect(setClipplayerAudioTarget(CP, 0, 5)).toMatch(/Disarm/);
    expect(data().recRequest?.['0']).toEqual({ slot: 3, recorderId: ydoc.clientID });
    expect(data().playing).toEqual([0]);
    expect(data().queued).toBeUndefined();
  });

  it('refuses notes, recorded automation, unconfirmed takes and foreign arms', () => {
    setClipplayerAudioTarget(CP, 0, 0);
    expect(toggleClipplayerLaneRecArm(CP, 0)).toMatch(/contains notes/);
    data().clips!['1'] = defaultNoteClip();
    data().auto = { '1': { tracks: { 'synth::gain': { events: [{ step: 0, value: 0.8 }] } } } };
    setClipplayerAudioTarget(CP, 0, 1);
    expect(toggleClipplayerLaneRecArm(CP, 0)).toMatch(/contains recorded automation/);
    expect(data().recArm?.['0']).not.toBe(true);
    setClipplayerAudioTarget(CP, 0, 2);
    expect(toggleClipplayerLaneRecArm(CP, 0)).toMatch(/Replace take/);
    expect(toggleClipplayerLaneRecArm(CP, 0, 'stale-take')).toMatch(/Replace take/);
    expect(toggleClipplayerLaneRecArm(CP, 0, 'take-original')).toBeNull();
    data().recRequest!['0'] = { slot: 2, recorderId: ydoc.clientID + 1 };
    expect(toggleClipplayerLaneRecArm(CP, 0)).toMatch(/another collaborator/);
    expect(data().recArm?.['0']).toBe(true);
  });

  it('single AUDIO selects without launch; arm survives exit and transport stays stopped', async () => {
    const sim = await installSimulatedLaunchpadSingle();
    bindLaunchpadToClip(CP); setLaunchpadView('control');
    sim.press('L', AUDIO_ENTRY.x, AUDIO_ENTRY.y);
    expect(__test_mode().mode).toBe('audio');
    sim.press('L', 0, 4); // lane 1, slot 4
    expect(data().playing).toEqual([0]); expect(data().queued).toBeUndefined();
    sim.cc('L', SCENE_CCS[0]!, 127);
    expect(data().recRequest?.['0']?.slot).toBe(3);
    sim.cc('L', SCENE_CCS[7]!, 127);
    expect(__test_mode().mode).toBe('session');
    expect(data().recArm?.['0']).toBe(true);
  });

  it('single audio source is undoable and replacement requires two consecutive confirmations', async () => {
    const sim = await installSimulatedLaunchpadSingle();
    bindLaunchpadToClip(CP); setLaunchpadView('control'); sim.press('L', 4, 6);
    sim.press('L', 0, 5); // audio slot 3
    sim.cc('L', SCENE_CCS[3]!, 127);
    expect(readClip(data(), 2)).toMatchObject({ kind: 'audio', live: true });
    sim.cc('L', 96, 127); // permanent undo
    expect((readClip(data(), 2) as AudioClipRecord).live).not.toBe(true);
    sim.cc('L', SCENE_CCS[4]!, 127);
    expect(data().recArm?.['0']).not.toBe(true);
    sim.press('L', 0, 5); // another action cancels
    sim.cc('L', SCENE_CCS[4]!, 127);
    expect(data().recArm?.['0']).not.toBe(true);
    sim.cc('L', SCENE_CCS[4]!, 127);
    expect(data().recArm?.['0']).toBe(true);
    expect(data().recRequest?.['0']?.replaceMediaId).toBe('take-original');
    expect(readClip(data(), 2)?.kind).toBe('audio');
  });

  it('pair R consumes one L target tap; subsequent L launches and R auto-arm remain independent', async () => {
    __test_setDeployment('pair', 'grid');
    const sim = await installSimulatedLaunchpad(); bindLaunchpadToClip(CP);
    sim.press('R', 4, 6); expect(__test_mode().mode).toBe('audio');
    sim.press('R', 0, 0); // pick target
    sim.press('L', 3, 7); // slot 4, lane 1, pair orientation
    expect(data().queued).toBeUndefined();
    sim.press('R', 0, 6); // arm
    expect(data().recRequest?.['0']?.slot).toBe(3);
    sim.press('L', 2, 7); // ordinary launch now
    expect(data().queued?.[0]).toBe(2);
    sim.press('R', 0, 3); // AUTO, separate from audio
    expect(laneAutomationArmed(data(), 0)).toBe(true);
    expect(data().recArm?.['0']).toBe(true);
  });

  it('audio copy crosses hardware and screen with its media reference and clears stale automation', async () => {
    const sim = await installSimulatedLaunchpadSingle(); bindLaunchpadToClip(CP);
    sim.cc('L', 98, 127); sim.cc('L', SCENE_CCS[0]!, 127); // SHIFT COPY
    sim.press('L', 0, 5);
    expect(clipboardClip()).toMatchObject({ kind: 'audio', mediaId: 'take-original' });
    data().auto = { '4': { tracks: [] } } as never;
    pasteClipplayerClip(CP, 4, clipboardClip()!, { tracks: [] });
    expect(readClip(data(), 4)).toEqual(take()); expect(data().auto?.['4']).toBeUndefined();
  });

  it('pair audio LED overlay uses the live matrix orientation', () => {
    const frame = { leds: new Map<number, [number, number, number]>() };
    paintAudioMatrix(frame, data(), true, 0, true);
    expect(frame.leds.get(padNote(2, 7))).toEqual(AUDIO_COLOR);
    expect(frame.leds.has(padNote(2, 0))).toBe(false);
  });

  it('refusal feedback is visible to the screen instead of silently doing nothing', async () => {
    const sim = await installSimulatedLaunchpadSingle(); bindLaunchpadToClip(CP);
    setLaunchpadView('control'); sim.press('L', 4, 6); sim.press('L', 0, 7);
    sim.cc('L', SCENE_CCS[0]!, 127);
    expect(clipplayerAudioFeedback(CP)).toMatch(/contains notes/);
    expect(data().recArm?.['0']).not.toBe(true);
  });
});
