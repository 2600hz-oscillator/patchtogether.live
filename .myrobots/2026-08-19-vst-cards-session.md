# VST BRIDGE cards — build session record (2026-08-19)

Executor session for `.myrobots/2026-08-19-vst-card-plan.md`. Issue: #1953.
Everything below marked MEASURED was run in this session; INFERRED is
reasoning not yet confirmed against a live helper.

## Shipped

| PR | scope | state (as of writing) |
|---|---|---|
| #1954 | M1 — vst-protocol.ts (0x01 + 0x02 codecs), vst-ring.ts (audio + MIDI SAB rings), dsp vst-bridge-core.ts (PolyMidiVoice, note/vel conversion duplicates + twin pins) | MERGED on green |
| #1967 | M2+M3 — transport (worker/client/owner, per-card connections, clientId = node id), dsp vst-bridge worklet, both defs + cards + VstBridgePanel, all registration/gate enrollments, mocked-helper e2e (vst-bridge.spec.ts + vst-lane-autowire.spec.ts), VRT exemptions | OPEN, CI running on 1617eb64 |
| (local) | M4 — vst-persistence driver + owner unmounts/stale-mount fixes + state-size UI + owner-verify doc + persistence e2e assertions | branch `feat/vst-bridge-m4-persistence` (3e75fbcb), PR held for a slot; body ready in scratchpad |

## MEASURED (this session)

- Note table pinned at THREE levels: unit (dsp duplicates + web canon,
  same table), and at the WIRE via the mocked helper: polyseqz-seeded
  roots c3/c4/a4 arrived as MIDI 48/60/69 (within the exact
  chordToVoices-derived voicing set). Unpatched vel ⇒ every NoteOn vel
  100. After transport stop every NoteOn had a NoteOff per note number.
- The owner's lane sentence passed end to end
  (vst-lane-autowire.spec.ts): palette-drop wiring pitch1→poly,
  gate1→gate, vel1→vel, outs→mixer ch1; vstFx insert re-route; clip →
  instrument(mock sine) → fx(echo) → mixer meter + audio out audible RMS.
- mono-normal gate caught a REAL defect: vstFx mono patch into in_l left
  OUT R silent → fixed in the worklet (inputs[IN_R] ?? inL, both paths),
  enrolled in the stereo-mono-normal e2e roster (row passes).
- e2e/package.json is a webgl-attest TOOLCHAIN PIN
  (webgl-attest-lib.ts:158). Adding `ws` there moved the WebGL content
  hash to 05428f75… and redded webgl-attest. Fix: declare ws +
  @types/ws at the ROOT package.json (NOT in the basis) — basis files
  byte-identical to main again, no GPU re-attest needed. Comment on the
  mock's import site explains this so nobody moves it back.
- polyseqz has NO 'mono' quality (CHORD_QUALITY_NAMES: maj/min/maj7/…);
  its closed voicing FILLS all voice lanes with octave doublings
  (chordToVoices) — derive expected note sets, never hand-type them.
- vitest `task test:one -- "a|b"` filters are SUBSTRINGS not regex.
- Full web unit suite on the M2/M3 tree: 16117/16118 (the 1 red was
  vrt-meta pre-exemption; green after the exemptions). dsp 1226 green.
- One TRANSIENT: per-module-per-port-inputs vstInstrument failed ONCE in
  the first combined local sweep run, passed on every rerun (solo and
  combined). Not reproduced; if CI shards show it, start there.
- VRT: full-sweep capture run 32299852863 was dispatched then CANCELLED
  (exemptions made it moot); NO bot commit landed on the branch.
- Backticks inside a double-quoted `git commit -m` get shell-substituted
  — one commit message got mangled (`unmounts` → gap); M4's was amended,
  the M2/M3 one (799f8887) still has the cosmetic gap.

## INFERRED / owner-verify (do NOT claim as verified)

- Everything live-helper: docs/vst-bridge-owner-verify.md is the
  checklist (DLS/AUDelay by ear, editor windows, park/adopt refresh,
  helper-restart cold remount, latency numbers, two-tab eviction).
- The adopt/cold disambiguation uses a 1 s grace after connect; helper
  change request (non-blocking): `adopted: true` on replayed `mounted`.
- Int32 ring counters wrap ~12.4 h @48 k; a manual reconnect after that
  re-bases the sampleTime epoch (documented in bridge.worker.ts start).

## Where things live

- Transport: packages/web/src/lib/audio/vst/ (protocol, rings, client,
  worker, owner, persistence). Worklet: packages/dsp/src/vst-bridge.ts
  (pure core: lib/vst-bridge-core.ts). Defs: modules/vst-instrument.ts,
  modules/vst-fx.ts, shared factory modules/vst-bridge-shared.ts. Cards:
  ui/modules/Vst{Instrument,Fx}Card.svelte + VstBridgePanel.svelte.
  Mock helper: e2e/_helpers/mock-vst-bridge.ts (real `ws` server, real
  codecs imported from web source via relative path).
- The def files each carry the 'vst-bridge' processor literal at the
  factory call site ON PURPOSE (typed VstProcessorName) — mono-normal-scan
  attributes worklet normals to defs by finding that literal in def code.

## Next session must

1. If #1967 not merged: merge on final-commit green (standard
   merge-on-green; new cards, no existing-look change), then
   `task pr:conflict-sweep`.
2. Retarget/rebase `feat/vst-bridge-m4-persistence` onto main, push,
   open the M4 PR with scratchpad body (`Closes #1953`), merge on green.
3. Hand the owner docs/vst-bridge-owner-verify.md.
4. Plan open questions Q1 (legato = off+on shipped; pitch-bend slides are
   a possible follow-up), Q3 (fx stays 100% wet — shipped), Q4 (both
   cards unfaced — recorded as bespoke-surface in the face-migration
   inventory with the needs-note-entry-cell blocker).
