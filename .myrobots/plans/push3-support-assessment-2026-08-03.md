# Push 3 support — port assessment against our actual Push 2 code

**Date:** 2026-08-03 · **Status:** RESEARCH + ASSESSMENT ONLY. No code written, none proposed for
merge. This is a decision document.

---

## VERDICT

**PARTIAL — and the split is unusually clean.** The 960×160 display ports for the cost of *one hex
constant* (`PID 0x1967` → `0x1969`); the 28 % of our stack that is SEMANTIC ports untouched; the
device layer needs a half-day hardware bring-up. **Nothing is permanently blocked. What does not
exist is an authoritative spec** — Ableton has published no Push 3 interface manual and has left the
request open for 2.5 years — so every device fact we would rely on is reverse-engineered, and a
firmware update can silently break us with no changelog to read.

**One caveat sharp enough to belong in the verdict:** the *display* half carries a risk the MIDI half
does not — a host-side process named `Push3` may already own the display endpoint, and a web page
cannot evict it (§8.4). If that process runs whenever Live is *installed* rather than *running*, the
browser display path is dead on most Push-owning machines. **MIDI-only is unaffected**, which is a
real argument for sequencing it first.

The one thing that would bite a naive port immediately, and that is *not* an information gap but a
real behavioural change:

> **Push 3 emits MPE by default, and MPE's timbre/slide axis is CC 74 — which sits inside our
> display-encoder range (CC 71–78). On a Push 3, sliding a finger on a pad would spin push-card
> encoder 4.** See §5.2. This is a two-line fix, but only if you know to make it.

---

## How to read the confidence labels

Every factual claim below carries one. This matters more than usual here: the best public Push 3
document contains at least three claims that contradict both Ableton's own Push 2 spec **and** our
working, hardware-tested code (§4.3).

| Label | Meaning |
|---|---|
| **[OFFICIAL]** | Ableton's own documentation, cited |
| **[RE]** | reputable reverse-engineering project, named + linked, source read |
| **[RE-HW]** | as above, and the author states they ran it on real Push 3 hardware |
| **[FORUM]** | forum/issue post, unverified |
| **[INFERENCE]** | our reasoning by analogy — **not established** |
| **[NOT FOUND]** | searched for, could not establish |

---

## 1. Push 3 comes in two forms — and both are relevant

