# PT-PTZ sysex protocol (helper ⇆ app)

The `ptzcam` module and the native macOS helper `tools/pt-ptz` speak a tiny
sysex protocol over a virtual CoreMIDI pair, both named **`PT-PTZ`** (the
helper's *destination* receives commands; its *source* carries replies). The
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
| `ver` | protocol version, `01` |
| `cmd` | see below |

Frames not carrying the `7D "PTZ"` prefix are ignored silently (other 0x7D
users are legal). A recognized frame with an unknown version or command gets an
ERROR reply.

## Commands

App → helper (send to the `PT-PTZ` destination):

| cmd | name | payload |
|---|---|---|
| `01` | CAPS_REQUEST | none |
| `02` | SET_ABS | `<control> <val35>` |

Helper → app (arrives from the `PT-PTZ` source):

| cmd | name | payload |
|---|---|---|
| `41` | CAPS_REPLY | `<count>` then per control: `<control> <min> <max> <res> <cur>` (each a val35) |
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
carries. Measured device ranges on the NexiGo P610 (arc-seconds for pan/tilt):
pan −612000..612000, tilt −108000..324000, zoom 0..3040, all res 1.

## Semantics

- **SET_ABS coalesces last-wins per control** in the helper; a 30 Hz timer
  flushes to USB. Send at any rate; only the newest value per control reaches
  the camera. Values are clamped to the probed device range before writing.
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
