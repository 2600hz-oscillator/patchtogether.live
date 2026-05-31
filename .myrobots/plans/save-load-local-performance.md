# Save / Load Local Performance — Design + Feasibility

Status: **DESIGN ONLY** (no feature build). Investigation done 2026-05-27 against
`main @ 7ad70e5`.

## 1. Goal (owner's words, paraphrased)

Two buttons — **"Save Local Performance"** and **"Load Local Performance"** — that
capture *everything* needed to reconstitute a "complete track": the JSON patch, the
on-screen module positions, and the bindings to local resources (video files, image
files, SAMSLOOP samples, MIDI device mappings, gamepad device mappings).

Use case: user builds a patch, kills the browser, reopens a **fresh browser on the
same PC** (same filesystem, same attached hardware), clicks "Load Local
Performance", and **everything just works** — no manual re-import of each asset.

The hard truth this doc settles up front: "fresh browser" has two very different
meanings, and only one of them can "just work" without a re-pick. See §3.

## 2. Inventory — what's already persistable, and how

The good news: **most assets are already captured by the existing patch envelope.**
The patch save format (`packages/web/src/lib/graph/persistence.ts`) is a JSON
`PatchEnvelope` wrapping a base64-encoded **Yjs `encodeStateAsUpdate`** — the entire
graph (nodes, edges, params, **and `node.data`**) round-trips. Module positions live
in `ModuleNode.position {x,y}` (`packages/web/src/lib/graph/types.ts`) inside that
same Yjs doc, so **positions are already saved**.

What that means per asset class:

