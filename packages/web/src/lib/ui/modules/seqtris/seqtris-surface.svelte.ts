// packages/web/src/lib/ui/modules/seqtris/seqtris-surface.svelte.ts
//
// THE `revision` SEAM, PROMOTED OUT OF ONE COMPONENT AND MADE SHARED.
//
// `SeqtrisCard.svelte` carries `let revision = $state(0)`, bumped after every
// user action so the derived that calls `api().launchpadStatus()` re-runs. That
// read is NOT reactive — the binder keeps `kind` / `ports` / `portName` in a
// per-binding closure in `seqtris-launchpad.ts`, deliberately, so it survives
// with no UI mounted — and the counter is the only thing that invalidates it.
// ⚠ OMIT IT AND THE STATUS LINE, THE LED AND THE CONNECT/UNBIND SWAP NEVER
// UPDATE. Silent, and no gate in the tree sees it.
//
// ⚠ WHY IT IS MODULE-SCOPE HERE AND WAS COMPONENT-SCOPE ON THE CARD, and it is
// a correctness change rather than a tidy-up. A faced module's LANE TILE and
// its open DOCK pane are two component instances mounted AT THE SAME TIME
// (`ModuleShell` gates the tile slot on `!extBody`, but that is per shell
// instance, not per node). The dock owns the gestures; the tile owns a bind
// lamp. A per-component counter would leave the tile's lamp frozen at whatever
// it read on mount while the dock beside it showed `bound` — two surfaces
// disagreeing about one hardware claim, which is exactly the failure the
// one-flag-two-surfaces rule exists to prevent.
//
// ⚠ AND THE CLAIM IT MIRRORS IS ITSELF MODULE-SCOPE. `owner` in
// `seqtris-launchpad.ts` is one token for the whole page — binding node A flips
// node B's status from `idle` to `claimed`. So the invalidation has to be
// page-wide too; a per-node counter would be a narrower signal than the state
// it is watching, and node B's lamp would lie.
//
// ⚠ NOT `node.data`, and not the Y.Doc. This is a pure INVALIDATION TICK for a
// non-reactive read of DEVICE-SERVICE state that lives on this machine. It is
// not durable, not collaborative and not per-node; writing it to the graph
// would be a per-gesture store write for something no collaborator can act on
// (`cv-modulation-live-store-write-storm`, one seam over). `previewCollapsed`
// is the opposite case and correctly DOES live on the node.
//
// Cost: one integer per page, bumped on a click. Never on a frame, never on a
// clock pulse — the board has its own push seam (`api().subscribe`).

/** ⚠ Accessor-wrapped rather than exported directly: a bare `export let` of a
 *  rune is `state_referenced_locally`, and `runes-module-warnings.test.ts`
 *  compiles this file with the real Svelte compiler and fails on ANY warning.
 *  (`node-versions.svelte.ts` is the shape being followed.) */
let revision = $state(0);

/** Read inside a `$derived` to subscribe to it. Returns the tick, which is
 *  meaningless on its own — `void seqtrisRevision()` is the intended call. */
export function seqtrisRevision(): number {
  return revision;
}

/** Every user gesture that can move the binder's closure state calls this:
 *  CONNECT, pick-a-port, unbind. A scene-button press calls it too, because
 *  `press()` can reach `changed()` and a caller should not have to know which
 *  of the two seams moved. */
export function bumpSeqtrisRevision(): void {
  revision++;
}
