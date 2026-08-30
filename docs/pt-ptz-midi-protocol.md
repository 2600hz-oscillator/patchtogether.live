# PT-PTZ sysex protocol v2 (helper ⇆ app)

The `ptzcam` module and the native macOS helper `tools/pt-ptz` speak a tiny
sysex protocol over virtual CoreMIDI pairs, one per camera, named
**`PT-PTZ-<SHORT>`** (e.g. `PT-PTZ-NEXIGOP6`, `PT-PTZ-PTZPRO2`; each
*destination* receives commands and its *source* carries replies). The
canonical implementations are `tools/pt-ptz/pt-ptz.c` (C) and
`packages/web/src/lib/audio/ptz-sysex.ts` (TypeScript) — change all three
files together.

Why MIDI: on macOS 26 the kernel UVC driver holds the camera's VideoControl
interface exclusively, so Chromium's in-browser PTZ constraints report nothing.
Bare EP0 class control requests from user space still work (proven on hardware
2026-08-29), and a virtual MIDI device rides the app's existing WebMIDI
plumbing and permission — zero new transports.

## Framing

```
F0 7D 50 54 5A <ver> <cmd> <payload…> F7
```

| byte | meaning |
|---|---|
| `7D` | experimental/educational manufacturer id |
| `50 54 5A` | ASCII `PTZ` — tag disambiguating other 0x7D traffic |
| `ver` | protocol version, `02` |
| `cmd` | see below |

Frames not carrying the `7D "PTZ"` prefix are ignored silently (other 0x7D
users are legal). A recognized frame with an unknown version or command gets an
ERROR reply.

## Commands

App → helper (send to the `PT-PTZ` destination):

| cmd | name | payload |
|---|---|---|
| `01` | CAPS_REQUEST | none |
| `02` | SET_ABS | `<control> <val35>` — absolute-mode axes only |
| `03` | SET_VEL | `<control> <val35 signed>` — velocity-mode axes; sign = direction, magnitude clamps into the speed range, `0` is an explicit STOP. Streaming any SET_VEL refreshes the stage-safety watchdog. |
| `04` | STOP_ALL | none — halt all velocity motion on this camera now |

Helper → app (arrives from the `PT-PTZ` source):

| cmd | name | payload |
|---|---|---|
| `41` | CAPS_REPLY | `<count>` then per control: `<control> <mode>` where mode `01` = absolute (followed by `<min> <max> <res> <cur>`), `02` = velocity (followed by `<speedMin> <speedMax> <speedRes>`), `00` = none (no payload); every value a val35 |
| `42` | ERROR | `<code>` `<ascii name…>` |

Controls: `01` pan · `02` tilt · `03` zoom.

Error codes: `01` `camera-absent` · `02` `control-failed` · `03` `bad-frame`.
The ASCII name is the contract; the code is a convenience.

## val35 encoding

A 35-bit two's-complement integer packed into **five 7-bit groups,
least-significant group first**:

```
b[i] = (v >> (7*i)) & 0x7F        for i = 0..4       (encode, v masked to 35 bits)
u    = Σ b[i] << (7*i);  v = u ≥ 2^34 ? u - 2^35 : u  (decode)
```

Range ±2^34 — covers the full int32 range the UVC PanTilt(Absolute) control
carries. Measured devices (2026-08-29): NexiGo P610 all-absolute — pan
−612000..612000 arc-sec, tilt −108000..324000, zoom 0..3040, res 1 (physical
granularity ≈1°). Logitech PTZ Pro 2 — pan/tilt VELOCITY at the degenerate
fixed speed range 1..1 (direction ±1 or stop), zoom absolute 100..1000.

## Semantics

- **SET_ABS coalesces last-wins per control** in the helper; a 30 Hz timer
  flushes to USB. Send at any rate; only the newest value per control reaches
  the camera. Values are clamped to the probed device range before writing.
- **SET_VEL is watchdog-guarded (stage safety)**: the module re-sends the
  current velocity every plan tick while nonzero; the helper stops a moving
  axis by itself if no SET_VEL arrives for ~250 ms, and also stops all motion
  on STOP_ALL, on SIGINT/SIGTERM/exit, and when the camera disappears. A
  crashed page can never leave a head panning mid-set.
- **CAPS_REPLY is the bind handshake**: the app requests caps after resolving
  the ports and maps its normalized values into the replied ranges. `cur` is
  refreshed from the camera on every request.
- **Unsolicited CAPS_REPLY** is sent when the camera transitions
  absent → present (hot-replug); treat any caps reply as fresh truth.
- **ERROR `camera-absent`** answers a caps request or a set attempt while the
  camera is unplugged (rate-limited to ~1/s for set traffic). The helper keeps
  serving and rebinds when the camera reappears.
- Helper process presence is signaled by the MIDI ports themselves: WebMIDI
  `statechange` fires when the virtual ports appear/disappear.
