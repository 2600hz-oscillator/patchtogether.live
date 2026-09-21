import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/audio/clip-media-store', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/audio/clip-media-store')>(),
  finishClipMediaTake: vi.fn(async () => {}),
}));
import { patch } from '$lib/graph/store';
import { clipUndo, __test_resetClipUndo } from '$lib/control/clip-undo';
import { defaultNoteClip, readClip, readClipAudio, type AudioClipRecord, type ClipPlayerData } from '$lib/audio/modules/clip-types';
import { referencedClipMediaIds, finishClipMediaTake } from '$lib/audio/clip-media-store';
import { writeClipplayerClip, emptyClipplayerClip, deleteClipplayerClip, pasteClipplayerClip } from './clipplayer/clipplayer-face-actions';
import { recoverClipTake, type ClipRecoveryCandidate } from './clip-media-recovery';

const ID = 'layer-test';
const take = (): AudioClipRecord => ({ kind: 'audio', mediaId: 'layer-a', takeAt: 1, frames: 96000,
  sampleRate: 48000, channels: 2, format: 'pcm-f32', lengthSteps: 16, loop: true });
const data = () => patch.nodes[ID]!.data as ClipPlayerData;
const notes = () => ({ ...defaultNoteClip(), steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 2 }] });
beforeEach(() => {
  __test_resetClipUndo(); vi.clearAllMocks();
  for (const key of Object.keys(patch.nodes)) delete patch.nodes[key];
  patch.nodes[ID] = { id: ID, type: 'clipplayer', domain: 'audio', position: {x: 0, y: 0}, params: {},
    data: { clips: { '0': notes() }, audio: { '0': take() }, auto: { '0': { tracks: { 'synth::gain': { events: [{step: 0, value: 0.7}] } } } } } } as never;
});

describe('clip audio layer lifecycle', () => {
  it('note edits and note clearing preserve the layer; whole-clip deletion and undo include it', () => {
    writeClipplayerClip(ID, 0, { ...notes(), root: 72 });
    expect(readClipAudio(data(), 0)).toEqual(take());
    emptyClipplayerClip(ID, 0);
    expect(readClip(data(), 0)).toMatchObject({ kind: 'note', steps: [] });
    expect(readClipAudio(data(), 0)).toEqual(take());
    deleteClipplayerClip(ID, 0);
    expect(readClip(data(), 0)).toBeNull(); expect(readClipAudio(data(), 0)).toBeNull();
    expect(referencedClipMediaIds(Object.values(patch.nodes) as never).has('layer-a')).toBe(false);
    clipUndo(ID);
    expect(readClipAudio(data(), 0)).toEqual(take());
    expect(referencedClipMediaIds(Object.values(patch.nodes) as never).has('layer-a')).toBe(true);
  });

  it('pasting a clip without audio removes a previous layer instead of attaching it to unrelated notes', () => {
    pasteClipplayerClip(ID, 0, { ...notes(), root: 48 }, null, null);
    expect(readClipAudio(data(), 0)).toBeNull();
    expect(readClip(data(), 0)).toMatchObject({ root: 48 });
    clipUndo(ID);
    expect(readClipAudio(data(), 0)).toEqual(take());
  });

  it('recovers onto its existing notes and automation without replacing either, and refuses occupied audio', async () => {
    const candidate: ClipRecoveryCandidate = { bytes: 192000 * 8, frames: 192000, loops: 2,
      manifest: { mediaId: 'recovered', nodeId: ID, lane: 0, slot: 0, startedAt: 1, status: 'recording',
        format: 'pcm-f32', sampleRate: 48000, channels: 2, frames: 192000, unitFrames: 96000, lengthSteps: 16 } };
    expect(await recoverClipTake(ID, candidate)).toBe(false);
    expect(finishClipMediaTake).not.toHaveBeenCalled();
    delete data().audio!['0'];
    const original = JSON.parse(JSON.stringify({ clips: data().clips, auto: data().auto }));
    expect(await recoverClipTake(ID, candidate)).toBe(true);
    expect(readClipAudio(data(), 0)).toMatchObject({ mediaId: 'recovered', lengthSteps: 32, frames: 192000 });
    expect({ clips: data().clips, auto: data().auto }).toEqual(original);
    clipUndo(ID);
    expect(readClipAudio(data(), 0)).toBeNull();
    expect({ clips: data().clips, auto: data().auto }).toEqual(original);
  });
});
