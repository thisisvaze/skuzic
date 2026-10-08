import SwiftUI

/// The music's controls, docked beside the paper: the vibe, every sound as a
/// fader, the other knobs folded under Advanced, and a box to ask for a
/// change. History says what changed and why. A port of the web build's mixer
/// (src/ui/Mixer.tsx).
struct MixerPanel: View {
    @EnvironmentObject private var store: SkuzicStore
    let onClose: () -> Void
    let onPickVibe: (Palette.Vibe) -> Void

    @State private var tab: Tab = .mix
    @State private var choosingVibe = false
    @State private var ask = ""
    @State private var showAdvanced = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                        vibeCard
                        sounds
                        advanced
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

    // MARK: - Vibe

    @ViewBuilder private var vibeCard: some View {
        if let vibe = store.vibe, let vibes = store.book?.palette.vibes {
            VStack(alignment: .leading, spacing: 0) {
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
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
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
            ForEach(Self.keyed(store.state.tracks)) { item in
                ChannelStrip(track: item.track)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
            AddSoundRow(full: store.state.tracks.count >= maxTracks)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: Self.keyed(store.state.tracks).map(\.id))
    }

    /// A track keyed by name, numbered when two share one.
    private struct Keyed: Identifiable {
        let id: String
        let track: Track
    }

    /// By name, not id: the eyes rebuild the mix with fresh ids whenever the
    /// page changes scene, and a sound that stays should keep its row rather
    /// than fade in again with the newcomers.
    private static func keyed(_ tracks: [Track]) -> [Keyed] {
        var seen: [String: Int] = [:]
        return tracks.map { track in
            let n = seen[track.label, default: 0]
            seen[track.label] = n + 1
            return Keyed(id: n == 0 ? track.label : "\(track.label)#\(n)", track: track)
        }
    }

    // MARK: - Advanced

    /// Every knob past the sounds, folded under one heading: the drawing and
    /// Gemini set them as it goes.
    private var advanced: some View {
        let config = store.state.config
        return DisclosureGroup(isExpanded: $showAdvanced) {
            VStack(alignment: .leading, spacing: 8) {
                RangeKnob(label: "Energy", low: "Still", high: "Flowing", value: config.density,
                          display: "\(Int((config.density * 100).rounded()))%") {
                    store.dispatch(.setConfig(ConfigPatch(density: $0)))
                }
                .knobCard()
                RangeKnob(label: "Brightness", low: "Mellow", high: "Bright", value: config.brightness,
                          display: "\(Int((config.brightness * 100).rounded()))%") {
                    store.dispatch(.setConfig(ConfigPatch(brightness: $0)))
                }
                .knobCard()
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        ToggleChip(title: "Drums", icon: "metronome", on: !config.muteDrums) {
                            store.dispatch(.setConfig(ConfigPatch(muteDrums: !config.muteDrums)))
                        }
                        ToggleChip(title: "Bass", icon: "music.note", on: !config.muteBass) {
                            store.dispatch(.setConfig(ConfigPatch(muteBass: !config.muteBass)))
                        }
                    }
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
                }
                .knobCard()
                RangeKnob(label: "Tempo", low: "Slow", high: "Fast", value: Double(config.bpm),
                          range: Double(Calm.bpm.lowerBound)...Double(Calm.bpm.upperBound),
                          display: "\(config.bpm) bpm") {
                    store.dispatch(.setConfig(ConfigPatch(bpm: Int($0.rounded()))))
                }
                .knobCard()
                RangeKnob(label: "Follow the words", low: "Loose", high: "Strict", value: config.guidance,
                          range: Calm.guidance, display: String(format: "%.1f", config.guidance)) {
                    store.dispatch(.setConfig(ConfigPatch(guidance: $0)))
                }
                .knobCard()
                Text("Tempo and key changes restart the music for a moment.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.inkMuted)
                    .padding(.horizontal, 4)
            }
            .padding(.top, 8)
        } label: {
            Text("Advanced")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.inkMuted)
                .padding(.leading, 4)
        }
        .tint(Theme.inkMuted)
    }

    // MARK: - Ask

    private var askBar: some View {
        HStack(spacing: 8) {
            TextField(store.thinking ? "" : "Ask for a change: “make it more chill”", text: $ask)
                .font(.system(size: 13))
                .submitLabel(.send)
                .onSubmit(send)
                .disabled(store.thinking)
                // While Gemini works the box rests, and its words shimmer in where the hint was.
                .overlay(alignment: .leading) {
                    if store.thinking {
                        Text("Rewriting the mix…")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.inkMuted)
                            .shimmer()
                            .allowsHitTesting(false)
                            .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: store.thinking)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var editing: Bool
    /// Words that change from outside (Gemini, the eyes) fade in rather than snap.
    @State private var wordsOpacity = 1.0

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
                .focused($editing)
                .opacity(wordsOpacity)
                .onChange(of: track.prompt) {
                    // Never while you type in it.
                    guard !editing, !reduceMotion else { return }
                    var still = Transaction()
                    still.disablesAnimations = true
                    withTransaction(still) { wordsOpacity = 0.2 }
                    DispatchQueue.main.async {
                        withAnimation(.easeOut(duration: 0.45)) { wordsOpacity = 1 }
                    }
                }
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

private extension View {
    /// One knob on its own card, like a sound's.
    func knobCard() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
