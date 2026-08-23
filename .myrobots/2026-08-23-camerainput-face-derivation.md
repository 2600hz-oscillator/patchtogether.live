# CAMERA — face + minimalist card, derived 2026-08-23

Owner directive, 2026-08-23: a cameraInput faceplate and an authored minimalist
card, as ASAP priority, both surfaces in one PR.

Everything below was read out of the live tree, not inferred from the roster.

## The fork that turned out not to be one

cameraInput is in `NON_SHELL_LANE_TYPES`. The expected shape of this work was
"remove the carve-out so the lane can show a face", which is a platform change
with an owner-P0 history. Tracing it instead showed the carve-out does not need
to move at all:

- `laneRenderKind` is `if (!shellFaces || !hasCard) return 'legacy'`, and
  `hasCard` is `isShellSwappable(...)`, which is false for a carve-out member.
  So the LANE renders the real card **whatever `migrated()` says**.
- `DockFullView` reads `migrated()` alone.

So promoting cameraInput gives the DOCK a faceplate and leaves the LANE showing
its real card — which is exactly what the directive asked for, because the same
directive orders an authored minimalist CARD. The lane surface is supposed to be
a card here. Chosen over the alternative (full promotion + `HeadlessSourceHost`)
because nothing in the ask required reverting a carve-out born from an owner P0
on a module CI cannot exercise.

**Consequence worth stating on its own: functional parity is TOTAL, which is
unique in this fleet.** Promotion normally deletes the card, and every card-only
affordance must be rebuilt or the module cannot be promoted (the samsloop STOP-2
refusal). Here nothing is removed anywhere — getUserMedia, the permission
machine, the presence badge and the local-only hint all stay reachable in the
lane, and the face is purely additive.

## Zero attest, and why the picker cannot be a param

`params` is untouched: `enabled`, `mirror`, `gain`, `fillMode` were already
correctly typed. Device selection is `node.data.deviceId`, enumerated at runtime
from the browser.

That is not a gap to fix — a `ParamDef` roster is a fixed set known when the def
is authored, and this one differs per machine and changes when hardware is
plugged in. So the picker can never be a face cell, and `controlCell` renders a
`static` cell as a dead dashed label by design. The extension body is the only
slot that fits, which is also where the SCREEN switch already lives.

Also recorded: none of the three two-state params needs a momentary/latching
classification, unlike every other faced two-state param so far. `looksLikeSwitch`
is `looksLikeToggle(p) && p.defaultValue === 0`, and all three default to **1** —
a camera arrives on, mirrored and filling.

## Two traps found by reading rather than by failing

**1. The `<video>` element must be BLITTED, never adopted.** It is owned by the
NODE and adopted into the card at runtime. A DOM node has one parent, so a face
body that adopted it would steal it from the card — and the card owns
getUserMedia, the stream and the permission machine. "Port the card's preview"
is the obvious move and it would have silently killed capture the moment the
dock opened. The body reads the module's own output texture instead.

**2. The card hydrated `deviceId` ONCE on mount.** A pick made anywhere else was
saved and never acted on until a remount. Invisible while the card held the only
picker; it stops being invisible the moment the dock face has one. Fixed by
tracking the saved id, guarded three ways (only on a real difference, only for a
non-null id, and reusing `shouldReacquireOnPick` so the states that refuse a
local re-acquire refuse this one too). The card's own header already promised
this behaviour — "each user's browser tries to match it to a local camera" — so
hydrate-once was under-delivering on a documented claim.

## The lamp reports what the GRAPH knows, and nothing else

The card's `camState` (idle / requesting / streaming / permission-denied /
device-in-use / …) is browser-local `$state` and deliberately NOT in Yjs: a
permission grant is a property of one person's browser, and syncing it would be
a lie about everyone else's. The engine exposes `attachExternalSource` but no
query, so attachment is not readable either.

So the face lamp answers only what the shared graph can answer — is a camera
chosen, is capture enabled — and defers everything about permission to the card,
which is always present in the lane. Inventing a second permission machine in
the body would have forked ownership of the stream. That is the designed
no-device state rather than an error hole.

## The face is capturable despite the live stream

`cameraInput` sits in `EXEMPT_FROM_VRT` ("live MediaStream defeats deterministic
capture"). The instruction in flight was to DELETE that entry if the face
captured. Reading the file first showed that would have been wrong twice:

- the `scoreboard` entry three lines above already establishes that these
  entries are about the **legacy card scene** — "a different surface with a
  different baseline" — and scoreboard kept its card exemption while gaining
  face scenes; and
- `ALLOWED_PERMANENT_EXEMPT` is ANCHORED, so removing a module from
  `EXEMPT_FROM_VRT` while it is still named there is RED.

The entry was RESCOPED instead: the card scene stays exempt (and on this module
the card always renders, so there is no version of it without a MediaStream),
while the face scenes capture normally via `simPin: __camerainputTestFrame` —
the module's own flag-gated seam that uploads a fixed synthetic checker,
"identical on every build → frame-stable", with no getUserMedia dependency. The
same seam the attest smoke already uses, and the reason CI having no camera does
not matter.

## A gate that refused the promotion, correctly, on a premise that does not hold here

`face-migration-inventory.test.ts` has a CARD-OWNED SOURCE gate: no
`generic-face` module may be in `DOM_SOURCE_LANE_TYPES`, because "a face over it
renders controls for a dead source".

The hazard is real for eight of the nine members. It cannot occur for
cameraInput, because it is also in `NON_SHELL_LANE_TYPES` and its card therefore
always mounts — `dom-source-modules.ts` documents exactly this ("its real card
always renders in the lane, so it is never swapped and never needs the headless
host").

Fixed by narrowing the PREDICATE to read the live `NON_SHELL_LANE_TYPES` set,
not by adding an exemption name: there is nothing to go stale, and a module that
LEAVES the carve-out becomes an offender again immediately, which is precisely
the review that removing such a carve-out should trigger. A negative control
asserts the narrowing is real (someone is covered), not universal (most members
are not), and that the predicate still says no for every swappable member.

Its sibling gate — the disposition — was also right to refuse: cameraInput was
`bespoke-surface` with a `needs-media-controller` blocker. That blocker assumed
promotion deletes the card. It does not, so the blocker no longer applies and
the disposition moved to `generic-face`.

## Near-miss worth recording: two concurrent bumps on a generated artifact

Diagnosing the red shard led to the right fix — recost the e2e timings from a
run that is red on CAPACITY but has valid per-spec times. That fix was already
in flight as its own PR, opened hours earlier on the same reasoning.

Had it been duplicated onto a second branch, two concurrent bumps would have
landed on one GENERATED artifact — the exact conflict class that generated files
are meant to avoid by being regenerated rather than hand-merged. The habit that
avoided it is cheap: before performing a repo-wide accept, check whether an open
PR already owns it.
