import { beforeEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { rerollBackdraftSensor } from './reroll-sensor';
import { nextSensorSeed } from '$lib/video/backdraft/crutchfield';

beforeEach(() => {
  ydoc.transact(() => {
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    patch.nodes.camera = { id: 'camera', type: 'backdraft', domain: 'video', position: { x: 0, y: 0 }, params: { tvMode: 3, sensorSeed: 167, feedback: 1.1 } };
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
});

it('rerolls only the saved seed, replicates through Yjs, and undoes one camera at a time', () => {
  expect(rerollBackdraftSensor('camera')).toBe(true);
  expect(patch.nodes.camera!.params.sensorSeed).toBe(nextSensorSeed(167));
  expect(patch.nodes.camera!.params.feedback).toBe(1.1);
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
  expect(replica.getMap('nodes').toJSON()).toEqual(ydoc.getMap('nodes').toJSON());
  expect(rerollBackdraftSensor('camera')).toBe(true);
  undoManager.undo();
  expect(patch.nodes.camera!.params.sensorSeed).toBe(nextSensorSeed(167));
  undoManager.undo();
  expect(patch.nodes.camera!.params.sensorSeed).toBe(167);
  replica.destroy();
});

it('does nothing for a missing or unrelated module', () => {
  expect(rerollBackdraftSensor('missing')).toBe(false);
  ydoc.transact(() => { patch.nodes.camera!.type = 'shapes'; });
  expect(rerollBackdraftSensor('camera')).toBe(false);
  expect(patch.nodes.camera!.params.sensorSeed).toBe(167);
});
