import Foundation

/// A single disposable Lyria session: its own URLSession, ordered sender and
/// off-main receive worker. Reconnecting always creates a fresh instance.
@MainActor
final class LyriaConnection {
    static let model = "models/lyria-realtime-exp"
    static let endpoint = "wss://generativelanguage.googleapis.com/ws/"
        + "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateMusic"

    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private var outbox: LyriaOutbox?
    private var reader: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var setup: CheckedContinuation<Void, Error>?
    private var ready = false
    private var closed = false
    private let onAudio: @Sendable (Data, Double) -> Void
    private let onControl: (LyriaStream.Control) -> Void
    private let onFailure: (Error) -> Void

    init(apiKey: String, onAudio: @escaping @Sendable (Data, Double) -> Void,
         onControl: @escaping (LyriaStream.Control) -> Void,
         onFailure: @escaping (Error) -> Void) throws {
        guard !apiKey.isEmpty else { throw EngineError.missingKey }
        var components = URLComponents(string: Self.endpoint)!
        components.queryItems = [URLQueryItem(name: "key", value: apiKey)]
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: components.url!)
        socket.maximumMessageSize = 4 * 1024 * 1024
        self.onAudio = onAudio
        self.onControl = onControl
        self.onFailure = onFailure
    }

    func connect() async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                // Install the waiter before the socket can deliver setupComplete.
                setup = continuation
                let socket = self.socket
                outbox = LyriaOutbox(
                    send: { text in try await socket.send(.string(text)) },
                    failed: { [weak self] error in self?.fail(error) })
                reader = LyriaStream.start(
                    receive: { try await socket.receive() },
                    onAudio: onAudio,
                    onControl: { [weak self] control in
                        Task { @MainActor in self?.handle(control) }
                    },
                    onError: { [weak self] error in
                        Task { @MainActor in self?.fail(error) }
                    })
                timeout = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 20_000_000_000) }
                    catch { return }
                    self?.fail(EngineError.timedOut)
                }
                socket.resume()
                send(["setup": ["model": Self.model]])
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.close() }
        }
    }

    func send(_ payload: [String: Any], key: String? = nil, sent: (() -> Void)? = nil) {
        guard !closed else { return }
        do {
            let bytes = try JSONSerialization.data(withJSONObject: payload)
            outbox?.enqueue(String(decoding: bytes, as: UTF8.self), key: key, sent: sent)
        } catch { fail(error) }
    }

    private func handle(_ control: LyriaStream.Control) {
        guard !closed else { return }
        if control.setupComplete, !ready {
            ready = true
            timeout?.cancel()
            timeout = nil
            let waiter = setup
            setup = nil
            waiter?.resume()
        }
        onControl(control)
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        Diagnostics.failure(.stream, "CONNECTION_FAILED", error)
        let wasReady = ready
        let waiter = setup
        setup = nil
        close()
        waiter?.resume(throwing: error)
        if wasReady { onFailure(error) }
    }

    func close() {
        guard !closed else { return }
        closed = true
        ready = false
        timeout?.cancel()
        timeout = nil
        outbox?.cancel()
        outbox = nil
        reader?.cancel()
        reader = nil
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        let waiter = setup
        setup = nil
        waiter?.resume(throwing: CancellationError())
    }
}
