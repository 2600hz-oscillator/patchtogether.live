// OriginPolicy.swift
//
// Origin-allowlist composition on top of WebSocketServer.defaultOriginPolicy
// (which allows: no Origin, loopback origins, patchtogether.live and its
// subdomains). Bridges pass user-supplied extras (--allow-origin) for e.g.
// *.pages.dev PR previews, which the default policy 403s by design.

import Foundation

extension WebSocketServer {
    /// The default policy, extended with exact extra hosts and/or
    /// ".suffix" wildcard entries (an extra of "*.pages.dev" or
    /// ".pages.dev" allows any subdomain of pages.dev).
    public static func policy(extraOrigins: [String]) -> (String?) -> Bool {
        let extras = extraOrigins.map { $0.lowercased() }
        return { origin in
            if defaultOriginPolicy(origin) { return true }
            guard let origin,
                  let host = URL(string: origin)?.host?.lowercased() else { return false }
            for extra in extras {
                if extra.hasPrefix("*.") {
                    if host.hasSuffix(String(extra.dropFirst(1))) { return true }
                } else if extra.hasPrefix(".") {
                    if host.hasSuffix(extra) { return true }
                } else if host == extra {
                    return true
                }
            }
            return false
        }
    }
}
