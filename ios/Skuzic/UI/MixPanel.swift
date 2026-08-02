import SwiftUI

/// Everything that isn't drawing: the live mix, Lyria's knobs, and what the
/// planner did. Slides in over the canvas rather than taking space from it.
struct MixPanel: View {
    @EnvironmentObject private var store: SkuzicStore
    /// Which section to show. The transport bar owns the choice, so each button
    /// opens straight to its own panel rather than landing on a tab picker.
    let tab: Tab
    /// The area the window is free to move in, so it can never be dragged
    /// entirely off screen.
    let bounds: CGSize
    @Binding var offset: CGSize
    @Binding var collapsed: Bool
    let onClose: () -> Void

    /// Captured when a drag starts; `offset` is shared so the window keeps its
    /// place when you switch between Mix and Engine.
    @State private var dragBase: CGSize?

    enum Tab: String, CaseIterable {
        case mix = "Mix"
        case engine = "Engine"

        var icon: String {
            switch self {
            case .mix: return "slider.vertical.3"
            case .engine: return "dial.medium"
            }
        }
    }

    private let panelSize = CGSize(width: 300, height: 360)
    private let bubble: CGFloat = 48

    var body: some View {
        Group {
            if collapsed { collapsedBubble } else { window }
        }
        .offset(offset)
    }

    // MARK: - Window

