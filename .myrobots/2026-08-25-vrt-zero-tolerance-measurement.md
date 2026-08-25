# VRT zero-tolerance: Phase 1 measurement (in progress)

Owner premise: a Svelte component tree can render deterministically every time,
so every pixel of VRT tolerance is hiding a bug.

Current tolerances (e2e/vrt/_shell-faces.ts, e2e/vrt/vrt.config.ts):
  DOCK_MAX_DIFF    = 1500 px
  COMPACT_MAX_DIFF =  150 px  (documented as INERT)
  threshold        = 0.1  (26/255 per channel)
  maxDiffPixelRatio= 0.01

Phase 1 question: boot each face TWICE on linux CI and diff at ZERO tolerance
(threshold 1/255, any difference at all). Population of non-deterministic
scenes is what the decision rests on.

This file is scaffolding for the branch; the measurement lives in the probe
spec and the report.
