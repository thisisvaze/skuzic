import Foundation

/// One in-flight WebSocket send. Only adjacent unsent config/prompt updates may
/// coalesce; playback commands are ordering barriers.
@MainActor
final class LyriaOutbox {
    private struct Message {
        var text: String
        var key: String?
        var sent: (() -> Void)?
    }
    private var pending: [Message] = []
    private var worker: Task<Void, Never>?
    private var closed = false
    private let send: @Sendable (String) async throws -> Void
    private let failed: (Error) -> Void

    init(send: @escaping @Sendable (String) async throws -> Void,
         failed: @escaping (Error) -> Void) {
        self.send = send
        self.failed = failed
    }

    func enqueue(_ text: String, key: String? = nil, sent: (() -> Void)? = nil) {
        guard !closed else { return }
        let message = Message(text: text, key: key, sent: sent)
        if let key, pending.last?.key == key {
            pending[pending.count - 1] = message
        } else {
            guard pending.count < 64 else {
                cancel()
                failed(URLError(.dataLengthExceedsMaximum))
                return
            }
            pending.append(message)
        }
        guard worker == nil else { return }
        worker = Task { [weak self] in await self?.drain() }
    }

    private func drain() async {
        defer { worker = nil }
        do {
            while !closed, !Task.isCancelled, !pending.isEmpty {
                let next = pending.removeFirst()
                try await send(next.text)
                guard !closed, !Task.isCancelled else { return }
                next.sent?()
            }
        } catch {
            guard !closed, !Task.isCancelled else { return }
            cancel()
            failed(error)
        }
    }

    func cancel() {
        closed = true
        pending.removeAll()
        worker?.cancel()
    }
}
