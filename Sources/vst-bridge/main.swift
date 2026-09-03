// vst-bridge — the patchtogether <-> plugin-host bridge app.
//
// Hosts the user's installed Audio Unit plugins (the AU builds of their
// "VSTs") and bridges them to a browser over localhost:
//   http://127.0.0.1:PORT/   — embedded browser test harness (plugin list,
//                              mount/unmount, generators, meters, a MIDI
//                              keyboard; emulates the future patchtogether
//                              VST BRIDGE card)
//   ws://127.0.0.1:PORT/ws   — the bridge protocol (JSON control + binary
//                              audio/MIDI blocks; spec in
//                              Sources/VSTBridgeCore/VSTProtocol.swift)
//
// Client-clocked: the browser's audio blocks pull the plugin render at the
// browser's sample rate — no audio hardware is opened, no mic permission
// needed, no resampling anywhere. Plugin editors open as native macOS
// windows (this process runs an NSApplication loop for exactly that).
//
// Usage:
//   vst-bridge [--port N] [--allow-origin HOST]... [--dock] [--list]
//
//   --port N              HTTP/WS port (default 9309)
//   --allow-origin HOST   allow an extra browser Origin host (repeatable;
//                         "*.pages.dev" allows a suffix). Loopback and
//                         patchtogether.live are always allowed.
//   --dock                show a Dock icon (default: accessory app — editor
//                         windows still appear and focus)
//   --list                list installed plugins and exit

import AppKit
import BridgeKit
import Darwin
import Foundation
import VSTBridgeCore

var args = Array(CommandLine.arguments.dropFirst())
func popValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...i+1); return v
}
func popValues(_ flag: String) -> [String] {
    var out: [String] = []
    while let v = popValue(flag) { out.append(v) }
    return out
}
func popFlag(_ flag: String) -> Bool {
    guard let i = args.firstIndex(of: flag) else { return false }
    args.remove(at: i); return true
}

if popFlag("--help") || popFlag("-h") {
    print("""
    vst-bridge — patchtogether <-> plugin-host bridge (localhost WebSocket).
      --port N              HTTP/WS port (default \(VSTBridgeInfo.defaultPort))
      --allow-origin HOST   allow an extra browser Origin host (repeatable)
      --dock                show a Dock icon
      --list                list installed plugins and exit
    """)
    exit(0)
}

let port = UInt16(popValue("--port") ?? "\(VSTBridgeInfo.defaultPort)") ?? VSTBridgeInfo.defaultPort
let extraOrigins = popValues("--allow-origin")
let showDock = popFlag("--dock")

if popFlag("--list") {
    let plugins = PluginRegistry.scan()
    for p in plugins {
        print("\(p.info.id)  [\(p.info.kind.rawValue)\(p.isV3 ? ", v3" : "")]  \(p.info.name)  (\(p.info.manufacturer) \(p.info.version))")
    }
    print("\(plugins.count) plugins")
    exit(0)
}

let service = VSTBridgeService(config: .init(
    port: port,
    harnessHTML: Data(PackageResources.harness_html),
    extraOrigins: extraOrigins))

/// Best-effort "who has the port?" for the EADDRINUSE message (same
/// diagnostic the es9 bridge grew after stray instances bit in the field).
func portHolder(_ port: UInt16) -> (pid: String, command: String)? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    p.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let out = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    var pid: String?
    var cmd: String?
    for line in String(decoding: out, as: UTF8.self).split(separator: "\n") {
        if line.hasPrefix("p"), pid == nil { pid = String(line.dropFirst()) }
        if line.hasPrefix("c"), cmd == nil { cmd = String(line.dropFirst()) }
    }
    return pid.map { ($0, cmd ?? "unknown") }
}

do {
    try service.start()
} catch WebSocketServer.ServerError.portInUse(let busy) {
    let holder = portHolder(busy)
    var msg = "Port \(busy) is already in use"
    if let h = holder { msg += " by PID \(h.pid) (\(h.command))" }
    msg += ".\n"
    if let h = holder, h.command.contains("vst-bridge") {
        msg += "That's another vst-bridge. Stop it with:  kill \(h.pid)\n"
    }
    msg += "Or use a different port:  vst-bridge --port \(busy == UInt16.max ? busy - 1 : busy + 1)\n"
    FileHandle.standardError.write(Data(msg.utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("failed to start bridge: \(error)\n".utf8))
    exit(1)
}

print("""

    VST bridge running:
      harness : http://127.0.0.1:\(service.boundPort)/
      protocol: ws://127.0.0.1:\(service.boundPort)/ws
    Open the harness in Chrome, press "start audio", and mount a plugin.
    Plugin editors open as native windows on this Mac. Ctrl-C to stop.
    """)

// AppKit run loop on the main thread — required for plugin editor windows.
// Accessory policy: no Dock icon/menu bar, but windows still open and
// focus (the service activates the app when it raises an editor).
signal(SIGINT, SIG_IGN)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler {
    print("\nstopping…")
    service.stop()
    exit(0)
}
sigintSource.resume()

let app = NSApplication.shared
app.setActivationPolicy(showDock ? .regular : .accessory)
app.run()
