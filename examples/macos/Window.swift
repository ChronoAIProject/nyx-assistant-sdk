import AppKit
import Foundation

// This window owns the list, selection, authorization and mutations. Its child
// process handles the same NyxID protocol and SDK as the independent web page.
final class ListWindow: NSObject, NSWindowDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 530, height: 270),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let selection = NSPopUpButton()
    let mark = NSButton(checkboxWithTitle: "已标记", target: nil, action: nil)
    let locked = NSButton(checkboxWithTitle: "只读模式", target: nil, action: nil)
    let input = NSTextField(string: "读取当前选择，然后标记这一项并告诉我实际结果。")
    let sendButton = NSButton(title: "发送", target: nil, action: nil)
    let output = NSTextField(wrappingLabelWithString: "")
    let process = Process()
    let commands = Pipe()
    var values: [String: Bool] = [:]
    var needsRecovery = false

    init(number: Int) throws {
        super.init()
        window.title = "NyxID · 清单 \(number)"
        selection.addItems(withTitles: ["Alpha", "Beta", "Gamma"])
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
        process.arguments = ["node", "examples/macos/bridge.mjs"]
        process.standardInput = commands
        process.standardOutput = responses
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.sendButton.isEnabled = false
                self?.output.stringValue = "连接已关闭，请核对最后一次操作。"
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

    var selectedID: String { selection.titleOfSelectedItem ?? "" }
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
                result = ["ok": false, "code": "read_only", "message": "此窗口为只读模式。"]
            case "set_mark" where args["id"] as? String == selectedID && args["marked"] is Bool:
                values[selectedID] = args["marked"] as? Bool
                changedSelection()
                result = ["ok": true, "value": ["id": selectedID, "marked": mark.state == .on]]
            default:
                result = ["ok": false, "code": "unavailable", "message": "当前选区或工具已改变。"]
            }
            write(["type": "result", "id": id, "result": result])
        } else if let text = event["text"] as? String {
            output.stringValue = text
            needsRecovery = event["pending"] as? Bool == true
            sendButton.title = needsRecovery ? "核对原请求" : "发送"
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
        catch { fputs("Unable to start the NyxID example: \(error)\n", stderr); NSApp.terminate(nil) }
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
