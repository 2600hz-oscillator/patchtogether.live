# Two things left over from 2026-08-01 (was: VRT hardening · DX7 · freezeframe)

Everything else this note carried has shipped and the rest was trimmed
2026-08-12. DX7 is done (8 of 8, through #1270). FREEZEFRAME's gate/trigger fix
merged as #1274 — with the FRAMETABLE sibling, a CI lane and a structural guard —
and the `HOLD_QUALIFY_MS` ↔ `DEFAULT_GATE_LEN_S` tie was resolved deliberately at
**75 ms / 3 ticks** (`freezeframe.ts:680`), not left at the boundary; the
HELD-vs-TRIGGER semantics rule now lives in that file's own header. The whole VRT
section described the two-platform baseline world that #1458 deleted.

Two items survive.

## 1. `feat/tidyvco-sine-tri-square` — pushed, no PR, never merged

Branch is still on `origin` at `30a5e8b6`. SHAPE morph becomes
sine → triangle → square; spectrally verified. **Needs owner ears — it is
audio-affecting, so it cannot self-merge.**

Two things known to be wrong with it, and they are the reason it is worth
finishing rather than dropping:

- the alias gate is **blind to the dominant images** — it passes on a signal
  whose loudest aliases it never looks at;
- **PW/PWM is inert across the lower half of SHAPE.**

## 2. The `combine-editor` fresh-spawn collapse — a product bug laundered by re-pinning

The toybox node-editor panel silently collapses to its minimum size on a fresh
spawn: a layout↔state feedback loop. The interesting part is how it hid — **its
VRT baseline oscillated dimensions for ~7 weeks against byte-identical source**,
and every re-pin absorbed the oscillation as if it were noise. A baseline that
changes size while the source does not is a product bug, never a capture flake.

Last re-verified 2026-08-04 as believed-open; not re-measured since.
