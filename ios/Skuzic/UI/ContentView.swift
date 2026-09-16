import SwiftUI

struct ContentView: View {
    let sketch: SketchMeta
    let onClose: () -> Void

    @EnvironmentObject private var store: SkuzicStore
    @EnvironmentObject private var sketches: SketchStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var canvas = CanvasController()

    @State private var panel: MixPanel.Tab?
    /// Shared by both sections so the window keeps its place, and its size, when
    /// you switch between Mix and Engine.
    @State private var panelOffset = CGSize.zero
    @State private var panelCollapsed = false
    @State private var toast: LogEntry?
    @State private var toastDismiss: Task<Void, Never>?
    @State private var autoInterpretTask: Task<Void, Never>?
    @State private var autoInterpretPending = false

    var body: some View {
        ZStack {
            Theme.workspace.ignoresSafeArea()

            DrawingCanvas(controller: canvas)
                .ignoresSafeArea()

            Button(action: close) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .semibold))
                    Text(sketch.title)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                }
                .foregroundStyle(.white.opacity(0.85))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(.white.opacity(0.12), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.2), radius: 12, y: 4)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding([.top, .leading], 16)

            ToolRail(canvas: canvas)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .padding(.leading, 16)

            TransportBar(
                panel: $panel,
                canInterpret: canvas.hasInk,
                onInterpret: { Task { await interpret() } }
            )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding([.top, .trailing], 16)

            if let toast {
                ActionToast(entry: toast)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 84)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .allowsHitTesting(false)
            }

            if let panel {
                // The reader sits inside the insets so the drag bounds exclude
                // the transport bar the window would otherwise hide under.
                GeometryReader { geo in
                    MixPanel(
                        tab: panel,
                        bounds: geo.size,
                        offset: $panelOffset,
                        collapsed: $panelCollapsed,
                        onClose: { self.panel = nil }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
                .padding(.horizontal, 16)
                .padding(.top, 74)
                .padding(.bottom, 20)
                .transition(.opacity)
            }
        }
        .statusBarHidden(true)
        .animation(.snappy(duration: 0.22), value: panel)
        .animation(.snappy(duration: 0.28), value: toast?.id)
        .task {
            canvas.onStrokeBegin = { cancelAutoInterpret(clearPending: false) }
            canvas.onStrokeEnd = {
                store.noteCanvasHasInk(canvas.hasInk)
                interpretIfAuto()
            }
            if let saved = sketches.loadDrawing(sketch.id) { canvas.load(saved) }
            store.adopt(sketches.loadState(sketch.id))
            store.noteCanvasHasInk(canvas.hasInk)
            // Always connect on open (blank new sketches included). Playback
            // still waits for ink + mix; drawing after connect should not need
            // another Start tap.
            await store.start()
            // Strokes that landed while connecting never scheduled a plan.
            interpretIfAuto()
        }
        .onChange(of: canvas.hasInk) { _, hasInk in
            store.noteCanvasHasInk(hasInk)
            if hasInk { interpretIfAuto() } else { cancelAutoInterpret() }
        }
        .onChange(of: store.thinking) { _, thinking in
            // Strokes made during a request must still update the final mix.
            if !thinking, autoInterpretPending { interpretIfAuto() }
        }
        .onChange(of: store.autoInterpret) { _, enabled in
            if enabled { interpretIfAuto() } else { cancelAutoInterpret() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Backgrounding can be followed by termination, so commit to disk.
            if phase == .background {
                cancelAutoInterpret(clearPending: false)
                persist()
            } else if phase == .active, autoInterpretPending {
                interpretIfAuto()
            }
        }
        .onDisappear {
            cancelAutoInterpret()
            canvas.onStrokeBegin = nil
            canvas.onStrokeEnd = nil
        }
        .onChange(of: store.log.first?.id) { _, _ in
            guard let latest = store.log.first else { return }
            toast = latest
            // A burst of plans should extend the toast, not stack them up.
            toastDismiss?.cancel()
            toastDismiss = Task {
                try? await Task.sleep(nanoseconds: 4_500_000_000)
                guard !Task.isCancelled else { return }
                toast = nil
            }
        }
    }

    // MARK: - Pieces

    // MARK: - Actions

    private func interpret() async {
        cancelAutoInterpret()
        guard canvas.hasInk, !canvas.isDrawing, !store.thinking, store.connected else { return }
        let exportStarted = Diagnostics.now
        Diagnostics.event(.drawing, "EXPORT_BEGIN buffer_s=\(String(format: "%.3f", store.buffered))")
        guard let drawing = canvas.exportJPEG() else {
            Diagnostics.event(.drawing, "EXPORT_FAILED")
            return
        }
        Diagnostics.event(.drawing, "EXPORT_END elapsed_ms=\(Diagnostics.milliseconds(since: exportStarted)) bytes=\(drawing.count)")
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
        guard store.autoInterpret, store.connected, canvas.hasInk, scenePhase == .active else { return }
        autoInterpretPending = true
        cancelAutoInterpret(clearPending: false)
        guard !canvas.isDrawing else { return }

        // Wait for a pause in drawing before rendering/uploading the canvas.
        // Beginning another stroke cancels this wait, including long strokes.
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

/// Status, transport and master volume, kept to a single floating capsule so it
/// never competes with the drawing surface.
private struct TransportBar: View {
    @EnvironmentObject private var store: SkuzicStore
    @Binding var panel: MixPanel.Tab?
    let canInterpret: Bool
    let onInterpret: () -> Void

    @State private var showLog = false

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(dotColor)
                .frame(width: 7, height: 7)

            Text(statusText)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)

            if store.connected {
                Divider().frame(height: 18).overlay(.white.opacity(0.15))

                Image(systemName: "speaker.wave.2")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
                Slider(
                    value: Binding(
                        get: { Double(store.masterVolume) },
                        set: { store.masterVolume = Float($0) }
                    ), in: 0...1
                )
                .frame(width: 90)
                .tint(.white)

                Button {
                    store.togglePlayback()
                } label: {
                    Image(systemName: store.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 16))
                        .frame(width: 38, height: 34)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)

                Button {
                    store.stop()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 15))
                        .frame(width: 38, height: 34)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.6))
            } else {
                Button {
                    Task { await store.start() }
                } label: {
                    Text(store.status == .connecting ? "starting…" : "start")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(.white))
                }
                .buttonStyle(.plain)
                .disabled(store.status == .connecting || !store.hasKey)
            }

            Divider().frame(height: 18).overlay(.white.opacity(0.15))

            BarButton(icon: "list.bullet", active: showLog, badged: !store.log.isEmpty,
                      help: "Actions") {
                showLog.toggle()
            }
            .popover(isPresented: $showLog, arrowEdge: .top) {
                ActionLogList()
                    .environmentObject(store)
                    .presentationCompactAdaptation(.popover)
            }

            BarButton(icon: "slider.vertical.3", active: panel == .mix, help: "Mix") {
                panel = panel == .mix ? nil : .mix
            }

            BarButton(icon: "dial.medium", active: panel == .engine, help: "Engine") {
                panel = panel == .engine ? nil : .engine
            }

            Button(action: onInterpret) {
                Group {
                    if store.thinking {
                        ProgressView().tint(.black).scaleEffect(0.7)
                    } else {
                        EqualizerBars(animated: store.audible) { store.levels(bands: $0) }
                    }
                }
                .frame(width: 46, height: 34)
                .background(Capsule().fill(.white))
                .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
            .disabled(!store.connected || store.thinking || !canInterpret)
            .opacity(!store.connected || !canInterpret ? 0.35 : 1)
            .accessibilityLabel("Interpret drawing")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.12), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.2), radius: 14, y: 5)
    }

    private var statusText: String {
        if !store.hasKey { return "no api key" }
        if store.status == .buffering, !store.statusDetail.isEmpty {
            return store.statusDetail
        }
        if store.connected {
            return "\(store.status.rawValue) · \(String(format: "%.1f", store.buffered))s"
        }
        if store.status == .error, !store.statusDetail.isEmpty {
            return String(store.statusDetail.prefix(40))
        }
        return store.status.rawValue
    }

    private var dotColor: Color {
        switch store.status {
        case .playing: return Color(hex: 0x4ADE9B)
        case .connecting, .buffering: return Color(hex: 0xE8C468)
        case .error: return Color(hex: 0xE8705F)
        case .ready, .paused: return .white.opacity(0.6)
        case .idle: return .white.opacity(0.3)
        }
    }
}


/// Icon button for the transport bar, with an optional unread dot.
private struct BarButton: View {
    let icon: String
    let active: Bool
    var badged = false
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: icon)
                    .font(.system(size: 17))
                    .frame(width: 38, height: 34)

                if badged {
                    Circle()
                        .fill(.white.opacity(0.85))
                        .frame(width: 5, height: 5)
                        .offset(x: -3, y: 5)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? .white : .white.opacity(0.6))
        .accessibilityLabel(help)
    }
}
