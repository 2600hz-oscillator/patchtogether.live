// packages/web/src/lib/audio/es9/bridge-state.ts
//
// The ONE pure decision the transport worker makes at socket close: what
// connection state the card should show. Extracted from bridge.worker.ts so
// the unit lane can pin it — the worker itself is a module worker with
// top-level side effects and can't be imported under jsdom.
//
// WHY THIS EXISTS (measured against the real native app, 2026-08-05): when a
// SECOND client connects while another holds the bridge, the app sends
// `{"type":"status","state":"busy","detail":"another client is connected"}`
// and then IMMEDIATELY closes the socket (code 1000, holder kept). The worker
// forwarded the truthful 'busy' — and one event later its `onclose` posted
// 'disconnected', overwriting it. The card renders 'disconnected' through its
// default label, so the user read "bridge not found" while the bridge was
// right there, healthy, and simply owned by another tab. With the ES-9 card
// now always mounted in its lane (auto-connect on rack load), multi-tab
// contention is the NORMAL case, which is how this mislabel was found.
//
// The rule: a close that FOLLOWS a bridge-side 'busy' status keeps saying
// 'busy' — the close is part of the app's reject-new handshake, not a lost
// bridge. Every other close stays exactly what it was before: 'disconnected'
// while the client wants the connection (the worker keeps retrying), or
// 'stopped' when the client itself is shutting down. `lastControlState` is
// the bridge's most recent status-message state for THIS socket; the worker
// clears it on `deviceInfo` (a genuine acceptance), so a real disconnect
// after a working session still reads 'disconnected'.

export function closeStateAfter(
  lastControlState: string | null,
  enabled: boolean,
): 'busy' | 'disconnected' | 'stopped' {
  if (!enabled) return 'stopped';
  return lastControlState === 'busy' ? 'busy' : 'disconnected';
}
