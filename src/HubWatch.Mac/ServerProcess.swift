import Foundation

/// Runs the bundled HubWatch server as a child process and keeps the end of its console output for error messages.
/// Callbacks run on the main queue.
final class ServerProcess {
    private let process = Process()
    private let pipe = Pipe()
    private let lock = NSLock()
    private var outputTail = ""
    private var stopping = false
    private let url: URL

    /// Called when the server exits on its own (not after stop()), with its exit code and recent output.
    var onExit: ((Int32, String) -> Void)?

    init(executable: URL, url: URL) {
        self.url = url
        process.executableURL = executable
        process.currentDirectoryURL = executable.deletingLastPathComponent()
        process.arguments = ["--no-browser", "--urls=\(url.absoluteString)"]
        process.standardOutput = pipe
        process.standardError = pipe

        // Keep reading so the server never blocks on a full pipe.
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self?.append(text)
        }
        process.terminationHandler = { [weak self] finished in
            guard let self else { return }
            self.pipe.fileHandleForReading.readabilityHandler = nil
            let status = finished.terminationStatus
            let output = self.recentOutput
            DispatchQueue.main.async {
                if !self.stopping { self.onExit?(status, output) }
            }
        }
    }

    var isRunning: Bool { process.isRunning }

    var recentOutput: String {
        lock.lock(); defer { lock.unlock() }
        return outputTail
    }

    func start() throws {
        try process.run()
    }

    /// Asks the server to shut down (SIGTERM, handled by ASP.NET Core), and kills it after 10 seconds.
    func stop(completion: @escaping () -> Void) {
        stopping = true
        guard process.isRunning else { return completion() }
        process.terminate()
        let process = self.process
        let pid = process.processIdentifier
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(10)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
            if process.isRunning { kill(pid, SIGKILL) }
            DispatchQueue.main.async(execute: completion)
        }
    }

    /// Polls the API until it answers, the process exits, or the timeout passes.
    func waitUntilReady(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            ServerProcess.isHubWatchResponding(at: url) { [weak self] responding in
                guard let self else { return }
                if responding { return completion(true) }
                if !self.process.isRunning || Date() > deadline { return completion(false) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: poll)
            }
        }
        poll()
    }

    /// True if a HubWatch server answers at this address (also one this app did not start).
    static func isHubWatchResponding(at url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url.appendingPathComponent("api/status"))
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let http = response as? HTTPURLResponse
            let ok = http?.statusCode == 200
                && (http?.value(forHTTPHeaderField: "Content-Type")?.contains("json") ?? false)
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    enum ExistingServer { case none, withUI, withoutUI }

    /// Checks for a HubWatch server this app did not start (brew services, the command-line version, a development
    /// server). One started with `dotnet watch` answers the API but serves no web UI (Vite does that in development).
    static func probeExisting(at url: URL, completion: @escaping (ExistingServer) -> Void) {
        isHubWatchResponding(at: url) { responding in
            guard responding else { return completion(.none) }
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            request.cachePolicy = .reloadIgnoringLocalCacheData
            URLSession.shared.dataTask(with: request) { data, response, _ in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                    && (data.flatMap { String(data: $0, encoding: .utf8) }?.contains("id=\"root\"") ?? false)
                DispatchQueue.main.async { completion(ok ? .withUI : .withoutUI) }
            }.resume()
        }
    }

    private func append(_ text: String) {
        // Drop ANSI colour codes from the console log.
        let clean = text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        lock.lock(); defer { lock.unlock() }
        outputTail = String((outputTail + clean).suffix(4000))
    }
}
