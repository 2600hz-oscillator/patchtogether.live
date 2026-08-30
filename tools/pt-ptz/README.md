# pt-ptz — MIDI→UVC bridge for the NexiGo P610

A single-file macOS CLI that exposes a virtual CoreMIDI destination + source
named **`PT-PTZ`** and bridges the sysex protocol described in
`docs/pt-ptz-midi-protocol.md` onto UVC class control requests (EP0) for the
NexiGo P610 (USB `3443:0c3d`). The app's `ptzcam` module talks to it over
WebMIDI; no other transport, no drivers, no Xcode project.

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
./pt-ptz --probe    # dump pan/tilt/zoom min/max/res/cur and exit
./pt-ptz --nudge    # small zoom pulse + restore — the hardware smoke test
./pt-ptz -v         # bridge with per-write logging
```

Expected startup output:

```
pt-ptz: virtual MIDI destination + source "PT-PTZ" up
pt-ptz: camera bound (pan -612000..612000, tilt -108000..324000, zoom 0..3040)
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
4. In the app, spawn a `ptzcam` module and grant the MIDI permission — the
   face shows BOUND once the caps handshake lands.

## Notes

- Device identity is compiled in (`WANT_VID`/`WANT_PID`, CameraTerminal id 1);
  a different camera model needs those and possibly the control selectors
  adjusted.
- Writes are last-wins coalesced per control and flushed at 30 Hz, clamped to
  the probed ranges. Pan and tilt share one UVC control; the helper caches the
  latest of each so a pan-only write does not disturb tilt.
- Uses the classic CoreMIDI API (deprecated but functional); revisit if a
  future macOS removes it.
