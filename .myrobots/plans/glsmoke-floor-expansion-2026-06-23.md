# glsmoke floor expansion + heavy-spec → SwiftShader conversion roadmap (2026-06-23)

Direction (owner): KEEP the two-pronged GL CI setup — the SwiftShader **glsmoke
floor** + the local real-GPU **webgl:attest** — and make BOTH as good as possible.
NOT the 4090 self-hosted runner (shelved; memo
`.myrobots/plans/4090-gh-runner-investigation-2026-06-23.md`).

## Ground truth (measured 2026-06-23)
- Full heavy GL set on a GitHub-hosted ubuntu SwiftShader runner @4 workers:
  **26.2 min, 117 passed / 39 FAILED / 1 skipped** (PR #881 experiment, since closed).
- Full heavy set on a real GPU (attest, M5, workers=1): **4–6.6 min** (ci-webgl-attest JSONs).
- 11 bounded-step `*-render-smoke` specs are cheap on SwiftShader (1.9–8s, vetted 3×).

## DONE
- **Floor +11** (this PR): the 11 cheap render-smoke specs added to the webgl-smoke
  job (by file, no spec edits → no re-attest). EXCLUDED peakstate-render-smoke
  (fails SwiftShader = real-GPU dep) + outlines-render-smoke (~48s, too slow).

## The classification of the 21 SwiftShader-FAILING heavy specs (gl-ci-viability workflow)
**14 convertible-to-SwiftShader · 5 real-gpu-only · 2 infra-gated.**

### CONVERT → bounded-step DRS, then move to the floor + OUT of the heavy globs (re-attest after each wave)
LOW effort:
- wavecel-video-outs.spec.ts
- videobox-performance-bundle.spec.ts
- video-audio-cvgate-coverage.spec.ts
- toybox-presets.spec.ts
- toybox-node-menu.spec.ts
- toybox-node-controls.spec.ts
- toybox-layer-selector.spec.ts
- peakstate-render-smoke.spec.ts  ← already DRS; fix = kill the 48-step warmup via a
  one-shot __peakstateVrtSeed opaque-clear + gate unread mono_out/out_3d behind
  frame.isOutputConnected (drops 60 steps → ~12). Then it can JOIN the floor too.
MED effort (toybox UI/render — verify the worker-render dependency per spec; the
pure UI/store ones convert, the ones that assert worker pixels may not):
- toybox-video-projection · toybox-shadertoy · toybox-node-batch ·
  toybox-new-content · toybox-layer-input · toybox-disk-loading

### REAL-GPU-ONLY → stay on the attest; HARDEN their reliability there
- b3ntb0x.spec.ts — 4-pass NTSC composite at OVERSAMPLE=8 (~30-35M texture
  fetches/frame); raw per-frame shader cost, already DRS. VRT-exempt.
- multi-video-playback.spec.ts — real 4× <video> decode-throttle; can't freeze
  (decode cadence owned by the browser, not engine.step()).
- wavesculpt.spec.ts — heavy 3D + the BLINK-trace assertions that capability-skip
  on SwiftShader (the genuine real-GPU-only markers).
- toybox-feedback.spec.ts — worker OffscreenCanvas compositor (renderLocus:'worker',
  free-running setTimeout loop that ignores __videoEnginePause).
- toybox-combine-editor.spec.ts — same worker-compositor path + interactive editor.

### INFRA-GATED → can't run on CI regardless of renderer
- videovarispeed-output.spec.ts — real video-file decode + keep-alive timing.
- videobox-output.spec.ts — real video decode.

## Attest hardening backlog (the OTHER prong)
- caffeinate -dimsu wrap: **already done** (scripts/webgl-attest.sh:26). task #150 stale.
- JSON-store prune: ci-webgl-attest/ is 50 files, only ever grows; add a prune
  (keep only the live hash; git retains history) → kills the manual git-rm-superseded step.
- #151 toybox real-GPU flake: the 5 real-gpu-only specs (esp the toybox worker ones)
  must be rock-solid in the attest — they're the irreducible set.
- Clearer preflightSolo messaging for the co-tenant (Edge) refusals.

## Execution order (next waves)
1. Land Floor +11 (this PR) → confirm webgl-smoke green on CI.
2. Convert LOW-effort batch (incl peakstate) → DRS, remove from heavy globs, add to
   floor, ONE re-attest. (workflow: author conversions in parallel, I validate + attest once.)
3. Convert MED toybox batch (verify worker-render dependency first).
4. Attest hardening: JSON prune + real-gpu-only reliability.
Net endgame: floor grows 11 → ~25; attest shrinks to ~5 real-gpu-only + 2 infra-gated
+ the already-passing heavy residue. Both prongs maximally good; no 4090 needed.
