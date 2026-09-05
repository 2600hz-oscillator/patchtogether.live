// packages/web/src/lib/ui/workflow/legacy-fallback.ts
//
// THE LANE-RENDER DECISION — the PURE rule that says what a module looks like
// in its workflow lane.
//
// It generalizes the dock-stub swap in Canvas.svelte's flowNodes derivation,
// whose only trigger used to be "the user docked this node". A module renders
// as one of three things:
//
//   • 'stub'   — the user explicitly docked it (the P2.5a path): a
//                DockStubCard in the lane, the module's real surface in the
//                dock rail.
//   • 'shell'  — the RACKLINE <ModuleShell> faceplate tile, at the LOD the zoom
//                calls for; EXPAND opens its full dock faceplate. This is what
//                a module renders unless it is one of the carve-outs below.
//   • 'native' — a type that renders no lane body at all and owns its own
//                surface (NON_SHELL_LANE_TYPES).
//
// This is a PURE render-time derivation: it reads only whether the user has
// docked the node and whether the type is a native snowflake, so it stays
// registry-free and trivially testable. It is NEVER persisted to the Y.Doc or
// to dockStore entries — the swap is transient view furniture, exactly like the
// pinned drawer, and persisting it would storm the CRDT and desync peers (see
// the cv-modulation-live-store-write + transient-dock disciplines). Zero-flake.

/** What a module renders as in its workflow lane (see the file header).
 *
 *  ⚠ THREE MEMBERS, AND THE SET IS CLOSED BY CONSTRUCTION: a node is either
 *  docked ('stub'), a snowflake that owns its own surface ('native'), or a
 *  faceplate tile ('shell'). There is no fourth thing a module can be, which is
 *  why `laneRenderKind` has no fall-through arm. */
export type LaneRenderKind = 'shell' | 'native' | 'stub';

