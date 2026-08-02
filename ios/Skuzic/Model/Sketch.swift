import Foundation

/// What the gallery needs to draw a card, without touching the drawing itself.
struct SketchMeta: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date

    init(id: UUID = UUID(), title: String = "Untitled", createdAt: Date = Date()) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        updatedAt = createdAt
    }
}

/// The mix as it sounded when the sketch was last closed. Restoring this is what
/// lets reopening a sketch pick the music back up rather than starting silent.
struct SketchState: Codable, Equatable {
    var tracks: [Track] = []
    var config = MixConfig()
}
