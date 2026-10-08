import SwiftUI

/// One sketch: the paper edge to edge, the tool rail on the left, the mini
/// player and the buttons along the top, the mixer docked on the right, and on
/// a blank page the vibes to start from. Laid out like the web build's studio.
struct ContentView: View {
    let sketch: SketchMeta
    let onClose: () -> Void

    @EnvironmentObject private var store: SkuzicStore
    @EnvironmentObject private var sketches: SketchStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var canvas = CanvasController()

    /// Wide screens dock the mixer beside the paper and remember whether it was
    /// open; narrower ones slide it up as a sheet that starts closed. The web
    /// build's rule, at the same 1024-point line.
    @AppStorage("skuzic_mixer_open") private var dockOpen = true
    @State private var sheetOpen = false
    @State private var width: CGFloat = 1024
    /// A sheet waiting for the mixer sheet to get out of the way.
    @State private var afterMixer: (() -> Void)?
    @State private var showSettings = false
    @State private var showKeySheet = false
    /// The Gemini fallback, for when the drawing reader can't run on this device.
    @State private var autoInterpretTask: Task<Void, Never>?
    @State private var autoInterpretPending = false

    var body: some View {
        ZStack {
            Theme.desk.ignoresSafeArea()

            ZStack {
                DrawingCanvas(controller: canvas)
                if !canvas.hasInk {
                    VStack(spacing: 8) {
                        Text("Draw anything")
                            .font(.system(size: 34, weight: .semibold))
                            .tracking(-0.8)
                            .foregroundStyle(Color(hex: 0x15130F).opacity(0.22))
                        Text("The paper is listening")
                            .font(.system(size: 14))
                            .foregroundStyle(Color(hex: 0x15130F).opacity(0.38))
                    }
                    .allowsHitTesting(false)
                }
            }
            .padding(.trailing, docked ? 356 : 0)
            .ignoresSafeArea()

            VStack {
                header
                Spacer()
            }

            // Between the header and the bottom edge. On a phone, or a small iPad
            // on its side, the rail is taller than that, so there it scrolls.
            ViewThatFits(in: .vertical) {
                ToolRail(canvas: canvas)
                // Room at the sides for the rail's shadow, which the scroll view clips.
                ScrollView { ToolRail(canvas: canvas).padding(.horizontal, 20) }
                    .scrollIndicators(.hidden)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, -20)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .padding(.leading, 16)
            .padding(.top, 72)
            .padding(.bottom, 16)

            if docked {
                MixerPanel(onClose: { dockOpen = false }, onPickVibe: pick)
                    .frame(width: 340)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Theme.border))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .padding(.top, 76)
                    .padding(.trailing, 16)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }

