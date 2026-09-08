# ES-9 multitrack capture — design, not built

Status: **specified, not built.** Nothing named `es9Recorderbox` exists in the
tree. What ships today is the pair this design would extend: the `es9` module
(bridge client at `packages/web/src/lib/audio/es9/`) and `recorderbox`
(`packages/web/src/lib/video/modules/recorderbox.ts`), which records a **hard
stereo** mix — `dest.channelCount = 2`.

The goal: record the 8 stem pairs feeding MIXMSTRS, each pair to its own file,
plus the master pair, alongside the video — on the operator's machine, through the
existing ES-9 helper.

## The shape of the number

8 stem pairs = 16 channels = 8 tracks, plus the master pair = **18 channels**.
That is not a coincidence of two designs: MIXMSTRS takes `ch1..ch8` L/R (16 ports),
and the ES-9 module's output-direction ports are `out1..out8` (physical jacks) plus
`usb1..usb8` (internal blocks) — also exactly 16. "Pre-mixmasters audio" is the
signal on the 16 edges terminating at the mixer's channel inputs: pre-fader,
pre-EQ, pre-send.

## The three corrections that define the design

Each one killed an approach that read as obviously correct.

1. **The capture point cannot be the live ES-9 output stream.** That stream is 16
   USB channels wide, of which 1–8 are the ES-9's internal blocks (main mix,
   phones, S/PDIF) and only 9–16 are the physical jacks — four stereo pairs, not
   eight. Carrying stems there consumes every USB out and puts them on the
   monitoring buses: **you could not monitor while recording**, and the master pair
   would need channels the helper's plane allocation cannot hold and silently
   discards. So the record path is a **separate logical channel space on a separate
   session** — for this feature the helper is a pure file-writing service that
   happens to live in the same process as the audio bridge. The consequence is the
   biggest win in the design: **the ES-9 need not be plugged in, so the record path
   is fully headless-testable.**

2. **The gap-accounting instrument is dead, not weak.** The most-cited claim in the
   original research was that drop detection came free from the existing counter.
   It does not: `packages/web/src/lib/audio/es9/bridge.worker.ts` advances
   `sampleTime += got` — frames **sent** — while the same function discards ring
   content elsewhere without touching the counter. The stream is therefore
   *gapless by construction across a drop*, and any detector reading it can never
   fire. This blocks the hard-stop-on-overflow policy outright: you cannot stop on
   an overflow you are structurally unable to see. The fix is a `producedFrames`
   counter incremented on every `process()` regardless of ring acceptance, carried
   in the block header — **with a negative control that forces a drop and asserts
   the number moves.** Without it the new counter can be exactly as blind as the
   old one and nothing would say so.

3. **The transport being reused is lossy by design.** The ES-9 bridge is a fixed
   ring with skip-on-full — correct for live monitoring, wrong for archival
   capture. The repo already contains the right policy and wrote down why:
   `packages/dsp/src/recorderbox-capture.ts` posts through a MessagePort that
   **buffers** under main-thread load, so the audio thread never drops a sample —
   that was the fix for recorderbox's own recording clicks. Routing a recording
   through the monitoring ring would re-introduce a bug recorderbox already fixed.

## Decisions (owner, 2026-08-02 — all twelve answered)

- **Mechanism:** separate `role:'record'` session; helper is a pure file writer.
  **No ES-9 required for a take.**
- **Overflow:** hard-stop the take with a clean finalize. Never "continue with a
  logged gap" — a short file that *plays* is the failure mode being bought out of.
- **Master bus:** recorded as a 9th pair, default on. 18 channels is the design
  width everywhere.
- **Format:** discrete stereo BWF WAV, 32-bit float (no clipping — DC-coupled CV
  legitimately exceeds ±1.0 — and no conversion on the write path), kept **under
  4 GiB**; no RF64 on day one. Without RF64 that ceiling is real: a stereo f32 pair
  crosses it at about 3 h 06 m, so the take must stop cleanly before it.
- **Chunking:** one continuous WAV per pair per take. Video keeps its own chunk
  cadence and the manifest carries the alignment — the boundaries are deliberately
  *not* aligned and nothing may assume they are.
- **Version skew:** refuse to arm, and name both versions (required vs actual). No
  per-block CRC — it is loopback, TCP's checksum is enough.
- **Take folder:** the helper owns it. It creates the folder and hands the path
  back to the browser, so the video lands beside the audio. The direction is
  pinned: helper → browser, never the reverse.
- **Deliverable:** a folder of files. No mux, no post-pass — **a crashed take stays
  usable**, and a remux step would be a second place for a take to die after the
  take is already over.
- **Deployed site:** accept inert (loopback is unreachable from https). The control
  must *explain why* rather than merely disable itself.
- **Distribution:** dev-only, build from source; no signing or notarization for
  this feature.

## Engineering unknowns (nobody knows these; no owner input closes them)

- **The record ring size is a budget, not a measurement.** It was chosen to survive
  a worst-case disk stall never observed on the owner's machine. Ship a high-water
  occupancy telemetry field from day one so week one converts the guess into a
  number — and only if it is a true high-water mark never reset mid-take.
- **The A/V drift bound is derived, not measured** (part-tolerance arithmetic). It
  justifies rebasing onto `ctx.currentTime`, which makes drift structurally zero
  and the bound moot. Do not quote it as a measurement or size anything with it.

## Open before this is built

Whether ES-9 RECORDERBOX re-homes inside the Electron shell
([native-shell.md](native-shell.md), which now owns the device-slot and helper
lifetime story) or stays an enhancement of the Swift helper; and whether the
browser-side multitrack record band that has since shipped on mixmstrs/cliprec
changes the requirement at all. Two premises of the original spec are already
stale: recorderbox and es9 both carry faces now, and the "new shell" gate it
waited on is the native-shell track.

> Provenance: the full spec (wire format, byte layout, phasing, per-file
> references) is preserved at the `myrobots-preserved-2026-09` tag
> (`.myrobots/plans/es9-recorderbox-2026-08-01`). Its line numbers had already
> drifted when it was written — re-grep, never trust an offset.
