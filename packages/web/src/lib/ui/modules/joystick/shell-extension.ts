// packages/web/src/lib/ui/modules/joystick/shell-extension.ts
//
// The JOYSTICK SHELL EXTENSION — one slot, `fullViewBody`: the real XY pad at
// the head of the dock full view.
//
// `joystickDef.face.extension: 'joystick'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell
// loads it lazily and never imports a joystick component itself
// (module-shell-import-guard).
//
// ⚠ THIS IS THE TWO-ORDINARY-CELLS FALLBACK (owner decision 2026-08-31), NOT
// the quadralogical shape, and the difference is the whole design:
// quadralogical declares `face.xyPads[].surface: 'body'`, so its body IS the
// pad cell and carries the shell's cell contract (`data-cell-kind`,
// `data-control-params`, the `control-pos_x` anchor). joystick declares NO
// `xyPads` at all — a pad-only face resolves to ZERO lane controls, which
// `module-face-lint` denies, and widening that gate to see a `tileBody` is an
// owner-declined gate edit. Instead `pos_x`/`pos_y` rank as two ordinary knob
// cells (the lane tile paints them; at the dock they are the parity-credited
// controls), and THIS body paints the real pad ABOVE that band as the
// module's own surface. It therefore must NOT carry the cell contract — a
// `control-*` anchor here would double-count both axes in faces-parity's
// exact multiset, and `data-control-params` would trip
// `face-xy-body-source.test.ts`'s inverse leg (a painted pad no def declares
// as body-painted). `joystick-face-model.test.ts` holds both absences.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import JoystickPadBody from './JoystickPadBody.svelte';

export default {
  fullViewBody: JoystickPadBody,
} satisfies ShellExtension;
