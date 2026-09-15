// The LINNSTRUMENT SHELL EXTENSION — one slot, `fullViewBody`: the three
// joystick pads, the link lamp and the two region lamps at the head of the
// dock full view.
//
// `linnstrumentDef.face.extension: 'linnstrument'` declares this file — the id
// IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell
// loads it lazily and never imports a linnstrument component itself.
//
// ⚠ THE JOYSTICK SHAPE, three times (owner decision 2026-08-31 on #1974): the
// def declares NO `xyPads` — a pad-only face resolves to zero lane controls —
// so the six axes rank as ordinary knob cells and THIS body paints the pads
// above them as the module's own surface. It therefore carries no cell
// contract: no `control-*` anchor, no `data-control-params`, no `data-cell-*`
// — any of them would double-count an axis in faces-parity's exact multiset.
// `linnstrument-face-model.test.ts` holds the absences.
//
// ⚠ NOTHING ONGOING LIVES HERE. Every pad drag is a reducer intent through
// `linnstrument-cell-actions.ts`; the CVs, the buses, the arps and the device
// subscription are the factory's and run with this body unmounted.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LinnstrumentPadsBody from './LinnstrumentPadsBody.svelte';

export default {
  fullViewBody: LinnstrumentPadsBody,
} satisfies ShellExtension;
