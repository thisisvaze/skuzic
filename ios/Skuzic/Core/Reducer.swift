import Foundation

@MainActor private var trackSeq = 0

@MainActor func newTrackID() -> TrackID {
    trackSeq += 1
    return "t\(trackSeq)"
}

/// Restored tracks carry ids like "t3"; without moving the counter past them a
/// freshly added track would reuse an id that is already on screen.
@MainActor func reserveTrackIDs(_ tracks: [Track]) {
    for track in tracks where track.id.hasPrefix("t") {
        if let n = Int(track.id.dropFirst()), n > trackSeq { trackSeq = n }
    }
}

private func clamp01(_ n: Double) -> Double { min(1, max(0, n)) }

/// The model refers to tracks by id when it can, but often uses the label it
/// invented a moment ago. Accept both, then fall back to fuzzy matching so a
/// near-miss degrades into the right track instead of a silently dropped action.
private func resolve(_ tracks: [Track], _ target: String) -> Track? {
    let needle = target.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return nil }

    if let hit = tracks.first(where: { $0.id == target }) { return hit }
    if let hit = tracks.first(where: { $0.label.lowercased() == needle }) { return hit }
    if let hit = tracks.first(where: { $0.label.lowercased().contains(needle) }) { return hit }
    if let hit = tracks.first(where: { needle.contains($0.label.lowercased()) }) { return hit }
    return tracks.first { $0.prompt.lowercased().contains(needle) }
}

@MainActor
func reduce(_ state: SkuzicState, _ action: Action) -> SkuzicState {
    var next = state

    switch action {
    case let .addTrack(label, prompt, volume, origin):
        let track = Track(
            id: newTrackID(),
            label: String(label.prefix(24)),
            prompt: prompt,
            volume: clamp01(volume),
            muted: false,
            origin: origin
        )
        next.tracks.append(track)
        if next.tracks.count > maxTracks {
            // Evict the quietest existing track so the mix stays legible.
            let victim = next.tracks.dropLast().min { $0.volume < $1.volume }
            if let victim { next.tracks.removeAll { $0.id == victim.id } }
        }

    case let .removeTrack(target):
        guard let hit = resolve(next.tracks, target) else { return state }
        next.tracks.removeAll { $0.id == hit.id }

    case let .modifyTrack(target, label, prompt):
        guard let hit = resolve(next.tracks, target),
              let index = next.tracks.firstIndex(where: { $0.id == hit.id })
        else { return state }
        if let label { next.tracks[index].label = String(label.prefix(24)) }
        if let prompt { next.tracks[index].prompt = prompt }

    case let .setVolume(target, volume):
        guard let hit = resolve(next.tracks, target),
              let index = next.tracks.firstIndex(where: { $0.id == hit.id })
        else { return state }
        next.tracks[index].volume = clamp01(volume)

    case let .setMuted(target, muted):
        guard let hit = resolve(next.tracks, target),
              let index = next.tracks.firstIndex(where: { $0.id == hit.id })
        else { return state }
        next.tracks[index].muted = muted

    case let .setConfig(patch):
        if let bpm = patch.bpm { next.config.bpm = min(200, max(60, bpm)) }
        if let density = patch.density { next.config.density = clamp01(density) }
        if let brightness = patch.brightness { next.config.brightness = clamp01(brightness) }
        if let guidance = patch.guidance { next.config.guidance = min(6, max(0, guidance)) }
        if let scale = patch.scale { next.config.scale = scale }
        if let muteBass = patch.muteBass { next.config.muteBass = muteBass }
        if let muteDrums = patch.muteDrums { next.config.muteDrums = muteDrums }

    case .clearTracks:
        next.tracks = []

    case .resetContext:
        next.contextEpoch += 1
    }

    return next
}
