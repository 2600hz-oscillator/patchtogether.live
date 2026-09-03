// EditorWindow.swift
//
// The plugin editor's native window. This is the huge simplification over
// remote-plugin systems like AudioGridder: the plugin and the user are on
// the SAME machine, so "open the editor" is just an NSWindow here — no UI
// streaming. Main thread only (AppKit); the service hops here via
// DispatchQueue.main and requires the app to be running an NSApplication
// run loop (vst-bridge's main.swift does; tests never touch this path).

import AppKit
import Foundation

@MainActor
public final class EditorWindowManager: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    /// Fired when the user closes the window themselves (⌘W / red button),
    /// so the service can tell the client editor{open:false}.
    public var onUserClose: (() -> Void)?

    public override init() { super.init() }

    public var isOpen: Bool { window != nil }

    /// Open (or re-focus) the editor for a mounted plugin.
    public func open(host: PluginHost, completion: @escaping (_ custom: Bool) -> Void) {
        guard !host.tornDown else { return }
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            completion(true)
            return
        }
        host.requestEditor { [weak self] viewController, custom in
            guard let self else { return }
            // A close/unmount may have raced the async editor load.
            guard self.window == nil, !host.tornDown else { completion(custom); return }
            let window = NSWindow(contentViewController: viewController)
            window.title = host.descriptor.info.name
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            self.window = window
            completion(custom)
        }
    }

    public func close() {
        guard let window else { return }
        window.delegate = nil
        self.window = nil
        window.close()
    }

    public func windowWillClose(_ notification: Notification) {
        window = nil
        onUserClose?()
    }
}
