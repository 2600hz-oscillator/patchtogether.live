import { beforeEach, describe, expect, it } from 'vitest';
import { patch } from '$lib/graph/store';
import { clipUndo, clipRedo } from '$lib/control/clip-undo';
import { defaultNoteClip, type NoteClipRecord } from '$lib/audio/modules/clip-types';
import { clipplayerClipAt, tieClipplayerNote } from './clipplayer-face-actions';

const id = 'tie-editor';
const initial: NoteClipRecord = { ...defaultNoteClip(), steps: [
  { step: 2, midi: 60, lengthSteps: 1, gateLen: 0.3, velocity: 80, prob: 0.5, pitchProb: 0.2, playEvery: 3 },
  { step: 5, midi: 60 }, { step: 4, midi: 67 },
] };
beforeEach(() => {
  if (patch.nodes[id]) delete patch.nodes[id];
  patch.nodes[id] = { id, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {},
    data: { clips: { '0': structuredClone(initial) } } };
});

describe('editor note ties', () => {
  it('merges the row, keeps note properties and other pitches, and is undoable', () => {
    tieClipplayerNote(id, 0, 2, 5, 60);
    const next = clipplayerClipAt(id, 0)!;
    expect(next.steps).toEqual([
      { step: 4, midi: 67 },
      { step: 2, midi: 60, lengthSteps: 4, velocity: 80, prob: 0.5, pitchProb: 0.2, playEvery: 3 },
    ]);
    clipUndo(id);
    expect(clipplayerClipAt(id, 0)).toEqual(initial);
    clipRedo(id);
    expect(clipplayerClipAt(id, 0)).toEqual(next);
    tieClipplayerNote(id, 0, 2, 3, 60);
    expect(clipplayerClipAt(id, 0)!.steps.find((e) => e.midi === 60)!.lengthSteps).toBe(2);
  });

  it('honors mono lanes and refuses invalid endpoints or an erased anchor', () => {
    patch.nodes[id]!.data!.mono = [true];
    tieClipplayerNote(id, 0, 2, 5, 60);
    expect(clipplayerClipAt(id, 0)!.steps).toHaveLength(1);
    const before = clipplayerClipAt(id, 0);
    for (const end of [-1, 1, 16]) tieClipplayerNote(id, 0, 2, end, 60);
    tieClipplayerNote(id, 0, 0, 5, 60);
    expect(clipplayerClipAt(id, 0)).toEqual(before);
  });
});
