# Native shell — design as built

Status: **partly shipped**. This doc records the architecture that is in the tree
(`apps/desktop/`, `apps/helpers/`, the device-slot layer in `packages/web/src/lib/graph/`)
and names, explicitly, the phases that are **not built**. Operating procedures —
how to install, build, run and smoke the shell — live in
[runbooks/native-shell.md](../../runbooks/native-shell.md).

The shell exists for one product reason: a live rig must come up with **zero
prompts and zero gestures** — ES-9, PTZ, four cameras, four displays — and must
never be interrupted by an ordinary workflow.

## The two-layer lifetime model

This is the whole design, and everything below is a consequence of it.

| layer | lifetime | what is in it |
| --- | --- | --- |
| **persistent-device** | app session | hardware sessions keyed on **reserved slot ids** — camera streams, audio-in tracks, bridge sockets, MIDI/USB/serial claims |
| **swappable-patch** | graph | everything else in the Y.Doc; a load clears and replaces it wholesale |

The insight the layer is built on: a hardware session in this repo is keyed on a
**node id**, and a patch load clears `patch.nodes` unconditionally — so a load
destroys the id, which destroys the session, which *is* the interruption. The fix
is not "protect the module", it is **protect the id**
(`packages/web/src/lib/graph/device-slots.ts`).

## Device slots, as built

Eight reserved node ids — `cam1..cam4`, `output1..output4` — with one canonical
type forever. Three details differ from the original plan and are the design:

- **No new module defs.** Slots reuse the shipped types: cameras are hidden
  `cameraInput` instances whose surface is the workflow topbar camera manager;
  outputs are `videoOut` cards in the video zone (`CAMERA_SLOTS` / `OUTPUT_SLOTS`).
- **`output1` keeps the historical id `workflow-videoOut`**, deliberately.
  Renaming it to `slot:output1` would be a delete plus an add — exactly the
  remove/add teardown the layer exists to prevent, inflicted on every rack in the
  fleet at once, on the slot most likely to be presenting.
- **Undeletability is reached by two different routes, because `pinned` is also
  the canvas-hide bit** (`isCanvasHiddenNode = pinned || hiddenCard`). Cameras are
  `pinned` (right: their face is the header manager); outputs are **not** — they
  are protected by the reserved-id guard `isDeviceSlotId()` alone, because a
  pinned output would vanish from the zone the operator presents from. Both
  directions are repaired: `planDeviceSlotIdentityRepairs()` also strips a
  `pinned: true` a peer writes onto an output slot.

**The honest guarantee.** Yjs has no conditional insert, so a hostile peer *can*
write a foreign type at a reserved id. The repair makes that state **transient and
self-healing** (one teardown, then the session returns at the same id) — it is not
structurally impossible. Do not restate it as impossible; that claim was corrected
once already on the pinned-singleton layer this one extends.

Load semantics: the clear pass skips slot ids and merges rather than deletes
(`decideSlotMerge`), a node arriving at a slot id with a different type is dropped
or coerced, and `stripSlotIdentityForDuplicate` keeps a duplicate from minting a
fifth competitor for the same hardware.

## Bindings never ride the Y.Doc

Which camera, which monitor, which ES-9 policy is a property of the **rig**, not the
patch: device ids are machine-local, so a saved patch opened elsewhere would carry a
stranger's hardware and collab peers would fight over each other's cameras.

`packages/web/src/lib/graph/device-slot-bindings.ts` is one per-machine record with
two backends behind one interface — the shell round-trips through the `bindings.get`
/ `bindings.set` bridge ops to a JSON file in `userData`
(`apps/desktop/src/rig-store.ts`), a plain browser falls back to `localStorage`.
Reads are synchronous against an in-memory cache so a render tick can consult a
binding; `whenReady()` and `subscribe()` cover hydration and late shell loads.
`DEVICE_SLOT_RIG_KEYS` is what `device-slots.ts` strips off `node.data` on the way
in and out.

The shell treats the record as **opaque JSON** and validates only "is this a plain
object". That asymmetry is deliberate: the binding shape evolves with the pre-flight
UI, and the shell must not need a rebuild to store a field it has never heard of. A
corrupt blob degrades to the empty rig, which lands the operator on `/preflight` —
the same outcome as a genuine first run.

## The shell process

`apps/desktop` is a **standalone npm package** (own lockfile, deliberately not a
root workspace) so web CI installs and the shared lockfile stay untouched. Electron
is pinned exact.

- `main.ts` — Chromium flag set applied before ready, one fullscreen window, native
  menus (Quit is native-only, by owner ruling — the preload exposes no `quit()`).
  Two flags are load-bearing: `--disable-features=MidiMacUmp` (without it SysEx
  reports send success while transmitting nothing on recent Chromium/macOS) and
  `autoplay-policy=no-user-gesture-required` (an AudioContext that reaches
  `running` with zero gestures is the point of the shell, and the boot spec asserts
  exactly that state).
