import Foundation

/// Receiving and decoding audio must keep running while PencilKit or image
/// export occupies the main actor. Only small control events return to the UI.
enum LyriaStream {
    static let defaultSampleRate: Double = 48000
    enum StreamError: Error { case server(Int), unsupportedFormat }

    struct Control: Sendable {
        var setupComplete: Bool
        var filteredPrompt: String?
        var filteredReason: String?
    }

    static func start(
        receive: @escaping @Sendable () async throws -> URLSessionWebSocketTask.Message,
        onAudio: @escaping @Sendable (Data, Double) -> Void,
        onControl: @escaping @Sendable (Control) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> Task<Void, Never> {
        Task.detached(priority: .userInitiated) {
            Diagnostics.event(.stream, "RECEIVE_WORKER_STARTED")
            defer { Diagnostics.event(.stream, "RECEIVE_WORKER_ENDED cancelled=\(Task.isCancelled)") }
            do {
                while !Task.isCancelled {
                    let message = try await receive()
                    let decodeStarted = Diagnostics.now
                    try Task.checkCancellation()
                    let data: Data
                    switch message {
                    case let .string(text): data = Data(text.utf8)
                    case let .data(raw): data = raw
                    @unknown default: continue
                    }
                    guard let json = try? JSONSerialization.jsonObject(with: data)
                        as? [String: Any] else {
                        Diagnostics.event(.stream, "INVALID_JSON bytes=\(data.count)")
                        continue
                    }
                    if let error = json["error"] as? [String: Any] {
                        let code = error["code"] as? Int ?? -1
                        Diagnostics.event(.stream, "SERVER_ERROR code=\(code)")
                        throw StreamError.server(code)
                    }
                    if json["warning"] != nil { Diagnostics.event(.stream, "SERVER_WARNING") }

                    let filtered = json.child("filteredPrompt", "filtered_prompt")
                    let control = Control(
                        setupComplete: json["setupComplete"] != nil || json["setup_complete"] != nil,
                        filteredPrompt: filtered.map { $0["text"] as? String ?? "" },
                        filteredReason: filtered.map {
                            $0["filteredReason"] as? String
                                ?? $0["filtered_reason"] as? String ?? "filtered"
                        }
                    )
                    if control.setupComplete || control.filteredPrompt != nil {
                        if control.setupComplete { Diagnostics.event(.stream, "SETUP_COMPLETE_RECEIVED") }
                        if control.filteredPrompt != nil { Diagnostics.event(.stream, "PROMPT_FILTERED") }
                        onControl(control)
                    }

                    let content = json.child("serverContent", "server_content")
                    let chunks = content?["audioChunks"] as? [[String: Any]]
                        ?? content?["audio_chunks"] as? [[String: Any]] ?? []
                    for chunk in chunks {
                        try Task.checkCancellation()
                        guard let encoded = chunk["data"] as? String,
                              let audio = Data(base64Encoded: encoded),
                              !audio.isEmpty, audio.count % 4 == 0
                        else {
                            Diagnostics.event(.stream, "INVALID_AUDIO_CHUNK")
                            continue
                        }
                        let mime = chunk["mimeType"] as? String ?? chunk["mime_type"] as? String
                        guard supported(mime) else { throw StreamError.unsupportedFormat }
                        onAudio(audio, sampleRate(from: mime))
                    }
                    let decodeMs = Diagnostics.milliseconds(since: decodeStarted)
                    if decodeMs > 50 {
                        Diagnostics.event(.stream, "SLOW_DECODE elapsed_ms=\(decodeMs) bytes=\(data.count)")
                    }
                }
            } catch {
                if !Task.isCancelled { onError(error) }
            }
        }
    }

    static func sampleRate(from mimeType: String?) -> Double {
        guard let mimeType, let range = mimeType.range(of: "rate="),
              let rate = Double(mimeType[range.upperBound...].prefix { $0.isNumber }),
              (8_000...192_000).contains(rate)
        else { return defaultSampleRate }
        return rate
    }

    private static func supported(_ mime: String?) -> Bool {
        guard let mime else { return true }
        let parts = mime.lowercased().split(separator: ";").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard ["audio/l16", "audio/pcm"].contains(parts.first ?? "") else { return false }
        for field in parts.dropFirst() {
            if field.hasPrefix("channels="), field != "channels=2" { return false }
            if field.hasPrefix("codec="), field != "codec=pcm" { return false }
        }
        return true
    }
}

private extension [String: Any] {
    func child(_ names: String...) -> [String: Any]? {
        for name in names {
            if let hit = self[name] as? [String: Any] { return hit }
        }
        return nil
    }
}
