// VSTBridgeService.swift
//
// The VST bridge's non-real-time engine room: owns the WebSocket server,
// the per-connection plugin instances, and the render pump.
//
// SESSION MODEL (v0.2): every WebSocket connection is an independent
// plugin INSTANCE — its own mounted plugin, MIDI queue, meters, editor
// window. That's what lets one browser patch run an instrument card AND
// an effect card at once: each card opens its own socket. (The es9
// bridge's single-active-client/takeover policy existed because the ES-9
// hardware is exclusive; plugins aren't, so that policy does not apply
// here.) A `hello.clientId` gives an instance a stable identity: on
// disconnect the instance is PARKED for a grace period and a reconnect
// with the same clientId adopts it — a page refresh keeps the mounted
// plugin and its state. A hello whose clientId is owned by a live session
// evicts that session (crashed tab reclaimed instantly). Anonymous
// sessions (no clientId) are torn down on disconnect.
//
// Clock model — the big difference from the ES-9 bridge: there is NO
// hardware clock here. The client's audio blocks ARE the clock; each
// inbound 0x01 block synchronously renders that many frames through the
// instance's plugin at the client's hello rate and the result goes
// straight back with the SAME sampleTime. No rings, no resampler, no
// drift controller.
//
//   WS binary 0x01 ──conn queue──▶ renderQueue: midi take → AU render ──▶ WS binary 0x01
//   WS binary 0x02 ──conn queue──▶ renderQueue: MidiQueue.add
//
// Threading:
//   - `lock` guards the instance maps + each instance's session/rate/
//     parked fields.
//   - `renderQueue` (one serial queue for ALL instances) confines every
//     instance's host, midiQueue, outSeq, meter accumulators, and mount
//     generation. Plugins render back-to-back, never concurrently — fine
//     at v1 scale (a couple of cards); revisit if instances multiply.
//   - Editor windows live on the main thread (vst-bridge runs an
//     NSApplication loop; tests never touch the editor path).

import AppKit
import BridgeKit
import Foundation
import Synchronization

public final class VSTBridgeService: @unchecked Sendable {
    public struct Config {
        public var port: UInt16
        public var harnessHTML: Data
        /// Concurrent live instances (sockets with an accepted hello).
        public var maxInstances: Int
        /// How long a disconnected clientId instance stays parked (plugin
        /// mounted, state intact) awaiting reattach before teardown.
        public var reattachGrace: TimeInterval
        /// Extra allowed Origins beyond loopback + patchtogether.live
        /// (e.g. "*.pages.dev" for PR previews).
        public var extraOrigins: [String]
        public init(port: UInt16, harnessHTML: Data,
                    maxInstances: Int = 16,
                    reattachGrace: TimeInterval = 90,
                    extraOrigins: [String] = []) {
            self.port = port
            self.harnessHTML = harnessHTML
            self.maxInstances = maxInstances
            self.reattachGrace = reattachGrace
            self.extraOrigins = extraOrigins
        }
    }

    /// One card's plugin instance. Fields are confined as commented; the
    /// class itself is handed between queues.
    final class Instance {
        // Guarded by the service's `lock`:
        var session: WebSocketSession
        var clientId: String?
        var parked = false
        var clientRate: Double = 0

        // renderQueue-confined:
        var host: PluginHost?
        var midiQueue = MidiQueue()
        var outSeq: UInt16 = 0
        /// Bumped for every (un/re)mount; an instantiate completing for a
        /// stale generation is discarded.
        var mountGeneration = 0
        var renderErrors = 0
        var inSumSq: [Float] = [0, 0]
        var outSumSq: [Float] = [0, 0]
        var meterFrames = 0
        var busyNanos: UInt64 = 0

        // Cross-queue counters:
        let droppedBlocks = Atomic<Int>(0)
        let pendingBlocks = Atomic<Int>(0)

        // Main-thread only:
        var editor: EditorWindowManager?

        init(session: WebSocketSession) {
            self.session = session
        }
    }

    private let config: Config
    private let server: WebSocketServer

    /// The actual port after start() — differs from config.port only when
    /// that was 0 (tests).
    public var boundPort: UInt16 { server.boundPort }

    private let lock = NSLock()
    /// Live instances by their current session id.
    private var bySession: [Int: Instance] = [:]
    /// Instances with a stable identity — live or parked — by clientId.
    private var byClientId: [String: Instance] = [:]
    private var pluginCache: [PluginDescriptor]?

    /// One serial render queue shared by all instances.
    private let renderQueue = DispatchQueue(label: "vst.bridge.render",
                                            qos: .userInteractive)
    /// Per-instance backpressure cap: a slow plugin drops ITS blocks at
    /// the door instead of queueing unbounded latency (or starving others).
    private static let maxPendingBlocks = 64

