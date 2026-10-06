import SwiftUI

/// The band's controls, docked beside the paper: what's playing and why, the
/// vibe, every sound as a fader, the feel knobs in plain words, and a box to
/// ask the band for a change. History says what changed and why. A port of
/// the web build's mixer (src/ui/Mixer.tsx).
struct MixerPanel: View {
    @EnvironmentObject private var store: SkuzicStore
    let onClose: () -> Void
    let onPickVibe: (Palette.Vibe) -> Void

    @State private var tab: Tab = .mix
    @State private var choosingVibe = false
    @State private var ask = ""
    @State private var showMore = false

    enum Tab: String, CaseIterable {
        case mix = "Mixer"
        case history = "History"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Section", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 32, height: 32)
                        .foregroundStyle(Theme.inkMuted)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Hide the mixer")
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch tab {
                    case .mix:
                        nowPlaying
                        sounds
                        feel
                    case .history:
                        ActionLogList()
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }

            if tab == .mix { askBar }
        }
    }

    // MARK: - Now playing

    private var nowPlaying: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Now playing")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.inkMuted)
            Text(title)
                .font(.system(size: 26, weight: .semibold))
                .tracking(-0.5)
                .foregroundStyle(Theme.ink)
                .padding(.top, 2)

            if let vibe = store.vibe, let vibes = store.book?.palette.vibes {
                HStack(spacing: 6) {
                    Text("Vibe").foregroundStyle(Theme.inkMuted)
                    Text(vibe.name).fontWeight(.medium).foregroundStyle(Theme.ink)
                    Spacer()
                    Button(choosingVibe ? "Done" : "Change") {
                        withAnimation(.snappy(duration: 0.2)) { choosingVibe.toggle() }
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.inkMuted)
                }
                .font(.system(size: 13))
                .padding(.top, 12)

                if choosingVibe {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible())], spacing: 8) {
                        ForEach(vibes) { option in
                            VibeCard(vibe: option, chosen: option.id == vibe.id) {
                                onPickVibe(option)
                                choosingVibe = false
                            }
                        }
                    }
                    .padding(.top, 10)
                }
            }

            Toggle(isOn: $store.autoInterpret) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Follow my drawing")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.ink)
                    Text(store.autoInterpret
                         ? "Lifting your pen changes the music to match the page."
                         : "The music stays as you set it while you draw.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.inkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(BrandToggleStyle())
            .padding(.top, 16)
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var title: String {
        if let scene = store.scene { return scene.prefix(1).uppercased() + scene.dropFirst() }
        return store.connected ? "Nothing yet" : "Not playing"
    }

    // MARK: - Sounds

    private var sounds: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeading(title: "Sounds", aside: "\(store.state.tracks.count) of \(maxTracks)")
            if store.state.tracks.isEmpty {
                Text("No sounds yet. Draw something, or add one below.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.inkMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            ForEach(store.state.tracks) { track in
                ChannelStrip(track: track)
            }
            AddSoundRow(full: store.state.tracks.count >= maxTracks)
        }
    }

    // MARK: - Feel

    private var feel: some View {
        let config = store.state.config
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeading(title: "Feel")
            VStack(alignment: .leading, spacing: 18) {
                RangeKnob(label: "Energy", low: "Calm", high: "Busy", value: config.density,
                          display: "\(Int((config.density * 100).rounded()))%") {
                    store.dispatch(.setConfig(ConfigPatch(density: $0)))
                }
                RangeKnob(label: "Brightness", low: "Dark", high: "Bright", value: config.brightness,
                          display: "\(Int((config.brightness * 100).rounded()))%") {
                    store.dispatch(.setConfig(ConfigPatch(brightness: $0)))
                }
                HStack(spacing: 8) {
                    ToggleChip(title: "Drums", icon: "metronome", on: !config.muteDrums) {
                        store.dispatch(.setConfig(ConfigPatch(muteDrums: !config.muteDrums)))
                    }
                    ToggleChip(title: "Bass", icon: "music.note", on: !config.muteBass) {
                        store.dispatch(.setConfig(ConfigPatch(muteBass: !config.muteBass)))
                    }
                }
                DisclosureGroup(isExpanded: $showMore) {
                    VStack(alignment: .leading, spacing: 18) {
                        RangeKnob(label: "Tempo", low: "Slow", high: "Fast", value: Double(config.bpm),
                                  range: 60...200, display: "\(config.bpm) bpm") {
                            store.dispatch(.setConfig(ConfigPatch(bpm: Int($0.rounded()))))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Key").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                                Spacer()
                                Menu {
                                    Button("Any key") {
                                        store.dispatch(.setConfig(ConfigPatch(scale: MusicScale.unspecified)))
                                    }
                                    ForEach(MusicScale.named, id: \.self) { scale in
                                        Button(MusicScale.display(scale)) {
                                            store.dispatch(.setConfig(ConfigPatch(scale: scale)))
                                        }
                                    }
                                } label: {
                                    Text(MusicScale.display(config.scale))
                                        .font(.system(size: 13))
                                        .padding(.horizontal, 12)
                                        .frame(height: 30)
                                        .background(Theme.secondary, in: Capsule())
                                        .foregroundStyle(Theme.ink)
                                }
                            }
                            Text("The pen always plays in F, so F maj / D min sounds best with it.")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.inkMuted)
                        }
                        RangeKnob(label: "Follow the words", low: "Loose", high: "Strict", value: config.guidance,
                                  range: 0...6, display: String(format: "%.1f", config.guidance)) {
                            store.dispatch(.setConfig(ConfigPatch(guidance: $0)))
                        }
                        Text("Tempo and key changes restart the music for a moment.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.inkMuted)
                    }
                    .padding(.top, 14)
                } label: {
                    Text("Tempo, key and more")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.inkMuted)
                }
                .tint(Theme.inkMuted)
            }
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    // MARK: - Ask

    private var askBar: some View {
        HStack(spacing: 8) {
            TextField(store.thinking ? "Rewriting the mix…" : "Ask for a change: “add a saxophone”", text: $ask)
                .font(.system(size: 13))
                .submitLabel(.send)
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(Theme.panel)
                    .background(Theme.ink, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canAsk)
            .opacity(canAsk ? 1 : 0.3)
            .accessibilityLabel("Send to the band")
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .frame(height: 44)
        .background(Theme.input, in: Capsule())
        .padding(12)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private var canAsk: Bool {
        store.connected && !store.thinking && !ask.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func send() {
        guard canAsk else { return }
        let text = ask
        ask = ""
        Task { await store.trigger(text) }
    }
}

/// One sound: its colour, name and level, what it plays (editable), and a fader.
private struct ChannelStrip: View {
    @EnvironmentObject private var store: SkuzicStore
    let track: Track

    /// The web build's channel colours, keyed off the id's number so a sound
    /// keeps its colour when others go.
    private static let tints: [UInt32] = [0x78A9EE, 0xEE8A80, 0xD89C3F, 0x6BC17F,
                                          0xAB9AF0, 0xE58CB4, 0xADB352, 0x2BBFC8]
    private var tint: Color {
        let n = Int(track.id.filter(\.isNumber)) ?? 0
        return Color(hex: Self.tints[n % Self.tints.count])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(tint).frame(width: 8, height: 8)
                Text(track.label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Spacer()
                Text(track.muted ? "off" : "\(Int((track.volume * 100).rounded()))")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(Theme.inkMuted)
                Button {
                    store.dispatch(.setMuted(target: track.id, muted: !track.muted))
                } label: {
                    Image(systemName: track.muted ? "speaker.slash" : "speaker.wave.2")
                        .font(.system(size: 13))
                        .frame(width: 28, height: 28)
                        .foregroundStyle(Theme.inkMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(track.muted ? "Turn \(track.label) on" : "Turn \(track.label) off")
                Button {
                    store.dispatch(.removeTrack(target: track.id))
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .foregroundStyle(Theme.inkMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(track.label)")
            }
            TextField("What it plays", text: Binding(
                get: { track.prompt },
                set: { store.dispatch(.modifyTrack(target: track.id, label: nil, prompt: $0)) }))
                .font(.system(size: 13))
                .foregroundStyle(Theme.inkMuted)
                .accessibilityLabel("What \(track.label) plays")
            Fader(value: track.volume, tint: tint) {
                store.dispatch(.setVolume(target: track.id, volume: $0))
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .opacity(track.muted ? 0.5 : 1)
    }
}

/// Add a sound in plain words, like "warm cello".
private struct AddSoundRow: View {
    @EnvironmentObject private var store: SkuzicStore
    let full: Bool
    @State private var draft = ""

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus").font(.system(size: 13)).foregroundStyle(Theme.inkMuted)
            TextField(full ? "All \(maxTracks) channels in use" : "Add a sound, like “warm cello”", text: $draft)
                .font(.system(size: 13))
                .disabled(full)
                .submitLabel(.done)
                .onSubmit(add)
            if !draft.trimmingCharacters(in: .whitespaces).isEmpty, !full {
                Button("Add", action: add)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .foregroundStyle(Theme.panel)
                    .background(Theme.ink, in: Capsule())
                    .buttonStyle(.plain)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(height: 44)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }

    private func add() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !full else { return }
        let label = prompt.split(separator: " ").prefix(2).joined(separator: " ")
        store.dispatch(.addTrack(label: label, prompt: prompt, volume: 0.5, origin: "you"))
        draft = ""
    }
}
