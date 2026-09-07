# batch-22 — video thin-tail blitz: derivation, banked (no code written)

Lane stood down on an owner token-budget directive before building group 1.
Nothing was implemented. No PR, no branch, no issues filed. This note exists so
next week's lane resumes from the derivation instead of redoing it.

## Derivation basis — verify this FIRST on resume

Everything below was derived at **origin/main = `a216ff243`** ("reshaper — the
first ZERO-ATTEST video face"), confirmed by `git rev-parse origin/main` at
stand-down.

⚠ **The shared main working checkout DRIFTED mid-session** — it moved from
`a216ff243` onto `556a97061`, a lineage that does **not** contain `a216ff243`,
while carrying another lane's uncommitted edits to
`.claude/skills/module-faceplates.md` and
`.myrobots/plans/faceplate-queue-2026-08-14.md`. `origin/main` never moved.

The consequence to know about: late reads in this session came off the drifted
tree, not off origin/main. Concretely, `reshaper.ts` read as having **no** `face`
block, which is false on origin/main. The param-count and disposition derivation
(below) was read before the drift and matches origin/main, but **re-verify the
card-shape scans and re-read the reshaper exemplar** rather than trusting the
notes here on those points. This is the shared-checkout analogue of the
"attest the merged tree, not the tip" hazard: an agent's cwd is not pinned to the
commit it thinks it is reading.

## The arithmetic

| | count |
|---|---|
| registered modules | 198 |
| faced + promoted | 98 |
| `generic-face`, undone | 43 |
| …of those, video | 32 |
| …of those, **≤4 params — this lane** | **17** → 16 after scoreboard split out |
| ≥5 params (next lane, out of scope here) | 15 |

Sources: `packages/web/src/lib/docs/contract-lock.txt` for param counts (it is the
pinned I/O golden, so it needs no registry import), crossed with
`docs/design/face-migration.generated.md` for dispositions.

**The named exclusions cost this lane nothing — intersection with the eligible
set is ZERO.** cellshade/chroma/chromakey/feedback/mandleblot are 6p, graphicEq
5p, milkdrop 8p, vfpgaRunner 16p — all already out on the ≤4 cut before the
in-flight-lane rule applies. doom/toybox/cameraInput/recorderbox/peertube are
`bespoke-surface` and were never in the generic-face pool.

## The 16, grouped by SHAPE (approved 4/4/4/4)

1. **knob banks** — `edges`(2) `colorizer`(3) `inwards`(3) `vdelay`(4).
   No picture, no toggles, no rosters; each is ONE honest band. Lowest risk,
   ships the pattern. **This is where the lane was told to start.**
2. **card-checked cells** — `lumakey`(3) `shapegen`(4) `tempest`(2) `fader`(4).
   Every face needs a cell the def alone gets wrong: `invert` and `solids` are
   2-state buttons on the card (a knob would be INERT — the moog962 lesson);
   `tempest.shape` cycles an existing `SHAPE_NAMES` roster; `fader` carries two
   `<select>` FX rosters with names that already exist plus two ranges.
   ⚠ `tempest` has no `docs:` and is not in STRICT_DOCS — boy-scout cost is
   docs + `docs:accept` + a contract-lock re-pin. Still zero-attest (`docs` and
   `face` are both stripped from the attest basis).
3. **screens** — `posterbox`(3) `tiler`(1) `sourcery`(4) `onetonine`(1).
   All four blit live video (`blitOutputForPreview`), so SCREEN ON/OFF is
   load-bearing here rather than ceremonial.
4. **remainder** — `mapper`(1) `destructor`(4) `luma`(4) `videoMixer`(4).

Monitor mode applies to **none** of the 16 — only Ruttetra, GraphicEq,
Monoglitch, Milkdrop and Reshaper carry `hideControls`, so per the rule it must
not be invented anywhere in this lane.

## Decision records (both approved by the coordinator, neither executed)

**`scoreboard` rides ALONE, later, with its own checkpoint.** Split out of group
4 under the owner's verbatim policy that big modules needing complex design do
not get batched. Two design questions, not implementation questions: its canvas
is **self-drawn, not a video-out blit**, so "OFF stops the blit, never the
engine" has no blit to stop and SCREEN semantics need designing; and its
`resetTrig`/`scoreTrig` have **no card control at all** today (CV-only), so
adding momentary buttons is enhancement-vs-parity and may need an owner call.
**An issue for this was NOT filed — it still needs filing.**

**`onetonine.showGrid` — declare the toggle in the FACE, leave the def contract
alone.** The def declares `showGrid 0..1 linear`, but the card renders it as a
2-state toggle button that mirrors to `node.data`. Retyping the def to `discrete`
would green a gate nothing reads while costing a contract-lock re-pin and an
attest window — the check-the-consumer rule. **An issue recording this
declared-vs-rendered mismatch (the card-vs-def class) as deferred-fix-shaped, and
recording why the def fix was refused now, was NOT filed — it still needs
filing.**

## Dispositions checked and found CORRECT (do not re-litigate)

The 17 `bespoke-surface` video modules were swept for a thin param-shaped module
hiding under a wrong label. **No mis-disposition found.** Closest call was
`outToLaunch` (2 plain params, no blocker), but its inventory `why` is honest —
it is a Launchpad *binder*, where device pick and bind/unbind are the interaction
and the two knobs are incidental to the binding flow.

## Correction to a stale memory note

`tempest` was recorded as "#935 awaiting owner preview". **#935 is MERGED.**
Tempest shipped and is fair game; the coordinator confirmed they are correcting
the memory note.
