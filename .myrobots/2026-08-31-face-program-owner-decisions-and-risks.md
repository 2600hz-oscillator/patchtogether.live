is "Play it". The alternative — a second gibribbon PR — would collide on twelve shared files and rank cells around ports #2263 deletes.

2. **joystick.** *Widen `module-face-lint`'s lane-paints-something clause to accept a wired `tileBody` (unlocking the nicer `xyPads` + `surface:'body'` shape), or ship the two-ordinary-cells fallback that needs no gate change?* → **Default: the fallback.** It ships today, the pad gesture survives on both surfaces, and the 2026-08-25 ruling puts the gate edit in the owner's hands. Cost of the default: the dock shows two knob cells beneath the pad body (the twotracks redundancy), against the inventory's old "never two knobs" design intent.

3. **videobox.** *The body blits the engine output — which is anamorphic, because `video-frame-upload` scales a 16:9 clip into the 4:3 `VIDEO_RES` with independent per-axis minima. Accept the squeeze (consistent with the fleet, and honest about what downstream and videoOut already receive), or keep a correct-aspect element view for the one module whose job is watching your film?* → **Default: blit**, and **report the anamorphic upload as a separate platform defect** — fixing it moves every video module's pixels and all their baselines and cannot ride a face PR.

4. **modtris.** *`levelStep` is ranked-but-dead (`stepModtrisState` never reads it) while the docs promise "gravity speeds up each level". Implement the ramp, or delete the param?* → **Default: implement** (no contract change; re-run `task art:one -- modtris` and attribute the lock-count move as intended). Deleting is a real contract change plus an orphan key in saved patches.

5. **nibbles.** *The `LEN` score has no legal painted home and `paintFrame` contains no text at all. Accept a `StatusLed` for ALIVE/DEAD plus the number on `aria-label`, or pay a WebGL re-attest to rasterize a HUD into the frame?* → **Default: lamp + aria**, with the visible-readout loss stated in the PR body. The lamp is not optional either way — with AUTO off (the default) a dead snake does not restart, so a frozen board is otherwise indistinguishable from a dropped keypress.

