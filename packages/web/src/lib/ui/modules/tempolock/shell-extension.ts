// packages/web/src/lib/ui/modules/tempolock/shell-extension.ts
//
// The TEMPOLOCK shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot: the LOCK + BEAT status lamps.
//
// `tempolockDef.face.extension: 'tempolock'` declares this file; the id IS
// this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WITH ONE RANKED CELL ON THE FACE. The module's product
// is a JUDGEMENT — "I am confidently locked at this tempo" — and no ParamDef
// can carry it: `locked` is on a jack, but a jack needs a cable and a
// consumer to be read, and the tracked BPM exists nowhere else a face may
// reach. `StatusLed` is the only status surface a face may use
// (face-rack-status-source's roster), so the two lamps live here, dock-only
// by `dockFullViewHeadPlan`. The BPM VALUE rides the LOCK lamp's detail —
// aria/title, never a text node (see TempolockStatusBody's header).

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TempolockStatusBody from './TempolockStatusBody.svelte';

export default {
  fullViewBody: TempolockStatusBody,
} satisfies ShellExtension;
