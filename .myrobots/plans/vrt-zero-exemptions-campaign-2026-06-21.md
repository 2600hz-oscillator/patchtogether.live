# Drive EXEMPT_FROM_VRT → zero (owner directive: ≥1 VRT for every module)

> **TRIAGE 2026-08-04 — NOT EXECUTED. The count went UP, and the durable fix was
> never built. Live backlog; the owner directive still stands.**
> - `EXEMPT_FROM_VRT` is **81 entries** today, not 76 — batches 1–5 below never
>   ran, and new modules kept self-exempting through exactly the >10-char-reason
>   escape hatch this doc identifies.
> - **The "Gate-tightening (the durable fix)" is the highest-value un-built item
>   here**: there is still no `ALLOWED_PERMANENT_EXEMPT` frozen allowlist anywhere
>   in the tree, so a new module can still exempt itself without review. That
>   single change is what stops the list growing while the batches are worked.
> - What DID happen in this area is the *other* axis — linux/platform coverage,
>   not per-module coverage: `EXEMPT_BASELINE_PAIRS` is now empty, and the
>   deficit ratchet was rebuilt in **#1272** to count all four gap mechanisms and
>   assert in both directions (`vrt-meta.test.ts`: `SHARED_LINUX_PAIR_CEILING`,
>   `LINUX_DEFICIT_CEILING`, `STALE_PAIR_CEILING`). The line below calling
>   `EXEMPT_BASELINE_PAIRS` "~140, legitimate, keep" is therefore obsolete.
> - The A/B/C/D categorisation and the PatchPanel-migration-first ordering are
>   still the correct execution plan; re-derive the per-category membership,
>   since six weeks of new modules have landed on top of it.

Investigated 2026-06-21. `e2e/vrt/vrt-exemptions.ts` has **76 EXEMPT_FROM_VRT entries**. **75 of 76 are reachable**; only `cadillac` is genuinely infeasible as a per-card VRT (it's a roaming overlay sprite — no SvelteFlow card body).

## Mechanisms (already exist)
- `VRT_MODULE_MASKS` — magenta-fills a canvas rect in baseline+actual → VRT the chrome while masking a live/animated canvas.
- `VRT_SCENES` (vrt-scenes.ts) — deterministic canvas content + AudioContext/`__*VrtSeed`/`__*VrtFreeze` freeze → canvas INCLUDED in diff. Scene overrides mask.
- `vrt-meta.test.ts` — ~1s self-test: every module baselined-on-≥1-platform OR in EXEMPT_FROM_VRT (>10-char reason).
- `EXEMPT_BASELINE_PAIRS` (~140, mostly `linux/*`) — darwin-now/linux-later capture scheduling, NOT a coverage gap; legitimate, keep.
- `vrt-update.yml` (workflow_dispatch `-f ref=<branch>`) — regenerates BOTH platforms, commits, close+reopens PR to re-fire required checks. The single capture path.

## Categories (tally)
- **A — capture as-is (~34):** pure-DOM cards (rings, elements, peaks, tides2, marbles, symbiote, warps, veils, attenumix, sidecar, cloudseed, clouds, callsine, analogLogicMaths, delay, grids, fourplexer, treeohvox, bluebox, helm, hydrogen@idle, moog921Vco/Cp3/904a/911/902, chroma, luma, chromakey, lumakey, slewSwitch, aquaTank, …). chroma/luma/chromakey/lumakey capture AFTER their PatchPanel migration.
- **B — mask canvas + capture chrome (~13):** 4plexvid, onetonine, chowkick, twotracks, vfpgaRunner, quadralogical-solo, mappy, shapegen, scoreboard, acidwarp, bentbox, b3ntb0x, gibribbon, doom (after its PatchPanel PR). Most masks already staged.
- **C — needs a freeze/seed hook first (~9):** numpadPlus, atlantisCatalyst, pong, modtris, frogger, skifree, livecode, clockedRunner, writeseq/macseq-if-REC-animates. Use the TIMELORDE reduced-motion precedent + nibbles/foxy seed-hook precedent.
- **D — capture deterministic empty/idle/pre-connect/no-file/no-ROM state + mask the live element (~17):** midi quartet (midiclock/midiLane/midiCvBuddy/midiOutBuddy = pre-Connect), 5 `<video>` cards (videobox/videovarispeed/archivist/tvLibrarian/peertube = no-file, mask `<video>`), cameraInput/audioIn/gamepad (no-device idle), controlSurface/matrixMix/launchpad/group (empty container), qbert/snes9x (ROM-missing "LOAD A ROM").
- **D-infeasible (1):** `cadillac` — no card surface. Best: a dedicated `CadillacOverlay` component VRT spec, OR the one permanent allowlisted exemption.

## Execution batches
- **Batch 0:** one `vrt-update.yml` on clean main → clears the bulk of trailing `linux/*` EXEMPT_BASELINE_PAIRS (free, de-risks).
- **Batch 1:** remove the ~34 A entries, one `vrt-update` capture (both platforms), promote the static ones into STRICT_VRT_MODULES. (Hold chroma/luma/chromakey/lumakey for 1b.)
- **Batch 1b:** after `fix/keyer-cards-patchpanel` (#853) + chroma/luma migration merges → baseline those 4.
- **Batch 2:** B masked-canvas cards (masks mostly staged) + doom + migrated raw-Handle cards.
- **Batch 3:** C freeze/seed hooks (per-module code + VRT_SCENES entry + 3× flake), then capture.
- **Batch 4:** D empty-state cleanups (mask live element, capture chrome).
- **Batch 5:** cadillac decision.

## Gate-tightening (the durable fix)
Tighten `vrt-meta.test.ts`: `Object.keys(EXEMPT_FROM_VRT)` must be a SUBSET of a frozen `ALLOWED_PERMANENT_EXEMPT` allowlist (`{cadillac}` or `{}`). A new module can no longer self-exempt — adding a key fails the ~1s gate ("every module needs ≥1 VRT; mask/freeze is the path"). Converts the >10-char-reason escape hatch (what let 76 accumulate) into "permanent-exempt requires an allowlist edit in review."

## CI/flake
Wall-time: ~+2-3 min on the INFORMATIONAL full vrt lane only (~60 new cards × 1-3s, workers:1); required vrt-strict timing unaffected unless a card joins STRICT. Flake: masks must cover the FULL painted region; linux-glyph ±1px (height-settle loop mitigates; capture both platforms via vrt-update, never hand-edit one side; text-heavy cards 3×-flake-check); confirm D-idle states don't tick a playhead while unpatched.

## Couples to the raw-`<Handle>`→PatchPanel migration wave (task #152)
Any exempt module still on raw Handles (acidwarp, chroma, fourplexvid, gibribbon, qbert, scoreboard, shapegen, snes9x, videobox, …) must be MIGRATED to PatchPanel FIRST, then captured (never capture-then-migrate, or the baseline pins the obsolete look).

Full agent report: task aec57d313b3905796 (this session).