    private var window: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(.white.opacity(0.1))

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    switch tab {
                    case .mix: mixTab
                    case .engine: engineTab
                    }
                }
                .padding(14)
            }
        }
        .frame(width: panelSize.width, height: panelSize.height)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.32), radius: 22, y: 8)
    }

    /// Doubles as the drag handle — the body scrolls, so only the bar can move it.
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.3))

            Text(tab.rawValue)
                .font(.system(size: 13, weight: .medium))

            Spacer()

            Button {
                withAnimation(.snappy(duration: 0.24)) {
                    collapsed = true
                    offset = nearestCorner(for: CGSize(width: bubble, height: bubble))
                }
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white.opacity(0.6))
            .accessibilityLabel("Collapse")

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white.opacity(0.6))
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .gesture(dragGesture(for: panelSize))
    }

    private var collapsedBubble: some View {
        Button {
            withAnimation(.snappy(duration: 0.24)) {
                collapsed = false
                offset = clamped(offset, for: panelSize)
            }
        } label: {
            Image(systemName: tab.icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: bubble, height: bubble)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(.white.opacity(0.14), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.3), radius: 14, y: 5)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Expand \(tab.rawValue)")
        .gesture(dragGesture(for: CGSize(width: bubble, height: bubble)))
    }

    // MARK: - Dragging

    private func dragGesture(for size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                let base = dragBase ?? offset
                if dragBase == nil { dragBase = base }
                offset = clamped(
                    CGSize(width: base.width + value.translation.width,
                           height: base.height + value.translation.height),
                    for: size)
            }
            .onEnded { _ in dragBase = nil }
    }

    /// The window is anchored top-trailing, so x runs negative going left and y
    /// positive going down.
    private func clamped(_ proposed: CGSize, for size: CGSize) -> CGSize {
        CGSize(
            width: min(0, max(-(bounds.width - size.width), proposed.width)),
            height: max(0, min(bounds.height - size.height, proposed.height)))
    }

    private func nearestCorner(for size: CGSize) -> CGSize {
        let minX = -(bounds.width - size.width)
        let maxY = bounds.height - size.height
        let centreX = offset.width + size.width / 2
        let centreY = offset.height + size.height / 2
        return CGSize(
            width: centreX < -(bounds.width / 2) + size.width ? minX : 0,
            height: centreY > bounds.height / 2 ? maxY : 0)
    }

    // MARK: - Tabs

    @ViewBuilder private var mixTab: some View {
        Text("\(store.state.tracks.count) / \(maxTracks) tracks")
            .font(.system(size: 11))
            .foregroundStyle(.white.opacity(0.45))

        if store.state.tracks.isEmpty {
            Text("nothing playing yet")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.4))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24)
        }

        ForEach(store.state.tracks) { track in
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(track.label)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)

                    Spacer()

                    Button {
                        store.dispatch(.setMuted(target: track.id, muted: !track.muted))
                    } label: {
                        Image(systemName: track.muted ? "speaker.slash" : "speaker.wave.2")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(track.muted ? .white.opacity(0.35) : .white.opacity(0.75))

                    Button {
                        store.dispatch(.removeTrack(target: track.id))
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white.opacity(0.35))
                }

                Text(track.prompt)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                Slider(
                    value: Binding(
                        get: { track.volume },
                        set: { store.dispatch(.setVolume(target: track.id, volume: $0)) }
                    ), in: 0...1
                )
                .tint(.white.opacity(track.muted ? 0.25 : 0.85))
            }
            .padding(11)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    @ViewBuilder private var engineTab: some View {
        let config = store.state.config

        knob("bpm", value: Double(config.bpm), range: 60...200, display: "\(config.bpm)") {
            store.dispatch(.setConfig(ConfigPatch(bpm: Int($0))))
        }
        knob("density", value: config.density, range: 0...1) {
            store.dispatch(.setConfig(ConfigPatch(density: $0)))
        }
        knob("brightness", value: config.brightness, range: 0...1) {
            store.dispatch(.setConfig(ConfigPatch(brightness: $0)))
        }
        knob("guidance", value: config.guidance, range: 0...6) {
            store.dispatch(.setConfig(ConfigPatch(guidance: $0)))
        }

        HStack {
            Text("scale").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
            Spacer()
            Menu {
                Button("auto") {
                    store.dispatch(.setConfig(ConfigPatch(scale: MusicScale.unspecified)))
                }
                ForEach(MusicScale.named, id: \.self) { scale in
                    Button(MusicScale.display(scale)) {
                        store.dispatch(.setConfig(ConfigPatch(scale: scale)))
                    }
                }
            } label: {
                Text(MusicScale.display(config.scale))
                    .font(.system(size: 12))
                    .foregroundStyle(.white)
            }
        }

        Toggle(
            "mute bass",
            isOn: Binding(
                get: { config.muteBass },
                set: { store.dispatch(.setConfig(ConfigPatch(muteBass: $0))) })
        )
        .font(.system(size: 12))

        Toggle(
            "mute drums",
            isOn: Binding(
                get: { config.muteDrums },
                set: { store.dispatch(.setConfig(ConfigPatch(muteDrums: $0))) })
        )
        .font(.system(size: 12))

        Text("bpm and scale changes restart generation")
            .font(.system(size: 10.5))
            .foregroundStyle(.white.opacity(0.35))
            .padding(.top, 2)

        Divider().overlay(.white.opacity(0.1)).padding(.vertical, 4)

        Toggle("auto-interpret", isOn: $store.autoInterpret)
            .font(.system(size: 12))

        Text("read the drawing after every stroke, instead of waiting for the button")
            .font(.system(size: 10.5))
            .foregroundStyle(.white.opacity(0.35))
            .fixedSize(horizontal: false, vertical: true)

        Divider().overlay(.white.opacity(0.1)).padding(.vertical, 4)

        HStack {
            Text("arranger")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.6))
            Spacer()
            Picker("arranger", selection: $store.plannerConfig) {
                ForEach(PlannerConfig.allCases) { config in
                    Text(config.label).tag(config)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .font(.system(size: 12))
        }

        Text(store.plannerConfig.summary)
            .font(.system(size: 10.5))
            .foregroundStyle(.white.opacity(0.35))
            .fixedSize(horizontal: false, vertical: true)

        HStack {
            Text("planner model")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.6))
            Spacer()
            Picker("planner model", selection: $store.plannerModel) {
                ForEach(PlannerModel.allCases) { model in
                    Text(model.label).tag(model)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .font(.system(size: 12))
        }

        Text("which Gemini model reads the drawing and plans the mix")
            .font(.system(size: 10.5))
            .foregroundStyle(.white.opacity(0.35))
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Bits

    @ViewBuilder
    private func knob(
        _ label: String,
        value: Double,
        range: ClosedRange<Double>,
        display: String? = nil,
        set: @escaping (Double) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                Spacer()
                Text(display ?? String(format: "%.2f", value))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.75))
            }
            Slider(value: Binding(get: { value }, set: set), in: range)
                .tint(.white.opacity(0.85))
        }
    }
}
