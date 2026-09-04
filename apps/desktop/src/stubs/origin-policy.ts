// Mirror of BridgeKit's WebSocketServer.defaultOriginPolicy
// (apps/helpers/nativeapps/Sources/BridgeKit/WebSocketServer.swift) — the
// stubs must reject exactly what the real helpers reject, so the harness's
// origin-allowlist leg proves the same contract on every tier.
//
// Allow: no Origin (non-browser local process), loopback origins on any
// port, and patchtogether.live + its subdomains. Everything else: 403.

export function defaultOriginAllowed(origin: string | undefined): boolean {
  if (!origin || origin.length === 0) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  return host === 'patchtogether.live' || host.endsWith('.patchtogether.live');
}
