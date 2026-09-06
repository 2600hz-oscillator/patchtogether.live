# SAMSLOOP load-silence: root cause + same-class fleet audit (2026-09-06)

Owner report: "on dev when i load this patch samsloop doesnt play."
PR branch: `fix/samsloop-load-silent`.

## Root cause (CONFIRMED — repro + negative control)

The frame→fraction window rework (#2158, 2026-08-23) moved samsloop's
START/END params from frame indices to fractions and added a load-time
migration — **inside `decodeBytesAndPush` only** (the `file`/upload hydrate
branch). The `record` (`node.data.sample`) and `legacy` (`node.data.samples`)
branches of `pushSampleIfChanged` consume the same persisted shape and never
migrated.

A patch saved before #2158 holding a recording (samsloop's primary use) with a
touched START loads with frame-indexed params. Both clamp to the worklet's
declared ±2 range, so any touched frame index resolves to `startFrac = 1`: a
**one-frame window at the sample's tail**. The playhead publishes, the waveform
paints, the faders look right — the output is the last sample repeated: DC,
inaudible. "Doesn't play."

Verified: `e2e/tests/samsloop-load-audible.spec.ts` legs 2+3 are RED on
origin/main's samsloop.ts and GREEN with the fix (negative-controlled both
directions; broken build pins the playhead at ≈0.9999 with zero spread).
REPEAT=3 green; full unit suite green; typecheck green.

Why coverage missed it: `samsloop-persistence.spec.ts` asserts the BYTES
survive — presence, not liveness. Nothing loaded a patch and asserted audible
output.

## Fixed in this PR

1. **samsloop** — `applySamsloopHydrateMetadata` (migration + metadata cache
   as one exported helper) called from ALL THREE push branches, plus a poll
   guard for the same-signature re-load (same bytes at a reused id, new
   frame-indexed params — the reconciler re-materializes nothing and never
   diffs data). Unit: `samsloop-hydrate-window.test.ts`. E2E:
   `samsloop-load-audible.spec.ts` (three source kinds × fresh-page +
   same-session routes, audible + playhead-sweep assertions).
2. **warrensspectrum** — the 120 ms band poll read the CAPTURED node (detached
   after any same-session load: `loadEnvelopeIntoStore` deletes + re-inserts
   every node in one transaction) and compared the PERSISTED `wsBandsRev`
   (two patches can hold the same rev with different tables). Now: reads via
   `livePatch.nodes[node.id]`, re-push keyed on a CONTENT signature
   (`warrensspectrumBandsSignature`, unit-pinned). Verified by unit test +
   code-identical pattern to the e2e-verified samsloop poll; no runtime leg.

## Generalized predicates

- **P1 one-branch migration**: persisted units/semantics changed; the load
  migration landed on one of N sibling consumers of the same shape.
- **P2 present-but-not-live**: node-owned media/state survives as bytes and
  paints in the UI while the engine state it drives is stale/degenerate.
  Aggravated by two engine facts (verified): the reconciler re-materializes a
  node only on id-absence or type/domain change and NEVER diffs `node.data`
  (reconciler.ts:176-186, 271-290); `loadEnvelopeIntoStore` deletes+re-inserts
  every node in one transaction (persistence.ts:553-556), so a factory-captured
  node proxy is DETACHED after any same-session load — even a poll is stale
  unless it re-looks-up `livePatch.nodes[id]`.
- **P3 presence-shaped tests**: round-trip specs asserting data-survival with
  no audible/visible-output leg are structurally blind to P1/P2
  (samsloop-persistence.spec.ts, videobox-performance-bundle.spec.ts).

## Fleet audit

Method: full audio-module factory sweep (every `node.data` consumer under
lib/audio/modules) + video/media restore-path sweep (every node-owned-media
module, all three load routes: fresh-page envelope, same-session envelope at
reused ids, .ptperf.zip). Static reads except where marked RUN.

### Ranked remaining defects (REPORT — not fixed here)

1. **clip-media GC can destroy takes the store still needs** —
   `Canvas.svelte:2593` (`void sweepClipMedia(referencedClipMediaIds(...))`,
   ungated) + `clip-media-store.ts:578-599` (`gcClipMedia([])` frees every
   non-recording take). Routes: (a) pre-provider-sync EMPTY snapshot on
   `/r/[id]` (the TIMELORDE auto-spawn effect gates on 'synced'; this effect
   does not — UNVERIFIED timing, but the guard is absent); (b) rack switch in
   the same origin — the OPFS store is origin-global, so rack B's sweep frees
   rack A's takes (`resetClipMediaSweepMemo` documents the case and has NO
   production caller). Severity: data destruction, unrecoverable. Fix shape:
   gate the sweep on provider-synced + a minimum-population/empty-set refusal,
   and wire the memo reset on rack switch. Owner decision on rack-scoping.
2. **Recorded clip audio is absent from every save format** — clip bytes live
   only in origin-local OPFS (`clip-media-store.ts`); the perf-zip collector
   gathers only video + twotracks tapes (`Canvas.svelte:3689-3706`), and the
   envelope carries only `mediaId` strings. A .ptperf.zip on another machine
   loads with every recorded clip SILENT, no notice (missing media is
   swallowed: `clipplayer.ts:834`). #2360's message reasons about clip takes
   riding the zip as role 'audio' — no such export path exists. Feature-shaped;
   owner decision.
