import AVFoundation
import SwiftUI

@main
struct SkuzicApp: App {
    @StateObject private var store = SkuzicStore()
    @StateObject private var sketches = SketchStore()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(Preferences.Key.theme.rawValue) private var theme = ThemeChoice.system.rawValue

    init() {
        // The pen can sound before the band connects. Setting the category now
        // puts both on the same playback session from the first stroke.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(sketches)
                .preferredColorScheme(ThemeChoice(rawValue: theme)?.scheme)
                .persistentSystemOverlays(.hidden)
        }
        .onChange(of: scenePhase) { _, phase in
            // Only .background — .inactive also fires for Control Centre and for
            // an unfocused Split View pane, where the canvas is still on screen.
            switch phase {
            case .active: store.resumeIfSuspended()
            case .background: store.suspendForBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: SkuzicStore
    @EnvironmentObject private var sketches: SketchStore
    @State private var open: SketchMeta?

    var body: some View {
        GalleryView(open: $open)
            #if DEBUG
            .onAppear {
                if DemoDrawing.requested != nil || DemoDrawing.preview != nil || DemoDrawing.show != nil,
                   open == nil {
                    open = sketches.create()
                }
            }
            #endif
            .fullScreenCover(item: $open, onDismiss: {
                // Covers swipe-dismiss so the next sketch can auto-connect.
                store.endSession()
            }) { meta in
                ContentView(sketch: meta, onClose: { open = nil })
                    .environmentObject(store)
                    .environmentObject(sketches)
            }
    }
}

