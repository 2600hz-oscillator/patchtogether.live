import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';
const messages = new SvelteMap<string, string>();
/** Shared, local feedback for hardware gestures and the open Clip Player. */
export function clipplayerAudioFeedback(nodeId: string): string { return messages.get(nodeId) ?? ''; }
export function setClipplayerAudioFeedback(nodeId: string, message: string): void {
  messages.set(nodeId, message);
  for (const id of messages.keys()) if (!patch.nodes[id]) messages.delete(id);
}
