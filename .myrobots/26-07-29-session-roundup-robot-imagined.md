# Session roundup — 2026-07-29 (robot-imagined)

> **2026-08-12 janitorial sweep: this was a status file for a moment that has
> passed, and ~110 lines of it were DELETED.** The "where things stand" / "merged
> this session" / "backdraft, where it landed" / "guardrails" sections were all
> either history or now carried in CLAUDE.md; the four "awaiting an owner
> decision" items that had measurements are carried, with those measurements, in
> `26-07-29-audio-bogging-diagnosis-robot-imagined.md`, which is the better
> source. What is below is the residue that exists nowhere else.

## Still live, and recorded nowhere else

- **The duplicate `[CRIT]` alert issues are still open — and there are now 51**
  (was 45 at the time of writing; oldest is #987, 2026-07-01). #1252 fixed the
  cause — alerting now reuses ONE issue per alert instead of opening one per cron
  tick — so the pile is inert, not growing. **Closing them was offered and never
  confirmed; do not close without asking.**

- **Backdraft is still in `EXEMPT_FROM_VRT`** — but the reason has narrowed to
  the purely mechanical one (no baseline PNGs), and the entry says so
  (`e2e/vrt/vrt-exemptions.ts:354-355`). Both of the ORIGINAL reasons are gone:
  the card is no longer variable-size and the in-card live canvas was removed in
  #1260. It has a `VRT_SCENES` entry, so it is deliberately absent from the mask
  map. **Un-actioned promotion candidate**, needing its own CI budget.

- **`BACKDRAFT_TV_MODE_LABELS[1]` is literally the string `"VIRTUAL CAMERA"`**,
  which makes a bank title read "VIRTUAL CAMERA · VIRTUAL CAMERA". Pre-existing,
  untouched: fixing the def moves `contract-lock`, so it was left alone.

## The one durable trap from this session

**The `e2e-video` lane was DELETED 2026-06-20 (#839)**, but
`e2e/webgl-heavy-globs.ts`'s header still described it in the present tense, and
that stale comment was cited to the owner as evidence for a "relocate the cost"
proposal that would in fact have **deleted ~690 s of backdraft PR coverage**. The
header now carries a ⚠ banner. **Adding a spec to `WEBGL_HEAVY_GLOBS` today
deletes its PR coverage; it does not move it.**
