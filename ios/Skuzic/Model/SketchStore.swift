import Foundation
import PencilKit

/// One folder per sketch under Documents/Sketches:
///
///   <uuid>/meta.json      title and timestamps
///   <uuid>/drawing.data   PKDrawing
///   <uuid>/state.json     tracks and engine config
///   <uuid>/thumb.png      gallery card
///
/// Keeping the drawing and thumbnail as their own files means the gallery can
/// list everything without decoding a single stroke.
@MainActor
final class SketchStore: ObservableObject {
    @Published private(set) var sketches: [SketchMeta] = []

    private let root: URL

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("Sketches", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        reload()
    }

    // MARK: - Paths

    private func folder(_ id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    func thumbnailURL(_ id: UUID) -> URL {
        folder(id).appendingPathComponent("thumb.png")
    }

    // MARK: - Listing

    func reload() {
        let contents =
            (try? FileManager.default.contentsOfDirectory(
                at: root, includingPropertiesForKeys: nil)) ?? []

        sketches = contents
            .compactMap { url -> SketchMeta? in
                let meta = url.appendingPathComponent("meta.json")
                guard let data = try? Data(contentsOf: meta) else { return nil }
                return try? JSONDecoder.iso.decode(SketchMeta.self, from: data)
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Lifecycle

    @discardableResult
    func create(title: String = "Untitled") -> SketchMeta {
        let meta = SketchMeta(title: title)
        try? FileManager.default.createDirectory(
            at: folder(meta.id), withIntermediateDirectories: true)
        write(meta)
        reload()
        return meta
    }

    func delete(_ id: UUID) {
        try? FileManager.default.removeItem(at: folder(id))
        reload()
    }

    func rename(_ id: UUID, to title: String) {
        guard var meta = sketches.first(where: { $0.id == id }) else { return }
        meta.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if meta.title.isEmpty { meta.title = "Untitled" }
        meta.updatedAt = Date()
        write(meta)
        reload()
    }

    // MARK: - Contents

    func loadDrawing(_ id: UUID) -> PKDrawing? {
        guard let data = try? Data(contentsOf: folder(id).appendingPathComponent("drawing.data"))
        else { return nil }
        return try? PKDrawing(data: data)
    }

    /// nil when the sketch has never been saved, so the caller can fall back to
    /// the last-used settings instead of the shipped defaults.
    func loadState(_ id: UUID) -> SketchState? {
        guard let data = try? Data(contentsOf: folder(id).appendingPathComponent("state.json"))
        else { return nil }
        return try? JSONDecoder.iso.decode(SketchState.self, from: data)
    }

    func save(id: UUID, drawing: PKDrawing, thumbnail: Data?, state: SketchState) {
        let directory = folder(id)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        try? drawing.dataRepresentation()
            .write(to: directory.appendingPathComponent("drawing.data"), options: .atomic)

        if let encoded = try? JSONEncoder.iso.encode(state) {
            try? encoded.write(
                to: directory.appendingPathComponent("state.json"), options: .atomic)
        }

        if let thumbnail {
            try? thumbnail.write(to: thumbnailURL(id), options: .atomic)
        }

        if var meta = sketches.first(where: { $0.id == id }) {
            meta.updatedAt = Date()
            write(meta)
        }
        reload()
    }

    private func write(_ meta: SketchMeta) {
        guard let data = try? JSONEncoder.iso.encode(meta) else { return }
        try? FileManager.default.createDirectory(
            at: folder(meta.id), withIntermediateDirectories: true)
        try? data.write(to: folder(meta.id).appendingPathComponent("meta.json"), options: .atomic)
    }
}

extension JSONEncoder {
    /// Dates as ISO-8601 so a sketch folder stays readable and portable.
    static let iso: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()
}

extension JSONDecoder {
    static let iso: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
