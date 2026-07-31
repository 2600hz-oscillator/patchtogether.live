# Session roundup — 2026-07-29 (robot-imagined)

Not asked for. State-of-the-world at shutdown, so the next session doesn't
re-derive it.

## Where things stand

- **Main: `366988fb`**, green. Push run for the last two merges was still
  finishing at shutdown — **verify it before trusting this line.**
- **Open PRs: none.** Queue fully drained.
- **Worktrees**: several agent worktrees left on disk (`peakstate-lazy`,
  `bd-nodisplay`, `pixelate-fix`, `wt-rebase` under scratchpad, others). All
  clean + pushed. Run `flox activate -- task worktree:guard` before creating more;
  cap is 10.

## Merged this session

| # | what |
|---|---|
| #1246 | adsr.release behavioral drive was a coin flip — P0 |
| #1249 | both shard-1 backdraft failures — SPATIAL TRANSFORM frames + full-output rAF tax |
| #1256 | swept the backdraft suite — **4 vacuous assertions** + every wait frame-driven |
| #1252 | alerting reuses ONE issue per alert instead of one per cron tick |
| #1245 | `/r/[id]` degrades to 503 when the DB is UNREACHABLE |
| #1225 | param cell kinds + panel shell cell (**DX7 PR 2**) |
| #1231 | backdraft display returns, 6hp × 3u (+ #1223 VIRTUAL CAMERA folded in) — owner merged |
| #1260 | backdraft **loses** the display — 4hp × 3u, two bank rows — owner merged |
| #1261 | peakstate renders only consumed outputs — **4× cheaper** — owner merged |

#1223 was **closed**, folded into #1231 — not dropped.

## Infrastructure state

- **Neon: upgraded to Launch with a $20 cap** (owner). The compute-quota
  exhaustion that 500'd every rackspace URL for ~24 h is resolved. With #1245 +
  #1252 now in, a future outage gives a clean 503 and **one** tracked issue
  instead of a 500 and 45 duplicates.
- **45 duplicate `[CRIT]` alert issues** (oldest #987, 2026-07-01) are **still
  open**. Closing them was offered and never confirmed — do not close without
  asking. Consequence of leaving them: the first run after #1252 opens **one**
  new marked issue (a 46th), which then reuses itself forever. Harmless.
- **WebGL attest is at `ac6d86f1`** — re-pinned on the owner's real GPU during
  this session under their standing "gpu is yours for any attests". Only
  `peakstate.ts` moved it.

## Standing directives reconfirmed in practice this session

- **Never merge on red**, and **check main's OWN push run**, not the PR's. I broke
  this once earlier (merged #1214 on PR-green, main went red) and it cost hours.
  Every merge this session waited for the gating run on the exact SHA.
- **Look-affecting video changes are owner-preview-before-merge.** #1260 and #1261
  were both left unmerged for the owner despite being green.
- **`git merge origin/main` locally, never `gh pr update-branch`** on shared
  registry files. Used for all three rebases.
- **Port 5173 is the owner's dev server.** Never `task e2e:stop`. Agents were told
  to use `E2E_PORT` and kill only their own PIDs.

## Live traps found this session (all fixed, but the shape recurs)

- **The `e2e-video` lane was DELETED 2026-06-20 (#839)**, but
  `e2e/webgl-heavy-globs.ts`'s header still described it in the present tense. I
  cited that stale comment to the owner as evidence for a "relocate the cost"
  proposal that would in fact have **deleted ~690 s of backdraft PR coverage**.
  Header now carries a ⚠ warning. **Adding a spec to `WEBGL_HEAVY_GLOBS` today
  deletes its PR coverage; it does not move it.**
- **One stray `//` outside `docs-hash-ignore` markers invalidated a WebGL
  attest.** See the blind-gates file.
- **`modules-card-map.test.ts` conflicts can be pure whitespace** — a #1225
  conflict looked alarming and was 25 blank lines inside an array literal, with
  both sides carrying the identical 55 entries. Count the entries before picking a
  side.

## Backdraft, where it landed

Two total reworks in one day, in opposite directions, both owner-driven:

1. #1231 — display **returns**, 320×240 centred on top, 6hp × 3u = 1080×540.
2. #1260 — display **removed entirely**, 4hp × 3u = **720×540**, gates upper-left
   (mirror x/y, shape, pure geo, tv, flicker) + loop/colour/key beside it, and
   geometry / tv screen / virtual camera on a row below. Faders got *longer*
   (153 → 187 px) because the 240 px display band is exactly what a second bank
   row costs.

The `<canvas>` was **not deleted** in #1260 — kept mounted at 0×0,
`pointer-events: none`, never painted, because `requestFullscreen()` can't take a
`display:none` element and the Present popup blits from it.

**Backdraft is in `EXEMPT_FROM_VRT` with no baseline PNGs on either platform, and
both original reasons for that exemption are now gone** (variable size, live
faceplate canvas). It is a **promotion candidate** for a follow-up with its own CI
budget.

Also noted, pre-existing, untouched: `BACKDRAFT_TV_MODE_LABELS[1]` is literally
the string `"VIRTUAL CAMERA"`, which made a bank title read "VIRTUAL CAMERA ·
VIRTUAL CAMERA". Fixing the def moves contract-lock, so it was left alone.

## Things awaiting an owner decision

1. **Buffer → Stable (45 ms)** test for the audio bog — cheapest, most
   informative thing available.
2. **60 fps engine cap** — halves remaining video cost; visible frame-rate change
   AND halves game tick rates.
3. **The preset-load leak** — no ticket. ~7,700–9,800 DOM nodes per load.
4. **Closing the 45 duplicate alert issues.**
5. **Promoting backdraft out of `EXEMPT_FROM_VRT`.**
6. **A per-module render-cost CI gate** — proposed, not built.
