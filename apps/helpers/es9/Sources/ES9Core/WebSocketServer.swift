// WebSocketServer.swift
//
// A tiny localhost HTTP + WebSocket server on Network.framework (system-only,
// no dependencies). Two jobs:
//   1. GET /            -> serve an embedded static page (the test harness).
//   2. GET /ws + Upgrade -> RFC 6455 WebSocket session (the bridge protocol).
//
// Binds 127.0.0.1 ONLY — the bridge is a local companion, never a network
// service. Browsers treat ws://127.0.0.1 as a potentially-trustworthy origin,
// so an HTTPS-served patchtogether page may open it without mixed-content
// issues (Chromium; which the web app already requires for device features).
//
// SECURITY: loopback-only is not enough — any web page in any tab can open
// ws://127.0.0.1:<port>. A hostile page must not be able to listen to the
// rack or drive CV into it, so WebSocket upgrades are gated by an ORIGIN
// allowlist (browsers always send Origin on WS handshakes; requests with no
// Origin header come from non-browser local processes, which are outside
// this threat model and allowed).
//
// Threading: each NWConnection gets its own serial DispatchQueue. Callbacks
// (onText/onBinary/onConnect/onDisconnect) fire on that queue. Sends may be
// called from any thread; NWConnection serializes internally.

import Foundation
import Network
import Synchronization

public final class WebSocketSession: @unchecked Sendable {
    public let id: Int
    fileprivate let connection: NWConnection
    fileprivate let decoder = WSDecoder()
    fileprivate var upgraded = false          // connection-queue only
    fileprivate var pending = Data()          // connection-queue only

    // Read from any thread (send guards), written via markClosed().
    private let closedFlag = Atomic<Bool>(false)
    fileprivate var closed: Bool { closedFlag.load(ordering: .acquiring) }
    /// Returns true if this call performed the open -> closed transition.
    fileprivate func markClosed() -> Bool {
        !closedFlag.exchange(true, ordering: .acquiringAndReleasing)
    }

    public var onText: ((WebSocketSession, String) -> Void)?
    public var onBinary: ((WebSocketSession, Data) -> Void)?
    public var onClose: ((WebSocketSession) -> Void)?

    fileprivate init(id: Int, connection: NWConnection) {
        self.id = id
        self.connection = connection
    }

    public func sendText(_ string: String) {
        send(opcode: .text, payload: Data(string.utf8))
    }

    public func sendBinary(_ data: Data) {
        send(opcode: .binary, payload: data)
    }

    public func close() {
        guard markClosed() else { return }
        connection.send(content: WebSocketCodec.closeFrame(),
                        completion: .contentProcessed { [connection] _ in
            connection.cancel()
        })
    }

    fileprivate func send(opcode: WSOpcode, payload: Data) {
        guard upgraded, !closed else { return }
        let frame = WebSocketCodec.encodeFrame(opcode: opcode, payload: payload)
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }
}

public final class WebSocketServer: @unchecked Sendable {
    public struct StaticPage {
        public let path: String
        public let contentType: String
        public let body: Data
        public init(path: String, contentType: String, body: Data) {
            self.path = path
            self.contentType = contentType
            self.body = body
        }
    }

    private var listener: NWListener?
    public let port: UInt16
    private let pages: [String: StaticPage]
    private var nextSessionID = 1
    private let stateQueue = DispatchQueue(label: "es9.ws.server")
    /// Strong refs — connection handlers capture sessions weakly, so the
    /// server must own them until close (dropping this was a real bug: the
    /// session deallocated right after accept and reads never re-armed).
    private var sessions: [Int: WebSocketSession] = [:]

    /// Called (on the connection's queue) when a client completes the
    /// WebSocket upgrade. Wire the session's onText/onBinary/onClose here.
    public var onSession: ((WebSocketSession) -> Void)?

    /// Origin gate for WebSocket upgrades. Receives the Origin header value
    /// (nil when absent). Defaults to `defaultOriginPolicy`.
    public var allowOrigin: (String?) -> Bool = WebSocketServer.defaultOriginPolicy