| Asset | Where it lives today | Already in the patch? | Net-new work |
|---|---|---|---|
| **Patch graph + edges + params** | Yjs doc → envelope `update` | ✅ Yes | None |
| **Module positions** | `ModuleNode.position` (in Yjs doc) | ✅ Yes | None |
| **PICTUREBOX images** | `node.data.imageBytes` — downscaled JPEG q=85 → base64, INLINE (`PictureboxCard.svelte`) | ✅ Yes (embedded) | None — already self-contained |
| **SAMSLOOP samples** | `node.data.samples` — mono PCM `number[]`, ≤250 KB cap, INLINE (`samsloop.ts` §"Data shape") | ✅ Yes (embedded) | None — already self-contained |
| **VIDEOBOX video files** | `node.data.fileMeta` (name/size/duration/`handleId`) in patch; the actual `FileSystemFileHandle` in **IndexedDB**, keyed by `handleId` (PR #102, `video-file-store.ts`) | ⚠️ Partial — metadata yes, file no | Re-grant / re-pick flow (mostly built for same-profile) |
| **MIDI-CV-BUDDY device** | `node.data.lastDeviceId` — **MIDIInput.id** (unstable across sessions), INLINE (`midi-cv-buddy.ts`) | ⚠️ Saved but fragile | Re-key by device **name** |
| **MIDI Learn (Fader/Knob CC maps)** | `localStorage` `pt.midi-bindings.v1`, keyed `moduleId:paramId`, **device-agnostic** (`midi-learn.svelte.ts`) | ❌ Not in patch (global localStorage) | Bundle into performance + name-key the device |
| **GAMEPAD mapping** | `node.params.padIndex` (slot 0–3 only) — NO `gamepad.id` keying (`gamepad.ts`) | ⚠️ Slot only | Re-bind by `gamepad.id` on `gamepadconnected` |

### 2a. The #102 handle pattern (THE key reusable building block)

`packages/web/src/lib/video/video-file-store.ts` is a dependency-free, feature-
detected, never-throws IndexedDB wrapper that stores/gets/deletes a
`FileSystemFileHandle` keyed by a stable id. Public API to reuse verbatim:

- `canPersistVideoHandles()` — gates on `indexedDB` **and** `showOpenFilePicker`
  (Chromium only; Firefox/Safari fail → re-link path).
- `newVideoFileId()`, `putVideoFileHandle(id, handle)`, `getVideoFileHandle(id)`,
  `deleteVideoFileHandle(id)`.
- `queryHandleReadPermission(handle)` → `'granted'|'prompt'|'denied'` (no prompt).
- `requestHandleReadPermission(handle)` → must run **inside a user gesture**.

`VideoboxCard.svelte` already implements the full lifecycle: on file pick, mint a
`handleId`, `putVideoFileHandle`, stamp `fileMeta.handleId` into `node.data`; on
load, `getVideoFileHandle(handleId)` → `queryHandleReadPermission` → if `prompt`,
show a one-click "re-allow {name}" button that calls
`requestHandleReadPermission` → on `granted`, `handle.getFile()` → object-URL into
the `<video>`. If the handle is absent (different profile/machine), it falls back to
a "Re-link: drop {name} ({size} · {m:ss})" prompt. **This is the template for every
file-backed asset.**

## 3. The browser-security reality (this shapes the whole design)

A web app **cannot** store an arbitrary filesystem *path* and silently re-read the
file later. The only sanctioned mechanism is the **File System Access API**: persist
`FileSystemFileHandle` / `FileSystemDirectoryHandle` objects in IndexedDB
(origin-bound, structured-cloneable), then on load call `.queryPermission()` /
`.requestPermission({mode:'read'})` — which require a **user gesture** and may
re-prompt.

Two scenarios, two outcomes:

- **Same browser profile, killed + restarted** (the realistic "just works"): IndexedDB
  persists → handles survive → **one click** to re-grant read permission → assets
  reload. THIS is the path we optimize for.
- **Truly fresh browser / new OS user / new profile / different machine**: IndexedDB
  is empty → handles are gone → JS may store path *hints* (filename/size for display)
  but **cannot** read a file it wasn't handed via a picker. The user must **re-pick**
  the file/folder (guided re-link). Non-negotiable browser sandbox rule.

**Recommendation: a single directory handle.** Instead of N per-file handles, on Save
prompt the user once with `showDirectoryPicker()` for the folder their assets live
in; store that one `FileSystemDirectoryHandle` in IDB. On Load, one `requestPermission`
re-grant on the dir handle, then resolve each asset by relative filename under it
(`dirHandle.getFileHandle(name)`). One permission prompt instead of one-per-file. The
per-file `handleId` path (#102) remains the fallback for files picked individually.

Hardware:
- **MIDI**: `MIDIInput.id` is **unstable** across sessions/replug. Key mappings by
  device **name** (+ manufacturer) and re-bind to a matching connected input on load;
  prompt if absent. Web MIDI also needs a permission grant (`requestMIDIAccess`).
- **Gamepad**: `Gamepad.id` is reasonably stable per device model. Key mapping by
  `gamepad.id`; re-bind on the `gamepadconnected` event. Gamepad API only exposes a
  pad after a button press (anti-fingerprinting gesture gate).

Browser support: File System Access API is **Chromium-strong** (Chrome/Edge/Opera/
Brave), **absent in Firefox**, and **only partial in Safari** (`showOpenFilePicker`
exists in recent Safari but `showDirectoryPicker` + persistent handles are
weak/absent). Web MIDI: Chromium + Firefox, **not Safari**. So the full "just works"
path is a **Chromium experience**; everywhere else degrades to the guided re-pick +
re-learn fallback. The design must degrade gracefully, never hard-fail.

## 4. The "Performance Bundle" data model

Split into two halves — a portable manifest vs. origin-local handles:

### 4a. Portable manifest (`PerformanceBundle`)
Superset of today's `PatchEnvelope`. Everything here is JSON-serializable and
shareable:
```ts
interface PerformanceBundle {
  bundleVersion: 1;
  savedAt: string;             // ISO 8601
  patch: PatchEnvelope;        // EXISTING — graph + positions + inline assets
  assets: AssetRef[];          // file-backed asset descriptors (see below)
  midiBindings: MidiBindingExport[];   // from localStorage, name-keyed
  midiDevices: { nodeId: string; deviceName: string; manufacturer?: string }[];
  gamepadBindings: { nodeId: string; gamepadId: string; padIndex: number }[];
}
interface AssetRef {
  assetId: string;             // stable; matches IDB key for the handle
  role: 'video' | 'image' | 'sample';
  nodeId: string;              // which module consumes it
  filename: string;            // hint for re-pick
  size?: number;
  contentHash?: string;        // optional re-link verification (reserved in #102)
  relativePath?: string;       // hint relative to the dir handle, if known
}
```
Note: PICTUREBOX images + SAMSLOOP samples are already inline in `patch`, so they DON'T
need an `AssetRef` for the same-profile fast path; an `AssetRef` is only needed for
**VIDEOBOX** (file too big to inline) and for any future "don't inline, link instead"
choice. We may still record image/sample `AssetRef`s purely as re-link hints.

### 4b. Origin-local handle store (IDB) — net-new tiny wrapper
A generalization of `video-file-store.ts`:
- One **named-slot index** store: `performance` → `{ name, bundle: PerformanceBundle,
  dirHandleKey?, savedAt }`.
- One **handles** store: `assetId | dirHandleKey` → `FileSystemFileHandle |
  FileSystemDirectoryHandle`.
The bundle carries the `assetId`s; the handles live beside it in IDB and never travel.

### 4c. Save artifact — both
- **Named IDB "performance" slots** (primary): carry handles → the same-profile
  "just works" reload. This is what the two buttons drive by default.
- **Optional manifest export** (`.perf.json` download): portable/shareable, but
  **cannot carry handles** — loading it on another profile/machine always triggers
  guided re-pick. Mirrors the existing `downloadEnvelope` / `pickAndLoadEnvelope`.

## 5. Reuse vs. build

**Reuse (already exists):**
- Patch graph + positions + inline image/sample persistence — `persistence.ts`
  (`makeEnvelope` / `loadEnvelopeIntoStore`), wired in `Canvas.svelte` (`savePatch` /
  `loadPatch`).
- IDB handle lifecycle + permission re-grant — `video-file-store.ts` + the
  `VideoboxCard.svelte` reload/re-link UX (#102).
- MIDI Learn store + setter re-registration on card mount — `midi-learn.svelte.ts`
  (`registerSetter` already rehydrates on remount).
- MIDI device reattach-by-saved-id scaffolding — `midi-cv-buddy.ts` (`attachToDevice`,
  `pickDefaultDevice`, hot-plug `onstatechange`).
- Gamepad slot param + `gamepadconnected` semantics — `gamepad.ts`.

**Build (net-new):**
1. `performance-store.ts` — generalized IDB wrapper (named slots + handles + dir
   handle). Mirror `video-file-store.ts`'s feature-detect / never-throw discipline.
2. `performance-bundle.ts` — `makePerformanceBundle(ydoc)` / `applyPerformanceBundle`
   (wraps `makeEnvelope` + collects midi/gamepad/asset refs) + `.perf.json` export/import.
3. Directory-handle pick + resolve helper (`showDirectoryPicker`, `getFileHandle`).
4. Re-key MIDI device binding by **name** (currently `lastDeviceId` = unstable id).
5. Gamepad mapping keyed by `gamepad.id` + re-bind on `gamepadconnected`.
6. Two toolbar buttons + the re-grant/re-pick guided UX (reuse VIDEOBOX's prompt UI).

## 6. Phased plan

- **P1 — patch + positions + video handles via one dir handle.** New
  `performance-store.ts` + `makePerformanceBundle` (just wraps `makeEnvelope` for now
  + the video `AssetRef`s). Save: prompt once for a directory handle, store it; Load:
  one re-grant, resolve VIDEOBOX files under the dir, fall back to per-file #102
  handles, then to guided re-pick. Images + samples already ride along inline in the
  envelope. Ships the two buttons. **De-risks the core unknown** (dir-handle +
  re-grant flow).
- **P2 — samples / images as linked assets (optional).** Only if we want to stop
  inlining large samples; otherwise P1 already covers them. Low priority.
- **P3 — MIDI + gamepad re-bind.** Bundle `pt.midi-bindings.v1`; re-key MIDI-CV-BUDDY
  + MIDI Learn by device **name**; gamepad mapping by `gamepad.id`; re-bind on
  connect events; prompt when a device is absent.
- **P4 — portable `.perf.json` export/import.** Shareable manifest; loading on a new
  profile drives the guided re-pick for every `AssetRef`. Reuses P1's resolve path.

## 7. Top risks

1. **Permission UX (highest).** Every File System Access + Web MIDI re-grant needs a
   user gesture and may re-prompt. A "Load Performance" with 3 videos + MIDI + a dir
   handle could fire several prompts. Mitigation: single dir handle (one file prompt),
   batch the gesture, clear status UI ("3 assets pending — click to re-allow").
2. **Browser support.** Full path is **Chromium-only**; Firefox has no FS Access,
   Safari is partial + no Web MIDI. Must degrade to guided re-pick + manual re-learn,
   never hard-fail. Detect with `canPersistVideoHandles()`-style gates.
3. **Handle invalidation.** If the user moves/renames/deletes a file or folder after
   Save, the stored handle resolves to a missing/`NotFoundError` file. Fall back to
   re-pick; `contentHash` (reserved in #102) can confirm "same file".
4. **Cross-profile / cross-machine = empty IDB.** "Fresh browser" only "just works" on
   the SAME profile. New profile = guided re-pick by design; set expectations in copy.
5. **MIDI/gamepad id instability.** MIDI `id` changes across sessions (hence name-key);
   gamepad needs a button press before it appears (hence `gamepadconnected` re-bind).
6. **localStorage scope.** MIDI Learn bindings are global, not per-patch. Bundling them
   into a performance + restoring on load could clobber the user's other-patch
   bindings — namespace or merge carefully.

## 8. Optional spike (de-risk only — NOT the feature)

A tiny throwaway to confirm the dir-handle + re-grant survives a profile restart:
`showDirectoryPicker()` → `putVideoFileHandle`-style IDB store of the dir handle →
reload tab → `getVideoFileHandle`-style read → `requestPermission` → `getFileHandle` →
`getFile()`. If green, P1 is fully de-risked since it reuses the existing #102 IDB
plumbing for a directory handle. (Recommend running this in a manual Chromium tab, not
CI — handle-permission gestures don't survive headless cleanly.)
