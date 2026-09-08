# ADR-018: Moog clone provenance — own code, clean-room, no port

- Status: Accepted. This ADR **reconstructs** a provenance record whose original
  source package is lost (see "The record that is gone"); it states what the
  tree itself attests, and nothing more.
- Date: 2026-09-08 (the initiative's first slices landed 2026-06-02)
- Deciders: project owner; this ADR documents the standing attestation
- Tags: licensing, dsp, modules, moog, provenance

## Context

The repository ships a family of modules modelled on the **Moog System 55 / 35**
modular synthesizers — 25 module definitions under
`packages/web/src/lib/audio/modules/moog*.ts` — all 25 promoted in
`STRICT_FACES` — plus two shared helpers (`moog-filterbank-factory.ts`,
`moog-filterbank-labels.ts`), backed by 13 worklet entries under
`packages/dsp/src/moog*.ts` and their shared pure cores under
`packages/dsp/src/lib/`. The worklet count is **not** the family's extent: 907A
and 914 ship as pure Web Audio (a fan of `BiquadFilterNode` plus bookend
shelves) with no worklet entry at all, and are covered only by the shared data
core below — so the enumeration in this ADR is complete against the 27 citing
files, not against the 13 entries. The first two slices
landed on 2026-06-02: the 921 VCO with the Moog/SYS55/SYS35 category and panel
infrastructure (#535, `d826ef438e`), and the 904A transistor-ladder low-pass
filter with the shared ladder core (#536, `88ca149e7e`).

Emulating a famous analog filter is a licensing minefield in exactly one place —
**the code you start from**. The best-known reference implementations of the
Moog ladder are copyleft: the Huovilainen reference C and the CSound opcodes
derived from it are LGPLv3, and the widely-copied musicdsp model is CC-BY-SA.
Starting from either would put a copyleft obligation on a proprietary DSP
bundle. Schematics are a separate hazard.

The initiative was therefore run as **own code**, and each module carries that
attestation in its own header. The attestation cited a licensing record in the
planning package that no longer exists.

## The record that is gone

`.myrobots/MOOG/` — including its `LICENSING.md` and the module spec whose
"Fig 9" anchors one gain law — is **absent from the tree and not locally
recoverable**: it is in no ref, reflog, stash or worktree, it is not in the
evidence-rescue tag `myrobots-evidence-rescue-2026-09-07`, and the pre-retirement
corpus snapshot `myrobots-preserved-2026-09` does not contain it either. It is
preserved only as **absence** — those two tags are the proof of what the corpus
did and did not hold when it was frozen.

**27 files still cite the missing directory** (29 references), so the citations
are dead pointers whose claims survive only because they were also written
inline. That was already partly true by design: a 2026-08-14 pointer cleanup
(#1633) dropped `MOOG/LICENSING.md` citations at sites where "permissive /
own-code / no schematic" was already stated in the same comment, on the grounds
that the pointer added citation weight and nothing else. One consequence is
visible in the tree today as an empty parenthetical where a citation used to
sit (e.g. `packages/dsp/src/lib/moog-cp3-dsp.ts` "Own-code (permissive,)").

**This ADR is the durable home those citations should point at.**

## Decision

**The Moog family is own code, written clean-room from unpatented published
technique. It is not a port of any Moog schematic, and not derived from any
copyleft source. The attestation lives in the source, and this ADR records where
and what it says.** One member of the family diverges from that framing and is
called out below rather than folded into it: the fixed-filter-bank data core is
**own data transcribed from published third-party references**, not clean-room
code.

**Attested inline in the worklet entry** (8 of 13):
`moog-cp3.ts`, `moog902.ts`, `moog904a.ts`, `moog904b.ts`, `moog904c.ts`,
`moog921-vco.ts`, `moog921a.ts`, `moog921b.ts`.

**Attested in a shared pure core** — the one the remaining worklet entries
delegate to, plus the data core the two worklet-less modules depend on:

| core | attestation |
| --- | --- |
| `lib/moog-ladder-dsp.ts` | OWN CODE — CLEAN-ROOM. Re-derived from the unpatented textbook **TPT / Zavalishin zero-delay-feedback** topology with a tanh-per-stage ladder for the growl and self-oscillation. **NOT** the LGPLv3 Huovilainen reference C or CSound opcodes, **NOT** the CC-BY-SA musicdsp model, **NOT** any Moog schematic. Consumed by 904A / 904B / 904C. |
| `lib/moog-vco-dsp.ts` | OWN CODE — a clean-room **polyBLEP / polyBLAMP** band-limited oscillator core written for this project; not a port of any Moog schematic or copyleft DSP source. Consumed by 921-VCO / 921B. |
| `lib/moog911-eg-dsp.ts` | OWN CODE — clean-room **exponential-segment contour** (a three-time-constant contour generator with a single sustain level, not a literal ADSR); not a Moog schematic or copyleft source. |
| `lib/moog-cp3-dsp.ts` | Own code — a forked, expanded version of this repo's own mixer. |
| `lib/moog-filterbank-dsp.ts` | OWN DATA — a 1/3-octave (ISO R10-ish) centre-frequency table plus band Q; no DSP class and no Web Audio. The values are transcribed from published references (the modularsynthesis.com Moog archive and multiple 914/907A clone makers) and asserted as facts about a 1/3-octave grid rather than a copyrightable schematic. Consumed by 907A / 914 — neither of which has a worklet entry. |
| `lib/spring-reverb-dsp.ts` | In-house, from scratch. |

**Not carrying a provenance line, and not needing a third-party one:**
`lib/trigger-delay-dsp.ts` (911A), `lib/trigger-convert-dsp.ts` (961) and
`lib/moog962-dsp.ts` (962) are timing and selection state machines written here
— a rising-edge counter, a threshold/width converter, a gate-advanced selector
trimmed from this repo's own multiplexer. Add the one-line attestation if the
family is ever formally audited; the gap is recorded here so it is visible
rather than assumed.

**One behavioural spec survived only as a code comment, and is restated here so
the lost figure does not take it.** `moog902`'s gain law (originally anchored to
"`MOOG/` spec Fig 9") is: a control sum in volts,
`control = gainKnob(0..6 V) + fcv + cvAmount × cv`; overall gain ×2 (+6 dB) at
pot maximum (6 V) or at CV 6 V; a ×3 ceiling reached at 9 V in LINEAR mode and
7.5 V in EXPONENTIAL mode; in LINEAR, `gainMul = control / 3`, so 0 V is
silence. The authority is `packages/dsp/src/moog902.ts`.

## Consequences

**Good:**

- The bundle carries no copyleft obligation from this family, and the specific
  sources that would have created one are named and refused rather than merely
  avoided.
- The claim is checkable without the lost record: the technique (TPT/ZDF,
  polyBLEP) is published and unpatented, the code is here, and the negative
  claims are stated per file.
- Reconstructing rather than deleting the citations keeps a licensing
  attestation from being quietly dropped in a cleanup — which is exactly the
  failure mode a pointer sweep makes easy.

**Bad / load-bearing:**

- **A lost provenance record cannot be re-verified, only re-attested.** Anything
  in `MOOG/LICENSING.md` beyond "permissive / own-code only" is gone. If the
  owner later recovers the directory, reconcile it against this ADR rather than
  the reverse, and say which won.
- The 27 dead citations should be repointed **here**, not deleted: the pointer
  is what tells a reader the claim has a home.
- **This ADR covers copyright provenance of the DSP only.** Naming, panel
  styling and trade dress are a separate question it does not address, and the
  in-repo evidence says nothing about them.
- One adjacent DSP licensing item is genuinely open and is **not** covered by
  this attestation: `packages/dsp/src/lib/resofilter-dsp.ts` states it was
  ported from a named upstream project and asserts no licence (see ADR-010).
  Either confirm that upstream is permissive or re-derive it clean-room the way
  this family was.

## References

- `packages/dsp/src/moog*.ts` and `packages/dsp/src/lib/moog-*.ts` — the
  attestations quoted above.
- `packages/dsp/src/moog902.ts` — the gain law restated here.
- `packages/web/src/lib/ui/modules/moog/MoogPanel.svelte` — the shared panel for
  the family.
- ADR-007 — the repository's other licensing record (game-asset distribution),
  and the precedent for stating what is actually true rather than what a policy
  document claims.
- ADR-010 — the open `resofilter` licensing item.
- Provenance: the source package is **lost**. Its absence is pinned by the tags
  `myrobots-preserved-2026-09` (the pre-retirement corpus) and
  `myrobots-evidence-rescue-2026-09-07` (the rescued records) — neither contains
  `.myrobots/MOOG/`.