    /// Allow: no Origin (non-browser local process), loopback origins (the
    /// embedded harness, local dev servers on any port), and patchtogether
    /// production/tier origins.
    public static func defaultOriginPolicy(_ origin: String?) -> Bool {
        guard let origin, !origin.isEmpty else { return true }
        guard let host = URL(string: origin)?.host?.lowercased() else { return false }
        if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1" {
            return true
        }
        return host == "patchtogether.live" || host.hasSuffix(".patchtogether.live")
    }

    public init(port: UInt16, pages: [StaticPage] = []) {
        self.port = port
        self.pages = Dictionary(uniqueKeysWithValues: pages.map { ($0.path, $0) })
    }

    public enum ServerError: Error, CustomStringConvertible {
        case bindFailed(String)
        /// EADDRINUSE, called out separately: it's the one bind failure with an
        /// obvious user remedy (kill the squatter, or pick another --port), so
        /// callers can print a fix instead of an errno.
        case portInUse(UInt16)
        public var description: String {
            switch self {
            case .bindFailed(let why): return "listen failed: \(why)"
            case .portInUse(let p):    return "port \(p) already in use"
            }
        }
    }

    public func start() throws {
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true      // audio blocks must not sit in Nagle
        }
        // Loopback only.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        // Surface bind failures synchronously: wait for .ready / .failed.
        // A busy port shows up as .waiting(EADDRINUSE) rather than .failed —
        // NWListener would sit there retrying forever — so treat both as fatal
        // and keep the NWError itself so we can classify it.
        final class Box { var error: NWError?; var cancelled = false }
        let box = Box()
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let error), .waiting(let error):
                box.error = error
                ready.signal()
            case .cancelled:
                box.cancelled = true
                ready.signal()
            default:
                break
            }
        }
        listener.start(queue: stateQueue)
        if ready.wait(timeout: .now() + 3) == .timedOut {
            listener.cancel()
            throw ServerError.bindFailed("timed out waiting for listener readiness")
        }
        if let error = box.error {
            listener.cancel()
            if case .posix(.EADDRINUSE) = error { throw ServerError.portInUse(port) }
            throw ServerError.bindFailed("\(error)")
        }
        if box.cancelled {
            listener.cancel()
            throw ServerError.bindFailed("cancelled")
        }
        listener.stateUpdateHandler = nil
        self.listener = listener
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    /// Hard cap on live connections — half-open sockets otherwise pin a
    /// session + queue + decoder each, forever (loopback-only, but any web
    /// page can open sockets at us).
    private static let maxSessions = 32

    private func accept(_ conn: NWConnection) {
        // Runs on stateQueue (the listener's queue).
        guard sessions.count < Self.maxSessions else {
            conn.cancel()
            return
        }
        let id = nextSessionID
        nextSessionID += 1
        let session = WebSocketSession(id: id, connection: conn)
        sessions[id] = session
        let queue = DispatchQueue(label: "es9.ws.conn.\(id)")
        conn.stateUpdateHandler = { [weak self, weak session] state in
            switch state {
            case .failed, .cancelled:
                guard let s = session else { break }
                self?.finish(s)
            default:
                break
            }
        }
        conn.start(queue: queue)
        receiveLoop(session)
    }

    /// Idempotent close path: fire onClose exactly once per tracked session
    /// (keyed on dict removal, which happens exactly once), drop the ref.
    private func finish(_ session: WebSocketSession) {
        var fire = false
        stateQueue.sync {
            if sessions.removeValue(forKey: session.id) != nil { fire = true }
        }
        if fire {
            _ = session.markClosed()
            session.onClose?(session)
        }
    }

    private func receiveLoop(_ session: WebSocketSession) {
        session.connection.receive(minimumIncompleteLength: 1,
                                   maximumLength: 256 * 1024) { [weak self, weak session] data, _, complete, error in
            guard let self, let session else { return }
            if let data, !data.isEmpty {
                self.handleBytes(session, data)
            }
            if complete || error != nil {
                self.finish(session)
                session.connection.cancel()
                return
            }
            if !session.closed {
                self.receiveLoop(session)
            }
        }
    }

    private func handleBytes(_ session: WebSocketSession, _ data: Data) {
        if session.upgraded {
            handleWSBytes(session, data)
            return
        }
        session.pending.append(data)
        guard let (head, consumed) = HTTPParser.parseRequestHead(session.pending) else {
            if session.pending.count > 64 * 1024 { session.connection.cancel() }
            return  // wait for the rest of the head
        }
        // Keep any bytes past the head — a client may pipeline its first WS
        // frame into the same segment as the handshake.
        let remainder = session.pending.count > consumed
            ? session.pending.suffix(from: session.pending.startIndex + consumed) : Data()
        session.pending = Data()

        if head.isWebSocketUpgrade, let key = head.headers["sec-websocket-key"] {
            guard allowOrigin(head.headers["origin"]) else {
                let deny = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                session.connection.send(content: Data(deny.utf8),
                                        completion: .contentProcessed { [weak session] _ in
                    session?.connection.cancel()
                })
                return
            }
            let response = WebSocketCodec.handshakeResponse(clientKey: key)
            session.connection.send(content: Data(response.utf8),
                                    completion: .contentProcessed { _ in })
            session.upgraded = true
            onSession?(session)
            if !remainder.isEmpty { handleWSBytes(session, Data(remainder)) }
            return
        }

        // Plain HTTP: serve a static page or 404, then close.
        let (status, page): (String, StaticPage?) = {
            if head.method == "GET", let p = pages[head.path] { return ("200 OK", p) }
            return ("404 Not Found", nil)
        }()
        let body = page?.body ?? Data("not found\n".utf8)
        let contentType = page?.contentType ?? "text/plain; charset=utf-8"
        let response = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(contentType)\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(response.utf8)
        out.append(body)
        session.connection.send(content: out, completion: .contentProcessed { [weak session] _ in
            session?.connection.cancel()
        })
    }

    private func handleWSBytes(_ session: WebSocketSession, _ data: Data) {
        let messages: [WSMessage]
        do {
            messages = try session.decoder.feed(data)
        } catch {
            session.close()
            return
        }
        for msg in messages {
            switch msg.opcode {
            case .text:
                if let s = String(data: msg.payload, encoding: .utf8) {
                    session.onText?(session, s)
                }
            case .binary:
                session.onBinary?(session, msg.payload)
            case .ping:
                let pong = WebSocketCodec.encodeFrame(opcode: .pong, payload: msg.payload)
                session.connection.send(content: pong, completion: .contentProcessed { _ in })
            case .close:
                if !session.closed {
                    session.connection.send(content: WebSocketCodec.closeFrame(),
                                            completion: .contentProcessed { [weak session] _ in
                        session?.connection.cancel()
                    })
                    finish(session)
                }
            case .pong, .continuation:
                break
            }
        }
    }
}
