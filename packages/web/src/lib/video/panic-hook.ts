// packages/web/src/lib/video/panic-hook.ts
//
// The PANIC seam between a video module factory and the graph layer.
//
// A module's `edge: 'trigger'` PANIC input is detected in its factory's
// `setParam` (the bridge-replay clock — the only place a replayed pulse is
// visible, #1725), but the reset it fires is a GRAPH edit: one LOCAL_ORIGIN
// Y.Doc transaction, so it syncs to collaborators and lands on the undo stack.
// No engine-layer file imports the live store (`$lib/graph/store`), and this
// file keeps it that way: the factory calls `requestVideoPanic(nodeId)`, and
// the handler — registered at engine boot (Canvas.svelte), where graph and
// engine already meet — routes it to the module's reset implementation
// ($lib/ui/modules/backdraft/panic.ts). One implementation, two triggers: the
// faceplate PANIC button calls the same reset directly.
//
// Unregistered (unit tests driving a bare factory; a torn-down engine) the
// request is a safe no-op and says so via the return value.

export type VideoPanicHandler = (nodeId: string) => void;

let handler: VideoPanicHandler | null = null;

/** Canvas registers the graph-side reset at engine boot; null on teardown. */
export function setVideoPanicHandler(h: VideoPanicHandler | null): void {
  handler = h;
}

/** Fire the registered panic handler for `nodeId`. Returns whether a handler
 *  was there to receive it — false is the honest "nothing happened". */
export function requestVideoPanic(nodeId: string): boolean {
  if (!handler) return false;
  handler(nodeId);
  return true;
}
