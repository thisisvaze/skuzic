import SwiftUI

/// Everything you set once: the key, how Reimagine thinks, and how it looks.
/// The same groups as the web build's settings, in the same plain words.
struct SettingsSheet: View {
    @EnvironmentObject private var store: SkuzicStore
    @AppStorage(Preferences.Key.theme.rawValue) private var theme = ThemeChoice.system.rawValue
    let onDone: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    group("Gemini API key", hint: "Lyria and Reimagine both use it. It stays on this device.") {
                        ApiKeyEditor()
                            .padding(14)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }

                    group("Reimagine", hint: "What Gemini does when you tap Reimagine or ask the band for a change.") {
                        VStack(spacing: 8) {
                            ForEach(PlannerConfig.allCases) { config in
                                choice(title: config.label, detail: config.summary,
                                       chosen: store.plannerConfig == config) { store.plannerConfig = config }
                            }
                        }
                        HStack {
                            Text(store.plannerModel == .flash38 ? "Gemini 3.8 Flash" : "Gemini 3.5 Flash Lite")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.inkMuted)
                            Spacer()
                            Picker("Gemini model", selection: $store.plannerModel) {
                                ForEach(PlannerModel.allCases) { Text($0.label).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .frame(width: 200)
                        }
                        .padding(.top, 4)
                    }

                    group("Appearance") {
                        Picker("Theme", selection: $theme) {
                            ForEach(ThemeChoice.allCases) { Label($0.title, systemImage: $0.icon).tag($0.rawValue) }
                        }
                        .pickerStyle(.segmented)
                    }

                    if store.connected {
                        Button("Stop the band") {
                            store.stop()
                            onDone()
                        }
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.inkMuted)
                    }
                }
                .padding(24)
            }
            .background(Theme.panel)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func group<Content: View>(_ title: String, hint: String? = nil,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                if let hint {
                    Text(hint).font(.system(size: 13)).foregroundStyle(Theme.inkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content()
        }
    }

    private func choice(title: String, detail: String, chosen: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                Text(detail).font(.system(size: 12)).foregroundStyle(Theme.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(chosen ? Theme.panel : Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(chosen ? Theme.brand3 : Theme.border, lineWidth: chosen ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