            if store.connected, !canvas.hasInk, let vibes = store.book?.palette.vibes {
                VibeStrip(vibes: vibes, current: store.vibeID, hint: previewHint, onPick: pick)
                    .frame(maxWidth: 940)
                    .padding(.leading, 112)
                    // Inside the paper: its 22-point inset plus a margin, and the dock when open.
                    .padding(.trailing, (docked ? 356 : 0) + 38)
                    .padding(.bottom, 28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .statusBarHidden(true)
        .animation(.snappy(duration: 0.25), value: docked)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .sheet(isPresented: Binding(get: { !wide && sheetOpen }, set: { sheetOpen = $0 }),
               onDismiss: { afterMixer?(); afterMixer = nil }) {
            MixerPanel(onClose: { sheetOpen = false }, onPickVibe: pick)
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .presentationBackground(Theme.panel)
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet { showSettings = false }
                .environmentObject(store)
        }
        .sheet(isPresented: $showKeySheet) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Paste a free Gemini API key to start the band. It stays on this device.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.inkMuted)
                    ApiKeyEditor {
                        showKeySheet = false
                        Task { await store.start() }
                    }
                    Spacer()
                }
                .padding(24)
                .background(Theme.panel)
                .navigationTitle("Gemini API key")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { showKeySheet = false } }
                }
            }
            .environmentObject(store)
            .presentationDetents([.medium])
        }
        .task {
            canvas.onStrokeBegin = { cancelAutoInterpret(clearPending: false) }
            canvas.onStrokeEnd = {
                store.noteCanvasHasInk(canvas.hasInk)
                follow()
            }
            canvas.onClear = { store.fadeOut() }
            canvas.meter = {
                guard let bands = store.levels(bands: 4), !bands.isEmpty else { return 0 }
                return bands.reduce(0, +) / Float(bands.count)
            }
            if let saved = sketches.loadDrawing(sketch.id) { canvas.load(saved) }
            store.adopt(sketches.loadState(sketch.id))
            store.noteCanvasHasInk(canvas.hasInk)
            // Always connect on open (blank new sketches included). Playback
            // still waits for ink, or for a vibe to be picked.
            await store.start()
            // Strokes that landed while connecting were never read.
            follow()
            #if DEBUG
            if DemoDrawing.show == "settings" { showSettings = true }
            if DemoDrawing.show == "mixer" { showMixer(true) }
            if let id = DemoDrawing.preview, let vibe = store.book?.vibe(id) {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                pick(vibe)
            }
            if let demo = DemoDrawing.requested {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                canvas.load(DemoDrawing.drawing(demo, in: canvas.canvas.bounds))
                canvas.onStrokeEnd?()
                if let wait = DemoDrawing.clearAfter {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    canvas.clear()
                }
            }
            #endif
        }
        .onChange(of: store.thinking) { _, thinking in
            // Strokes made during a request must still update the final mix.
            if !thinking, autoInterpretPending { interpretIfAuto() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Backgrounding can be followed by termination, so commit to disk.
            if phase == .background {
                cancelAutoInterpret(clearPending: false)
                persist()
            }
        }
        .onDisappear {
            cancelAutoInterpret()
            canvas.onStrokeBegin = nil
            canvas.onStrokeEnd = nil
            canvas.onClear = nil
            canvas.meter = { 0 }
        }
    }

    // MARK: - Top bar

    /// The player floats centred on a wide screen; on a phone it takes the room
    /// between the two ends instead, so nothing overlaps.
    private var header: some View {
        HStack(spacing: compact ? 8 : 10) {
            backButton
            if compact { player } else { Spacer() }
            headerButtons
        }
        .overlay { if !compact { player } }
        .padding(.horizontal, 16)
        .padding(.top, 16)
    }

    private var player: some View {
        MiniPlayer(compact: compact, onNeedKey: { present { showKeySheet = true } })
    }

    private var backButton: some View {
        Button(action: close) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                if !compact {
                    Text(sketch.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                }
            }
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 14)
            .frame(height: 40)
            .glass(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to your sketches")
    }

    private var headerButtons: some View {
        HStack(spacing: 2) {
            headerButton(compact ? nil : "Reimagine", icon: "sparkles", label: "Reimagine", tint: Theme.brand3,
                         enabled: store.connected && !store.thinking && canvas.hasInk) {
                Task { await interpret() }
            }
            headerButton(compact ? nil : "Mixer", icon: "slider.horizontal.3", label: "Mixer",
                         pressed: mixerOpen) {
                showMixer(!mixerOpen)
            }
            headerButton(nil, icon: "gearshape", label: "Settings") { present { showSettings = true } }
        }
        .padding(3)
        .glass(Capsule())
    }

    private func headerButton(_ title: String?, icon: String, label: String? = nil, tint: Color? = nil,
                              pressed: Bool = false, enabled: Bool = true,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).foregroundStyle(tint ?? Theme.ink)
                if let title { Text(title).foregroundStyle(Theme.ink) }
            }
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, title == nil ? 10 : 12)
            .frame(height: 34)
            .background(pressed ? Theme.secondary : .clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(label ?? title ?? "")
    }

    private var wide: Bool { width >= 1024 }
    private var compact: Bool { width < 640 }
    private var docked: Bool { wide && dockOpen }
    private var mixerOpen: Bool { wide ? dockOpen : sheetOpen }

    private func showMixer(_ open: Bool) {
        if wide { dockOpen = open } else { sheetOpen = open }
    }

    /// Only one sheet shows at a time, so another one waits for the mixer's to close.
    private func present(_ open: @escaping () -> Void) {
        if !wide && sheetOpen {
            afterMixer = open
            sheetOpen = false
        } else {
            open()
        }
    }

    private var previewHint: String? {
        guard let id = store.previewing, let book = store.book else { return nil }
        return "Previewing \(book.vibe(id).name). Draw to start the band."
    }

    // MARK: - Actions

    private func pick(_ vibe: Palette.Vibe) {
        store.pickVibe(vibe, blank: !canvas.hasInk, page: { [canvas] in canvas.page() })
    }

    /// Lifting the pen: read the page with the eyes, or, where they can't run,
    /// fall back to asking Gemini after a pause.
    private func follow() {
        guard store.connected, onScreen else { return }
        if store.eyesUnavailable {
            interpretIfAuto()
        } else {
            Task { await store.readDrawing { [canvas] in canvas.page() } }
        }
    }

    /// The live app state, not the `scenePhase` captured with the canvas
    /// callbacks: that copy stays at whatever it was when they were set, which
    /// at launch is `.inactive`, and it silently blocked every reading.
    private var onScreen: Bool { UIApplication.shared.applicationState != .background }

    private func interpret() async {
        cancelAutoInterpret()
        guard canvas.hasInk, !canvas.isDrawing, !store.thinking, store.connected else { return }
        guard let drawing = canvas.exportJPEG() else { return }
        await store.trigger("Recognized Input Update", drawing: drawing)
    }

    private func persist() {
        sketches.save(
            id: sketch.id,
            drawing: canvas.drawing,
            thumbnail: canvas.thumbnailPNG(),
            state: store.snapshot
        )
    }

    private func close() {
        cancelAutoInterpret()
        persist()
        store.endSession()
        onClose()
    }

    private func interpretIfAuto() {
        guard store.connected, canvas.hasInk, onScreen else { return }
        autoInterpretPending = true
        cancelAutoInterpret(clearPending: false)
        guard !canvas.isDrawing else { return }

        // Wait for a pause in drawing before rendering/uploading the canvas.
        autoInterpretTask = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 800_000_000) }
            catch { return }
            guard !Task.isCancelled else { return }
            autoInterpretTask = nil
            guard !store.thinking else { return }
            await interpret()
        }
    }

    private func cancelAutoInterpret(clearPending: Bool = true) {
        autoInterpretTask?.cancel()
        autoInterpretTask = nil
        if clearPending { autoInterpretPending = false }
    }
}