/**
 * Node TYPES that are NOT swapped to the shell/placeholder even under the
 * preview — they keep rendering their real in-lane card. The set is down to ONE
 * member: the CADILLAC roaming sprite, which is already filtered out of
 * flowNodes upstream and has no SvelteFlow node body at all.
 *
 *   ⚠ `group` AND `sticky` USED TO BE THE OTHER TWO, described here as
 *   "organizational chrome with no module card to dock". Both modules are
 *   DELETED (owner ruling 2026-09-03: group and sticky are deleted entirely, not
 *   moved), so the entries went with the defs rather than being re-argued. That
 *   makes this set purely a CADILLAC carve-out, and worth saying plainly: it is
 *   no longer a list of modules awaiting a face — it is one non-module.
 *
 *   ⚠ THE SNOWFLAKE CLAUSE THIS LIST WAS BUILT AROUND IS NOW EMPTY. It read:
 *     "clipplayer + the remaining MIDI control surfaces — SNOWFLAKES whose lane
 *     face is a grid / launcher / mapper, not a ranked-knob skeleton (plan §6):
 *     they get bespoke faces in a later spike, and stay on the verbatim legacy
 *     card until then rather than a lossy placeholder". Every module it ever
 *     covered has now had that spike — `launchpadControlLeft`, `electraControl`,
 *     `controlSurface` and finally `clipplayer` (below) — and the surviving
 *     entries are organisational chrome and a roaming sprite, none of which is a
 *     module card at all. The clause's own warning was the reason it emptied
 *     rather than hardened: READ IT AS A CLAIM ABOUT EACH CARD, NOT AS A LABEL
 *     FOR THE GROUP; reasoning from the group label is how one of its entries
 *     outlived its reason by a whole consolidation.
 *   ⚠ videoOut USED TO BE IN THIS SET and is not any more (#1821). Its entry
 *     read: its BODY IS the live, freely-resizable output screen, and
 *     swapping it for a picture-less tile removed the ONLY user-viewable video
 *     output from the shell. That reasoning was about a tile with no picture,
 *     and it was right: a blank tile is not a monitor.
 *     It is no longer the alternative. videoOut now carries a real `face`, so
 *     its lane tile is a `ModuleShell` painting the LIVE `VideoTileThumb`, and
 *     the big picture moved to where the owner asked for it — right-click →
 *     DETACH DISPLAY, a free-floating resizable window with no patch wires
 *     (owner 2026-08-17: *"the card does not need the arbitrary resizing on the
 *     card, but i want to be able to right-click -> detach display"*).
 *     ⚠ The picture survives the swap only because the face ranks NOTHING:
 *     `laneBodyPlan`'s ROW branch returns `glyph: hasGlyph` unconditionally, and
 *     it is the PLATE branch — reached only by a face with more controls than a
 *     row holds — where ranked cells evict the glyph (#1785). A future param on
 *     this def would walk it toward that branch; `videoout-face-model.test.ts`
 *     asserts the tile keeps its picture at every tier so the day that happens
 *     is a red test rather than a silent regression.
 *   ⚠ cameraInput USED TO BE IN THIS SET and is not any more. Its entry named
 *     two things that lived ONLY on its card:
 *       (a) the live SOURCE — the card owns getUserMedia + the `<video>` element
 *           and hands it to the engine via `attachExternalSource` (see
 *           ./dom-source-modules). "Swapped for a tile, camera → OUTPUT is
 *           patched-but-black, and switching an already-running rack INTO the
 *           shell actively DETACHES the live camera on the card's onDestroy";
 *       (b) the DEVICE PICKER — a `<select>` populated from
 *           `enumerateDevices()`, persisted to `node.data.deviceId`. It is NOT
 *           a ParamDef, so no shell face CELL can render it (a `static` face
 *           cell is a dead dashed label by design — ModuleShell's controlCell).
 *           ⚠ THIS CLAUSE USED TO READ "no shell FACE can render it", AND THAT
 *           IS FALSE AS A GENERAL STATEMENT — the one word does real damage.
 *           A face is not only its cells: the `fullViewBody` extension slot is
 *           a plain Svelte component that can call `getActiveEngine()` and
 *           `enumerateDevices()` and render whatever it likes, which is exactly
 *           where cameraInput's picker went and where `midiclock`'s MIDI-input
 *           picker went after it. The true constraint is narrower and worth
 *           stating precisely: a runtime roster cannot be a `ParamDef`'s
 *           `options` (a roster is a fixed set known when the def is authored,
 *           and this one differs per machine), so it needs a SURFACE rather
 *           than a cell. Two agents in a row read the old sentence and
 *           concluded a platform change was required before a binder could be
 *           promoted; neither was.
 *     ⚠ (a) IS NO LONGER TRUE AT ALL, and it was already not true when this
 *     entry was last read. The claim describes the world BEFORE
 *     `<HeadlessSourceHost>` existed: cameraInput is in
 *     `DOM_SOURCE_LANE_TYPES` ⊂ `HEADLESS_MOUNT_LANE_TYPES`, and
 *     `needsHeadlessSourceMount` returns true for kind 'shell', so the shell
 *     keeps the real card mounted off-screen and the source is never orphaned.
 *     The onDestroy detach it feared was removed for the same reason (the
 *     `<video>` and its stream are NODE-owned — $lib/ui/media/node-media-registry).
 *     ⚠ (b) IS STILL TRUE and is answered rather than dodged: the picker moved
 *     into the faceplate's EXTENSION BODY
 *     ($lib/ui/modules/cameraInput/CameraInputOutputBody.svelte), which is the
 *     one slot that can hold a control no `ParamDef` can express.
 *     ⚠ AND THE REST OF THE CARD IS REACHED BY A NAMED SEAM, which is the part
 *     that had to be BUILT rather than merely re-argued. An off-screen host is
 *     `pointer-events: none`, so the card's "Request access" gesture — the only
 *     path to `getUserMedia` for a first-time visitor — and its recovery text
 *     become unclickable. `$lib/ui/media/camera-status-registry` publishes the
 *     card's capture state and registers its acquire command so the faceplate
 *     can show and drive them, WITHOUT a second getUserMedia owner existing.
 *     Parity was preserved first; the promotion followed.
 *   ⚠ launchpadControlLeft USED TO BE IN THIS SET and is not any more. Its
 *     entry was the #1579 anchor case — the list once named the unsuffixed
 *     `launchpadControl`, which resolves to NO def, so the carve-out silently
 *     never fired — and the id-drift half of that lesson is unchanged and still
 *     gated (`legacy-fallback.test.ts`: every member must resolve to a
 *     registered def, and the unregistered id must stay GONE).
 *     ⚠ WHAT DID NOT SURVIVE IS THE CARVE-OUT'S STATED REASON. It sat under the
 *     "grid / launcher / mapper" clause above, and that has not described this
 *     module since the LEFT + RIGHT cards were consolidated into one: the card
 *     is a title, four buttons, a status line and a docs hint — no canvas, no
 *     pad matrix, not even the colour legend the VRT exemption credited it with
 *     (that moved to LaunchpadDocs.svelte). The 8×8 matrix this module drives
 *     is on the HARDWARE, which is why nothing in the app ever painted it.
 *     ⚠ THE OTHER HALF OF THE CLAUSE WAS TRUE AND IS DISCHARGED, WHICH IS WHAT
 *     RETIRES THE ENTRY. "A placeholder tile would be LOSSY" is exactly right —
 *     `ModuleShellPlaceholder` offers no route to Pair, Connect single, Bind or
 *     the view segment, and those four gestures are the whole module. The face
 *     carries them: SINGLE and PAIR are ranked `action` cells and therefore
 *     reach the lane tile (only `panel` cells are dock-restricted), and BIND +
 *     the view segment are in the extension body
 *     ($lib/ui/modules/launchpadControl/LaunchpadBinderBody.svelte) because a
 *     `ShellActionCell.label` is a plain string and cannot flip between two
 *     opposite actions. Same shape as cameraInput's (b): the clause was true,
 *     and it was answered by building the surface rather than by re-arguing it.
 *     ⚠ AND THIS ONE NEEDED NO STATUS REGISTRY, because it is in NEITHER half
 *     of HEADLESS_MOUNT_LANE_TYPES — it owns no media element and pushes
 *     nothing into an engine handle — so its card is simply not mounted after
 *     promotion and there is no `pointer-events: none` host to reach through.
 *   ⚠ electraControl USED TO BE IN THIS SET and is not any more, and it was the
 *     LAST meta module in it. Its removal is not optional paperwork attached to
 *     the promotion — it is a PRECONDITION of it, for the reason
 *     launchpadControlLeft's inventory note already records: this set
 *     short-circuits `laneRenderKind` BEFORE `migrated` is read, so a carved-out
 *     type's lane can never become a shell. Two further mechanisms make it
 *     load-bearing rather than tidy: `FACES` (e2e/vrt/_shell-faces.ts) is
 *     asserted EQUAL to `STRICT_FACES` in both directions, so a promoted module
 *     MUST have VRT scenes; and `bootWithFace` waits on
 *     `.svelte-flow__node[data-id=…] [data-testid="module-shell"]`, which a
 *     carved-out type never renders. Membership and promotion are therefore
 *     mutually exclusive by construction, not by preference.
 *     ⚠ WHAT THE STATED REASON WAS, AND WHICH HALF SURVIVED. The "grid /
 *     launcher / mapper" clause above is TRUE of this card — it really is a 6×6
 *     mapper — and that half is not the operative one. The operative half is
 *     "…and keep the module's own full surface UNTIL THEN rather than a lossy
 *     stand-in": the alternative stopped being a stand-in once the face
 *     existed, exactly as for videoOut and launchpadControlLeft, and this PR is
 *     the "later spike" the clause defers to.
 *     ⚠ THE ARITHMETIC IS REAL AND IS ANSWERED RATHER THAN WAVED AWAY. The
 *     board's narrowest honest width is six 48 px columns plus bank gutters
 *     (`min-width: 360px` on the card) against SHELL_TILE_W = 192, so it cannot
 *     be a lane tile and `fullViewBody` is not painted at the lane. That is the
 *     same measurement on which controlSurface was refused — and it does not
 *     refuse this module, because THIS ONE'S DESIGN HOME IS NOT A LANE TILE.
 *     electraControl is the `E` of the M/E/C pin trio with `surface: 'drawer'`
 *     and `data.pinned`, so its always-on instance is canvas-hidden and has no
 *     lane tile at all; `dockRailRendersFace` flips its drawer to
 *     `<ModuleShell view='drawer'>`, and `dockFullViewHeadPlan` gates the body
 *     on `isFaceplateView(view)` (`view !== 'lane'`), so the board paints there
 *     at full faceplate width. For the instance every workflow rack has, the
 *     192 px number never applies. A SECOND, user-spawned canvas instance is
 *     reachable (graph/cap.ts excludes the pin from `maxInstances`), and for
 *     that one the board moves from inline-on-the-tile to one click away in the
 *     dock full view — the ordinary semantic-zoom contract every promoted module
 *     accepts, with no affordance lost.
 *     ⚠ AND THE PARENTHETICAL IN THAT ENTRY — "the same measurement on which
 *     controlSurface was refused" — DESCRIBES A REFUSAL THAT HAS SINCE BEEN
 *     OVERTURNED, see below; it is kept because it was true when the entry was
 *     written and the electraControl argument never rested on it.
 *   ⚠ controlSurface USED TO BE IN THIS SET and is not any more. Its refusal
 *     was the electraControl width arithmetic without electraControl's drawer
 *     escape: the free-growing pointer board (360–760 px, a function of how
 *     many sources are bound) cannot be a 192 px lane tile, and controlSurface
 *     is NOT pinned, so every instance lives in a lane. What retired the entry
 *     is that the measurement was taken BEFORE `tileBody` existed (#2242):
 *     the lane tile now carries the module's one OWN control (the LOCK, a
 *     ranked toggle cell over node.data.locked) plus a live strip of
 *     bound-source colours, and the board itself is one Expand away in the
 *     dock full view — the ordinary semantic-zoom contract, owner-approved for
 *     exactly this module (2026-08-31, owner-decisions item 10, on the
 *     electraControl precedent). The prune side effect the card owned moved to
 *     the tileBody (node-on-canvas lifetime), which is what keeps every
 *     surface prune-ful — including a USER-DOCKED node's rail occupant, which
 *     renders the FACE since the 2026-09-03 P0 removed `pinned` from
 *     `dockRailRendersFace`.
 *   ⚠ clipplayer USED TO BE IN THIS SET and is not any more. It was the entry
 *     the "snowflake" clause was actually true of: its card IS a launcher grid,
 *     and a ranked-knob skeleton in its place would have been a lane tile of
 *     three global playback knobs where a player expects to see which of eight
 *     lanes is sounding. What retired it is that the alternative is no longer a
 *     skeleton. The launch grid, the piano roll and the four eight-wide lane
 *     rows are PF-14 PANELS — the same kria route, one size up — so the dock
 *     full view paints the launcher at its real size; and the lane tile carries
 *     a `tileBody` strip of the eight lanes' live state plus a panic STOP, so
 *     the canvas still answers the only question a 192 px tile is asked. The
 *     rest of the card (transport, both recorders, the undo stack, the
 *     mute/stop deck, the monome bind, the arranger pop-out) is the module's
 *     `fullViewBody`, one Expand away — the ordinary semantic-zoom contract,
 *     owner-approved for exactly this module (2026-08-31, owner-decisions item
 *     10, alongside controlSurface). The owner previews the COMPACT tier before
 *     merge; the pinned `c`-pane instance is unchanged, since it already
 *     painted at faceplate width.
 *     ⚠ AND THE SPLIT-BRAIN THIS LIST USED TO CREATE IS WHAT IS BEING CLOSED,
 *     not worked around. `laneRenderKind` consults `NON_SHELL_LANE_TYPES` while
 *     `DockFullView` switches on bare `STRICT_FACES` membership, so promoting a
 *     module while leaving it here would have painted the CARD on the canvas
 *     and the FACEPLATE in the dock — two different instruments for one node,
 *     with no gate in the repo able to see it (`module-face-lint` reads the def,
 *     `faces-parity` drives the dock, and neither reads this set). Removing the
 *     entry in the SAME diff as the promotion is what keeps the two sides one
 *     instrument.
 * Everything else with a resolvable card swaps.
 */
