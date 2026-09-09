# EDGE CLEANUP — the classification SHIPPED; these 5 owner calls did not

The 276-row Phase 0 classification table that used to fill this file is **fully
discharged and has been deleted.** Its output now lives in the tree, which is a
better copy of it than this file was:

- `packages/web/src/lib/docs/undeclared-edge-ledger.ts` — **deleted**; the debt
  it inventoried was paid, not carried.
- Every pair is declared on its own `PortDef` (`edge: 'trigger' | 'gate'`), and
  `contract-lock.txt` carries **380** `edge=` tokens.
- All 6 CONTRADICTION rows resolved DSP-wins, verified in the defs:
  `drummergirl.gate`, `flipper.in1/in2`, `moog961.s_in/v_out1/v_out2` are all
  declared `gate`, and the trigger-vocabulary prose that contradicted them is
  gone.

**Pattern worth keeping from that exercise:** 5 of the 6 contradictions were the
same shape — *a module whose DECISION is edge-driven but whose SIGNAL PATH is
width-preserving.* The author documented the decision; the contract needed the
signal path. FLIPPER and MOOG961 cross-reference each other in source
("duration-matched, like FLIPPER"), so they were one finding, not three.

**And one property of the vocabulary lint, not of the ports:** `kria.gate1`
passed while `gate2/3/4` failed on the identical semantic, purely because the
first sibling got the long sentence and the rest got the short one. The bare
word "gate" is not in `GATE_VOCAB` — prose must say *while / held / high /
level* to satisfy a `gate` declaration.

---

## Ports where the DSP suggests the CONSUMER may be wrong — OWNER DECISIONS, still open

These were explicitly held back from Phase 1: they are classified by what the
code does, and changing any of them is a behaviour change.

1. **`drummergirl.gate` — the docs describe a module the DSP is not.** The one
   place where a user-visible behaviour is genuinely in question, not just a
   wording choice. On the **7 of 16 shapes with `sustainOf > 0`** (up to 0.5,
   `drummergirl.dsp:35-37`), a *held* gate sustains the drum indefinitely. Either
   the prose was wrong (declare `gate`, fix the prose — **what shipped**) or the
   DSP should force `sustain = 0` for a true one-shot drum voice. **The second is
   a behaviour change and needs the owner.** Note `drummergirl.ts:212` also marks
   the gate `generator` "ON PURPOSE", so this has been thought about before.

2. **`vfpgaRunner.g1..g4` — the semantic is genuinely per-loaded-spec.** The host
   publishes *both* the held level and the edge count (`vfpga-runner.ts:420-421`)
   and lets the loaded FPGA spec's gate-role pick. **No single `edge` value is
   correct for all specs.** Declared `gate` because the host always maintains
   held state, so `gate` never lies — but the honest answer is that `PortDef.edge`
   **cannot express "depends on the loaded program"**. Making this exact needs
   either a third semantic or a per-spec override.

3. **`writeseq.gate` (in) is genuinely dual and BOTH halves are load-bearing.**
   It feeds a rising-edge count (`:511`, `:533-541` — quantize-record and
   record-start) *and* a held-level read (`:757` → `:840-842` — live passthrough
   overriding the sequenced output). Declared `gate` because the level read
   changes the audible output; the edge half is real and undocumented by the
   declaration. **No bug — but the one-field contract loses information here.**

4. **`moog993` (all 5) — the DSP is a WIRE, so it cannot settle them.**
   `moog993.ts:9-13` is explicit: *"PASSIVE ROUTING — no DSP. Pure Web Audio
   graph (GainNodes only)."* Nothing edge-detects or level-interprets, so the
   classification rests on unanimous prose plus the modelled hardware. Declaring
   `trigger` means the generated sentence reads *"fires once per rising edge"*
   for a jack that in fact relays whatever width arrives. Least-wrong, but a
   judgement — **the one place a reviewer could reasonably choose differently.**

5. **`marbles.clk` is a 50 %-duty square, not a narrow pulse**
   (`marbles.ts:155` `clk[i] = masterPhase < 0.5 ? 1 : 0`). Declared `trigger`
   because it is a master clock and the repo vocabulary files "clock" under
   trigger — but its waveform is the held-square shape `gate-trigger.ts`
   associates with a **gate**. Purely cosmetic (glyph + doc sentence); no
   behaviour depends on it.

---

## One reusable gotcha from Phase 0

**Loop-generated docs read as "this module has no prose".** `synesthesia`
(inside a `docs: (() => {…})()` IIFE), `twotracks` and `wavesculpt` build their
`docs` entries in a loop, so a per-port `docs.outputs.<id>` grep finds nothing —
all 16 synesthesia ports were initially misrecorded as having no prose on exactly
that mistake. **Resolve prose through `module-docs.generated.ts`, never through a
source grep**, and remember one template edit moves N ports.
