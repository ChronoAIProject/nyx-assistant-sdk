import AppKit
import Foundation

struct WindowText: Decodable {
    let items: [String: String]
    let windowTitle, mark, readOnly, prompt, send, resume, closed, denied, unavailable, startFailed: String
}

struct WindowCatalog: Decodable {
    let defaultLocale: String
    let locales: [String: WindowText]

    func language(for preferences: [String]) -> String {
        for preference in preferences {
            var subtags = preference.split(separator: "-")
            while !subtags.isEmpty {
                let tag = subtags.joined(separator: "-")
                if let match = locales.keys.first(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) {
                    return match
                }
                subtags.removeLast()
            }
        }
        return defaultLocale
    }
}

let catalogURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("locales.json")
let catalog = try JSONDecoder().decode(WindowCatalog.self, from: Data(contentsOf: catalogURL))
let language = catalog.language(for: Locale.preferredLanguages)
let windowText = catalog.locales[language]!

// This window owns the list, selection, authorization and mutations. Its child
// process handles the same NyxID protocol and SDK as the independent web page.
final class ListWindow: NSObject, NSWindowDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 530, height: 270),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let selection = NSPopUpButton()
    let mark = NSButton(checkboxWithTitle: windowText.mark, target: nil, action: nil)
    let locked = NSButton(checkboxWithTitle: windowText.readOnly, target: nil, action: nil)
    let input = NSTextField(string: windowText.prompt)
    let sendButton = NSButton(title: windowText.send, target: nil, action: nil)
    let output = NSTextField(wrappingLabelWithString: "")
    let process = Process()
    let commands = Pipe()
    var values: [String: Bool] = [:]
    var needsRecovery = false

    init(number: Int) throws {
        super.init()
        window.title = String(format: windowText.windowTitle, number)
        for (id, title) in windowText.items.sorted(by: { $0.key < $1.key }) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.representedObject = id
            selection.menu?.addItem(item)
        }
        selection.selectItem(at: 0)
        selection.target = self; selection.action = #selector(changedSelection)
        mark.target = self; mark.action = #selector(markCurrent)
        sendButton.target = self; sendButton.action = #selector(send)
        let stack = NSStackView(views: [selection, mark, locked, input, sendButton, output])
        stack.orientation = .vertical; stack.alignment = .leading
        stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            input.widthAnchor.constraint(equalTo: stack.widthAnchor),
            output.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        window.delegate = self
        let responses = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "examples/macos/bridge.mjs", language]
        process.standardInput = commands
        process.standardOutput = responses
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.sendButton.isEnabled = false
                self?.output.stringValue = windowText.closed
            }
        }
        try process.run()
        DispatchQueue.global().async { [weak self] in
            var buffer = Data()
            while true {
                let bytes = responses.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                buffer.append(bytes)
                while let newline = buffer.firstIndex(of: 10) {
                    let line = buffer[..<newline]
                    if let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                        DispatchQueue.main.async { self?.handle(event) }
                    }
                    buffer.removeSubrange(...newline)
                }
            }
        }
        window.setFrameOrigin(NSPoint(x: 100 + number * 45, y: 150 + number * 40))
        window.makeKeyAndOrderFront(nil)
    }

    var selectedID: String { selection.selectedItem?.representedObject as? String ?? "" }
    @objc func changedSelection() { mark.state = values[selectedID] == true ? .on : .off }
    @objc func markCurrent() { values[selectedID] = mark.state == .on }
    @objc func send() {
        guard !input.stringValue.isEmpty else { return }
        sendButton.isEnabled = false
        write(["type": needsRecovery ? "resume" : "send", "text": input.stringValue])
    }

    func write(_ payload: [String: Any]) {
        guard process.isRunning, var bytes = try? JSONSerialization.data(withJSONObject: payload) else { return }
        bytes.append(10)
        try? commands.fileHandleForWriting.write(contentsOf: bytes)
    }
    func handle(_ event: [String: Any]) {
        guard window.isVisible else { return }
        if event["type"] as? String == "call", let id = event["id"] as? String {
            let args = event["args"] as? [String: Any] ?? [:]
            var result: [String: Any]
            switch event["name"] as? String {
            case "read_selection":
                result = ["ok": true, "value": ["id": selectedID, "marked": mark.state == .on]]
            case "set_mark" where locked.state == .on:
                result = ["ok": false, "code": "read_only", "message": windowText.denied]
            case "set_mark" where args["id"] as? String == selectedID && args["marked"] is Bool:
                values[selectedID] = args["marked"] as? Bool
                changedSelection()
                result = ["ok": true, "value": ["id": selectedID, "marked": mark.state == .on]]
            default:
                result = ["ok": false, "code": "unavailable", "message": windowText.unavailable]
            }
            write(["type": "result", "id": id, "result": result])
        } else if let text = event["text"] as? String {
            output.stringValue = text
            needsRecovery = event["pending"] as? Bool == true
            sendButton.title = needsRecovery ? windowText.resume : windowText.send
            sendButton.isEnabled = true
        }
    }
    func windowWillClose(_ notification: Notification) {
        try? commands.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }
}

final class Demo: NSObject, NSApplicationDelegate {
    var windows: [ListWindow] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        do { for number in 1...2 { windows.append(try ListWindow(number: number)) } }
        catch { fputs(String(format: windowText.startFailed, error.localizedDescription) + "\n", stderr); NSApp.terminate(nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        for item in windows where item.process.isRunning { item.process.terminate() }
    }
}

let app = NSApplication.shared
let delegate = Demo()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
