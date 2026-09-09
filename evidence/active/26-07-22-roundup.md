# Roundup — 2026-07-22

> **2026-08-12 janitorial sweep: the ~700-line session log that used to follow
> was DELETED.** It was four documents in one (status / TODO / findings /
> guardrails) and all of it had merged or moved. What survives is exactly the
> ten carried-forward items below plus the durable findings at the bottom — the
> two things a grep proved exist nowhere else. Nothing was summarised away: the
> deleted half was history, not backlog.

> # ⚠ KEPT ONLY FOR THE TEN ITEMS BELOW (audited 2026-08-04)
>
> This was an **append-only session log** written 2026-07-22 and appended through
> 2026-07-27. Nearly everything in it merged or was promoted
> elsewhere — ModuleShell #1164, the per-module rework batches #1169/#1171/#1174/#1332,
> Push 2 Phase 1 #1165 and the WebUSB screen #1283/#1285/#1309/#1339, the lights
> write-storm fix, the Push 3 assessment (#1310), the `PortDef.label` field, the
> jack-suffix fix, snaredrum SPREAD (#1328), the third-expand LRU, and the whole
> guardrails section (now `CLAUDE.md` + `26-08-01-pickup…md` §5). The
> *"dock full-view isn't gated by `?shell=1` — STILL UNANSWERED"* question **was
> answered**: `.myrobots/plans/shell-ui-refactor-resume-2026-07-26.md:53-66` —
> *"SETTLED — leave as is."* Resume pointer for the UI track is that same plan.
>
> **It is kept because ten things in it exist NOWHERE ELSE.** Verified by grep
> across the repo and the rest of `.myrobots`. If this file is ever deleted,
> these must be carried forward first:
>
> 1. **The MPE-to-CV module design — the owner's stated PREFERRED shape, never
>    built.** `grep -rniw mpe` over `packages/web/src`, `packages/dsp/src` and
>    `e2e` returns **zero hits**. One module consumes MPE MIDI and exposes the MPE
>    dimensions as per-voice CV (bend-summed pitch, gate, pressure, slide/timbre,
>    velocity) as poly cables, with **no per-module MPE code**. Targets:
>    wavesculpt, cube, videocube, tidyvco, dx7, macrooscillator. Test device:
>    LinnStrument. (`push3-support-assessment-2026-08-03.md` §5 is a *different*
>    problem — receiving MPE *from* a Push 3.)
> 2. **The Push 2 "Channel view" spec — and that the owner was CUT OFF mid-spec.**
>    Far right = pre/post mixmaster stereo VU; then purple send1/send2 meters;
>    remaining space = 8 right-click-assignable slots. **What shipped in #1285 is
>    a different design** (a hand-maintained 8-encoder text schema in
>    `push-card-config.ts`); `grep -rni "vu\|meter"` over
>    `packages/web/src/lib/control/push2/` → **0 hits**. The unfinished slot
>    behaviour was never settled.
> 3. **The WebMIDI-in-CI owner ask, with its rationale** — the headless sim has no
>    MIDI latency or backpressure; investigate real WebMIDI between networked
>    containers. No lane, no plan doc. (The push2 integration plan records the
>    *constraint*, never the ask.)
> 4. **A live source↔docs contradiction and the deliberate reason it was left.**
>    `packages/dsp/src/lib/karplus-dsp.ts:285` still says `B = 1 → ≈ 90·f0`; the
>    formula on the next line is `f0·2^(0.5+5.5·B)`, i.e. **64·f0**, which is what
>    the AUTHORED doc at `karplus.ts:279` says. **The DSP comment is the wrong
>    one.** Left unfixed because `dspSourceSha` hashes the file TEXT, so a comment
>    edit invalidates `art/scenarios/karplus/*.sha`. **Fold into the next
>    ART-touching PR** — that instruction lives only here.
> 5. **The WAVECEL `webgl-smoke` flake report** — a bare `nonZeroFrac > 0.02`
>    pixel assert with no renderer-tolerance or capability gate (passes on a real
>    GPU, flaked on #1167's run). Prescribed fix = the recorderbox #687 / edges
>    #688 capability-probe pattern. Not located in today's specs; may have moved.
> 6. **Video-visibility follow-up (a), still true in source:**
>    `WavesculptCard.svelte:81` is a bare `useStore()` while the sibling cards use
>    `card-kit`'s guarded `captureFlowStore()`. Only this file records **why** the
>    sweep skipped it — the card is in the WebGL attest basis, so fixing it costs
>    a basis edit + a one-time re-attest, or a shell-side seam.
> 7. **Video-visibility follow-up (b):** synesthesia's tile keeps a static wave; a
>    VU-meters thumb is the candidate.
> 8. **Two owner UX questions, asked and never answered.** (i) A fresh rack's
>    transport starts RUNNING so the first ▶ stops it — start stopped, or make the
>    ■ state clearer? (`timelorde.ts:47` still defaults `running: 1`.) (ii)
>    `resolveInputSourceId` silently picks the **lowest edge id**, so a second
>    cable into an occupied video input is **invisibly ignored**; recommendation
>    was replace-on-connect. `grep replace-on-connect` → 0 hits.
> 9. **The `sampleSpread` latent-flake diagnosis** — the 6th member of the
>    clipplayer flake family, still live at `e2e/tests/clip-automation.spec.ts:79-95`
>    (`count = 14, intervalMs = 70`, a Playwright-side `readParam` +
>    `waitForTimeout` loop feeding ~6 tests). CLAUDE.md carries the general rule
>    but names `workflow-master-transport`, not this helper.
> 10. **Two unmet obligations:** #1169 merged with *"do not auto-merge: the owner
>     previews the faces"* in its body and **no human approving review** — the
>     owner has never previewed its final merged state, because the video P0 was
>     found and fixed after the approval. And the Push 2 Live-port matcher
>     inversion is code-only and still **needs verifying on a real Windows box**.
>
> Everything else here is history.

---

## Other durable findings
- **A VRT baseline was silently stale**: `workflow-dock-patch` passed INSIDE its 5% maxDiffPixelRatio
  while still rendering v1.2.0-era chrome. Re-pinned. A loose tolerance can hide real drift for months
  — a sweep of other >0 tolerances is worth doing.
- **`controlFamilies` DOES project into contract-signature** (`contract-signature.ts` ~:124). The
  "families are UI-only / out of contract" assumption is WRONG — adding one is a contract change.
- **Lane wiring is managed ALL-OR-NOTHING**: unpatching POLY on a lane instrument stands down the whole
  clip→instrument link (pitch AND gate) as a unit. That is what makes it go properly silent.
- A raw edge delete on a managed lane edge SNAPS BACK on the next reconcile pass — #1178 writes the
  delete + a detach-suppression marker in ONE transact so it stays gone and undoes as one unit.