6. **moog956.** *`LEGACY_DOCK_CANDIDATES` and the `midi-binding-node-lifetime` SUBJECT run out of un-faced modules. Re-point both at `toybox`, or retire the legs (the branch the spec's own error text offers)?* → **Default: toybox**, contingent on its card satisfying each predicate; verify at build time.

7. **chromaconsole.** *Accept two operable surfaces per slot — a generic band knob (the MIDI-learn / clip-automation / Push-2 anchor) plus the body's real `Segmented` — i.e. the shipped twotracks shape?* → **Default: yes.** The alternative asks for per-node cell derivation, which is platform work; and if it is ever wanted, the cheap ask is a `node` argument on `shellCellFor`, **not** `ParamDef.labelFor` and not a `face.bodyParams` widening.

8. **videovarispeed.** *The SPEED fader is a 0..1 that means −4×..+4× with 0.5 = +1×. Declare `ParamDef.format` (paints a readout, and costs a WebGL re-attest because `params` is not hash-transparent), or put the multiplier in the body beside the scrubber?* → **Default: body-side.** No def edit, no attest, no collision with "decimals gone, not hidden".

9. **ptzcam.** *The axis-mode line (`pan abs · tilt abs · zoom abs`) is three-valued per axis and says whether the knobs are positions or rates. Three lamps with the word on `detail`, or paint it in the body?* → **Default: three lamps** (lit = velocity axis), with the narrowing argued in the `EXTENSION_BODY_ROLES` `why`, on the es9 precedent.

10. **controlSurface and clipplayer — the two lane-tier changes.** *The board leaves the canvas: an inline free-growing panel (360–760 px for controlSurface; a 336 px launcher that grows to ~2,200 px in clip view for clipplayer) becomes a 192×180 tile plus one Expand click, with a live strip on the tile.* → **Default: ship**, on the electraControl / semantic-zoom precedent, with mandatory owner preview of the compact tier — not just the dock. If refused for controlSurface, the named capability is relaxing `SHELL_TILE_W/H` uniformity for occupants that declare a tile body, which costs the byte-identical flush-stack invariant: platform work, not a face PR.

11. **Resting-readout deletions, program-wide.** Every promotion in this plan deletes at least one painted derived value (joystick's `x/y`, nibbles' `LEN`, mappy's per-surface lamps, videobox/videovarispeed/peertube/archivist time readouts, clipplayer's seven, moog956's semitones, ptzcam's mode line). Each is individually defensible under the 2026-08-17/19 rulings and collectively it is a visible change to surfaces the owner uses. → **Default: proceed**; the owner preview per PR is where this gets judged, and the PR body must name every deletion rather than let it be discovered.

12. **Cadence.** *Hold ≤3 open PRs across 8 waves — roughly 8 merge cycles.* → **Default: yes, as briefed.** ⚠ While #2263 is open, waves carry **2** new PRs, not 3.

---

## 8. Risks

**What this plan could get wrong**

- **It is built from recon + adversarial challenge, not from a fresh read at build time.** Every line number here was true when read and `main` moves. Each brief must be re-verified against `origin/main` before the first edit — the parity-skeptic pass found a real STOP-2 in six modules the recon had called clean, and there is no reason to think the seventh through twentieth are different. The cheap check that would have caught most of them: **enumerate every `data-testid` in the legacy card and diff it against (params ∪ controlFamilies ∪ the body's own testids)**; what is left over is the STOP-2 surface.
- **Attest scope.** The hash covers a **tree**, not a diff: `main` moving any file under `packages/web/src/lib/video/` changes mappy's or gibribbon's hash without their diffs changing. Measure on the **merged** tree, never from the dirty primary checkout, and regenerate the pin **last**, confirming only the `.sha`/hash moved. Two easy accidental enrolments: a `getContext('webgl')` in an extension body, and a new `*_RANGE` export from a basis file.
- **Shared-roster merges.** Eight of these PRs edit `shell-cells.ts`, all twenty edit `strict-faces.ts` + the inventory + `_shell-faces.ts` + both timing artifacts. "Keep both sides" is unsafe; the accept re-run is mandatory; `gh pr update-branch` drops content on exactly these files. The wave rule reduces the *hand-maintained* collisions; it cannot remove the *generated* ones.
- **Cost-artifact truncation.** Re-pinning while shards PEND produces a diff that reads exactly like a legitimate re-pin. tvLibrarian's promotion needed two follow-up commits for rows a rebase silently discarded; frogger's absorbed 18 orphaned entries for nine modules.
- **VRT determinism is asserted, not yet measured, for several new face scenes.** Three carry real risk: textmarquee and archivist (system-font glyphs inside a GL texture, the class `vrt-exemptions.ts:192-197` already names for one of them), and nibbles/modtris (whose pins are new code). The honest fallback in each case is a `FACES_WITHOUT_SCENES` entry **with the measurement in it**, not a mask and not a re-run.
- **CI wall time.** Twenty promotions add ~36 face scenes to a `vrt-strict` lane already at 12 shards near ~61% (8 shards previously hit 90% of the 600 s cap and timed out — those pass zero-failed and are **not** flakes), plus ~15 new e2e specs and 20 faces-parity rows, two of which cold-boot a WASM game or a video decode inside the dock body. Estimate the delta **per PR** against the 2-minute sign-off rule; the aggregate is well over it and is the owner's to schedule.
- **The two carve-out removals (W7, W8) flip the lane for every saved patch at once.** They are last for that reason, and neither should merge without an owner preview of the **compact** tier.

**What this plan is structurally unable to see**

- **Component-only behaviour** — the whole point of STOP 2. A def-reading gate cannot see a mount effect, a lease, a rAF, a listener, a card-local `$state` read, or a `$effect` that reconciles a synced key. Six of the twenty had exactly one such item with no home in the first plan (`ensureLoaded`, `adopt`, `registerVideoExport`, `pruneSurfaceDangling`, `probeEncoders`, the recording reconciler). Assume the rest do too.
- **Browser-only failures.** Two pads painting at the dock; an element adopted out from under a second mount; a right-click that summons the shell node menu on top of the module's own; a `tileBody` and a `fullViewBody` sharing a testid and throwing strict-mode. None of these reddens a unit or a VRT run.
- **`?shell=legacy` green.** 377 of 431 specs boot the legacy shell. After each promotion those specs keep passing over a surface no player meets — which is why every brief owes a default-shell leg, and why "the existing spec is green" is never evidence about a face.
- **Declared gate blind spots** the plan relies on and cannot verify from outside: `face-resting-text-source` cannot see extension-body text; `EXTENSION_BODY_ROLES` cannot see a `tileBody`; the typed-entry leg is presence-only and cannot tell that the face's field is the *same* affordance; `card-primitive-parity` scopes its instance denial to ranked **params**, so a `node.data`-backed primitive (clipplayer's lane colour) is invisible to it; and `module-face-lint`'s lane clause counts `curatedFace().controls.length` and cannot see a painting tile body.
- **Hardware paths.** No CI runner has a MIDI device, a PT-PTZ camera, a mic with a prior grant, an H.264 encoder that actually emits chunks, or a monome. chromaconsole's CONNECT, ptzcam's binding, audioIn's `hasLabels`, recorderbox's interlock and clipplayer's GRID bind all ship on arguments plus an audition ledger. Owner hardware verification is the only instrument that closes those, and several are already outstanding from earlier work.
- **Taste.** Whether the compact tier reads well, whether the deleted readouts are missed, whether a 192 px tile is an acceptable home for a launcher — no gate measures any of it. That is what the owner preview on every row is for, and it is the reason none of these merges on green alone.
## Appended 2026-09-02 (session d8066daa, face-endgame push)

1. **#2314 recorderbox — awaiting your preview, fully green.** The promotion makes the
   auto-spawned RECORDER paint a face tile in every fresh rack (65 baselines moved from
   tile overlap alone). Look-change ruling applies; it will not auto-merge. Also inside:
   the #1574 guard is weaker by construction now (tile body survives dock collapse), and
   a mount-time encoder probe finding (a real 4-frame encode per mounting surface, not
   per page) is reported in the body, deliberately not "fixed".
2. **face-tvLibrarian-dock per-VM colour fragility.** Max channel delta 8/255, no content
   difference; appears whenever a timings re-pin re-bins that scene onto a different VM.
   Recapture pins it to one VM (flips back next re-bin); tolerance widening is forbidden.
   Wants a fleet-level answer. Surfaced twice already (#2314's runs).
3. **moog956 (#2315) multiplayer note:** gate is now momentary/unsaved (correct — a saved
   high gate is an unstoppable drone), so a remote collaborator's ribbon press no longer
   sounds your VCA (pos still syncs). Same trade tomtom/tidyVco/clap/bluebox already made.
4. **nibbles (#2317) open question in its PR body:** should the face paint a score?
   Plus two reported instrument findings: faces-parity spawns all modules with no domain
   (video modules parity-tested with no engine behind them), and manual-strike-wiring's
   grep is comment-blind.
5. **peertube merged unpinned:** face-peertube.spec.ts rode the median in e2e-timings;
   the next settled re-pin (2315/2317 choreography) absorbs it. Self-healing, noted.

6. **vrt-update.yml header contradicts its own step (found in #2319 review, reported
   only — your no-CI-changes ruling):** header L60-61 says the capture runs
   `--update-snapshots=all`, citing the all-black face-outlines-dock defect `=all`
   was adopted to fix; the step at L356 deliberately runs `=changed` (its comment
   argues bare `=` rewrote 22 unrelated baselines once). Consequence: a baseline
   that PASSES tolerance is never refreshed, so the all-black class is reachable
   again by design. Decide which side is right; the tree currently wins.
7. **videovarispeed compact scene is placement-sensitive** (11 green → 8 red → 2
   green across three re-bins): baseline appears to capture the tile before its
   idle shader paints (black vs purple well). Fix branch in flight
   (fix/videovarispeed-vrt-paint-race); do not read any single green as repair.

8. **Timings-accept scripts accept partial runs** (#2319 review): e2e-timings-accept
   refuses only zips==0 and vrt-strict-timings-accept only shards==0 — 8/12 shards
   merges happily and silently drops a third of the rows. Every truncation incident
   traces here. A ~3-line "expect 12" guard in each script would close it, but per
   your no-new-gates ruling this is reported as an option, not shipped.

## Ready branches awaiting a PR slot (2026-09-02)
- `fix/reconciler-type-swap` @ f82d128f4 — same-id type/domain swap now remove+adds;
  synesthesia #1847 row UN-PARKED on byte-identical evidence; seqtris row left
  parked (mechanism unproven). DOOM boot unprovable locally (asset gate 404) —
  argued inert, not claimed.
- `fix/videovarispeed-vrt-paint-race` — in flight (agent working).

- `fix/videovarispeed-vrt-paint-race` @ 1eace9104 — READY (waiting for a PR slot).
  Mechanism: thumb throttle (15fps) vs 6-rAF settle window — a FAST shard samples
  the unpainted well; baseline was the painted state. Fix: component publishes
  data-thumb-painted; capture waits on it before freeze, both tiers, all 59 wells.
  ⚠ painter-compact is NOT this class: its compact box is 86.4px wide in an 88px
  shot — column x=87 is a partial-coverage edge, a dpr/fractional-width phase
  issue needing its own fix; mirrorpool/matrixMix restorations each need their
  own box-fraction measurement first.

9. **face-mirrorpool-dock does not reproduce boot-to-boot** (found during #2322):
   3736 px GPU / 2501 px SwiftShader between two boots of IDENTICAL code — its
   roster claim "BYTE-IDENTICAL across boots (2026-08-21)" does not hold. The
   scene passes CI on luck margin; its compact sibling was already dropped
   2026-08-26 for non-reproduction. Wants: re-measure and either fix the
   integrator seam or move the dock scene to FACES_WITHOUT_SCENES honestly.

10. **CV clock dropped ONE pulse in the SPEEDERR performance** (measured: +1.000
    period phase step at t≈89.9s, ±0.3ms lock elsewhere; PAM re-lock = the audible
    triple/quad). Scheduler already drops-not-flushes; margin is the defect:
    200ms lookahead = 1.25 pulses at 94BPM. OWNER DECISION: (1) wire seq-clock
    worklet (#967 landed, #969 wiring parked on your ears, branch feat/seq-clock-wire
    @ 7e16129) — recommended; (2) interim lookahead 200→750ms WITH cancel-and-
    reschedule (bpm knob lag otherwise) — also needs ears; (3) surface `skips`
    diagnostic regardless. Ready branch: fix/cv-clock-burst @ 9e00f3908 (test-only
    invariant pins, 12/12 REPEAT=3) awaiting a PR slot.

- `feat/clipplayer-face` @ cfef8b8eb — branch-ready (workflow builder done; 4-cap held it).
- `feat/trails-surface` @ 6812abf9a — branch-ready (same).
Build workflow wf_08eee3e4-f98 COMPLETE: all 8 modules built (8/8 agents, 0 errors).

11. **Main post-merge verification starves under merge cadence** (CI-policy, your
    no-CI-changes ruling → reported only): main's push runs use cancel-in-progress,
    so with merges every 15-30min, 4 consecutive main commits (4b0cae442 → 632a19726)
    had runs CANCELLED — no completed full main run since 05e6c071e, and PROD ships
    nightly from the latest GREEN main. Each merge was pre-verified green on its PR
    at identical content, but "cancelled" reads as silence, not success. Options:
    serialize merges enough to let one run finish, drop cancel-in-progress on main,
    or accept PR-run coverage as the gate. Tonight: the coordinator will hold merges
    after the last one of the evening until main's run completes green.

12. **mixmstrs clip-recording spec needs a re-base**: it raced the clipplayer face
    build (same day) and its premise "clipplayer has no face and is not getting one"
    is now false. Re-base inputs from #2326's review: (a) pad-state logic now has
    TWO copies (card padState + face clipplayerPadState) no gate compares — the
    three new recording states must land in a SHARED helper, not be authored twice;
    (b) the arm column is a 4th PF-14 panel + family + rank, not one glyph joining
    an existing column (trodden path, 3 precedents in the same face); (c) per-lane
    outputs remain friction-free. Artifact page + spec.md both need the update.

13. **Third VRT placement mechanism: per-SILICON rasterization** (#2323): EPYC 7763
    vs 9V74 render a KnobConic conic-gradient arc 15px/max-delta-14 apart; CPU model
    is not a function of shard index, so any timings re-pin re-rolls the die. Family:
    tvLibrarian per-VM color (item 2). face-seqtris-compact dropped per precedent.
    Fleet-level fix candidates: raise threshold only on conic-arc scenes (no — owner
    forbade tolerance widening), pin VRT runners to one CPU family, or accept
    compact-scene drops as the standing mitigation.
14. **Latent flake to triage: workflow-master-transport.spec.ts** ("drives audible
    clip playback through the real lane chain (legacy-cards)") — recovered-on-retry
    on 33692179171 shard 5, zero flaky entries in the prior run; newly exposed by
    re-binning. Fix-or-park owed.

15. **e2e planner has no audio-contention class** (#2323's finding): the contention
    scanner classifies only `media` (video-decode markers); the 35 specs with
    audible-RMS assertions join no class, so a full timings re-pin can pack them
    into contention and the flaky-audit gate reds on recovered retries (observed
    twice, same shard index, different specs). Mitigation in use: face PRs restore
    main's costs byte-for-byte and graft only new keys. Real fix = an audio class
    in e2e-contention-scan.mjs — a CI/gate change, so it's yours to green-light.

16. **CI's DOOM1.WAD source is DEAD** (found building the doom face): ci.yml pulls
    distro.ibiblio.org/slitaz/.../doom1.wad → 404 (verified twice); every DOOM job
    survives only on cache key doom-wad-shareware-v1 — one eviction from fleet red.
    Working mirror SHA-1-verified (5b2e249b9c... exact match):
    doomworld.com/3ddownloads/ports/shareware_doom_iwad.zip. One-line ci.yml swap,
    needs your sign-off per the no-CI-changes ruling.
17. **VOCABULARY_DEBT doom 'Gain'-vs-'Volume'** now user-visible on the faceplate;
    paying it card-side reds doom-controls.spec.ts:448 + moves 4 baselines, def-side
    moves the attest hash. Left open, reported.

## PR queue (slots free as merges land)
1. feat/doom-face @ 809b4ef05 (built, verified, no baseline bot needed)
2. feat/toybox-face (building)
3. feat/cliprec-2-store @ f2406ee59 (stacked on #2329)

18. **snh-hold.spec.ts recovered-flake** (toybox run 2): same shape #2310 fixed —
    waitForNoteEstablished's flat 15s budget under shard contention. Sibling of
    item 14 (workflow-master-transport). Both = audio-readiness budgets exposed
    by re-binning; one contention-budget fix PR owed for the pair. No #1847 park.

19. **vrt-update.yml discards MOVED baselines** (toybox run 33718814822): the capture
    step is set -e around bare playwright --update-snapshots=changed; a MISSING
    baseline passes (committed) but a MOVED one "fails by regenerating" and the
    stage/upload steps (no if:) are skipped — correct pixels produced on the runner
    and thrown away. Workaround in use: delete the stale baseline so the scene takes
    the missing path. Real fix = tolerance on the capture step or if: always() on
    stage/upload — a CI change for your sign-off. Every future intentional render
    change hits this.

20. **Clip-media recovery prompt unreachable on the default shell** (slice 2 gap the
    clipplayer promotion opened): the crash-recovery affordance lives only in
    ClipplayerCard.svelte; default-shell users see the face. The "fix lands only on
    the surface you looked at" class. Deferred deliberately (adding it to the face
    makes the store PR look-affecting); follow-up owed — small face-side prompt or
    fold into slice 5. Builder ready to take it when a slot frees.

21. **Dead WAD fetch in 7 MORE workflows + Taskfile.yml** (found by #2337, out of its
    approved scope): identical distro.ibiblio.org 404 URL, all sharing the cache key
    ci.yml keeps warm. Same SHA-verified Doomworld swap each. Awaiting owner
    sign-off to extend.

22. ✅ **RULED 2026-09-04 — DELETE.** Owner: *"delete face-cube-dock vrt entirely
    now"*. Done in #2346 (`scenes: ['compact']`, baseline + timings row removed).
    The same message retired the face carve-out entirely: *"that ruling is no
    longer valid, all faces merge on green"* — cube, wavesculpt and videoOut
    holds are all dead. Memory updated.
    Original entry: **face-cube-dock is the cube instance of the boot-to-boot class** (#2341 census):
    152px AA wobble on the scope trace, same code+baseline green the boot before and
    5/5 on main; placement disproven (bot commit touched 1 unrelated PNG). Mitigation
    = scenes-drop per precedent, but cube carries the owner merge carve-out — owner
    one-liner requested. Evidence crops saved in the midiclock agent's scratchpad.

23. **New VRT flake class named: live load-diagnostics painted on resting surfaces**
    (#2344's find): cvBuddy's LATE lamp lit on `skips>0` — the runner's load average
    on a resting face; latent since ship, likelier under #2338's heavier boot.
    Fixed for cvBuddy both surfaces. SWEEP CANDIDATE: any other face painting a
    live diagnostic at rest (XRUN lamps, drop counters) has the same exposure.

24. **Degraded-runner wall-clock kills on vrt-strict shards** (2026-09-04, #2344
    run 33838446759, two attempts): a shard lands on a slow Azure runner (145MB
    node_modules cache extract 4min despite a cache HIT, LFS fetch 55s, PNG
    verify 70s — every I/O step 2-4x normal), setup reaches ~9min, and
    `timeout-minutes: 15` kills the job mid-suite with conclusion=cancelled and
    ZERO failed tests. Distinct from the 600s capacity class (that one is plan
    cost; this is runner lottery — 11/12 shards green on the same commit). Any
    fix (raise the job cap, pre-flight runner speed probe, retry-on-cancelled)
    is a CI change and needs owner sign-off. Until ruled: diagnose via step
    timings to confirm the class, re-run the shard, record occurrences here.

25. **vrt-strict capacity decision — 12 shards no longer carries the lane**
    (2026-09-04). The honest timings re-pin (#2345; dock scenes ~doubled since
    #2338's heavier boot) prices the fleet at 5411 CPU-s: 12 shards = 451 s
    windows = 75% of the 600 s global timeout, predicted wall 10.49 min. That
    fits the 15-min job cap ONLY on a healthy runner; tonight 4/12 + 4
    consecutive shard-11 draws (item 24) landed slow-I/O machines and were
    wall-clock-killed with zero failed tests. Planner pricing (spread ~1.0x):
    14 shards -> 387 s (65%), wall 9.43 min, +5.9 job-min; 16 shards -> 338 s
    (56%, the design point), wall 8.61 min, +11.9 job-min. The 8->12 bump
    (#2222) is annotated "chosen, owner call", so this one is the owner's too.
    RECOMMEND 16. Until ruled I hold at 12 and re-run killed shards.

    ✅ **RULED 2026-09-04 — NO.** Owner: *"i don't want more VRT runners, we ought
    to have removed a lot of VRTs with the legacy work... our VRT workflow is too
    heavy and will be trashed and re-done once legacy is removed, so, do not
    waste time on that now."* The lever is SHRINKING the lane, not widening it:
    delete VRT scenes that the legacy removal kills anyway. Do not re-open the
    shard-count question; do not invest in the VRT workflow itself.

26. **The "cancelled" CI jobs are `timeout-minutes` kills, not an external
    canceller** (2026-09-04, diagnosed on main run 33853156685 attempt 2).
    GitHub reports a job killed by its `timeout-minutes` cap as
    conclusion=`cancelled`, NOT `failure` — so a capacity kill and a queue
    cancellation are indistinguishable at the run level, and `gh run view
    --json jobs` returns EMPTY timestamps for them, which reads as "never
    started". The attempts API (`/actions/runs/<id>/attempts/<n>/jobs`) shows
    the truth. Attempt 2: `typecheck` killed at 10:05 against its
    `timeout-minutes: 10`; seven vrt-strict shards killed at 15:16-15:19
    against `timeout-minutes: 15`. Cause underneath is item 24 (degraded runner
    I/O — a 145 MB node_modules extract taking 4 min on a cache HIT), now
    reaching jobs beyond vrt-strict. HOW TO TRIAGE: `cancelled` + zero failed
    tests = infra; read step timings before suspecting the change.

27. ✅ **RULED 2026-09-04 — BUILD ONCE, FAN TO BOTH MERGER INPUTS.** Owner picked
    option (a): instantiate the ladder ONCE and feed that single output to both
    merger inputs. No DSP edit, no dither change, no ART re-pin. Δφ = 0 by
    construction, so the meter reads the true 1.0622 on every spawn. Needs a new
    ledger class for "dual-mono types that are actually mono", and the parked
    `EXEMPT_OUTPUT_EMIT['moog904a.audio']` comes back OUT when this lands.

28. ✅ **RULED 2026-09-04 — `saved_groups`: DROP IT in a new migration.** Owner
    chose the destructive option with the tradeoff stated: every user's saved
    group library is destroyed at deploy, and it breaks the repo's append-only
    non-destructive migration precedent (so it SETS a new one — future
    migrations may cite this). Clean schema, no orphaned table.

29. ✅ **RULED 2026-09-04 — `vizPassthrough`: RETIRE IT, DOOM edit APPROVED.**
    Scoped DOOM approval, granted explicitly: remove `data-viz-passthrough`
    from `DoomSurface.svelte`, drop `vizPassthrough: true` from every def, and
    delete `group-viz-hosts.ts` + its tests. Readers of the attribute after
    GroupCard dies: ZERO, so this is markup-only with no behaviour change.
    ⚠ The approval covers THAT ATTRIBUTE ONLY — no other DOOM code, spec, wait,
    budget or ledger entry is in scope.

30. ✅ **RULED 2026-09-04 — DOOM card source-probes: DELETE them with the card.**
    `doom-face-model.test.ts` runs source probes asserting "DoomCard.svelte must
    not own X any more" (line ~209) via `stripped('DoomCard.svelte')`. After S4
    deletes the file those read empty, and an empty string satisfies every
    "must not contain" — they would go GREEN VACUOUSLY (same shape as
    `collapse-keeps-playing.spec.ts:201`). Owner ruled: delete the two
    source-probe blocks in the SAME commit as the card. Remaining DOOM
    coverage is the face-side model legs, `face-doom.spec.ts`, and the standing
    DOOM e2e battery including collab.
    ⚠ ACCEPTED COST, named at decision time: nothing then prevents a DOOM card
    being reintroduced later.
    Original entry: **`moog904a` is stereo-decorrelated and its meters
    lie** (2026-09-04, found chasing the shard-8 "flake"). `moog904a` is
    `cls: 'dual-mono'` (`packages/web/src/lib/audio/dual-mono.ts:148`), so the
    engine builds the ladder TWICE, one per channel. Each instance bootstraps
    its self-oscillation from its OWN `Math.random()` thermal dither
    (`packages/dsp/src/moog904a.ts`). Same frequency (2684-2695 Hz, stable),
    INDEPENDENT phase. Anything that mono-sums — an AnalyserNode, and therefore
    **the shipping faceplate glyph and the legacy VuMeter** — reads
    `A·|cos(Δφ/2)|`. Measured over 25 spawns: 0.0246 … 1.0521 against a
    bit-stable single-leg amplitude of 1.0622. So **~30% of spawns display under
    half the true level**, and ~0.3% land near antiphase and read as silence.
    It breaks dual-mono's premise (the DSP is deterministic in input+params);
    moog904a is the ONLY module in the population carrying `Math.random`.
    OPTIONS, cheapest first: (a) build moog904a ONCE and fan the single
    instance to both merger inputs — no DSP edit, no ART re-pin, and it makes
    the module behave like the real mono 904A; (b) share one dither stream
    across the two instances; (c) accept the decorrelation deliberately and say
    so in the ledger. ⚠ Do NOT change the dither VALUES — that is the one route
    that costs an ART re-pin. The emit test is being PARKED with a pointer to
    this entry rather than re-pointed, because re-pointing makes the defect
    unobservable.

31. **Fleet-audit / clip-audio-save closeout + power-loss recovery (2026-09-06).**
    All 8 fleet-audit findings and the clip-audio-save gap are addressed.
    MERGED to main this session: #2367 (samsloop/warrensspectrum load-silence),
    #2369 (vst stops persisting old plugin over a loaded record; dx7 content-
    signature voice detect), #2370 (load-staleness family — finding #3 videobox+
    varispeed re-attach, #4 the four MIDI hydrate-once modules via the new
    read-only `$lib/audio/live-node-data` watch seam, #8 audio-out sink re-apply).
    The load-staleness seam DOC-against-ENGINE-polls and NEVER writes the doc.
    HELD for owner decision (green/ready, NOT merged):
    • #2363 — clip-media/recording/clipplayer/twotracks: wants the look approval
      + face-clipplayer-dock baseline authored (VRT is the intended +12px dock
      diff, not a defect).
    • #2361 — device-slots: slot-chrome look + baselines + the output1 display-
      name call (accept vs grandfather to VIDEOOUT).
    • #2368 — timelorde transport-continuity: touches a SHARED scheduler-tick /
      `muteOutputs` raw-write-ledger seam (broader blast radius than a single
      module), so held for a transport-behavior review before merge.
    ⚠ E2E FLAKE FAMILY (reded main + branch CI repeatedly during recovery, each
    cleared on re-run, NONE caused by the merges): (a) workflow-mode/surfaces
    30s-`waitForFunction` compositor-starvation (rAF/flat-poll fixtures starved
    by the live SwiftShader compositor — fix pattern is timer-poll / direct-read,
    established by the #2368 fixture work); (b) `backdraft-clocked-delay` 120s
    SwiftShader-video timeout; (c) `peertube.spec.ts:273` @video HLS capability-
    gated (real network stream — inherently CI-variable). Stabilization candidate
    whenever the owner wants it prioritized; not yet fixed systemically.