export const NON_SHELL_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'cadillac',
]);

/** Inputs to the pure lane-render decision. */
export interface LaneRenderInput {
  /** The user has an explicit persisted dock ENTRY for this node. */
  userDocked: boolean;
  /** The module type id (n.type). */
  type: string;
  /** This type renders no lane body of its own — `NON_SHELL_LANE_TYPES`.
   *  Injected by the caller rather than looked up here so the decision stays
   *  pure and registry-free. */
  laneNative: boolean;
}

/**
 * The core lane decision. Order matters:
 *   1. an explicit user dock ALWAYS wins → 'stub' (the P2.5a contract is
 *      unchanged: a user who docked a module sees the stub in the lane and the
 *      real surface in the rail);
 *   2. an organizational-native type → 'native' (it has no lane body of its own
 *      — CADILLAC is filtered out of `flowNodes` upstream, and this arm is what
 *      keeps the function TOTAL rather than answering 'shell' for a node that
 *      will never be handed to `ModuleShell`);
 *   3. otherwise the faceplate.
 *
 * ⚠ IT NO LONGER ASKS WHETHER THE TYPE IS MIGRATED, and that is a fact about
 * the fleet rather than a relaxation. The question existed to route un-migrated
 * types to a placeholder skeleton; the inventory reports 195 registered / 194
 * faced-and-promoted / 1 organizational-native / 0 remaining, so the branch had
 * no population to route. A module shipping without a face is now caught where
 * it should be — `module-face-lint`, at the def — instead of by silently
 * rendering a different lane body.
 *
 * PURE — same inputs, same output, no side effects.
 */
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  return i.laneNative ? 'native' : 'shell';
}

