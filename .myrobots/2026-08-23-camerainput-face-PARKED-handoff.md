# PARKED: the cameraInput FACE (option A, as built) — handoff

**Status: parked, awaiting an owner decision on the lane surface.** Nothing here is
broken; it is blocked on a product/platform choice, not on a defect. The CARD half of
the same directive shipped separately (minimalist card + the `deviceId` tracking fix +
its positive-controlled gate) and carries no promotion, so it is safe on main whatever
the owner decides.

Branch contents: the `face` block on `camera-input.ts`, the extension body
(`CameraInputOutputBody.svelte` + `shell-extension.ts`), and the registry entries
(`STRICT_FACES`, `EXTENSION_BODY_ROLES`, the VRT roster with its `simPin`, the
`face-screen-render` SUBJECTS row, the inventory disposition move, and the
`CARD-OWNED SOURCE` gate narrowing).

## Why it is parked

The directive asked for a face AND an authored minimalist card. Option (A) delivered
both by promoting the module for the DOCK while leaving its real card in the LANE —
`cameraInput` is in `NON_SHELL_LANE_TYPES`, so `laneRenderKind` returns `'legacy'`
whatever `migrated()` says, while the dock reads `migrated()` alone.

**That is structurally blocked, and the blocker is not fixable inside this PR.**

Measured, not assumed:

```
NON_SHELL members: group, sticky, cadillac, clipplayer, controlSurface,
                   electraControl, launchpadControlLeft, cameraInput
videoOut in set?               false
FACED modules also NON_SHELL:  []      <- empty
```

So cameraInput would be the FIRST faced module whose lane renders a card, and the fleet's
face specs all assume the opposite. ⚠ Note the misleading comment that cost time:
`legacy-fallback.ts` describes the carve-out as using "the mechanism already proven for
videoOut", which reads as though videoOut is a faced carve-out member. It is not in the
set at all.

Three specs break on the same locator:

| spec | site | what it does |
|---|---|---|
| `faces-parity.spec.ts` | :300 | finds `[data-testid="module-shell"]` in the lane, clicks `shell-open-dock` |
| `face-screen-render.spec.ts` | :342 (`openDockFor`) | identical pattern |
| `workflow-shell-faces.spec.ts` | :359 | the COMPACT scene screenshots the lane's `module-shell` — no subject at all |

⚠ **`faces-parity` cannot be opted out of.** It is REGISTRY-DRIVEN off `STRICT_FACES`
(lines 22/63), so it auto-enrols cameraInput the instant it is promoted — the very act
that creates the face. And that file explicitly refuses the workaround at line 919:
"REGISTRY-DRIVEN off STRICT_FACES instead of growing a per-module branch here."

⚠ `FACES_WITHOUT_SCENES` does NOT rescue this. It excuses VRT scenes only; `faces-parity`
still enrols and still fails. Checked before proposing it.

## The two futures

**(B) FULL PROMOTION — remove `cameraInput` from `NON_SHELL_LANE_TYPES`.** Everything in
this branch then works unchanged, because the module looks like every other faced one.
The source survives by a proven mechanism: cameraInput ∈ `DOM_SOURCE_LANE_TYPES` ⊂
`HEADLESS_MOUNT_LANE_TYPES`, and `needsHeadlessSourceMount` returns true for
`kind === 'shell'`, so `HeadlessSourceHost` mounts the real card off-screen and keeps
`getUserMedia` alive.
Cost: one set member, plus `dom-source-modules.test.ts:819`, which asserts that
membership deliberately and must be updated with its reason rewritten.
⚠ Trade: the minimalist card becomes invisible in shell mode (it runs headless). It
remains visible under `?shell=legacy`.
⚠ Lineage: this reverses a carve-out created in response to an owner P0 ("no video at
all"), on a module CI cannot exercise. Owner sign-off territory.

**(D) STAY UNFACED** — what shipped. The card work stands on its own; this branch waits.

## If (B) is chosen, the work is small

1. Remove `'cameraInput'` from `NON_SHELL_LANE_TYPES`, rewriting the block comment that
   explains why it was there (it is long and specific — do not just delete the name).
2. Update `dom-source-modules.test.ts:819` and the note in `dom-source-modules.ts` that
   says cameraInput "is never swapped and never needs the headless host" — that sentence
   becomes false and is load-bearing documentation.
3. ⚠ Re-narrow or REVERT the `CARD-OWNED SOURCE` narrowing in
   `face-migration-inventory.test.ts`. It currently exempts generic-face modules whose
   card always mounts, reading the live `NON_SHELL_LANE_TYPES`. Under (B) cameraInput
   leaves that set, so the exemption stops applying to it automatically — which is the
   designed behaviour, but it means the gate will demand the module NOT be generic-face
   unless the hazard is re-argued for the headless-host case. Decide deliberately; do not
   widen the predicate to make it pass.
4. Everything else on this branch is already correct for (B), including the VRT `simPin`
   and both scenes.

## What is worth keeping regardless

- The `__camerainputTestFrame` `simPin` finding: the face IS capturable despite the
  live-MediaStream exemption, because that exemption is about the CARD scene.
- The rescoped `EXEMPT_FROM_VRT` entry (card stays exempt; face scenes capture).
- The blit-never-adopt rule for the node-owned `<video>` — the single most dangerous
  trap in this module, documented in the body's header.
