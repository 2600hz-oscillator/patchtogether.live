import { patch, undoManager } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { CRUTCHFIELD_DEFAULTS, nextSensorSeed } from '$lib/video/backdraft/crutchfield';

/** One persisted, undoable camera change. Running history is deliberately
 * retained: replacing the camera response should perturb the live loop. */
export function rerollBackdraftSensor(nodeId: string): boolean {
  const node = patch.nodes[nodeId];
  if (!node || node.type !== 'backdraft') return false;
  const seed = nextSensorSeed(node.params.sensorSeed ?? CRUTCHFIELD_DEFAULTS.sensorSeed);
  undoManager.stopCapturing();
  setNodeParam(nodeId, 'sensorSeed', seed);
  undoManager.stopCapturing();
  return true;
}
