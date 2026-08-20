# VST BRIDGE — owner verification checklist (live helper)

Everything testable without the helper is tested (protocol codecs, the
poly-CV→MIDI note/gate/velocity conversion, lane autowiring, and the full
browser transport against a mock helper at the WebSocket seam — see
`e2e/tests/vst-bridge.spec.ts` / `vst-lane-autowire.spec.ts`). The items
below are the half that only exists on a machine with the REAL helper and
REAL AU plugins. Issue #1953 (which carries the plan's milestones).

## Setup

```sh
cd ../patchtogether.nativeapps && swift run -c release vst-bridge
```

Chromium (or Firefox), `http://localhost:5173/rack` or
`https://dev.patchtogether.live/rack` (the helper allowlists
`*.patchtogether.live`; `--allow-origin '*.pages.dev'` for PR previews).
Safari is expected inert (documented, same posture as the ES-9).

## The owner's sentence (plan §M2/M3 acceptance)

- [ ] Drop **vst instrument** into a channel lane → card connects, plugin
      picker lists your AUs (Apple + Arturia, ~189).
- [ ] Mount `Apple: DLSMusicDevice` (`au:aumu:dls :appl`) → the lane's clip
      player drives it; notes you write in the clip SOUND, at the pitches
      you wrote (spot-check c3 / c4 / a4 by ear or a tuner — the wire-level
      48/60/69 mapping is already machine-verified against the mock).
- [ ] Chords in the clip play polyphonically; tied notes hold; retriggers
      re-strike. Stop the transport → no stuck notes.
- [ ] Drop **vst fx** into the SAME lane → lane audio keeps flowing
      (bit-transparent bypass), mount `Apple: AUDelay` (`au:aufx:dely:appl`)
      → audible delay on the lane.
- [ ] Kill the helper mid-play → the fx card local-bypasses (lane keeps
      audio, dry); the instrument card goes silent; both cards show
      "helper not found". Restart the helper → cards reconnect on their own.

## M4: persistence / reattach / editor

- [ ] **OPEN EDITOR** raises the plugin's native macOS window; closing it
      natively flips the card's button back to "open editor".
- [ ] Tweak the plugin in its editor → close the editor (or wait ≤60 s) →
      the card shows "state saved in patch · N KB".
- [ ] **Refresh the page** → the card re-adopts the RUNNING instance
      (instant `mounted`, same tweaked sound — the 90 s parked-instance
      window; verify no `setState` stomped your live tweaks).
- [ ] **Quit the helper, relaunch it, reload the page** (parked instance
      gone) → the card cold-remounts the persisted plugin and re-applies
      the saved state — the tweaked sound survives a full helper restart.
- [ ] A sample-heavy instrument whose state exceeds 256 KB shows the
      "state too large — plugin id only" note and still remounts by id.
- [ ] Two tabs on the same patch: the second tab's card takes the instance
      ("claimed by another tab" in the first); CONNECT in the first
      reclaims it. No reconnect war.
- [ ] `latencySamples` / rtt / load% readouts look sane; **measure the real
      added latency** (plan open item 1 — the estimates were INFERRED:
      ~10-15 ms instrument, ~15-25 ms insert).

## Multi-instance

- [ ] Instrument + fx in one lane mount two different plugins concurrently
      (two sockets, one instance each — the helper's
      `testTwoConcurrentInstances` covers the native side).

## Helper change requests (nice-to-have, none blocking)

1. `mounted` could carry `adopted: true` when it is a parked-instance
   replay — the card currently disambiguates adopt-vs-cold with a 1 s grace
   window after connect (`vst-persistence.ts`), which a flag would delete.
2. Plugin-emitted MIDI back to the browser stays phase-2 (arps out).
