import SwiftUI

private let studioKeyURL = URL(string: "https://aistudio.google.com/apikey")!

/// Paste-your-own Gemini key. Shared by gallery Settings and the engine panel.
struct ApiKeyEditor: View {
    @EnvironmentObject private var store: SkuzicStore
    var onSave: (() -> Void)?
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SecureField("Gemini API key", text: $draft)
                .textContentType(.none)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .onSubmit(save)

            HStack {
                Link("Get a key", destination: studioKeyURL)
                    .font(.system(size: 12))
                Spacer()
                Button("Save", action: save)
            }
            .font(.system(size: 12))

            Text(store.hasKey
                 ? "saved on this device — not in the app binary"
                 : "needed to play. Stays on this device.")
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.35))
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear { draft = Preferences.apiKey }
        .onDisappear { store.setApiKey(draft) }
    }

    private func save() {
        store.setApiKey(draft)
        onSave?()
    }
}
