import SwiftUI

/// Bars that follow the actual spectrum while audio is playing.
struct EqualizerBars: View {
    /// Only moves while audio is actually running — bars bouncing over silence
    /// claim something is happening when nothing is.
    let animated: Bool
    let levels: (Int) -> [Float]?

    /// Resting pose when silent. Still an equalizer glyph, just not moving.
    private static let rest: [CGFloat] = [0.45, 0.8, 0.6, 0.35]
    private static let floor: CGFloat = 0.16

    /// Meters look wrong with symmetric smoothing: level should jump and then
    /// sag, so attack is near-instant and release is slow.
    private static let attack: CGFloat = 0.55
    private static let release: CGFloat = 0.12

    private static let barWidth: CGFloat = 2.5
    private static let height: CGFloat = 16
    private static let frameNanos: UInt64 = 16_000_000

    @State private var smoothed = EqualizerBars.rest

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(Array(smoothed.enumerated()), id: \.offset) { _, level in
                Capsule().frame(width: Self.barWidth, height: Self.height * level)
            }
        }
        .frame(height: Self.height)
        // Polled rather than published from the store: this ticks at display
        // rate, and routing it through the store would re-render every view
        // observing it, not just these four bars.
        .task(id: animated) {
            guard animated else {
                smoothed = Self.rest
                return
            }
            while !Task.isCancelled {
                if let next = levels(Self.rest.count) {
                    for i in smoothed.indices where i < next.count {
                        let target = max(Self.floor, CGFloat(next[i]))
                        let k = target > smoothed[i] ? Self.attack : Self.release
                        smoothed[i] += (target - smoothed[i]) * k
                    }
                }
                try? await Task.sleep(nanoseconds: Self.frameNanos)
            }
        }
    }
}