    private var metersTimer: DispatchSourceTimer?

    public init(config: Config) {
        self.config = config
        self.server = WebSocketServer(
            port: config.port,
            pages: [.init(path: "/", contentType: "text/html; charset=utf-8",
                          body: config.harnessHTML)])
        server.allowOrigin = WebSocketServer.policy(extraOrigins: config.extraOrigins)
    }

    // MARK: - Lifecycle

    public func start() throws {
        server.onSession = { [weak self] session in
            self?.wire(session)
        }
        try server.start()

        // Warm the component registry off the startup path.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = self?.plugins()
        }

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.125, repeating: 0.125)
        timer.setEventHandler { [weak self] in self?.metersTick() }
        timer.resume()
        metersTimer = timer
    }

    public func stop() {
        metersTimer?.cancel()
        metersTimer = nil
        server.stop()
        let all: [Instance] = lockThen {
            var seen = Set<ObjectIdentifier>()
            var out: [Instance] = []
            for instance in bySession.values where seen.insert(ObjectIdentifier(instance)).inserted {
                out.append(instance)
            }
            for instance in byClientId.values where seen.insert(ObjectIdentifier(instance)).inserted {
                out.append(instance)
            }
            bySession.removeAll()
            byClientId.removeAll()
            return out
        }
        renderQueue.sync {
            for instance in all {
                let host = instance.host
                instance.host = nil
                retire(host)
            }
        }
    }

    /// Zombies: v2 instances that were unmounted but must NEVER be freed.
    /// Three crash reports (2026-08-19, Arturia Acid V / CZ V) share one
    /// backtrace: __CFRunLoopDoSource0 → plugin code, after dispose — the
    /// plugin's framework registers main-run-loop sources that outlive
    /// AudioComponentInstanceDispose, so freeing the instance turns the
    /// next source fire into a use-after-free. Hosts survive this by
    /// child-process isolation (our roadmap) or by never disposing
    /// in-process v2 instances; until the child-process host exists we do
    /// the latter. Cost: one silenced, render-resource-free plugin object
    /// leaks per unmount — acceptable for a local helper session.
    /// Lifecycle-queue confined.
    private static var graveyard: [PluginHost] = []

    /// Retire a host SAFELY, on the lifecycle thread: silence it, free its
    /// render resources — and for v2, park the object forever (see
    /// `graveyard`). v3 instances live out-of-process and free normally.
    /// Call only after the render queue no longer references the host.
    private func retire(_ host: PluginHost?) {
        guard let host else { return }
        PluginLifecycle.queue.async {
            host.allNotesOff()
            host.teardown()
            if !host.descriptor.isV3 {
                Self.graveyard.append(host)
            }
        }
    }

    // MARK: - Plugin registry cache

    private func plugins(rescan: Bool = false) -> [PluginDescriptor] {
        lock.lock()
        if !rescan, let cached = pluginCache {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let scanned = PluginRegistry.scan()   // slow-ish first time; NOT under the lock
        lock.lock()
        pluginCache = scanned
        lock.unlock()
        return scanned
    }

    private func lockThen<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    private func instance(for session: WebSocketSession) -> Instance? {
        lockThen { bySession[session.id] }
    }

    // MARK: - Session wiring

    private func wire(_ session: WebSocketSession) {
        session.onText = { [weak self] s, text in self?.handleText(s, text) }
        session.onBinary = { [weak self] s, data in self?.handleBinary(s, data) }
        session.onClose = { [weak self] s in self?.detach(s) }
    }

    /// hello is where a socket becomes (or re-adopts) an instance.
    private func handleHello(_ session: WebSocketSession, _ hello: HelloMessage) {
        guard hello.rate > 8000, hello.rate <= 384000 else { return }
        var evicted: WebSocketSession?
        var instance: Instance?
        var atCapacity = false
        lock.lock()
        if let existing = bySession[session.id] {
            // Re-hello on the same socket: just a rate update.
            existing.clientRate = hello.rate
            instance = existing
        } else if let clientId = hello.clientId, let owner = byClientId[clientId] {
            // Reattach (parked) or reclaim (a live session — usually a
            // crashed tab whose socket hasn't closed yet — gets evicted).
            if !owner.parked {
                evicted = owner.session
                bySession.removeValue(forKey: owner.session.id)
            }
            owner.parked = false
            owner.session = session
            owner.clientRate = hello.rate
            bySession[session.id] = owner
            instance = owner
        } else if bySession.count >= config.maxInstances {
            atCapacity = true
        } else {
            let created = Instance(session: session)
            created.clientId = hello.clientId
            created.clientRate = hello.rate
            bySession[session.id] = created
            if let clientId = hello.clientId { byClientId[clientId] = created }
            instance = created
        }
        lock.unlock()

        if atCapacity {
            session.sendText(encodeControlJSON(StatusMessage(
                state: "busy",
                detail: "instance limit reached (\(config.maxInstances))")))
            session.close()
            return
        }
        if let evicted {
            evicted.sendText(encodeControlJSON(StatusMessage(
                state: "stopped", detail: "this instance reconnected elsewhere")))
            evicted.close()
        }
        guard let instance else { return }

        session.sendText(encodeControlJSON(HelperInfoMessage(rate: hello.rate)))
        session.sendText(encodeControlJSON(PluginListMessage(plugins: plugins().map(\.info))))
        // Re-sync a mounted plugin; remount if the rate changed.
        renderQueue.async { [weak self] in
            guard let self, let mounted = instance.host else { return }
            if mounted.rate == hello.rate {
                session.sendText(encodeControlJSON(mounted.mountedMessage))
            } else {
                self.remount(instance, mounted, rate: hello.rate, for: session)
            }
        }
    }

    private func detach(_ session: WebSocketSession) {
        var toTeardown: Instance?
        var toPark: Instance?
        lock.lock()
        if let instance = bySession[session.id], instance.session === session {
            bySession.removeValue(forKey: session.id)
            if instance.clientId != nil {
                instance.parked = true
                toPark = instance
            } else {
                toTeardown = instance
            }
        }
        lock.unlock()

        if let toPark {
            // Parked: keep the plugin + state for reattach, but nothing may
            // keep sounding, and stale MIDI must not fire on reattach.
            renderQueue.async {
                toPark.midiQueue.removeAll()
                toPark.host?.allNotesOff()
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + config.reattachGrace) { [weak self] in
                guard let self else { return }
                let expired: Instance? = self.lockThen {
                    guard let clientId = toPark.clientId, toPark.parked,
                          self.byClientId[clientId] === toPark else { return nil }
                    self.byClientId.removeValue(forKey: clientId)
                    return toPark
                }
                if let expired { self.teardown(expired) }
            }
        }
        if let toTeardown { teardown(toTeardown) }
    }

    private func teardown(_ instance: Instance) {
        closeEditorOnMain(instance, notify: nil)
        renderQueue.async { [weak self] in
            instance.mountGeneration += 1
            let host = instance.host
            instance.host = nil
            instance.midiQueue.removeAll()
            self?.retire(host)
        }
    }

    // MARK: - Control plane

    private func handleText(_ session: WebSocketSession, _ text: String) {
        guard let data = text.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ControlEnvelope.self, from: data)
        else { return }

        if envelope.type == "hello" {
            guard let hello = try? JSONDecoder().decode(HelloMessage.self, from: data) else { return }
            handleHello(session, hello)
            return
        }
        if envelope.type == "ping" {
            if let ping = try? JSONDecoder().decode(PingMessage.self, from: data) {
                session.sendText(encodeControlJSON(PongMessage(t: ping.t)))
            }
            return
        }

        // Everything below needs an instance (i.e. a completed hello).
        guard let instance = instance(for: session) else { return }
        switch envelope.type {
        case "mount":
            guard let mount = try? JSONDecoder().decode(MountMessage.self, from: data) else { return }
            let rate = lockThen { instance.clientRate }
            guard let descriptor = PluginRegistry.find(id: mount.pluginId, in: plugins()) else {
                session.sendText(encodeControlJSON(MountErrorMessage(
                    pluginId: mount.pluginId, message: "unknown plugin id")))
                return
            }
            renderQueue.async { [weak self] in
                self?.beginMount(instance, descriptor, rate: rate,
                                 restoringState: nil, for: session)
            }

        case "unmount":
            closeEditorOnMain(instance, notify: nil)
            renderQueue.async { [weak self] in
                instance.mountGeneration += 1
                let host = instance.host
                instance.host = nil
                instance.midiQueue.removeAll()
                self?.retire(host)
                session.sendText(encodeControlJSON(UnmountedMessage()))
            }

        case "openEditor":
            renderQueue.async { [weak self] in
                guard let self else { return }
                guard let host = instance.host else {
                    session.sendText(encodeControlJSON(EditorMessage(open: false)))
                    return
                }
                DispatchQueue.main.async {
                    let manager = self.editorOnMain(instance)
                    manager.open(host: host) { custom in
                        session.sendText(encodeControlJSON(EditorMessage(open: true, custom: custom)))
                    }
                }
            }

        case "closeEditor":
            closeEditorOnMain(instance, notify: session)

        case "getState":
            renderQueue.async {
                if let host = instance.host, let state = host.stateBase64() {
                    session.sendText(encodeControlJSON(StateMessage(
                        pluginId: host.descriptor.info.id, data: state)))
                } else {
                    session.sendText(encodeControlJSON(StateMessage(pluginId: "", data: "")))
                }
            }

        case "setState":
            guard let msg = try? JSONDecoder().decode(SetStateMessage.self, from: data) else { return }
            renderQueue.async {
                guard let host = instance.host else {
                    session.sendText(encodeControlJSON(StateSetMessage(
                        ok: false, detail: "no plugin mounted")))
                    return
                }
                let ok = host.setState(base64: msg.data)
                session.sendText(encodeControlJSON(StateSetMessage(
                    ok: ok, detail: ok ? nil : "state rejected (not for this plugin?)")))
            }

        case "rescanPlugins":
            session.sendText(encodeControlJSON(
                PluginListMessage(plugins: plugins(rescan: true).map(\.info))))

        default:
            break
        }
    }

    // MARK: - Mounting (render queue)

    /// Render-queue only. Starts an instantiate; the completion hops back
    /// to the render queue and installs the host unless superseded.
    private func beginMount(_ instance: Instance, _ descriptor: PluginDescriptor,
                            rate: Double, restoringState: String?,
                            for session: WebSocketSession) {
        guard rate > 0 else {
            session.sendText(encodeControlJSON(MountErrorMessage(
                pluginId: descriptor.info.id, message: "send hello before mount")))
            return
        }
        instance.mountGeneration += 1
        let generation = instance.mountGeneration
        PluginHost.mount(descriptor: descriptor, rate: rate) { [weak self] result in
            guard let self else { return }
            self.renderQueue.async {
                guard generation == instance.mountGeneration else {
                    if case .success(let orphan) = result { self.retire(orphan) }
                    return
                }
                switch result {
                case .success(let newHost):
                    let replaced = instance.host
                    instance.host = newHost
                    instance.midiQueue.removeAll()
                    instance.renderErrors = 0
                    if replaced != nil { self.closeEditorOnMain(instance, notify: nil) }
                    self.retire(replaced)
                    if let restoringState { _ = newHost.setState(base64: restoringState) }
                    session.sendText(encodeControlJSON(newHost.mountedMessage))
                case .failure(let error):
                    session.sendText(encodeControlJSON(MountErrorMessage(
                        pluginId: descriptor.info.id, message: "\(error)")))
                }
            }
        }
    }

    /// Render-queue only. The client reconnected at a different sample
    /// rate: remount the same plugin at the new rate, carrying state across.
    private func remount(_ instance: Instance, _ mounted: PluginHost, rate: Double,
                         for session: WebSocketSession) {
        let state = mounted.stateBase64()
        let descriptor = mounted.descriptor
        instance.mountGeneration += 1
        instance.host = nil
        closeEditorOnMain(instance, notify: nil)
        retire(mounted)
        beginMount(instance, descriptor, rate: rate, restoringState: state, for: session)
    }

    // MARK: - Editor helpers

    private func editorOnMain(_ instance: Instance) -> EditorWindowManager {
        dispatchPrecondition(condition: .onQueue(.main))
        return MainActor.assumeIsolated {
            if let editor = instance.editor { return editor }
            let manager = EditorWindowManager()
            manager.onUserClose = { [weak self, weak instance] in
                guard let self, let instance else { return }
                let target = self.lockThen { instance.parked ? nil : instance.session }
                target?.sendText(encodeControlJSON(EditorMessage(open: false)))
            }
            instance.editor = manager
            return manager
        }
    }

    private func closeEditorOnMain(_ instance: Instance, notify session: WebSocketSession?) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if let manager = instance.editor {
                    let userClose = manager.onUserClose
                    manager.onUserClose = nil          // deliberate close, not the user's
                    manager.close()
                    manager.onUserClose = userClose
                }
                session?.sendText(encodeControlJSON(EditorMessage(open: false)))
            }
        }
    }

    // MARK: - Data plane (audio + MIDI blocks)

    private func handleBinary(_ session: WebSocketSession, _ data: Data) {
        guard let instance = instance(for: session), let first = data.first else { return }
        switch first {
        case BridgeWire.audioFrameType:
            guard let block = try? BridgeWire.decode(data) else {
                instance.droppedBlocks.wrappingAdd(1, ordering: .relaxed)
                return
            }
            guard instance.pendingBlocks.load(ordering: .relaxed) < Self.maxPendingBlocks else {
                instance.droppedBlocks.wrappingAdd(1, ordering: .relaxed)
                return
            }
            instance.pendingBlocks.wrappingAdd(1, ordering: .relaxed)
            renderQueue.async { [weak self] in
                self?.renderAndReply(instance, session, block)
                instance.pendingBlocks.wrappingSubtract(1, ordering: .relaxed)
            }
        case MidiWire.frameType:
            guard let (_, events) = try? MidiWire.decode(data) else { return }
            renderQueue.async {
                instance.midiQueue.add(events)
            }
        default:
            break
        }
    }

    /// Render-queue only: the pull-through render of one client block.
    private func renderAndReply(_ instance: Instance, _ session: WebSocketSession,
                                _ block: AudioBlock) {
        let frames = block.frameCount   // decode already caps at maxFrameCount
        let inL = padded(block.plane(channel: 0), frames)
        let inR = block.plane(channel: 1).map { padded($0, frames) } ?? inL

        var outPlanes: [[Float]]
        let start = DispatchTime.now().uptimeNanoseconds
        if let host = instance.host {
            let events = instance.midiQueue.take(before: block.sampleTime &+ UInt64(frames))
            let midi = events.map { ev in
                PluginHost.ScheduledMidi(
                    offsetFrames: ev.sampleTime > block.sampleTime
                        ? Int(ev.sampleTime - block.sampleTime) : 0,
                    bytes: ev.bytes)
            }
            switch host.render(inputPlanes: [inL, inR], frames: frames,
                               sampleTime: block.sampleTime, midi: midi) {
            case .success(let rendered):
                outPlanes = rendered
            case .failure:
                instance.renderErrors += 1
                let silence = [Float](repeating: 0, count: frames)
                outPlanes = [silence, silence]
            }
        } else {
            // No plugin mounted: bit-transparent bypass. Keeps the path
            // provable (and latency measurable) before anything is mounted.
            outPlanes = [inL, inR]
        }
        instance.busyNanos &+= DispatchTime.now().uptimeNanoseconds &- start

        accumulate(&instance.inSumSq[0], inL, frames)
        accumulate(&instance.inSumSq[1], inR, frames)
        accumulate(&instance.outSumSq[0], outPlanes[0], frames)
        accumulate(&instance.outSumSq[1], outPlanes[1], frames)
        instance.meterFrames += frames

        instance.outSeq &+= 1
        let reply = AudioBlock(seq: instance.outSeq, sampleTime: block.sampleTime,
                               channelMask: 0b11, frameCount: frames,
                               planes: outPlanes)
        session.sendBinary(BridgeWire.encode(reply))
    }

    private func padded(_ plane: [Float]?, _ frames: Int) -> [Float] {
        guard var p = plane else { return [Float](repeating: 0, count: frames) }
        if p.count < frames { p.append(contentsOf: repeatElement(0, count: frames - p.count)) }
        return p
    }

    private func accumulate(_ sumSq: inout Float, _ plane: [Float], _ frames: Int) {
        var acc: Float = 0
        for i in 0..<min(frames, plane.count) { acc += plane[i] * plane[i] }
        sumSq += acc
    }

    // MARK: - Meters (~8 Hz, per instance)

    private func metersTick() {
        let live: [(Instance, WebSocketSession, Double)] = lockThen {
            bySession.values.map { ($0, $0.session, $0.clientRate) }
        }
        guard !live.isEmpty else { return }
        renderQueue.async {
            for (instance, session, rate) in live {
                func dBFS(_ sumSq: Float, _ frames: Int) -> Float {
                    guard frames > 0, sumSq > 0 else { return -120 }
                    return max(-120, 10 * log10(sumSq / Float(frames)))
                }
                let frames = instance.meterFrames
                let loadPct: Float = (frames > 0 && rate > 0)
                    ? Float(Double(instance.busyNanos) / (Double(frames) / rate * 1e9) * 100)
                    : 0
                let message = VSTMetersMessage(
                    inputRMS: [dBFS(instance.inSumSq[0], frames), dBFS(instance.inSumSq[1], frames)],
                    outputRMS: [dBFS(instance.outSumSq[0], frames), dBFS(instance.outSumSq[1], frames)],
                    renderErrors: instance.renderErrors,
                    droppedBlocks: instance.droppedBlocks.load(ordering: .relaxed),
                    midiQueued: instance.midiQueue.count,
                    loadPct: loadPct)
                instance.inSumSq = [0, 0]
                instance.outSumSq = [0, 0]
                instance.meterFrames = 0
                instance.busyNanos = 0
                session.sendText(encodeControlJSON(message))
            }
        }
    }
}
