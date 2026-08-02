import SwiftUI

/// The full history, newest first. Lives in a popover off the transport bar
/// rather than taking a slot in the mix panel.
struct ActionLogList: View {
    @EnvironmentObject private var store: SkuzicStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Actions")
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 10)

            Divider().overlay(.white.opacity(0.1))

            if store.log.isEmpty {
                Text("no actions yet")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.4))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 9) {
                        ForEach(store.log) { entry in
                            ActionCard(entry: entry, compact: false)
                        }
                    }
                    .padding(14)
                }
            }
        }
        .frame(width: 380, height: 480)
    }
}

/// Fires when the planner replies and fades itself out — the mix changes under
/// you, so the reasoning is worth seeing without going and looking for it.
struct ActionToast: View {
    let entry: LogEntry

    var body: some View {
        ActionCard(entry: entry, compact: true)
            .frame(maxWidth: 460)
            .background(
                .ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(0.14), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.25), radius: 20, y: 6)
    }
}

private struct ActionCard: View {
    let entry: LogEntry
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: entry.error == nil ? "sparkles" : "exclamationmark.triangle")
                    .font(.system(size: 11))
                    .foregroundStyle(
                        entry.error == nil ? .white.opacity(0.5) : Color(hex: 0xE8705F))

                Text(entry.event)
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
            }

            if let error = entry.error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(hex: 0xE8705F))
                    .lineLimit(compact ? 2 : nil)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !entry.reasoning.isEmpty {
                Text(entry.reasoning)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(compact ? 2 : nil)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !entry.actions.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(entry.actions.enumerated()), id: \.offset) { _, action in
                        Text(action.summary)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(1)
                    }
                }
                .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(
            compact
                ? nil
                : RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06))
        )
    }
}
