// packages/web/src/lib/ui/modules/electra-auto-reconnect.ts
//
// THE LIVE WIRING for the Electra auto-reconnect machine (#2248).
//
// The state machine itself — the (load, device-connect) edge logic, the
// statechange debounce, the safety rails — is `$lib/electra/auto-reconnect.ts`,
// pure over an injected dependency seam. This file is where the seam meets the
// singletons: the broker (one Electra on the end of the cable → one access, one
// port map), the patch store (which electraControl node to flash for), the
// Permissions API (never prompt without a gesture), and `electraSendToDevice`
// (THE flash — the same seam the button and the ranked face cell fire, so this
// is a third TRIGGER of one flash, never a second implementation of it).
//
// MODULE-SCOPE SINGLETON, like `liveAutoconfig` and the outcome store in
// `electra-cell-actions.ts`, and for the same reason: the thing being tracked
// (permission + port presence + "did this page already flash for this edge")
// is per-PAGE, not per-component and not per-Canvas-mount. Canvas re-arms the
// LOAD edge on every mount / explicit patch load; the machine, its access and
// its statechange subscription live for the page.
//
// `flash` passes `recordPress: false` — an automatic flash presses nothing, so
// it must not write an audition record (see electraSendToDevice's doc).

import { ElectraAutoReconnect } from '$lib/electra/auto-reconnect';
import { electraBroker } from '$lib/electra/broker';
import { webMidiSupported, queryMidiPermission } from '$lib/audio/midi-access';
import { patch } from '$lib/graph/store';
import { listElectraControls } from '$lib/graph/electra-control';
import { electraSendToDevice } from './electra-cell-actions';

let live: ElectraAutoReconnect | null = null;

/** The page-lifetime auto-reconnect machine (lazily constructed). */
export function getElectraAutoReconnect(): ElectraAutoReconnect {
  if (!live) {
    live = new ElectraAutoReconnect({
      midiSupported: webMidiSupported,
      // Sysex-scoped: the Electra pipeline needs sysex, and a plain-midi grant
      // does NOT imply a sysex one — querying the weaker permission here would
      // let connect() fire an ungestured sysex prompt.
      permissionState: () => queryMidiPermission({ sysex: true }),
      connect: () => electraBroker.connect(),
      devicePresent: () => electraBroker.hasElectraDevice(),
      onStateChange: (fn) => electraBroker.onStateChange(fn),
      // First id-sorted electraControl — the same "first one wins" pick the
      // flash host uses (host.ts electraControlBindings), so the auto flash
      // can never target a different node than the preset generator reads.
      findElectraNodeId: () => listElectraControls(patch.nodes)[0]?.id ?? null,
      flash: (nodeId) => {
        electraSendToDevice(nodeId, undefined, { recordPress: false });
      },
    });
  }
  return live;
}

/** TEST SEAM: drop the singleton. Never called from app code. */
export function __resetElectraAutoReconnect(): void {
  live?.stop();
  live = null;
}
