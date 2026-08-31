# pt-ptz — MIDI→UVC bridge for PTZ cameras (multi-device)

A single-file macOS CLI that enumerates every UVC camera declaring a PTZ
control, exposes one virtual CoreMIDI destination + source pair per camera
(named **`PT-PTZ-<SHORT>`**, e.g. `PT-PTZ-NEXIGOP6`, `PT-PTZ-PTZPRO2`), and
bridges the sysex protocol described in `docs/pt-ptz-midi-protocol.md` onto
UVC class control requests (EP0). Per-device VideoControl interface and
camera-terminal ids come from the descriptors — no model is hardcoded.
Absolute axes (NexiGo P610) take positions; velocity axes (Logitech PTZ Pro 2
pan/tilt) take rates guarded by a ~250 ms stage-safety watchdog that stops
motion when the app stops streaming — and on Ctrl+C, exit, or camera loss.
The app's `ptzcam` module talks to it over WebMIDI; no other transport, no
drivers, no Xcode project.

It never opens the USB interface — on macOS 26 the kernel UVC driver owns it
(`kIOReturnExclusiveAccess`), but bare EP0 class requests on the unopened
interface work, GET and SET both (proven on hardware 2026-08-29).

## Build

System clang only:

```sh
make          # → ./pt-ptz
```

## Run

```sh
./pt-ptz            # run the bridge (leave it running; Ctrl+C to stop)
./pt-ptz --probe    # list every camera with per-axis modes/ranges and exit
./pt-ptz --nudge    # per-camera small zoom pulse + restore — the hardware smoke test
./pt-ptz -v         # bridge with per-write logging
```

Expected startup output (one pair per camera):

```
pt-ptz: virtual MIDI pair "PT-PTZ-NEXIGOP6" up (NexiGo P610 PTZ Camera 3443:0c3d)
pt-ptz: virtual MIDI pair "PT-PTZ-PTZPRO2" up (PTZ Pro 2 046d:085f)
pt-ptz[PT-PTZ-NEXIGOP6]: bound — pan abs -612000..612000, tilt abs -108000..324000, zoom abs 0..3040
pt-ptz[PT-PTZ-PTZPRO2]: bound — pan vel speed 1..1, tilt vel speed 1..1, zoom abs 100..1000
```

`camera ABSENT` at startup is not fatal — the helper keeps serving, replies
`camera-absent` error frames, and binds (announcing with an unsolicited caps
reply) as soon as the camera is plugged in. Hot-unplug mid-show recovers the
same way.

## Show checklist

1. Plug in the camera, start the helper (or `scratch/start_ptz.sh`).
2. `./pt-ptz --nudge` once — if the image zooms and returns, the USB path is
   good.
3. Start the browser **with sysex-capable MIDI**: Chromium 152 on macOS
   silently drops sysex unless launched with
   `--disable-features=MidiMacUmp` (see `start_edge.sh`) — the app will look
   bound but the camera will not move if you skip this.
4. In the app, spawn one `ptzcam` module PER CAMERA, pick the camera in each
   card's dropdown, and grant the MIDI permission — each card shows BOUND with
   its per-axis modes once the caps handshake lands.

## Notes

- Any UVC camera declaring Zoom(Absolute), PanTilt(Absolute) or
  PanTilt(Relative) is picked up automatically, up to 4 at once.
- Writes are last-wins coalesced per control and flushed at 30 Hz, clamped to
  the probed ranges. Pan and tilt share one UVC control; the helper caches the
  latest of each so a pan-only write does not disturb tilt.
- Uses the classic CoreMIDI API (deprecated but functional); revisit if a
  future macOS removes it.
