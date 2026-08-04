# Ableton Push 2 integration — findings + plan

**Goal:** A tight, custom Push 2 integration for patchtogether.live —
pads/encoders/buttons over WebMIDI as a first-class control surface, AND
arbitrary graphics on the on-device 960×160 color LCD driven from the
browser over WebUSB. "Show us arbitrary stuff on the screen" is the
differentiator and the reason to do this.

**Status:** ~~RESEARCH COMPLETE. No code written.~~ **FULLY BUILT.**

> **TRIAGE 2026-08-04 — SHIPPED END TO END, including the differentiator.**
> `packages/web/src/lib/control/push2/` now holds the whole stack the VERDICT
> predicted: WebMIDI pads/encoders (`push2-device.svelte.ts`, `push2-sysex.ts`,
> `push2-map.ts`) **and** the WebUSB 960×160 display (`push2-display.svelte.ts`,
> `push2-display-frame.ts`, `push-screen-layout.ts`, `push-card-paint.ts`), plus a
> `push2-control` meta module. It went well past this doc: per-module PUSH CARDs
> with an owner-editable schema (`push-card-config.ts`, now a documented
> conflict surface in CLAUDE.md) and LEGEND MODE (**#1309**).
> §7's open questions were answered by building. **The Push 3 port assessment
> that supersedes this for protocol facts is
> `push3-support-assessment-2026-08-03.md`** — it re-derives the device layer
> against our actual shipped code.
> ⚠ **FLAGGED FOR THE OWNER as a deletion candidate.** It is spent research; the
> only reason it was not deleted in this pass is that it is the sourced record of
> the WebUSB display protocol and the third-party prior art, which a Push 3
> bring-up may still want alongside the newer assessment.

---

## VERDICT

**Fully browser-feasible on Chromium today — screen included — and
already proven in-browser by third parties.** On macOS (owner's
platform) it is frictionless: no OS driver claims the display interface,
so WebUSB `claimInterface` just works. No native helper app is required
(unlike the ES-9 path).

- **Pads / encoders / buttons / RGB LEDs → WebMIDI + SysEx.** This is
  Launchpad-shaped; we clone the existing Launchpad triplet with a
  different codec. Familiar, low-risk.
- **The 960×160 LCD → WebUSB bulk transfer.** This is a *separate,
  vendor-specific* USB interface from the MIDI one, so WebMIDI (pads) and
  WebUSB (screen) coexist on one page with zero conflict. This is net-new
  transport surface for us — the repo has **zero** `navigator.usb` code
  today — but it is not exotic: it's a fixed frame format we blit a
  canvas into.
- **The screen is a downstream sink for video/canvas infra we already
  run off-main-thread** (WebGL modules, OffscreenCanvas workers,
  DOCKSCOPE, milkdrop). It is not a bespoke graphics project.

Proven prior art (verified by direct fetch): `greyivy/learn-push2-with-
svelte` drives the display over WebUSB **and** reads pads over WebMIDI in
one Chromium page. Canvas→framebuffer reference: `halfbyte/ableton-push-
canvas-display` (Node/`node-usb`; our only change is `transferOut` vs
libusb). Canonical protocol doc: Ableton `push-interface`,
`doc/AbletonPush2MIDIDisplayInterface.asc`.

---

## 1. The architecture we slot into

Controller code lives under `packages/web/src/lib/control/`. The design
is a controller-AGNOSTIC "brain" + one bespoke stack per controller
family. There is **no cross-controller device manager / registry** — each
family is wired independently into its card, auto-registered via
`import.meta.glob`. The Launchpad is the direct template for Push.

Shared brain — reuse verbatim, do not fork:
- `control/clip-surface-map.ts` — placement-free clip logic: clip-index↔
  (slot,lane) math, edit-mode pitch/step math, and per-cell **LED
  *decision* helpers as ABSTRACT STATE** (`LED_EMPTY` / `LED_LOADED` /
  `LED_QUEUED_LO/HI` / `LED_PLAYING` / note-editor levels). It knows
  nothing about coordinates or bytes. A header comment already
  anticipates us: "a richer (RGB) surface can map these to hues."

Per-controller triplet (what we build for Push, cribbing Launchpad):
1. **pure byte codec** (`launchpad-sysex.ts` / `mext.ts`) — DOM-free,
   golden-vector tested.
2. **device singleton** (transport) with an `installSimulated*` in-memory
   seam so e2e drives presses and asserts emitted bytes with no hardware
   and no permission prompt.
3. **placement adapter** (`*-map.ts`) — physical pads/encoders → the
   brain's abstract cells + a color language.
4. **control binding** (`*-control.svelte.ts`) — mode machine, key
   routing, writes to app state.

Plus a **meta-module def** (`$lib/meta/modules/…`) and a **card**
(`$lib/ui/modules/…Card.svelte`), auto-registered by glob — no central
list to edit.

Two invariants Push inherits for free and MUST preserve:
- **All controllers write launches to the same synced field
  `node.data.queued[lane]`** on the `clipplayer` node. A Push, a
  Launchpad, and the on-screen UI all drive one clip-player, and
  **multiplayer works with no extra code**.
- **Binding (which node the controller drives) is per-machine
  `localStorage`; LED/screen frames are LOCAL render state, NEVER
  synced.** Your hardware is yours; the musical result is shared. Add a
  new `pt.push.boundClipNode` key; do not touch the Y.Doc for surface
  state.

Reference file map (Launchpad, the template):
`control/launchpad/launchpad-sysex.ts` (codec),
`launchpad-device.svelte.ts` (WebMIDI singleton + hot-plug + sim),
`launchpad-map.ts` (8×8 placement + RGB color language),
`launchpad-control.svelte.ts` (mode machine, KEYS, arm strip, node.data
seams), `$lib/meta/modules/launchpad-control.ts` (def),
`$lib/ui/modules/LaunchpadControlCard.svelte` (card). Sim install hooks
are exposed on `globalThis.__launchpadTestInstall*` from `Canvas.svelte`.

---

## 2. Push 2 surface A — MIDI (pads / encoders / buttons / LEDs)

Over WebMIDI with `requestMIDIAccess({ sysex: true })`, a dedicated
access (NOT shared with midi-learn / midi-cv-buddy, so a pad press can't
be mis-routed into CC/Note learn — Launchpad does exactly this).
Manufacturer ID `00 21 1D`, device `01`, model `01`. All SysEx:
`F0 00 21 1D 01 01 <cmd> … F7`.

- **8×8 pads** = Note-On `0x90` / Note-Off `0x80`. **Bottom-left = note
  36, +1 across a row, +8 up a row, top-right = note 99** (notes 36–99).
  (Launchpad uses `(y+1)*10+(x+1)`; Push uses `36 + row*8 + col` — the
  addressing differs, everything downstream ports.)
- **Pad color** = Note-On **velocity (0–127) indexes a 128-entry
  palette**; Note-On **channel (0–15) selects an LED animation**
  (channel 0 = none). Default anchors: 0=black, 125=blue, 126=green,
  127=red. Palette is SysEx-reprogrammable (Set Palette Entry cmd `0x03`,
  Reapply cmd `0x05`). **Decision: v1 use the stock palette by velocity
  index** (map the brain's abstract `LED_*` states → chosen indices in
  `push-map.ts`); reprogram the palette only if we want an exact
  patchtogether hue language later.
- **Encoders (8 above the display)** turn → **relative CC 71–78**
  (right=1–63, left=64–127, "relative 2's-complement"). **Touching an
  encoder cap → Note-On** (release → Note-Off) — touch vs turn are
  distinct, ideal for "grab this param" UX. Tempo=CC14, Swing=CC15,
  Master=CC79.
- **Display-row buttons**: below screen CC 20–27 (Master=28), above
  screen CC 102–109. Transport Play=CC85, Record=CC86, etc. Momentary
  (127 press / 0 release).
- **Pressure**: defaults to Channel Pressure `0xD0`; switchable to Poly
  Key Pressure `0xA0` via Set Aftertouch Mode cmd `0x1E`. Touch strip →
  Pitch Bend by default.
- **Mode**: boots in Live mode. Enter User mode with
  `F0 00 21 1D 01 01 0A 01 F7` (cmd `0x0A`, `01`=User). Use the User Port
  so we don't fight Live's control-surface protocol.

This half is "another Launchpad triplet." `decodeMidiMessage` and the
grid-addressing port over directly; the LED path differs (velocity-index
palette + optional SysEx, vs Launchpad's pure-SysEx-RGB) so the encode
side of the codec is the main rewrite.

---

## 3. Push 2 surface B — the display (WebUSB, net-new)

The killer feature and the only genuinely new subsystem.

- **Composite device**; the display is a **vendor-specific (class 0xFF)
  bulk interface, separate from MIDI**. **VID `0x2982` / PID `0x1967`,
  interface 0, bulk OUT endpoint `0x01`.**
- **Frame = 960×160, 16-bit/px, BGR565 little-endian.** NOTE: B and R are
  swapped vs plain RGB565 — bits 15–11 = blue, 10–5 = green, 4–0 = red.
  Pack: `word = ((b>>3)<<11) | ((g>>2)<<5) | (r>>3)`, written low-byte
  first.
- **Line = 2048 bytes** (1920 visible = 960px×2 + 128 filler bytes).
  **Frame = 160 × 2048 = 327,680 bytes (~320 KB)**, preceded by a
  **16-byte header `FF CC AA 88 00×12`**.
- **Signal shaping**: XOR each line with the repeating byte pattern
  `E7 F3 E7 FF` (mask `0xFFE7F3E7`) before sending.
- **Transport**: `transferOut(1, header)` then `transferOut(1, frame)` in
  ~16 KB chunks. Double-buffered at 60 fps in hardware (repeats last
  frame; blacks out after ~2 s of no frames).
- **Perf**: ~320 KB over hi-speed USB 2.0 is ~7–8 ms theoretical, but the
  reference author reports the bulk transfer eats "almost all of the
  16 ms" at 60 fps. **Default to 30 fps** unless conversion is proven
  cheap. Do the RGBA→BGR565+XOR conversion **in a worker / WASM** (reuse
  the off-main-thread pattern we already use for video, "Fix E") to avoid
  main-thread GC jitter.

WebUSB feasibility (the crux — resolved YES):
- Display is class `0xFF` → **not** on Chrome's WebUSB blocklist (which
  only blocks Audio/Video/HID/Mass-Storage/Smart-Card/Wireless) →
  `claimInterface(0)` is allowed. The MIDI interface is Audio-class, so
  WebUSB can't claim it and WebMIDI owns it — **that's precisely why the
  two coexist with no conflict.**
- **macOS: nothing to do** (no kernel driver binds a 0xFF interface).
- **Windows**: needs WinUSB bound to the display interface — *already
  bound if Ableton Live is installed*; else a one-time Zadig / Ableton
  WDI-installer step. Detect + instruct.
- **Linux**: one udev rule for `2982:1967`.
- **Firefox/Safari/iOS: no WebUSB.** Screen feature must **degrade
  gracefully** (pads/encoders still work over WebMIDI). Same
  capability-probe discipline as `serialAvailable()`/`webMidiAvailable()`
  — add a `usbAvailable()` gate.
- Chrome rules: HTTPS/secure-context (localhost OK for dev);
  `navigator.usb.requestDevice()` needs a **user gesture** (wire into the
  card's Connect button); after the one-time picker grant, `getDevices()`
  works on return visits.

---

## 4. The screen as an output SINK for existing infra

The LCD is just a 960×160 canvas. We already render lots of things
off-thread. The "display render-source" abstraction should let the bound
node/app choose what to blit. Candidate sources (most already exist):
- **clip/session view** — the grid, playing/queued/loaded state, tempo
  (a real on-hardware session display).
- **scope / spectrum / waveform** (DOCKSCOPE-style).
- **any video module's output**, downscaled — patch a video module →
  Push screen.
- **focused-module param readouts** synced to the CC-71–78 touch-to-grab
  encoder gesture (touch encoder → show that param big).
- **patch minimap**, MIDI-learn target, transport.

Design the sink as a small contract: something produces an
`ImageData`/`OffscreenCanvas` at ≤30 fps; the display transport converts
+ ships it. Keep the "what to draw" pluggable so v1 can ship one source
and add more without touching transport.

---

## 5. Build breakdown + effort

| Piece | Effort | Notes |
|---|---|---|
| `push-sysex.ts` codec | Low–Med | Pure, golden-vector tested like `mext.ts`. Pads 36–99, palette, encoder CC decode, mode toggle. |
| Push MIDI device singleton | Med | Crib `launchpad-device.svelte.ts`: WebMIDI+sysex, hot-plug via `onstatechange`, port-name filter, `installSimulated*`, `maxInstances:1`. |
| `push-map.ts` placement adapter | Med | 8×8 (notes 36–99) + display-row buttons + encoders → brain cells; palette-index color language. |
| `push-control.svelte.ts` binding | Med–High | Mode machine / key routing / node.data writes. Much of Launchpad's control logic is liftable but it imports launchpad placement directly — **parameterize the shared control logic or fork deliberately.** |
| **WebUSB display transport** | **High (net-new)** | First `navigator.usb` in repo. requestDevice/open/selectConfiguration(1)/claimInterface(0)/transferOut singleton + `installSimulated*` seam (CI has no device). |
| **BGR565/XOR frame encoder** | Med | Pure + golden-vector testable; run in a worker/WASM. |
| **Display render-source sink** | Med–High | The "what to draw" contract; reuse video/canvas pipeline. |
| meta-module + card + e2e sim wiring | Low–Med | Mirror `LaunchpadControlCard`; `import.meta.glob` auto-registers; expose `globalThis.__pushTestInstall*` in `Canvas.svelte`. |

Rough shape: MIDI half ≈ the Launchpad set (~2–3k lines, mostly cribbed);
display half is the new, higher-risk work but is well-bounded by a fixed
frame format.

---

## 6. Gotchas / house-rules that apply

- **CI has no Push, no WebUSB device, and runs SwiftShader.** Every path
  MUST go through `installSimulated*` transport seams and
  capability-gated asserts — this is a hard repo rule (recorderbox #687 /
  edges #688 burned cycles on real-GPU-passes-CI-fails). WebUSB e2e =
  sim-only; a real transfer is never exercised on CI. Keep added CI
  wall-time small (<~2 min, or get owner sign-off) — the display e2e must
  be a lightweight sim, not a heavy video/GPU path.
- **New capability probe**: add `usbAvailable()` (`'usb' in navigator`)
  and graceful degrade, mirroring `serialAvailable()` /
  `webMidiAvailable()`. Screen dark, pads live, off Chromium.
- **Attest hashes**: `control/` files are NOT in the WebGL/collab basis →
  no re-attest. BUT if the display render-source touches a video basis
  file (a WebGL module def), wrap doc/basis-adjacent edits in
  `// docs-hash-ignore:start … :end` markers, per the standing "docs must
  not change attest hashes" rule. Check before touching any video def.
- **`maxInstances: 1`** on the meta-module (one expensive device), like
  ES-9 / Launchpad.
- App already runs **cross-origin-isolated** (for ES-9 SAB) — no new
  headers needed for WebUSB; a display-conversion worker + SAB is
  available if we want it.
- **Flake-check**: any new/changed test 3× locally (`REPEAT=3
  task {test,e2e,vrt}:one`) before MR; run the auto-enrolled
  per-module/behavioral/vrt rows for the new meta-module too. Run
  `task typecheck` (svelte-check) in addition to vitest.
- **NOT the ES-9 native-companion path.** Push is fully browser-reachable;
  the localhost-WS + SAB-ring machinery is overkill and unnecessary here.
  ES-9 is only precedent for "arm's-length helper if a web API ever falls
  short," which it doesn't for Push.

---

## 7. Open questions (lock with owner before build → then feature spec)

1. **Screen content priority for v1** — session/clip view? scope/
   visualizer? "pipe any video module here"? focused-module param
   readouts? (Determines whether the display sink is clip-state-driven or
   a generic canvas sink first.)
2. **Primary pad role** — clip launcher (Launchpad-parity, instant
   reuse) vs a poly/note instrument surface (Push's poly-AT/pressure
   shine here) vs both via modes.
3. **Encoders** — bind the 8 to the focused module's params generically
   (touch-to-grab), or a fixed mixer/macro layout?
4. **v1 scope** — MIDI-only first (ship the familiar half, screen dark),
   or commit to the screen day one since it's the whole point?

---

## Sources

- Ableton `push-interface` — `doc/AbletonPush2MIDIDisplayInterface.asc`
  (canonical protocol; MIDI + display in one file).
- `Ableton/push2-display-with-juce` (official display reference, C++).
- `greyivy/learn-push2-with-svelte` — **browser** WebUSB display +
  WebMIDI pads (proves the crux).
- `halfbyte/ableton-push-canvas-display` — best JS canvas→framebuffer
  reference (Node/`node-usb`; "16 ms" perf note).
- `ffont/push2-python` (+ pysha) — clean frame-format + full-MIDI
  reference.
- `garrensmith/abletonpush` — in-browser WebMIDI pads/LEDs (no display).
- Chrome WebUSB guide + "Interface Class Filtering" intent-to-ship
  (blocklist rationale); Ableton Win display-driver support article.
- In-repo templates: `control/launchpad/*`, `control/monome/*`,
  `control/clip-surface-map.ts`, `audio/modules/es9.ts` (+ es9/ bridge)
  for the native-helper precedent we are NOT using.
