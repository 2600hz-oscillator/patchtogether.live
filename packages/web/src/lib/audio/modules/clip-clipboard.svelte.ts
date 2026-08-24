// packages/web/src/lib/audio/modules/clip-clipboard.svelte.ts
//
// THE ONE clip clipboard. The typed COPY BUFFER that every surface which copies
// or pastes a clip reads and writes — the Launchpad (and therefore Push 2, which
// injects itself as that singleton's surface port rather than forking parity
// logic) and, since 2026-08-23, the card's note right-click menu.
//
// WHY IT MOVED HERE. The buffer used to be a module-level `let` inside
// launchpad-control.svelte.ts. That was correct while only one surface could
// copy: the owner then asked for copy/paste on the card's note menu that "work
// the same as when we copy/paste on the push or launchpad", and "the same" is
// not merely the same SEMANTICS — a second buffer would mean copying on the card
// and pasting on the Launchpad silently pastes the wrong clip (or nothing). ONE
// buffer is the only shape in which the two surfaces are the same clipboard.
//
// WHAT IT IS NOT. This module owns the BUFFER, not the WRITE. Reading a clip
// into the buffer and applying a paste both stay with the surface, because the
// undo origin differs per surface (the card writes through clip-undo.ts's
// per-node UndoManager; the Launchpad tags LAUNCHPAD_UNDO_ORIGIN) and unifying
// those is a separate, deliberate follow-up that clip-undo.ts:22-32 already
// documents. The PURE copy/paste math likewise stays in clip-types.ts
// (`copyClip`, `pasteApplies`, `readScene`, `sceneWritePlan`) — this file adds
// no math and no policy, only the shared state and its typed accessors.
//
// PER-MACHINE, NEVER SYNCED. A clipboard is a property of the person at the
// keyboard, not of the rack: it is deliberately NOT a Y.Doc field, so two
// collaborators hold independent buffers and neither can paste out from under
// the other. It also survives a surface re-bind on purpose (unplugging a
// Launchpad must not empty your clipboard).
//
// The state is a rune so a surface can DERIVE from it — the card's PASTE item
// disables itself the moment the buffer empties. The Launchpad renders LEDs
// imperatively and simply reads it.

import type {
  AutoClipRecord,
  CopyBuffer,
  CopyBufferKind,
  NoteClipRecord,
} from './clip-types';

/** The typed buffer: one clip, or a whole scene. `null` = empty clipboard. */
let buffer = $state<CopyBuffer | null>(null);

/** The clip-kind buffer's SOURCE clip index — the Launchpad paints a turquoise
 *  glow on the pad a clip was copied FROM. `null` for a scene buffer (a scene
 *  has no single source pad) and for an empty clipboard. */
let sourceIndex = $state<number | null>(null);

/** The whole buffer, or null when the clipboard is empty. */
export function clipboardBuffer(): CopyBuffer | null {
  return buffer;
}

/** Load the clipboard. `srcIndex` is the source clip index for a CLIP buffer
 *  (the Launchpad's source glow); pass null for a scene, which has no single
 *  source pad. */
export function setClipboardBuffer(next: CopyBuffer, srcIndex: number | null = null): void {
  buffer = next;
  sourceIndex = srcIndex;
}

/** Empty the clipboard — turns off the Launchpad's turquoise source glow and its
 *  deck COPY-INDICATOR, and disables the card menu's PASTE. */
export function clearClipboard(): void {
  buffer = null;
  sourceIndex = null;
}

/** The clip-kind buffer's source clip index, else null. */
export function clipboardSourceIndex(): number | null {
  return sourceIndex;
}

/** The buffered CLIP (buffer kind === 'clip'), else null. Every single-clip
 *  paste path reads through this, so a SCENE buffer can NEVER paste onto a
 *  single clip — scene→clip and clip→scene are no-ops by the type gate
 *  (`pasteApplies`), not by each caller remembering to check. */
export function clipboardClip(): NoteClipRecord | null {
  return buffer?.kind === 'clip' ? buffer.clip : null;
}

/** The buffered clip's SIBLING AUTOMATION, or null when the source carried none
 *  (or the buffer is a scene). THE ENVELOPE BELONGS TO THE CLIP: a paste writes
 *  this alongside the notes in one transaction, and a null DELETES the target's
 *  stale record rather than leaving a ghost envelope under foreign notes. */
export function clipboardClipAuto(): AutoClipRecord | null {
  return buffer?.kind === 'clip' ? buffer.auto : null;
}

/** True when ANY buffer (clip OR scene) is loaded. */
export function clipboardLoaded(): boolean {
  return buffer !== null;
}

/** The buffer kind ('clip' | 'scene'), or null when empty — drives the
 *  Launchpad's distinct paste colour and its paste-arm target dimming. */
export function clipboardKind(): CopyBufferKind | null {
  return buffer?.kind ?? null;
}

/** Test-only reset. The clipboard is module-level singleton state, so a spec
 *  that loads it leaks into the next one without this. */
export function __test_resetClipboard(): void {
  buffer = null;
  sourceIndex = null;
}
