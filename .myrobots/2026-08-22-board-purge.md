# Board purge — 2026-08-22 (owner-directed, adversarial)

Owner directive, verbatim: "adversarial agent to please review the issues list and just close
anything that's not critical to functionality or CI wall time. it's full of garbage i didn't ask
for, i think a lot of it is either obsolete or not useful and i don't care about losing it,
clean that shit the fuck up."

Result: 130 open → 96 CLOSED · 26 KEPT by criterion · 8 mechanically exempt.
Every close carries the same comment with a reopen invitation. Nothing else was touched.

## KEPT — (a) live user-facing functionality defect, verified framing

- #2054 foxy rebuilds a 256×256 volumetric field ~24×/s on the MAIN THREAD — audible-glitch class
- #2045 concurrent multiplayer spawn can dispose() the LIVE ES-9 hardware bridge
- #2036 mandelbulb.detail dead over 15/27 positions and the DEFAULT sits in the dead band
- #2008 gatemaiden TRI delivers HALF the area of SQR (owner ears)
- #2002 rasterize GAIN: curve:log silently ignored; floor paints mid-grey, not darkness
- #2000 rasterize SCAN is a change detector, not a position control — the knob lies
- #1999 wavecel ships bit-exactly MONO; 5 of 10 params inert at spawn
- #1961 warrensvisions: 5 of 7 CV inputs cannot reach documented behaviour; COHERENCE stuck
- #1946 b3ntb0x TBC default makes the module's documented headline gesture impossible
- #1937 SCREEN OFF stops renewing the watch mark — the toggle can kill the producer (spirographs, freezeframe; #2015 closed as same-class, covered here)
- #1913 moog904a self-oscillation does not track 1V/oct and exceeds full scale (owner ears)
- #1900 moog921Vco width_cv pins 68% of every LFO cycle (owner ears)
- #1883 moog921Vco SOFT sync is bit-identical to HARD at 67.77% of pitches (owner ears)
- #1826 /rack boots NO engine and shows no audio prompt — the default route is silently dead
- #1762 three affordances every legacy card has and all 45 faces lack — functional parity
- #1754 pinned TIMELORDE's producer is DEAD on every default rack
- #1737 mixmstrs macro clobbers a saved compressor by +29.17 dB — live, destructive
- #1667 auto-wire grabs channel 1's direct out instead of the MIX bus on multi-out mixers
- #1583 EPIC (P0): card unmount destroys node-lifetime resources — 12 candidates, 11 modules

## KEPT — (b) CI wall time / stability / ability to merge

- #2105 wavesculpt BLINK fails all retries under attest Pass A-heavy — taxes every attest window
- #2017 an e2e spec edit implicates every module the spec SPAWNS — forces full sweeps on face PRs
- #1847 FLAKE PARK ledger (95 parked tests) — THE tests-to-fix list the owner's park rule mandates
- #1816 every github-actions[bot] pull_request run parks at action_required — merge friction on every capture-bot push
- #1813 clipplayer-controls e2e cost jumped 10× on an unchanged spec — literal wall time
- #1787 waitForTimeout ledger payoff — active program, flake/wall reduction (two batches queued)
- #1505 attest umbrella waits on jobs it ignores; basis wider than the import closure — latency on every basis PR

## EXEMPT — mechanical

- #2089, #2090, #2101 — Fixes-referenced by OPEN PRs (#2118, #2120, #2110); close on merge
- #1810, #1808, #1763 — alert label (own lifecycle)
- #1803, #1801 — observability label (own lifecycle)

## CLOSED — 96, one line each

