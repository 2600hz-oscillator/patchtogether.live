// PairRouting.swift
//
// The Bitwig-style addressing model: the 16x16 ES-9 is exposed not as one
// stereo device but as N individually-addressable STEREO PAIRS — input pairs
// 1/2, 3/4, ... 15/16 and output pairs 1/2, ... 15/16. In the native engine
// each pair becomes its own "ES-9 IN" / "ES-9 OUT" module (mirroring the
// web app's AUDIO IN / AUDIO OUT cards, which can only ever reach the FIRST
// pair via getUserMedia/setSinkId — see ../inet.modular plan).
//
// This file is the PURE, hardware-free core of that model so it can be unit
// tested. The duplex IOProc consumes a `RoutingPlan` to copy interleaved-by-
// channel input buffers to output buffers.

import Foundation

/// A zero-based stereo pair index. Pair 0 = channels 0,1 (UI "1/2").
public struct StereoPair: Equatable, CustomStringConvertible {
    public let index: Int
    public init(_ index: Int) { self.index = index }
    /// Zero-based left channel.
    public var leftChannel: Int { index * 2 }
    /// Zero-based right channel.
    public var rightChannel: Int { index * 2 + 1 }
    /// 1-based UI label, e.g. "1/2", "3/4".
    public var label: String { "\(leftChannel + 1)/\(rightChannel + 1)" }
    public var description: String { label }
}

/// One passthrough route: read input pair -> write output pair.
public struct PairRoute: Equatable {
    public let input: StereoPair
    public let output: StereoPair
    public init(input: StereoPair, output: StereoPair) {
        self.input = input
        self.output = output
    }
    public init(inputPair: Int, outputPair: Int) {
        self.init(input: StereoPair(inputPair), output: StereoPair(outputPair))
    }
}

/// A validated set of pair routes against a device's actual channel counts.
public struct RoutingPlan {
    public let routes: [PairRoute]
    public let inputChannels: Int
    public let outputChannels: Int

    public init(routes: [PairRoute], inputChannels: Int, outputChannels: Int) {
        self.routes = routes
        self.inputChannels = inputChannels
        self.outputChannels = outputChannels
    }

    public var inputPairCount: Int { inputChannels / 2 }
    public var outputPairCount: Int { outputChannels / 2 }

    /// Validate every route fits inside the device's channel counts.
    public func validate() -> [String] {
        var errors: [String] = []
        for r in routes {
            if r.input.rightChannel >= inputChannels {
                errors.append("input pair \(r.input.label) exceeds \(inputChannels) input channels")
            }
            if r.output.rightChannel >= outputChannels {
                errors.append("output pair \(r.output.label) exceeds \(outputChannels) output channels")
            }
        }
        return errors
    }

    /// Default MVP plan: straight-through passthrough of every input pair to
    /// the same-numbered output pair (1/2->1/2, 3/4->3/4, ...), limited by
    /// whichever direction has fewer pairs.
    public static func straightThrough(inputChannels: Int, outputChannels: Int) -> RoutingPlan {
        let pairs = min(inputChannels, outputChannels) / 2
        let routes = (0..<pairs).map { PairRoute(inputPair: $0, outputPair: $0) }
        return RoutingPlan(routes: routes, inputChannels: inputChannels, outputChannels: outputChannels)
    }
}

/// Error carrying a human-readable parse message.
public struct RouteParseError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Parse a routing spec string like "1:1,2:5,3:3" where each token is
/// inputPair:outputPair using 1-BASED pair numbers (matching the UI labels).
/// Returns the parsed routes (0-based internally) or an error message.
public func parsePairRoutes(_ spec: String) -> Result<[PairRoute], RouteParseError> {
    var routes: [PairRoute] = []
    let tokens = spec.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    for tok in tokens where !tok.isEmpty {
        let parts = tok.split(separator: ":")
        guard parts.count == 2,
              let inP = Int(parts[0]), let outP = Int(parts[1]),
              inP >= 1, outP >= 1 else {
            return .failure(RouteParseError("bad route token '\(tok)' (expected inputPair:outputPair, 1-based)"))
        }
        routes.append(PairRoute(inputPair: inP - 1, outputPair: outP - 1))
    }
    if routes.isEmpty { return .failure(RouteParseError("no routes parsed from '\(spec)'")) }
    return .success(routes)
}

/// Linear-amplitude RMS -> dBFS. -inf clamped to -120.
public func rmsToDBFS(_ rms: Float) -> Float {
    guard rms > 0 else { return -120 }
    return max(-120, 20 * log10f(rms))
}