3. **videobox + videovarispeed same-session reused-id staleness** — loading v2
   of a patch over v1 keeps PLAYING v1's clip while the UI reports v2's file:
   `node-video-source-registry.ts:608-612` (reload only in createController;
   `handleReloadAttempted` never re-armed) and `node-varispeed-registry.ts:
   761-782, 1111-1123` (`hasBytes` short-circuits the pump), ×7 slots.
   Archivist already has the correct pattern — re-attach when the persisted
   identifier changes (`node-archivist-source-registry.ts:629-652`); port it.
4. **HYDRATE-ONCE MIDI family** — factory-captured data, stale after a
   same-session load at reused ids (wrong device/channel = silent):
   midi-out-buddy.ts:531-533 (out device + channel), midi-lane.ts:668-679
   (channels/mode/CC#/device), midi-cv-buddy.ts:610-620 (channel/device/
   priority/retrig), midiclock.ts:386-411 (device; plus a P1: the legacy
   `data.divisor` fallback runs factory-only and a legacy patch has no
   `params.divisor` for the reconciler to diff → wrong clock division).
   Partial mitigation: the perf-zip route re-binds devices via
   `autoBindMidiDevices`; the plain envelope route does not.
5. **clipplayer stride-8→64 clip-key migration is factory-only**
   (`clipplayer.ts:1143-1195`, on the stated-but-false premise that the
   factory "always runs") — a pre-`sv` patch loaded at a reused id never
   re-keys: clips read at stride-64 against stride-8 keys → pads silently
   never fire; the LWW-hardening containers are also not created. Runtime
   reads are otherwise WATCHED. Fix wants the same care as the containers
   (LWW races) — not a drive-by.
6. **vst-bridge** — `data.vst` read only on connect/first plugin-list and only
   when nothing is mounted (`vst-persistence.ts:106-116, 189-201`); a
   same-session load never re-reads, and the driver then PERSISTS the
   currently-mounted plugin back over the loaded patch's saved `data.vst`
   (`:127-140`) — the load is silently reverted in the doc. UNCERTAIN on the
   socket lifecycle; vst has its own active branches.
7. **timelorde legacy `isPlaying`→muteOutputs migration is spawn-only**
   (`timelorde.ts:538-546`) — a v1 patch loaded over a live TIMELORDE keeps
   the previous mute/run state. Transport = whole-rack blast radius; DO NOT
   drive-by (owner's clock).
8. **audio-out sink applied once at boot** (`audio-out.ts:464`) — a loaded
   patch's output-device pick is ignored on same-session load.
9. **twotracks tape loss on .imp.json has no user-facing notice** — correct
   behavior (worklet-owned PCM, zip-only), stated only in a code comment
   (`Canvas.svelte:3417-3421`). One-line notice at export/load closes it.
10. **dx7 voiceRev aliasing (UNCERTAIN)** — reads are live (WATCHED) but the
    change test is presetName+voiceRev, both persisted; two saves can alias.
    Same class as the ws rev aliasing fixed here; lower probability.

### Checked clean (mechanism + file:line in the audit transcripts)

- WATCHED (live `livePatch` lookup + signature/tick): samsloop (fixed), dx7,
  cube, wavecel, wavesculpt, kria, score, numpad-plus, gamepad, ptzcam,
  chromaconsole, clocked-runner, twotracks (reels worklet-owned).
- Extras-producer registry (re-runs on data signature at reused ids):
  picturebox, toybox layers/shader/OBJ, painter, textmarquee.
- RESTORE-OK / by-design: archivist (identifier-change re-attach — the model
  fix for #3), lushgarden (static site assets, nothing persisted), camera/
  ptzcam (re-acquire by design), recorderbox (OPFS scratch deliberately
  outside the patch; recovery has a surface), videobox/varispeed zip route
  (bytes seeded to IDB pre-envelope; plain-envelope re-link is prompted).
- IRRELEVANT: audioin, charlottes-echos, mixmstrs, moog912/993, livecode,
  trails, transport helpers, clip-* pure coercers.
- Load routes converge: importPatchJson, `__persistence.load`, perf-zip and
  preset slots all funnel through `persistenceLoad`; the envelope carries the
  whole node.data (samsloop bytes included; #2355's streaming zip releases
  only out-of-band media buffers — envelope untouched).

### Completeness critic (what was NOT checked)

- peertube / tvlibrarian: the no-card death was fixed by the nodeHlsSource
  registry; whether a same-session load that CHANGES the persisted selection
  re-attaches was not audited.
- milkdrop preset data restore; DOOM (excluded by name — owner boundary, not
  audited); toybox worker locus (`?videoworker=1` flag-gated: worker never
  receives loaded data without ToyboxConsole mounted — latent, flagged).
- The pre-sync GC race (1a) is argued from the absent guard, not run.
- quicksave `applySnapshot` writes data+params at reused ids
  (transport-card.ts:122) — safe for SCORE (live reads); unaudited against
  every module wired into QuicksaveControls.