**Both SKUs exist. [OFFICIAL]** — [Push 3 Reference Manual](https://cdn-resources.ableton.com/resources/pdfs/push-manual/3/2024-11-05/push3-manual-en.pdf) (144 pp., 2024-11-05), §1.3:

> "Push comes in two configurations. The first configuration includes a processor, battery, and an
> SSD hard drive, which allows you to use Push as a standalone instrument. The second does not come
> with those components, so Push must be connected to a computer to make music using Live."
>
> "In terms of features, there is no difference between Push units with or without a processor."

**The premise in the brief — that the Standalone may not present as a controller at all — is
half right, and the half that is wrong is the important half.**

**The Standalone DOES present as a controller, but only after a MANUAL, ON-DEVICE mode switch.
[OFFICIAL]** — manual §2.1:

> "In the Status tab you can see whether Push is currently set to Standalone Mode or Control Mode.
> Press the highlighted upper display button to switch to Control Mode."

Ableton's term is **"Control Mode"**. Three consequences that matter to us:

- **Plugging in USB-C does not switch modes.** The manual describes no automatic transition.
- **Push boots into Standalone Mode on first power-on. [OFFICIAL]** (§2).
- **In Standalone Mode the device presents nothing usable to a host.** The internal x86 computer owns
  the audio and MIDI hardware exclusively — *"in standalone mode the computer inside the Push 3 is
  using that stuff as an audio interface so it's not available for other computers."* **[FORUM]**, but
  now corroborated by a second independent thread and consistent with the zero-probe result in §2.3.
  Still **no packet capture, `lsusb`, or official statement.** Treat as very likely, not established.
- **In Control Mode it presents MIDI ports, an audio interface ("Ableton Push 3 Audio"), and the
  display**, all over the one USB-C cable. **[OFFICIAL]** manual §2.2.1.
- ⚠ **Ableton never states that Push 3 itself is class-compliant.** Every "class-compliant" in their
  documentation refers to gear you plug *into* Push's USB-A **host** port. The evidence that Push 3 is
  class-compliant to a host is an iPadOS report (iPadOS loads no vendor drivers, so enumeration there
  implies class-compliance) — strong reasoning, but **[FORUM]**.

So the Standalone is usable by us, but the user journey starts with two on-device presses we cannot
perform for them. The **Controller** (tethered) SKU is always in Control Mode and is therefore the
SKU that exercises our exact path.

---

## 2. Does a Push 3 enumerate over WebUSB / WebMIDI?

### 2.1 USB identity

| | VID | PID | Source |
|---|---|---|---|
| Push 2 | `0x2982` | `0x1967` | **[OFFICIAL]** — `AbletonPush2MIDIDisplayInterface.asc` |
| **Push 3** | `0x2982` | **`0x1969`** | **[RE] ×4 independent, zero contradicting values found** |

The four sources, all read as source code rather than README claims:

1. **DrivenByMoss** (Jürgen Moßgraber) — `Push3ControllerDefinition.java`:
   `VENDOR_ID = 0x2982; PRODUCT_ID = 0x1969; INTERFACE_NUMBER = 0; ENDPOINT_ADDRESS = 0x01;`
2. [`danielknng/push3-protocol-docs`](https://github.com/danielknng/push3-protocol-docs) —
   `USB_PRODUCT_ID = 0x1969  # Push 3 (Push 2 is 0x1967)`
3. [`jaekong/PushDisplayServer`](https://github.com/jaekong/PushDisplayServer) — `0x1969`,
   **[RE-HW]** author states tested on a real Push 3 Standalone
4. [`ffont/push2-python` issue #9](https://github.com/ffont/push2-python/issues/9) — **[FORUM]** a
   user got Push **2** display code running on real Push 3 hardware in 2023 by changing only the PID

Our two constants live at `push2-display-frame.ts:49-51`. This is genuinely a one-line delta.

### 2.2 The interface class — strongly evidenced, still not a descriptor read

Our whole WebUSB-and-WebMIDI-coexist-on-one-page argument rests on the display interface being
**vendor-specific (class `0xFF`)**, which is not on Chrome's WebUSB blocklist. `push2-display.svelte.ts:8-12`
states this explicitly for Push 2, and it is **[OFFICIAL]** there.

**For Push 3, no source anywhere prints `bInterfaceClass`.** But three independent lines of evidence
now converge on vendor-specific, and none of them is a guess:

1. **[RE-HW]** `jaekong/pushDisplayTest` drives the Push 3 display through the **WebUSB API shape
   specifically** — `requestDevice` → `selectConfiguration(1)` → `claimInterface` → `transferOut` —
   selecting the interface whose USB string descriptor is **`"Ableton Push 3 Display"`**. WebUSB
   refuses to claim USB-Audio- and HID-class interfaces, so a successful claim is strong evidence the
   interface is vendor-specific.
2. **[OFFICIAL]** On Windows, Ableton's Push **3** display driver installs the device under
   *Universal Serial Bus devices*, **not** under *Sound, video and game controllers* — and the MIDI
   ports need no driver at all. That device-category split is the signature of a vendor-specific bulk
   function sitting alongside a class-compliant MIDI function, which is exactly the Push 2 topology.
3. **[RE]** linux-hardware.org's probe database resolves Push 2 (`usb:2982-1967`) as
   **`Class ff-ff-ff`** — vendor-specific, confirming our Push 2 assumption from a third,
   independent corpus.

**It remains [INFERENCE] for Push 3 until someone reads the descriptor.** This is still the single
highest-value thing to measure with hardware (§8) — and see §2.3 for just how unmeasured it is.

### 2.3 Negative findings — verified, not assumed

- **`usb.ids` contains no Ableton entry at all** (hwdata `Version: 2026.06.26`). Downloaded and
  grepped twice, independently: no `2982` vendor line; entries jump `2972 FiiO` → `298d Next
  Biometrics`. **This is true of Push 2 as well** — the USB-ID databases are simply not a source
  here. **[NOT FOUND — verified ×2]**
- **The Linux kernel has no Ableton quirk** (`sound/usb/quirks*.c`): zero matches. **[NOT FOUND — verified]**
- **linux-hardware.org has never seen a Push 3.** `usb:2982-1967` (Push 2) returns 1 probe,
  `Class ff-ff-ff`. `usb:2982-1969` (Push 3) returns an **empty page — zero probes, ever.** The Push 2
  hit is the negative control proving the lookup works. **[NOT FOUND — verified with a working control]**
- **No `lsusb -v` dump of any Push 3 exists publicly, on any platform.** As far as two independent
  research passes can determine, running `lsusb -v -d 2982:1969` on a Control-Mode Push 3 would
  produce **the first public descriptor dump in existence.** **[NOT FOUND]**
- **[RE]** DrivenByMoss ships a udev rule,
  [`resources/99-userusbdevices.rules`](https://github.com/git-moss/DrivenByMoss/blob/master/resources/99-userusbdevices.rules),
  containing `ATTR{idProduct}=="1969"` — a runtime file exercised on real Linux hardware rather than
  a constant in a source tree. Independent corroboration of the PID.
- **Whether the two SKUs share a PID: [INFERENCE], now leaning YES.** The manual says the
  configurations are feature-identical **[OFFICIAL]** and the FAQ says *"Any configuration of Push 3
  can be connected to a computer and used in Control Mode"* **[OFFICIAL]**; DrivenByMoss ships a
  *single* `0x1969` matcher used successfully by owners of both variants **[RE]**. A competing claim
  of `0x1968` for the controller-only SKU appears in `yonkolevel/AbletonPushDisplayKit`, but that
  repo's constants show signs of being AI-authored and it is the weaker source. **Still unresolved
  without a dump of each.**

---

## 3. The display — the good news, stated carefully

**There is NO official Push 3 display spec. [OFFICIAL — established by absence, rigorously]:**

- Every repo in the GitHub `Ableton` org was enumerated via the API. There is no `push3` repo.
  [`Ableton/push-interface`](https://github.com/Ableton/push-interface) is still described as *"The
  Ableton Push 2 MIDI and display interface manual."* (independently re-verified for this document).
- Issue [#33 "Updates for Push 3?"](https://github.com/Ableton/push-interface/issues/33), opened
  **2024-02-24**, is **still open**. All 11 comments have `author_association: NONE`. **No Ableton
  employee has replied in 2.5 years.**

**But the protocol is established by reverse engineering, and it is byte-for-byte identical to Push 2.**
Two fully independent implementations (Python and Swift/JS) agree with each other *and* with the
official Push 2 spec on every field:

| Field | Push 2 **[OFFICIAL]** | Push 3 **[RE] ×2** | Our constant |
|---|---|---|---|
| Resolution | 960 × 160, 16 bpp | identical | `PUSH_DISPLAY_W/H` |
| Line stride | 2048 B = 1920 visible + 128 filler | identical | `PUSH_DISPLAY_LINE_BYTES` |
| Frame size | 160 × 2048 = 327,680 B | identical | `PUSH_DISPLAY_FRAME_BYTES` |
| Frame header | `FF CC AA 88` + twelve `00` | identical | `PUSH_DISPLAY_HEADER` |
| XOR shaping | `E7 F3 E7 FF` repeating | identical | `PUSH_DISPLAY_XOR_MASK` |
| Endpoint | bulk OUT `0x01`, interface 0, config 1 | identical | `PUSH2_USB_ENDPOINT` etc. |
| Chunking | "typically 16 kbyte buffers" | `CHUNK_SIZE = 16_384` | `PUSH_DISPLAY_CHUNK_BYTES` |

**[RE-HW]** — `jaekong`, issue #33, 2025-09-12: *"I have tested the USB display interface, and it
works the same as well."* — with a demo video and published code, on a Push 3 Standalone, and he
reports the Swift version also *"[works] on Push 3's Controller Mode."*

Corroborating from a completely different data path, **[OFFICIAL]**: Ableton's own *Push 3 Display
Driver (Windows)* help article instructs users to run an installer literally named
**`push2-display-driver-installer`**. Ableton ships the *Push 2* display driver to service a Push 3.
That says the driver-binding shape is the same family. **It does not say the pixel format is the
same** — but it is convergent with the RE sources that say exactly that.

Independent corroboration on physical size: Sound On Sound's [Push 3
review](https://www.soundonsound.com/reviews/ableton-push-3) states *"the screen is the same"* as
Push 2's. Retail listings give the panel as 230.4 mm × 38.4 mm — which is exactly 960 × 160 at a
0.24 mm pixel pitch. Suggestive, and consistent, but note this is arithmetic agreement, not a
measurement of a Push 3.

### ⚠ A concrete trap in the best public Push 3 document

`danielknng/push3-protocol-docs` says "RGB565" and implements red in the high bits:

```python
return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)   # RED high — WRONG for Push
```

This is **red/blue swapped** versus the official Push 2 spec, which gives the layout explicitly as
`b4…b0 | g5…g0 | r4…r0` — **BGR565, blue high**. `jaekong`'s independently written code agrees with
the official spec, and so does our `push2-display-frame.ts:122-127`, whose own comment already names
this exact hazard:

> "a channel swap or a one-line stride error still produces a plausible image, and 'plausible' is the
> hardest kind of wrong to notice."

**Keep our packer. Do not port theirs.** Our golden vectors — `(255,0,0) → 0x001F`,
`(0,0,255) → 0xF800` — are the gate that catches this, and they already exist.

---

## 4. The control map

**No official chart exists. [OFFICIAL — by absence]**, same evidence as §3. Ableton's *Push 3 MIDI
FAQ* documents Push 3 as a MIDI-mapping *host* for external gear; it publishes no CC/note table for
Push 3's own controls.

### 4.1 Confirmed SAME as Push 2 **[RE, cross-corroborated by two sources]**

8×8 pads = **notes 36–99**, bottom-left 36 · display encoders **CC 71–78** · master **CC 79** ·
tempo **CC 14** · SysEx header **`F0 00 21 1D 01 01 … F7`** (same manufacturer *and* same device
family bytes `01 01`) · Play 85 · Undo 119 · Shift 49 · cursor/D-Pad 44–47 · Mute 60 · Solo 61 ·
Record 86 · Master 28 · Stop Clip 29.

**Every CC our `push2-map.ts` binds is in this list.** That is the reason the verdict is PARTIAL and
not NO.

### 4.2 Confirmed MOVED or NEW on Push 3 **[RE, both sources agree]**

- **"New" button: CC 87 → CC 92.** DrivenByMoss carries *both* constants (`PUSH_BUTTON_NEW = 87`,
  `PUSH_3_BUTTON_NEW = 92`) — the strongest available form of this evidence. **We do not bind CC 87,
  so this costs us nothing.**
- **CC 111**: "Browse" on Push 1/2 → "toggle master/cue volume" on Push 3. **We do not bind it.**
- **New Push-3-only controls:** Add 32, Hot Swap 33, Session Display 34, Capture MIDI 65,
  **jog-wheel turn 70**, Files 80, Help 81, Save 82, Lock 83, cursor-centre 91, jog-wheel
  left/press/right 93/94/95, small-knob press 15.

⚠ **Two of these land on CCs we already use or nearly use.** `jog-wheel turn = CC 70` sits directly
below our encoder block (71–78) — safe, but by one. **`small-knob press = CC 15`** collides with our
`PUSH_CC_ENCODER_SWING = 15` (card-flip). On Push 2, CC 15 is the Swing *encoder*; if on Push 3 CC 15
is a *button press*, our card-flip knob silently changes character. **Verify on hardware.**

### 4.3 ⚠ Three claims in the public chart that contradict our WORKING code

Cross-checked against `push2-map.ts`, which is hardware-tested on the owner's Push 2:

| `danielknng` claims | Official Push 2 spec + our code say | Assessment |
|---|---|---|
| upper row (above display) = CC 20–27, lower = 102–109 | **102–109 = above**, 20–27 = below (`PUSH_CC_ABOVE_DISPLAY_BASE = 102`) | rows **inverted** |
| Scene 1 → CC 36 … Scene 8 → CC 43 | CC 43 = scene 1 (**top**) … 36 = scene 8 (bottom) | order **reversed** |
| pixel format "RGB565" | BGR565 (§3) | channels **swapped** |

**[INFERENCE]** These read as labelling errors in the RE document rather than hardware changes,
because DrivenByMoss — which supports Push 1/2/3 from *one* constants file and annotates every
genuine difference — marks none of them as version-specific. **But we cannot rule out a real Push 3
change.** Both directions are cheap to settle with a device and a MIDI monitor; neither is settleable
from documentation.

### 4.4 One genuinely unresolved conflict

**Encoder-touch note numbers.** The **[OFFICIAL]** Push 2 spec's own worked example gives
`0x90 0x47 0x7F` = "leftmost track encoder touched" → **note 71** (touch notes tracking the CC
numbers). **[RE]** DrivenByMoss says `PUSH_KNOB1_TOUCH = 0` … `KNOB9_TOUCH = 8` with **no version
qualifier**; `danielknng` agrees (0–7). Weakly favouring 0–8: the official spec separately documents
touch-strip touch = note 12, which fits a contiguous 0…12 scheme.

**We do not currently map encoder touch at all**, so this blocks nothing today — but it is a live
example of the documentation being self-contradictory, and it must be measured before we build
touch-to-select.

---

## 5. MPE — the real breaker

### 5.1 It is on by default, and Ableton says so plainly

**[OFFICIAL]** manual §2.2.2: *"By default the pads are configured to enable MPE (MIDI Polyphonic
Expression) data."* Three Expression Modes exist: **MPE** (default), Poly Aftertouch, Mono
Aftertouch.

**[OFFICIAL]** manual §16, on User Mode — Ableton warning about its own default:

> "we recommend that you first set the Expression Mode to either Poly Aftertouch or Mono Aftertouch
> before entering User Mode. This will allow you to trigger changes with the pads more reliably
> compared to using **MPE Mode, which is configured for expressive playing and changes MIDI channels
> every time the pads are pressed**."

### 5.2 What that does to OUR code, specifically

Two findings, and they point in opposite directions — which is exactly why this had to be checked
against the source rather than reasoned about:

**GOOD — our pad handling is already MPE-tolerant, for free.** `decodePush2Message` masks the channel
off (`const status = msg[0] & 0xf0`, `push2-sysex.ts:226`) and its docblock says *"Channel is
ignored."* MPE's channel rotation is therefore invisible to us: a note-on on channel 5 decodes exactly
like one on channel 0. We also drop pitch bend (`0xE0`), poly aftertouch (`0xA0`) and channel
pressure (`0xD0`) — we only decode `0x90`/`0x80`/`0xB0` — so the per-note pitch-bend flood is
silently discarded rather than misrouted.

**BAD — one collision, and it is squarely on a feature the owner uses.**

> **MPE's timbre/slide axis is CC 74. Our display-encoder range is CC 71–78.**
> `isEncoderCc(74)` → true. `encoderTarget(74)` → `{ kind: 'strip', index: 3 }` → **push-card
> encoder 4**. `decodeRelativeCc` then reads the *absolute* slide value 0–127 as a two's-complement
> *relative* delta.

So on a Push 3 in its default mode, **sliding a finger up and down a pad walks push-card encoder 4's
parameter** — up to ±4 detents per message, continuously, for as long as you touch the pad. It would
present as "the 4th knob is possessed", and nothing in our test suite could catch it, because our
simulated device only sends what we tell it to.

Three candidate fixes, in increasing order of confidence:

1. **Send the MPE-off SysEx on bind.** **[RE]** command `0x1E`: `F0 00 21 1D 01 01 1E <mode> F7`,
   `00` = channel pressure, `01` = poly AT, `02` = MPE. DrivenByMoss corroborates the *existence* of
   the operation ("Turn MPE on/off (only Push 3)"). **The exact bytes appear in no official source.**
2. **Bind the User port instead of the Live port** — per-note expression may not flow there. Unverified.
3. **Gate encoder CCs on "no pad currently held"** — device-independent, needs no protocol knowledge,
   and is the only one of the three that is correct even if both of the others are wrong.

(3) is the one to design blind; (1) is the one to verify on hardware.

---

## 6. Our 28 files — SEMANTIC vs DEVICE, with line counts

Measured, not estimated. Totals reconcile exactly to `wc -l` = **8500**.

> ⚠ **Re-measured 2026-08-12: the line counts below are a snapshot the in-flight
> legend work (§7.2) had already moved by the time this was committed, and four
> more Push PRs landed after.** `packages/web/src/lib/control/push2/` is now
> **34 `.ts` files / 12,858 lines** — `push2-map.ts` 349→456,
> `push-screen-layout.ts` 346→652, `push-card-config.ts` 117→148, plus
> `push-electra-model`, `push-legend-model`, `push-midi-conflict` and
> `push2-led-zones` (all outside the 28 counted here). **Re-derive the bucket
> arithmetic before quoting a share.** What has NOT moved is the finding: the
> SEMANTIC↔DEVICE seam is real (still zero device imports), and the measured
> Push 3 delta inside the DEVICE bucket is still one constant and one regex.

| Bucket | Files | Lines | Share | Source lines | Test lines |
|---|---:|---:|---:|---:|---:|
| **SEMANTIC** — zero device facts; ports unchanged | 12 | **2409** | **28.3 %** | 1018 | 1391 |
| **MIXED** — app logic parameterised by device geometry | 6 | **2503** | **29.4 %** | 1186 | 1317 |
| **DEVICE** — Push-2 protocol; must be re-derived | 10 | **3588** | **42.2 %** | 2145 | 1443 |
| **TOTAL** | **28** | **8500** | 100 % | 4349 | 4151 |

### SEMANTIC — 2409 lines, ports with **no** changes

| File | Lines | What it knows |
|---|---:|---|
| `push-card-schema.ts` | 259 | which 8 params a module shows (override → face → generic) |
| `push-card-model.ts` | 262 | the view model: bar `frac`, readout text, cells, pips |
| `push-card-config.ts` | 117 | the owner-editable per-module control roster |
| `push-lane.ts` | 151 | lane membership + focus ("most recently added / last viewed") |
| `push2-view.svelte.ts` | 128 | per-rack lane-focus memory in localStorage |
| `push-card-encoder.ts` | 87 | value math for a detent (roster / discrete / arc-fraction) |
| `push2-types.ts` | 14 | type re-exports |
| *+ 5 test files* | 1391 | |

**Negative-controlled:** every import of all seven source files was enumerated. They import only from
`$lib/graph`, `$lib/ui/controls`, `$lib/ui/workflow`, `$lib/multiplayer`, and each other.
**Zero imports from the device bucket.** This is a real seam, not an aspiration.

Four hardware-derived *numbers* do leak in, and all four are one-line edits:

- `PUSH_CARD_SLOTS = 8` (`push-card-schema.ts:41`) — comment says *"Fixed by hardware."*
- `CELL_MAX_STEPS = 16` (`push-card-model.ts:53`) — justified by the ~102 px strip interior
- `MAX_ENCODER_STEP = 4`, `ENCODER_FRAC_STEP = 0.01` (`push-card-encoder.ts:40,44`)

Push 3 also has 8 display encoders and the same 960×160 panel, so **all four are unchanged in
practice.**

### MIXED — 2503 lines, semantic logic pinned to device geometry

| File | Lines | Device-coupled lines | What would change |
|---|---:|---:|---|
| `push2-control.svelte.ts` | 704 | **32** | imports `PUSH_CC_*`, `classifyPush2`, `push2FrameToLeds`, the two transports |
| `push-screen-layout.ts` | 346 | **21** | `PUSH_SCREEN_W/H` + the vertical band constants tuned to a 160 px panel |
| `push-card-paint.ts` | 136 | **5** | scratch-canvas size |
| *+ 3 test files* | 1317 | — | |

**Only 58 of the 1186 MIXED source lines touch a device fact.** The other ~95 % is orchestration —
lane select, card flip, the CC-commit pump, dirty-checked repaint — that a second device inherits.

### DEVICE — 3588 lines, the actual port surface

| File | Lines | Push-3 delta |
|---|---:|---|
| `push2-display.svelte.ts` | 713 | **PID constant only** (VID, interface, endpoint, config all identical) |
| `push2-display-frame.ts` | 318 | **none** — every geometry constant matches Push 3 per §3 |
| `push2-device.svelte.ts` | 505 | port-name matcher `/push ?2/` → family matcher; Windows numbered variants |
| `push2-map.ts` | 349 | CC constants re-verified on hardware; **CC 74 guard**; CC 15 check |
| `push2-sysex.ts` | 260 | mode SysEx (same `01 01` family bytes); palette re-verify |
| *+ 5 test files* | 1443 | re-run against a Push 3 profile |

**The headline ratio:** 42 % of the stack is device-locked *by file*, but the measured Push 3 delta
inside that 42 % is dominated by **one constant and one regex**. The display half of the device
bucket (1031 source lines across two files) is very close to a no-op.

### One latent defect the port would expose

The panel resolution is declared **twice, independently**: `PUSH_DISPLAY_W/H`
(`push2-display-frame.ts:64-66`, the codec) and `PUSH_SCREEN_W/H` (`push-screen-layout.ts:39-40`, the
layout). They agree today by coincidence of authorship. The only thing tying them together is the
`RangeError` in `packPushFrameInto` — a loud runtime guard, but a guard on a fact that should have one
declaration. **Collapse these before any port**, or the first device with a different panel size
produces two disagreeing truths.

---

## 7. The device-abstraction seam

### 7.1 What it would have to name

Six device facts, and where each is declared today:

| # | Fact | Declared at |
|---|---|---|
| 1 | Transport identity — VID/PID/interface/endpoint/config | `push2-display-frame.ts:49-57`; port matcher `push2-device.svelte.ts:181-197` |
| 2 | Panel geometry — W/H/bpp/stride/filler/header/XOR/chunk | `push2-display-frame.ts:64-99` **and again** `push-screen-layout.ts:39-40` |
| 3 | Control map — CC numbers, pad note base, grid origin | `push2-map.ts:58-100`, `push2-sysex.ts:44-56` |
| 4 | LED colour model — palette anchors, which buttons are RGB vs mono | `push2-sysex.ts:121-150`, `push2-map.ts:276-294` |
| 5 | Mode handshake — the Live/User SysEx | `push2-sysex.ts:34-41,175-189` |
| 6 | Encoder encoding — relative two's complement | `push2-sysex.ts:103-106` |

A `PushDeviceProfile` record carrying those six groups, with `push2Profile` and `push3Profile` as its
two instances, is the whole seam. The pure codecs (`push2-sysex.ts`, `push2-display-frame.ts`) already
take everything as arguments or module constants — they would take a profile instead. Nothing in the
SEMANTIC bucket changes.

### 7.2 Does the legend work's binding table already provide part of it?

**Partly — and the useful half, but it is worth being precise, because the answer is not the obvious
one.**

The legend feature (in flight; commits `daeb3912` "the button ROUTING is a table that carries its own
legend" + `54d8a161` "LEGEND MODE") puts button bindings in a table:

```ts
export interface TopRowBinding { cc: number; action: TopRowAction; legend: string }
export const TOP_ROW_BINDINGS: readonly TopRowBinding[] = [
  { cc: CC_UP, action: 'transport', legend: 'PLAY/STOP' },   // 91
  …
];
```

**The critical detail: that table lives in `launchpad-map.ts` and is keyed by LAUNCHPAD CC 91–98 —
our app's internal control vocabulary — not by Push CCs.** `push2-map.pushCcToLaunchpadTopCc()`
translates Push CC 20–27 → Launchpad 91–98.

**What that gives us: the table is already device-independent.** A Push 3 re-points the *translation*
and inherits every action and every legend string for free. That is exactly the right shape, and it
was not designed for this.

**What it does not give us:** it is a *legend* table, not a *device binding* table. It names what a
button MEANS; the Push CC that reaches it is still a hardcoded `export const` in `push2-map.ts` —
thirteen of them. And its scope is deliberately narrow: `legendScope()` itself declares the uncovered
set — the 8×8 pads, the encoders, the D-Pad, the channel-select row, the GRID-held layer, the PROB
pages, copy/paste arms.

> **Verdict on the seam question: the legend work supplies the SEMANTIC half of a binding table and
> none of the DEVICE half.** It is sufficient as a model to copy — one row, two consumers, with a gate
> that fails in both directions — and insufficient as the seam itself. The natural follow-on is to give
> `push2-map.ts`'s thirteen `PUSH_CC_*` constants the same treatment: one table, rows carrying the CC
> *per device profile*, with dispatch and legend reading the same row.

---

## 8. Cost estimate

### 8.1 Work we can do BLIND — ~3–4 days, fully testable today

Every item here is exercised by the existing simulated-device harness
(`installSimulatedPush2` / `installSimulatedPush2Display`), which drives the **real** open → claim →
transfer path against a fake device.

| # | Work | Est. |
|---|---|---|
| A | Collapse the duplicate resolution declaration (§6); extract `PushDeviceProfile` over the six fact groups (§7.1) | 1 d |
| B | Add a `push3Profile`; add a simulated Push 3; re-run every unit + e2e row against **both** profiles | 1 d |
| C | **MPE hardening (§5.2)** — the "no encoder CC while a pad is held" guard; design the mode-set SysEx path behind a flag | 0.5 d |
| D | Port-name matcher `/push ?2/` → device family + Windows numbered variants (we have the Launchpad precedent) | 0.5 d |
| E | `Push2Diagram.svelte` (202 lines) is a to-scale Push **2** faceplate — a Push 3 faceplate is new SVG art; docs + `module-manifest` copy | 0.5 d |

⚠ **The blind work cannot validate itself.** A simulated Push 3 built from reverse-engineered facts
will pass every test we can write and still be wrong on hardware — the tests would be asserting that
our code matches our own assumptions. This is the repo's own "validate the instrument" failure mode,
and it is worth stating in the PR that ships item B.

### 8.2 Work that NEEDS A DEVICE — ~half a day of bring-up

One session with a Push 3, Chrome DevTools, `lsusb -v`, and a MIDI monitor settles all of it. We
already have the two diagnostics this needs: `dumpPortNames()` on connect, and the per-CC console
logger the legend branch added for unbound buttons.

0. **Does a `Push3` process already hold the display endpoint (§8.4.1)?** Check with Live *closed*,
   then with Live *never having been launched this boot*. **Do this first** — a negative result kills
   the browser display path regardless of how the other six go, and it costs one `lsof`/Process
   Explorer look.
1. **`lsusb -v` → read `bInterfaceClass` on the display interface.** Settles §2.2, and would be the
   first public Push 3 descriptor dump in existence (§2.3).
2. Confirm PID `0x1969`; confirm WebUSB and WebMIDI actually coexist on one page (Push 2's headline property).
3. Blit one frame with our **unmodified** packer — confirms the whole of §3 in one shot.
4. Walk every button and encoder: settle the §4.3 contradictions (display-row direction, scene order),
   **CC 15** (§4.2), and encoder-touch notes (§4.4).
5. Confirm MPE behaviour and whether the `0x1E` mode SysEx works (§5.2).
6. Confirm the Standalone's Standalone → Control → User path, and whether it enumerates at all in
   Standalone Mode.
7. Confirm power adequacy — **a dim display on Push 3 is a power symptom, not a protocol bug.**

### 8.3 Genuinely blocked on information that does not publicly exist

Only one thing, and it is not a task — it is a standing condition:

> **There is no authoritative Push 3 interface specification, and Ableton has declined to produce one
> for 2.5 years** (issue #33, opened 2024-02-24, zero employee replies). Everything in §2–§5 that is
> not in the manual is reverse-engineered. **A firmware update can change any of it with no changelog
> we can read.**

That does not block the *work* — hardware measurement substitutes for a spec, and our golden-vector
discipline means a regression would fail loudly. It blocks the *warranty*. Push 2 support rests on a
document Ableton published; Push 3 support would rest on four strangers' repos and one bring-up
session.

A second, softer item: fully settling whether the two SKUs enumerate identically needs **both** SKUs,
not one — though §2.3 now leans toward a shared PID.

### 8.4 Three risks that are neither blind work nor information gaps

These are real technical constraints. None is a documentation problem; none is fixed by buying a
device; each could individually sink the *display* half of the feature while leaving MIDI intact.

1. **⚠ A host-side process may already own the display endpoint.** Reported on `push-interface`
   issue #33: a process named **`Push3`** holds the display interface. A USB interface can be claimed
   by exactly one client, and **a web page cannot terminate a host process.** If that process is
   spawned only by a running Ableton Live, this is the same situation as Push 2 and the answer is
   "don't run Live at the same time". **If it is a background helper installed alongside Live and
   running regardless, it is a hard blocker for the browser on any machine that has Live installed** —
   which is most of our Push-owning users. **[FORUM] — and the single most important thing to
   determine in the bring-up session (§8.2).**
2. **Windows requires the interface bound to WinUSB**, which is precisely what Ableton's
   `push2-display-driver-installer` provides. We **cannot ship that from a web page.** Live users will
   already have it; a Push 3 owner who has never installed Live would have no path to the display
   through us. Our existing `failed` status already degrades correctly here
   (`push2-display.svelte.ts:94`), so this is a documentation and expectation-setting problem, not a
   code one. **[OFFICIAL]**
3. **An undocumented fourth USB function, `Ableton Push 3 xPort`**, appears with a yellow bang in
   Windows Device Manager and has no public driver; Ableton Support reportedly describes it as *"an
   internal debugging tool that is not distributed along with Push."* Unlikely to affect us, but it
   means the Push 3's USB topology has at least one function nobody outside Ableton understands.
   **[FORUM]**

**Net effect: the MIDI-only slice is unaffected by all three.** That is a real argument for
sequencing MIDI first and treating the display as a separate, hardware-gated decision.

---

## 9. What the owner would need to buy or borrow

**To settle essentially everything: one Push 3 Controller** (the tethered SKU, no processor). It is
the cheaper of the two, and it is the SKU that is *always* in Control Mode — so it exercises our exact
code path with no on-device mode dance. Everything in §8.2 items 1–5 and 7 is answerable with it alone.

**To settle the Standalone questions as well: borrow a Standalone** for an afternoon. Items 6 and the
SKU-identity question in §8.3 need it and cannot be answered any other way. Buying one purely for this
is not warranted; a borrow or a shop demo unit is.

**Also needed, and easy to overlook:** the **supplied Ableton PSU** and a USB-C cable. Push 3 requires
a minimum of **15 W (5 V / 3 A)** **[OFFICIAL]**, and many computer and hub ports supply only
5 V / 1.5 A; the documented symptom is *"Push not powering on or the display appearing dim."* A
bring-up session on bus power alone could produce a dim panel and get misread as a framebuffer bug.

---

## 10. Open questions for the owner

1. **Is Push 3 support wanted at all, given §8.3?** Supporting a device with no vendor spec is a
   standing maintenance liability, not a one-off cost.
2. **Which SKU do we target?** Controller-only is materially cheaper to support (no mode dance, no
   "does it enumerate" question) and is the one our current architecture already fits.
3. **Should the MPE guard (§5.2, option 3) ship for Push 2 now, independent of any Push 3 work?** It is
   device-independent, costs a few lines, and hardens us against any future MPE controller. It is the
   one item here with value even if Push 3 support is never built.
4. **Do we split MIDI from display?** §8.4 makes MIDI-only strictly safer: it is unaffected by the
   `Push3` endpoint-ownership risk, the Windows WinUSB dependency, and the `xPort` unknown. A
   MIDI-first Push 3 slice would be ~2 of the ~3–4 blind days and could ship without ever resolving
   the display questions — at the cost of shipping a Push 3 integration whose headline feature (the
   screen) is missing.

---

## Sources

- [Ableton Push 3 Reference Manual (PDF, 2024-11-05)](https://cdn-resources.ableton.com/resources/pdfs/push-manual/3/2024-11-05/push3-manual-en.pdf)
- [Ableton/push-interface](https://github.com/Ableton/push-interface) · [issue #33 "Updates for Push 3?"](https://github.com/Ableton/push-interface/issues/33)
- [Push 3 USB power FAQ](https://help.ableton.com/hc/en-us/articles/9109387410716-Push-3-USB-power-FAQ) · [Push 3 Display Driver (Windows)](https://help.ableton.com/hc/en-us/articles/10295607009436-Push-3-Display-Driver-Windows) · [Push 3 Technical FAQ](https://help.ableton.com/hc/en-us/articles/8483166334748-Push-3-Technical-FAQ) · [Push tech specs](https://www.ableton.com/en/push/tech-specs/)
- [git-moss/DrivenByMoss](https://github.com/git-moss/DrivenByMoss) (Bitwig + Reaper Push 3 support)
- [danielknng/push3-protocol-docs](https://github.com/danielknng/push3-protocol-docs) — ⚠ see §3, §4.3
- [jaekong/PushDisplayServer](https://github.com/jaekong/PushDisplayServer) · [jaekong/pushDisplayTest](https://github.com/jaekong/pushDisplayTest)
- [ffont/push2-python issue #9](https://github.com/ffont/push2-python/issues/9)
- [Sound On Sound — Ableton Push 3 review](https://www.soundonsound.com/reviews/ableton-push-3)
- [Ableton Forum — Push 3 Standalone audio interface / USB MIDI](https://forum.ableton.com/viewtopic.php?t=248949)
- [linux-usb.org/usb.ids](http://www.linux-usb.org/usb.ids) — negative finding, verified ×2 (hwdata 2026.06.26)
- [linux-hardware.org USB probe database](https://linux-hardware.org/?view=search) — Push 2 `2982:1967` = `Class ff-ff-ff` (1 probe); Push 3 `2982:1969` = **zero probes ever**
- [DrivenByMoss `99-userusbdevices.rules`](https://github.com/git-moss/DrivenByMoss/blob/master/resources/99-userusbdevices.rules) — udev rule carrying `idProduct 1969`

**Method note.** This document is the merge of two independent research passes plus direct
verification of the decisive claims. Where the passes disagreed, both are reported rather than
averaged — see §4.3 and §4.4. One arithmetic error propagated between sources during research
(`20 × 0x4000` rendered as 327,664 rather than **327,680**); it originates in
`push3-protocol-docs` and is corrected wherever it appears above.
