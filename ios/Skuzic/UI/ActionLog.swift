import SwiftUI

/// What changed and why, newest first: the mixer's History tab.
struct ActionLogList: View {
    @EnvironmentObject private var store: SkuzicStore

    var body: some View {
        VStack(spacing: 6) {
            if store.log.isEmpty {
                Text("Every change to the music shows up here, with the reason for it.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.inkMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            ForEach(store.log) { entry in
                ActionCard(entry: entry)
            }
        }
    }
}

private struct ActionCard: View {
    let entry: LogEntry
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if !entry.reasoning.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.inkMuted)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                Text(entry.event)
                    .font(.system(size: 13))
                    .foregroundStyle(entry.error == nil ? Theme.ink : Color(hex: 0xD4483B))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = entry.error {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(hex: 0xD4483B))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !entry.actions.isEmpty {
                FlowRow(entry.actions.map(\.inWords))
            }
            if open {
                Text(entry.reasoning)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if !entry.reasoning.isEmpty { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } }
    }
}

/// Small pills that wrap onto as many lines as they need.
private struct FlowRow: View {
    let items: [String]
    init(_ items: [String]) { self.items = items }

    var body: some View {
        WrapLayout(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, text in
                Text(text)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.inkMuted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

private struct WrapLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        rows(in: proposal.width ?? .infinity, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (index, origin) in rows(in: bounds.width, subviews).origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                                  proposal: .unspecified)
        }
    }

    private func rows(in width: CGFloat, _ subviews: Subviews) -> (origins: [CGPoint], size: CGSize) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (origins, CGSize(width: widest, height: y + lineHeight))
    }
}

extension Action {
    /// What the action did, in the words the mixer uses.
    var inWords: String {
        switch self {
        case let .addTrack(label, _, _, _): return "added \(label)"
        case .removeTrack: return "removed a sound"
        case .modifyTrack: return "rewrote a sound"
        case let .setVolume(_, volume): return "a sound to \(Int((volume * 100).rounded()))"
        case let .setMuted(_, muted): return muted ? "turned a sound off" : "turned a sound on"
        case let .setConfig(patch):
            var parts: [String] = []
            if let v = patch.density { parts.append("energy \(Int((v * 100).rounded()))%") }
            if let v = patch.brightness { parts.append("brightness \(Int((v * 100).rounded()))%") }
            if let v = patch.bpm { parts.append("tempo \(v)") }
            if let v = patch.guidance { parts.append(String(format: "follow the words %.1f", v)) }
            if let v = patch.muteDrums { parts.append(v ? "drums off" : "drums on") }
            if let v = patch.muteBass { parts.append(v ? "bass off" : "bass on") }
            if patch.scale != nil { parts.append("new key") }
            return parts.joined(separator: " · ")
        case .clearTracks: return "new mix"
        case .resetContext: return "fresh start"
        }
    }
}
