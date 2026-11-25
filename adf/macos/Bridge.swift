import Foundation

@MainActor
final class Bridge {
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var callbacks = [String: (Record) -> Void]()

    func call(_ action: String, _ args: Record, done: @escaping (Record) -> Void) {
        do {
            try open()
            let key = UUID().uuidString
            let frame = try JSONSerialization.data(withJSONObject: ["id": key, "action": action, "args": args])
            callbacks[key] = done
            try input?.write(contentsOf: frame + Data([10]))
        } catch {
            disconnect()
            done(["error": "ADF デーモンへの接続に失敗しました"])
        }
    }

    private func open() throws {
        if process?.isRunning == true { return }
        guard let resource = Bundle.main.resourceURL,
              let binary = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("adf")
        else { throw CocoaError(.fileNoSuchFile) }
        let process = Process()
        process.executableURL = binary
        process.arguments = ["bridge"]
        process.currentDirectoryURL = resource
        let inbound = Pipe()
        let outbound = Pipe()
        process.standardInput = inbound
        process.standardOutput = outbound
        let reader = outbound.fileHandleForReading
        reader.readabilityHandler = { [weak self] file in
            let chunk = file.availableData
            if chunk.isEmpty { file.readabilityHandler = nil }
            DispatchQueue.main.async {
                if chunk.isEmpty { self?.disconnect() } else { self?.read(chunk) }
            }
        }
        try process.run()
        self.process = process
        input = inbound.fileHandleForWriting
    }

    private func read(_ chunk: Data) {
        buffer.append(chunk)
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end)
            buffer.removeSubrange(...end)
            if let frame = (try? JSONSerialization.jsonObject(with: line)) as? Record,
               let key = frame["id"] as? String {
                callbacks.removeValue(forKey: key)?(frame)
            }
        }
    }

    private func disconnect() {
        input = nil
        process = nil
        buffer.removeAll()
        let pending = callbacks.values
        callbacks.removeAll()
        for callback in pending { callback(["error": "ADF デーモンとの接続が切断されました"]) }
    }
}
