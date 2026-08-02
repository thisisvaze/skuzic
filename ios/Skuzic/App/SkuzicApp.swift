import SwiftUI

@main
struct SkuzicApp: App {
    @StateObject private var store = SkuzicStore(apiKey: Secrets.geminiAPIKey)
    @StateObject private var sketches = SketchStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(sketches)
                .preferredColorScheme(.dark)
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