- #2113 VRT face harness: bootWithFace can pin a GLOBAL but not a PARAM — which is the only thing keeping acidwarp out of the FACES roster
- #2112 [P2][testing] rings model-switch test asserts a property BOTH models share — peak>0.01 cannot fail on a model that never switched
- #2095 infra: Neon bill decomposition + self-host evaluation — $1/day at one-user traffic is compute churn, not load
- #2094 /dev/video-patch-drop is the largest single ROUTE in the production Worker — should /dev/** ship at all?
- #2085 Video face tier-ladder comments describe a PLATE tier that does not exist — faceTierCap is geometry, not LANE_PLATE_MAX_CELLS
- #2084 vco-scope-audio-trace is re-rolled by every FULL sweep: phase nondeterminism the two-consecutive-captures precondition structurally cannot see (2nd sighting of the #2077 class)
- #2080 monoglitch's VRT mask 'why' claims it re-randomises off the engine clock — the shader has no clock and no RNG
- #2079 Local e2e is fully blocked in a fresh worktree: dsp:ensure reports "dist is current" while dist/vst-bridge.js is missing
- #2068 midi-binding-node-lifetime borrows a real UN-MIGRATED module as its subject — a target that expires by design, twice in one day; it needs a forced-placeholder hook, not a third re-point
- #2065 spectrograph's face would DROP its live sonogram — hasVideoSurface is a DOMAIN check, and an audio module with mono-video outs has no engine surface
- #2063 worktree:guard can DELETE a live agent worktree — its abandoned predicate (clean + fully-pushed) has no liveness check and describes every freshly-spawned worktree; the victim silently falls back to main
- #2060 Spawning THREE audio modules took 28.2s in one in-page evaluate on a 2-core runner — a rack-load cost players pay, not a test defect
- #2051 The momentary/latching ratchet is blind to noUserControl, and whether it fires at all is an accident of `curve` — backdraft and colourofmagic get opposite treatment for the same VRT freeze param
- #2049 RuttetraCard.svelte re-types twelve numeric ranges and is not in RANGE_BOUND_CARDS — they agree with the def today, so nothing at source level stops the next edit diverging
- #2047 ruttetra def labelled three params 'Tint R/G/B' while its card has always passed 'R'/'G'/'B' — a recorded VOCABULARY_DEBT divergence, now drained
- #2043 The VRT font pin has a COVERAGE HOLE: all 5 bundled faces are ~230-codepoint Latin subsets, so 65 of 224 cards render text through an UNPINNED fontconfig fallback
- #2042 rasterize's fullViewBody has ZERO e2e coverage — the extension IS the reason it could be promoted, and dropping it would go green
- #2029 Nothing gates the half of the SCREEN ON/OFF ruling that matters: a faced video module may stop renewing its watch mark on OFF and drop out of the pull set
- #2023 acidwarp cannot be promoted yet: it is VRT-EXEMPT for nondeterminism its own freeze does not fix — plus 8 palette names stranded in the card and a CV-only sceneTrig a face would paint
- #2020 The §B10 spec bank instructs three builds to declare FaceReadoutValue — the mechanism was deleted (1809 lines) BEFORE the base it measured
- #2019 Family cells print their full `controlFamilies.label` as a resting caption, and `bareCells` is lint-restricted to params so nothing can suppress it
- #2015 spirographs SCREEN OFF stops the render loop and renews no watch mark — it violates the 'keeps rendering while OFF' ruling whenever the faceplate is the only watcher
- #2005 synesthesia's eight band GAINs are boost-only (1..2) and ship at their MINIMUM, and MASTER's 'unity at noon' is asymmetric by 2.5 dB
- #2004 synesthesia's VIDEO mode has NO non-card implementation — a face deletes an entire operating mode and orphans 2 of its 4 inputs
- #1992 flake(e2e): two SYSTEMIC populations behind the #1907 tail — 75 GL-readback polls, and 31 specs on the invisible 30s default with a bare waitFor
- #1981 wavesculpt BLINK scope leg renders ZERO pixels nondeterministically under real-GPU attests — the #1905 producer-race family, third module
- #1976 vite preview serves assets without COI headers — every dedicated worker (es9 + vst bridges) silently dead in preview/CI e2e
- #1974 A promoted face can resolve to an EMPTY LANE PLATE — and it blocks joystick (Q43) on functional parity, not on #1963
- #1964 The rolling spec index recommends `face.paramCells: 'toggle'` — that value does not typecheck, and the cheap fix it promises does not exist
- #1960 warrensvisions: the shipped docs describe a LOCK control that does not exist — the core runs it pinned at 0.5, worth 2.5x salience on a lattice fundamental (+2 more docs-vs-code contradictions)
- #1956 bentbox: `__bentboxFreezeTime` pins uTime but NOT field parity — the module animates period-2 at the shipped defaults, so it cannot baseline
- #1947 b3ntb0x: the DECODE program binds uEncode every frame — activeTexture + bindTexture + uniform1i — and never samples it
- #1941 face-outlines-dock VRT is non-deterministic: the phase pin is DEAD CODE because the face harness never sets the flag it waits on
- #1940 b3ntb0x: the 'bend_d IS enhance' finding is HALF right — they coincide only at the defaults, and the module's own headline gesture is what separates them
- #1932 Canvas skips the headless producer host when a dock full view is open — correct for a CARD, wrong for a FACE; a forward trap for promoting scope/timelorde
- #1922 mandelbulb: hue=1.0 is bit-identical to hue=0.0, the slice box ignores CV while the waveform beside it follows, and both drop sub-0.0005 moves
- #1921 mandelbulb: no resize() — the 16:9 output switch stretches the bulb by 1.333×, and three resolution constants in the file are stale
- #1918 moog912: the rectifier curve never reaches 0, so a SILENT follower emits a constant +9.7752e-4 DC on ENV forever
- #1915 face-migration inventory: moog960 is the ONLY playhead-driven module classified generic-face — its 8 siblings are all bespoke-surface, and a face would drop the live column playhead with no cell to replace it
- #1908 The DRS harness drives its whole frame burst in ONE page.evaluate — that renders BLACK under SwiftShader, and b3ntb0x.spec.ts fails there today (unreported: webgl-smoke is grep-tagged)
- #1888 The 'envelope' glyph resolves on four HARDCODED param names, so moog911 — the repo's other envelope generator — can never draw one; give the def a role mapping (hash-transparent, contract-free)
- #1886 moog911a has NO trigger queue and no doc says so — at the shipped 0.1 s default a 16 Hz clock puts 48 triggers in and 0 pulses out; plus a 1 ms pulse width on no dial and a SERIES total stated as an exact equality that is off by one sample
- #1885 moog911's three T knobs declare units:'s' and none delivers it — T1 is x1.3816, T2 ranges x1.3816..x0.0001 depending on a DIFFERENT knob, and each T is bit-exactly inert in a region at its own endpoint
- #1884 moogCp3's docs state the mix equation two different ways in ONE file — the wrong form overstates the delivered level by up to 100%, and the shipped math makes ch4 and attenuator4 bit-exactly interchangeable
- #1881 moog905: the calibrated tail oracle CONVERGES — 2.7% mean error, and the spec's table is 1.31-1.52x wrong
- #1877 swolevco: SYMMETRY exceeds full scale at both ends (peak 1.0286 saw / 1.0428 square) and its level is non-monotonic across the sweep
- #1868 audio: moog923's two filters carry +1.96 dB of resonance nobody chose — Web Audio reads lowpass/highpass Q in DECIBELS
- #1866 outlines: 'shape' is a six-state named enum (circle/triangle/square/pentagon/hexagon/octagon) declared curve:'linear' with no options[] — it renders as a smooth rotary over six silent 0.1667-wide bands at every tier
- #1865 STOP 2 population: the 'hide controls → resizable monitor' node.data affordance is on 8 generic-face pool modules with no shell representation — 6 of them unspec'd, and every def-reading gate is blind to it
- #1857 VRT's 1% ratio spans the whole card, so a visibly-wrong LIVE CANVAS passes — and a passing baseline is never rewritten (measured: 1099px over threshold, worst 83/255, PASS)
- #1835 flake: vrt-strict LEG 0 'no analyser could attach' — readFaceAudio is a single-shot read gated on PAINT readiness, not on the audio graph
- #1819 Per-module drop-gesture coverage as each video module gains a face
- #1817 docs-only-gate guard G2 inherits the weak question #1815 just fixed: a PARKED ci.yml run makes it refuse a bypass that should apply
- #1814 ART wavetable-vco cv-path fails nondeterministically: same branch, byte-identical audio surface, green on one commit and red on the next
- #1804 warrensspectrum filterbank INSTRUMENT CHECK is load-sensitive — p99 ratio measured 2.59 against a floor of 3 on loaded CI, passes 3x locally
- #1797 art-gallery.yml is unrecoverable after a transient Pages failure: rerun-failed-jobs duplicates the github-pages artifact, and there is no workflow_dispatch
- #1791 moog921a WIDTH at its declared MINIMUM (0.000) produces the MIDPOINT duty (measured 49.85 %) — a 2 %-wide plateau, a 48-point discontinuous drop, and dead travel above 0.98
- #1786 BackdraftCard's band readout is computed at a hardcoded bezel of 0.4 while the param ships at 0.5 — and is blind to BEZEL entirely (measured 0 bands vs 14 across its range)
- #1779 illogic-face.spec.ts: the AND/NAND readiness poll gates one snapshot and asserts a DIFFERENT one — 7/9 under load, 18/18 quiet
- #1773 analogLogicMaths: both CV inputs are bit-exactly inert UPWARD at the shipped default — attA/attB ship AT the param's declared max
- #1767 [ui-v2] The dock drawer needs a HEIGHT control — one control, top-right, sizing the vertical space every open module gets
- #1755 The four GAME modules declare vizPassthrough but GroupCard mounts nothing for them — a collapsed group shows an EMPTY viz slot
- #1752 A local VRT run SILENTLY AUTHORS the missing baselines it just failed on — and a second local run then reports them PASSING
- #1747 featurecv's card meters disagree with the jacks they name — unsmoothed targets, so ATK/REL move them by exactly 0
- #1736 card-def-agreement is blind to TEMPLATED paramIds — 80 of MixmstrsCard's 89 controls, in neither gate nor ledger
- #1734 slewSwitch: the CV audit that cleared all four paramTarget inputs left NO permanent gate — and the `input: 0` fallback would keep a sweep green
- #1723 backdraft: the engine→store reflect for five gate-flipped params is dead unless the card is docked (card-unmount class)
- #1709 A new e2e spec can fall out of PR coverage by FILENAME ALONE — webgl-heavy globs auto-enrol into a lane that no longer runs
- #1704 buggles: RING is documented as "audio-rate" in five places and its carrier tops out at 12.5 Hz
- #1699 ART: moog914/907a pin with RAW repoSourceSha, so a COMMENT in the shared lib invalidates an audio baseline — contradicting the profiles' own stated precedent
- #1698 moog filter banks: ONE Q constant is read as linear Q by 12 bandpasses and as DECIBELS by the 2 shelves (+4.00 dB corner resonance, undocumented)
- #1687 [P1][testing] Does the #1680 offline-render race reach ART? cube + cloudseed have baselines and were measured non-reproducible
- #1684 [P2][ci-health] e2e:timings:accept is a SINGLE-SAMPLE replacement, so "a cost that moved a lot is a finding" cannot be acted on
- #1683 [P2][testing] A bare root `npx vitest` globs into .claude/worktrees — one file ran as five, four from other branches
- #1673 WARRENSSPECTRUM's 8×5 filterbank is unreachable from MIDI — the bands are node.data, not ParamDefs
- #1659 [P3][dsp] rbj-biquad: fc unclamped at the low end goes UNSTABLE, Q=0 yields NaN, and sr is in no cache key
- #1606 Shell/legacy PARITY: 377 of 431 e2e specs reach the canvas on ?shell=legacy — features can be dead on the default rack and green in CI
- #1576 TOYBOX randomize: context-aware curated random patches, node/layer locks, expanded asset bank — on a dynamic-registry architecture
- #1575 toybox.patchtogether.live — public sandbox subsite for pasting shaders and uploading OBJ/assets that run in TOYBOX
- #1569 [P1][ci-health] The e2e flaky tail is SIX tests, not two — 10 of 12 green runs hid one; --fail-on-flaky stays off until it is drained
- #1527 2026-08 hardening punch list — index, ordering, and orchestrator guide
- #1525 [P2][testing] One scan library + one VRT roster: collapse 12 tree-walkers and ~23 hand-rolled source guards
- #1522 [P1][testing] Playwright taxonomy: journey / integration / probe tiers, plus a real black-box journey suite
- #1521 [P3][legacy-removal] LEG-10: post-deletion consolidation and the second LoC harvest
- #1520 [P2][legacy-removal] LEG-09: rewrite, move, or delete every legacy-coupled test — deliberately
- #1519 [P2][legacy-removal] LEG-08: delete the 195-card fleet (~70k LoC) and its import infrastructure
- #1518 [P2][legacy-removal] LEG-07: delete the shell switch, placeholder, dock legacy branch, and headless host
- #1517 [P1][legacy-removal] LEG-06: replace visual coverage — full-tier face baselines, per-scene budgets, delete-on-migrate
- #1516 [P1][legacy-removal] LEG-05: migrate the ~164 remaining modules in risk cohorts
- #1515 [P0][legacy-removal] LEG-04: invert the canonical e2e fixture to the default shell; generated allowlist for the legacy remainder
- #1514 [P1][ui-v2] Extract the typed, dev-only e2e test bridge out of Canvas
- #1513 [P1][ui-v2] Canvas.svelte (8,610 lines): staged controller extraction
- #1511 [P0][legacy-removal] LEG-02: node-owned media lifecycle — no source may exist because a card is mounted
- #1509 [P0][ui-v2] LEG-03a: a note-entry face cell, and consolidation of the 8 hand-cloned xy pads
- #1507 [P2][ci-health] CI machinery diet: composite setup action, dead workflows, generated required/informational DAG, cache keys
- #1503 [P1][ci-health] Deterministic + least-privilege CI: npm ci, exact Playwright pin, SHA-pinned actions, permissions, dependabot, scanning
