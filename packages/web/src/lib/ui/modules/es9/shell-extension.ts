// packages/web/src/lib/ui/modules/es9/shell-extension.ts
//
// The ES-9 shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `es9Def.face.extension: 'es9'` declares this file; the id IS this
// directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN TWENTY-FOUR CONTROLS ARE CELLS. Exactly one thing
// on this module cannot be a cell, and it is not a control: the three LAMPS.
// `StatusLed` is the ONLY status surface a face may use — the positive form of
// the resting-text ruling — and it is rendered from a module-owned
// `fullViewBody` and nowhere else. There is no generic site for it, by design:
// a lamp indicates something only this module knows.
//
// ⚠ AND IT IS *ONLY* THAT. Every control the face ranks — CONNECT, DISCONNECT
// and the twenty-two jack classes — is a real cell and none of them is
// duplicated here. A body that also carried them would be a second
// implementation of controls the face already owns.
//
// ⚠ es9 NEEDS NO STATUS REGISTRY, and the reason is worth stating because
// `cameraInput` needed one. Camera had to build a registry because promotion
// parks its real card in `<HeadlessSourceHost>` — mounted so the stream
// survives, `pointer-events: none` so nothing on it is clickable — and the body
// needs the card's own published state. es9 is in NEITHER
// `DOM_SOURCE_LANE_TYPES` NOR `CARD_PRODUCER_LANE_TYPES`, so nothing keeps its
// card alive after promotion and nothing needs to: the connection already lives
// in a node-keyed engine-side registry (`$lib/audio/es9/bridge-owner`) that was
// built for exactly this, on GRAPH lifetime. The registry `cameraInput` had to
// invent is the thing es9 already had.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the ranked cells, which is the half that matters
// there — and CONNECT, the gesture this module is silent without, is one of
// them.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import Es9BridgeBody from './Es9BridgeBody.svelte';

export default {
  fullViewBody: Es9BridgeBody,
} satisfies ShellExtension;