- `server.ts` — loopback static server for the `PT_DESKTOP_BUILD=1` adapter-static
  bundle, mirroring `packages/web/_headers`: COOP `same-origin` + COEP
  `credentialless` (isolation for SharedArrayBuffer/Faust threads;
  *credentialless*, not require-corp, so no-CORP cross-origin media keeps loading).
  SPA fallback serves `/rack`, which has no prerendered HTML. `file://` is out —
  OPFS, getUserMedia and WebMIDI need a secure context.
- `security.ts` — the trust boundary in one place. The grants are the product;
  what makes them safe is the **origin lock**. Two reachable holes existed before
  it: `setWindowOpenHandler` allowed every URL, so an ordinary `target="_blank"`
  link opened a remote origin in a window carrying the preload under session-wide
  camera/mic/USB/HID/screen grants; and nothing guarded `will-navigate`. Every
  predicate is pure and exported so the harness can call the **refusals** directly.
- `bridge.ts` / `preload.ts` — one `ipcMain.handle` per command behind a single
  versioned envelope, so sender validation is written once and a later phase adds
  *ops*, not channels. `command()` resolves with `{ok:false,error}` rather than
  rejecting, because contextBridge drops custom Error properties and the consumer
  is a pre-flight status row — an outcome to render, not an exception. The
  sandboxed preload cannot `require` a relative module, so it re-declares the
  version and channel names; a compile-time equality assertion in `bridge.ts` keeps
  the two copies from drifting.
- `supervisor.ts` — one per helper, `stopped → starting → running →
  restarting(backoff+jitter) → crash-looped`, plus a terminal `foreign-listener`.
  **Health is process alive AND hello accepted AND the port is ours.** The third
  clause is not theoretical: a probe that resolved on any non-binary frame reported
  `running` for a child that had already exited, while the renderer talked to a
  stale orphan. Ownership is proven in three layers — the reply must parse as a
  known protocol type, `protocolVersion` must match when present, and the process
  listening on the port must be our own child pid — plus a per-launch nonce.
  **An unknown listener is reported, never killed**: reaping by port would let a
  mis-detection take out the operator's DAW.

## Two-stage pre-flight

Forcing the setup screen is split across the two processes, and each half answers a
different question:

1. **main** decides first run vs configured — `store.isFirstRun()` picks the
   initial route, and `preflight.done` swaps the same window to `/rack`.
2. **the renderer** decides whether a *configured* rig is still intact:
   `evaluateRigRelaunch()` runs when `/rack` mounts and bounces back to
   `/preflight` when a bound camera, display fingerprint, or configured helper is
   positively absent.

**Bounce only on a positive absence.** `enumerateDevices` before a grant returns
redacted entries, `getScreenDetails()` off a gesture rejects, and a plain browser
has no supervisor at all — each is *indeterminate*, and the rule is "keep the
rack". This is also what keeps the guard off the hundreds of ordinary `/rack`
specs: an unbound rig gathers no evidence and can never prompt.

`/preflight` is an ordinary web route, not a shell-native panel, and it reuses the
app's own enumeration (screen identity, the camera pattern, the push2 / launchpad /
PTZ rosters) rather than reinventing it — so the same screen drives the browser.

## Not built

Stated so a reader does not infer them from the sections above:

- **Output windows and the display map** — `main.ts` creates no output
  `BrowserWindow`s and holds no display map. The premise was spiked and passed
  (same-origin opener→popup DOM access, painted, frames advanced), so the blit
  design holds, but nothing consumes it yet.
- **Click-free crossfade on patch swap** — mandatory by owner answer, with no
  design and no owning phase. `packages/web/src/lib/audio/continuity-probe.ts`
  records the blocker: there is no app-lifetime master bus today.
- **AudioContext auto-resume + AudioGate suppression under the shell** — an
  OS-side suspension (sleep/wake, default-sink removal, another app grabbing the
  device) still has no non-gesture recovery path.
- **The `desktop-e2e` CI job** — the required-subset spec exists and runs as a
  local task; the workflow job is unwired and needs owner wall-time sign-off.
- **Continuity hardening** (off-main save paths, worker recorderbox capture) and
  **distribution** (Developer ID signing, notarization, DMG).

## Open owner decisions

Crossfade semantics (true overlap vs fade-out/build/fade-in — roughly an order of
magnitude apart in cost); the renderer-crash guarantee for output windows (narrow
the words, or give outputs a main-owned transport); signing sign-off, which blocks
distribution; the ES-9 push-policy caller (hardware verification outstanding); and
whether collab is in v1 — if it is, the relay re-auth path must stop navigating the
renderer away first.

DOOM is excluded by name from every phase of this program and nothing proceeds
without explicit owner approval.

> Provenance: the planning package behind this design is preserved at the
> `myrobots-preserved-2026-09` tag (`.myrobots/2026-09-04-native-shell-plan/`).
> Where that prose and the tree disagree, the tree is right.