/** The xyflow node TYPE to emit for a decided lane kind. `'native'` emits the
 *  module's own type, which resolves to nothing in `nodeTypes` — the only
 *  member is filtered out of `flowNodes` before it reaches xyflow. */
export function emittedTypeFor(kind: LaneRenderKind, moduleType: string): string {
  switch (kind) {
    case 'stub':
      return 'dockStub';
    case 'shell':
      return 'moduleShell';
    case 'native':
    default:
      return moduleType;
  }
}

/** True when a type renders NO lane body of its own — the `'native'` arm's
 *  input. `isShellSwappable(type, hasResolvableCard)` stood here and asked the
 *  opposite question with a second term: "does this type resolve to a real CARD
 *  and is it not an excluded snowflake". The card half has no referent any more,
 *  so what is left is the snowflake half, stated positively. */
export function isLaneNative(type: string): boolean {
  return NON_SHELL_LANE_TYPES.has(type);
}

// ── EVERY DOCK-RAIL OCCUPANT RENDERS ITS FACEPLATE ──────────────────────────
//
// The rule above answers "what does this module render as IN ITS LANE". A DOCK
// RAIL occupant — the `m` tray, a user-docked module, the 🎧 topbar panel — is
// a separate surface, and it has no decision to make: there is one thing a
// module can render, so `DockCardHost` mounts it unconditionally.
//
// ⚠ THAT WAS ONCE A THREE-INPUT RULE, AND THE LESSON FROM IT IS LIVE EVEN
// THOUGH THE RULE IS NOT. A pure rule with an INJECTED input is only as good as
// its call sites, and nothing in the type system can tell you a caller is
// missing. Three separate hosts had to be found by hand, one of them only after
// the owner reported it on screen — and the fourth, the topbar 📷 CAMERA
// MANAGER, has now been missed TWICE (see the note on `emittedTypeFor` below).
//
// THE GENERAL FORM, for whoever adds a fifth: when you mount a module surface
// somewhere new, decide what it renders THERE. The default is a decision too.
//
// ⚠ AND THERE IS A HOST THAT IS NOT A `DockCardHost` AT ALL, WHICH IS WHY THE
// "fourth host" WARNING DID NOT CATCH IT — TWICE. The workflow topbar's 📷
// CAMERA MANAGER (`$lib/ui/workflow/CameraSurface.svelte`) keeps one
// always-mounted `<SvelteFlow nodeTypes={…}>` per mapped camera; that is the
// surface the owner's P0 screenshot calls the "top camera area", and for a
// `hiddenCard` camera it is the module's ONLY surface.
//
// It emitted `type: node.type` into a `nodeTypes` map that no longer has a
// per-module entry, so it resolved NOTHING and painted a blank host — a
// streaming camera whose picture and source picker had both silently gone. It
// now emits through `emittedTypeFor`, the same helper the lane uses, so a
// future change to this switch cannot miss it a third time.
//
// ⚠ THE CAMERA IS NOT OWNED BY ANY SURFACE, and an older note here said it was.
// `getUserMedia`, the MediaStream and the permission machine belong to
// `$lib/ui/media/node-camera-source-registry`, on GRAPH lifetime. A mapped
// camera streams with nothing mounted for it at all — which is why the blank
// host was a RENDERING bug and not a dead camera, and why fixing it needed no
// ownership move.

