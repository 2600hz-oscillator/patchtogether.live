# Drive EXEMPT_FROM_VRT → zero (owner directive: ≥1 VRT for every module)

> **TRIAGE 2026-08-12 — the BRAKE landed; the DRAINING never started.**
> - The durable fix this doc asked for is **BUILT**: `ALLOWED_PERMANENT_EXEMPT`
>   (`e2e/vrt/vrt-exemptions.ts:992`) is a frozen deny-by-default allowlist, and
>   `vrt-meta.test.ts` asserts it EQUALS `Object.keys(EXEMPT_FROM_VRT)` in **both**
>   directions — a new module can no longer self-exempt through the
>   >10-char-reason hatch, and a drained module cannot leave a stale licence
>   behind. The `vrt-exemptions.ts` header names this file as the drain plan.
> - **No batch below has run.** `EXEMPT_FROM_VRT` was 76 at authoring and is ~80
>   today. Membership has churned for a year of new modules — **re-derive the
>   per-category membership before executing; treat the names below as
>   illustrations of the TECHNIQUE, not as a worklist.**
> - The platform axis this doc assumed is **gone**: `{platform}` was deleted in
>   **#1458** (ONE baseline set, authored by linux CI). Anything about
>   `EXEMPT_BASELINE_PAIRS`, darwin/linux pairs or per-platform capture is stale
>   and has been removed from this file.
> - `vrt-strict` now also covers the FACEPLATE scenes (**#1483**); the per-card
>   `STRICT_VRT_MODULES` subset is separate and still opt-in with no enrolment
>   rule (that asymmetry is measured in the `vrt-exemptions.ts` comment, not here).

Investigated 2026-06-21 against a 76-entry list: **75 of 76 were reachable**; only
`cadillac` was genuinely infeasible as a per-card VRT (it is a roaming overlay
sprite — there is no SvelteFlow card body to capture).

## Mechanisms (all still exist)
- `VRT_MODULE_MASKS` — magenta-fills a canvas rect in baseline+actual → VRT the
  chrome while masking a live/animated canvas. Every `MaskRect` now carries a
  REQUIRED `why`.
- `VRT_SCENES` (`vrt-scenes.ts`) — deterministic canvas content +
  AudioContext/`__*VrtSeed`/`__*VrtFreeze` freeze → canvas INCLUDED in the diff.
  A scene override beats a mask, and is always the better answer.
- `vrt-meta.test.ts` — ~1 s self-test: every registered module is baselined or
  named in `ALLOWED_PERMANENT_EXEMPT`.
- `vrt-update.yml` (`workflow_dispatch -f ref=<branch>`) — the single capture
  path; commits the baseline and close+reopens the PR to re-fire required checks.

## The four techniques, by shape of module
The value of this categorisation is the mapping from *why a card resists capture*
to *what unlocks it*. Membership is stale; the mapping is not.

- **A — capture as-is.** Pure-DOM knob/fader/port cards. Nothing needed but a
  capture. (Was the largest group: rings, marbles, attenumix, sidecar, cloudseed,
  clouds, analogLogicMaths, delay, fourplexer, treeohvox, bluebox, the moog
  cluster, chroma, luma, chromakey, lumakey, slewSwitch, …)
- **B — mask the canvas, capture the chrome.** A live/animated canvas the card
  wraps. (4plexvid, onetonine, vfpgaRunner, quadralogical, mappy, shapegen,
  scoreboard, acidwarp, bentbox, b3ntb0x, gibribbon, doom, …) Prefer a SCENE over
  a mask wherever the content can be frozen — a mask deletes pixels from the diff
  with nothing replacing them.
- **C — needs a freeze/seed hook first.** Self-animating game/visualiser cards.
  Precedents: TIMELORDE reduced-motion, the nibbles/foxy seed hooks. (numpadPlus,
  atlantisCatalyst, pong, modtris, frogger, skifree, livecode, clockedRunner, …)
- **D — capture a deterministic empty/idle/pre-connect/no-file/no-ROM state and
  mask the live element.** (midi quartet at pre-Connect; the `<video>` cards at
  no-file; cameraInput/audioIn/gamepad at no-device; controlSurface/matrixMix/
  launchpad/group as empty containers; qbert/snes9x at "LOAD A ROM".) ⚠ Confirm
  the idle state does not tick a playhead while unpatched.
- **D-infeasible: `cadillac`.** No card surface. Either a dedicated
  `CadillacOverlay` component VRT spec, or the one permanent allowlist entry.

## Ordering constraint that still binds
**A module still on raw `<Handle>` jacks must be migrated to PatchPanel FIRST,
then captured** — never capture-then-migrate, or the baseline pins the obsolete
look. (24 of 218 files under `ui/modules/` still carry a raw `<Handle>` as of
2026-08-12; 189 use PatchPanel.)

## CI/flake
Wall-time lands on the INFORMATIONAL full-vrt lane only (~1–3 s per new card at
`workers:1`); the required `vrt-strict` timing is unaffected unless a card is
promoted into the strict subset. Flake notes: a mask must cover the FULL painted
region; text-heavy cards get the height-settle loop and a 3× flake-check.
