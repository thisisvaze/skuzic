import Foundation
import OSLog

/// Default-level events appear in Xcode and persist in Apple's unified log.
/// Call only from control/worker queues, never from an audio render callback.
enum Diagnostics {
    enum Area: String, CaseIterable {
        case session, stream, audio, drawing, planner
    }

    private static let origin = ProcessInfo.processInfo.systemUptime
    /// devicectl --console captures standard streams. Opt in for terminal runs;
    /// keep pipe I/O on its own queue so a slow reader cannot stall audio work.
    private static let terminalEnabled = ProcessInfo.processInfo.environment["SKUZIC_DIAGNOSTICS_STDOUT"] == "1"
    private static let terminalQueue = DispatchQueue(label: "skuzic.diagnostics.terminal", qos: .utility)
    private static let loggers = Dictionary(uniqueKeysWithValues: Area.allCases.map {
        ($0, Logger(subsystem: "com.incubious.skuzic", category: $0.rawValue))
    })

    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    static func milliseconds(since start: TimeInterval) -> Int { Int((now - start) * 1000) }

    /// Messages must contain operational metadata only: never keys, URLs,
    /// drawings, prompt text, response bodies or NSError.userInfo.
    static func event(_ area: Area, _ message: String) {
        let start = origin
        let elapsed = String(format: "%.3f", now - start)
        loggers[area]?.notice("[skuzic][\(area.rawValue, privacy: .public)] +\(elapsed, privacy: .public)s \(message, privacy: .public)")
        mirrorToTerminal("[skuzic][\(area.rawValue)] +\(elapsed)s \(message)")
    }

    static func failure(_ area: Area, _ event: String, _ error: Error) {
        let error = error as NSError
        loggers[area]?.error("[skuzic][\(area.rawValue, privacy: .public)] \(event, privacy: .public) domain=\(error.domain, privacy: .public) code=\(error.code)")
        mirrorToTerminal("[skuzic][\(area.rawValue)] \(event) domain=\(error.domain) code=\(error.code)")
    }

    private static func mirrorToTerminal(_ line: String) {
        guard terminalEnabled else { return }
        terminalQueue.async {
            try? FileHandle.standardError.write(contentsOf: Data((line + "\n").utf8))
        }
    }
}
