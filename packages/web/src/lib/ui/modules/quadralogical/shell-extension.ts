// packages/web/src/lib/ui/modules/quadralogical/shell-extension.ts
//
// The QUADRALOGICAL SHELL EXTENSION — the module-owned end of the extension
// seam (#1512), joining the `fullViewBody` cohort.
//
// `quadralogicalDef.face.extension: 'quadralogical'` declares this file — the
// id IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a quadralogical component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY THIS ONE CARRIES MORE THAN A PICTURE, and it is the first body that
// does. Every other adopter's body is a preview canvas plus its SCREEN switch;
// the CONTROLS all live in bands. Here the module's picture and its primary
// CONTROL are the same surface — the joystick sits ON TOP of a live 2×2
// preview of the four inputs it is mixing — so the pad itself is inside this
// body, declared `face.xyPads[0].surface: 'body'` so the dock does not also
// paint it in a band. That declaration is checked in both directions
// (`module-face-lint`'s inverted zero-cell assertion and
// `face-xy-body-source.test.ts`), because a `'body'` pad whose body does not
// paint it is not a no-op — it is a deleted control.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb` and the generic `XyPad`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import QuadralogicalScreenBody from './QuadralogicalScreenBody.svelte';

export default {
  fullViewBody: QuadralogicalScreenBody,
} satisfies ShellExtension;