/// The mixer at its smallest: play or pause, the meter, what's playing, and
/// the volume. Always on screen, whatever else is open.
private struct MiniPlayer: View {
    @EnvironmentObject private var store: SkuzicStore
    var compact = false
    let onNeedKey: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            button
            if store.audible {
                EqualizerBars(animated: true) { store.levels(bands: $0) }
                    .foregroundStyle(Theme.ink)
            }
            Text(status)
                .font(.system(size: 13))
                .foregroundStyle(store.thinking ? Theme.inkMuted : Theme.ink)
                .lineLimit(1)
                .shimmer(store.thinking)
                .contentTransition(.opacity)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: status)
            if store.status == .error {
                Button("Retry") { Task { await store.start() } }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.ink)
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 16)
        .frame(height: 44)
        .glass(Capsule())
        .frame(maxWidth: 420)
    }

    @ViewBuilder private var button: some View {
        let live = store.playing || store.previewing != nil
        Button {
            if !store.hasKey { onNeedKey() }
            else if !store.connected { Task { await store.start() } }
            else { store.togglePlayback() }
        } label: {
            Image(systemName: live ? "pause.fill" : "play.fill")
                .font(.system(size: 14))
                .frame(width: 36, height: 36)
                .foregroundStyle(live ? .white : Theme.panel)
                .background(live ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.ink), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(live ? "Pause" : "Play")
    }

    private var status: String {
        if !store.hasKey { return "Add a key to play" }
        if store.status == .connecting { return "Starting the music…" }
        if store.status == .error { return "The music dropped out" }
        if let id = store.previewing, !store.playing, let book = store.book {
            return "\(book.vibe(id).name), a preview"
        }
        if !store.connected { return "Not playing" }
        if store.thinking { return "Reimagining…" }
        if store.status == .paused { return "Paused" }
        if store.playing { return "Now playing" }
        return "Draw anything"
    }
}
