import AVFoundation

/// A short loop of a vibe, heard the moment it's tapped: the band takes a few
/// seconds to start, which is too long to wait to hear what a vibe is. The
/// loops are shared with the web build (public/sounds/vibes, rendered by
/// scripts/make-vibe-previews.py): a whole number of bars plus a one-second
/// tail, which is crossfaded into the next pass so the loop has no seam.
@MainActor
final class VibePreview {
    /// The loop files carry this much past the loop point. Matches the script.
    private nonisolated static let tail = 1.0
    /// Enough passes to get the idea; after that the page goes quiet again.
    private nonisolated static let passes = 2
    private nonisolated static let fadeIn = 0.5
    private nonisolated static let fadeOut = 3.0

    private var players: [AVAudioPlayer] = []
    private var pending: [DispatchWorkItem] = []
    private(set) var playing: String?
    private let onChange: (String?) -> Void

    init(onChange: @escaping (String?) -> Void) { self.onChange = onChange }

    func play(_ id: String, volume: Float) {
        stop(fade: 0.6)
        guard let url = Bundle.main.url(forResource: id, withExtension: "mp3", subdirectory: "Sounds/vibes")
                ?? Bundle.main.url(forResource: id, withExtension: "mp3"),
              let first = try? AVAudioPlayer(contentsOf: url)
        else { return } // no loop for this vibe yet; the band still starts on the first mark

        let length = first.duration - Self.tail
        var passes = [first]
        while passes.count < Self.passes, let next = try? AVAudioPlayer(contentsOf: url) { passes.append(next) }
        let t0 = first.deviceCurrentTime + 0.05
        for (k, player) in passes.enumerated() {
            player.volume = 0
            player.prepareToPlay()
            player.play(atTime: t0 + Double(k) * length)
            let start = Double(k) * length + 0.05
            later(start) { player.setVolume(volume, fadeDuration: k == 0 ? Self.fadeIn : Self.tail) }
            if k < passes.count - 1 {
                // The tail overlaps the next pass's head: one fades out as the other fades in.
                later(start + length) { player.setVolume(0, fadeDuration: Self.tail) }
            } else {
                later(start + length + Self.tail - Self.fadeOut) { player.setVolume(0, fadeDuration: Self.fadeOut) }
                later(start + length + Self.tail) { [weak self] in self?.finish() }
            }
        }
        players = passes
        playing = id
        onChange(id)
    }

    func setVolume(_ volume: Float) {
        for player in players where player.isPlaying { player.setVolume(volume, fadeDuration: 0.05) }
    }

    /// Wind down whatever is playing over `fade` seconds.
    func stop(fade: Double = VibePreview.fadeOut) {
        guard !players.isEmpty else { return }
        let fading = players
        for player in fading { player.setVolume(0, fadeDuration: fade) }
        DispatchQueue.main.asyncAfter(deadline: .now() + fade + 0.05) {
            for player in fading { player.stop() }
        }
        finish()
    }

    private func finish() {
        pending.forEach { $0.cancel() }
        pending = []
        players = []
        if playing != nil {
            playing = nil
            onChange(nil)
        }
    }

    private func later(_ seconds: Double, _ work: @escaping @MainActor () -> Void) {
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        pending.append(item)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, seconds), execute: item)
    }
}
