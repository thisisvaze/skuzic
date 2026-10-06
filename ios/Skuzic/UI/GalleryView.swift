import SwiftUI

/// Procreate's gallery: everything you've drawn, newest first, with a new-sketch
/// tile leading. Tapping a card opens the editor and resumes its music.
struct GalleryView: View {
    @EnvironmentObject private var sketches: SketchStore
    @EnvironmentObject private var store: SkuzicStore
    @Binding var open: SketchMeta?

    @State private var renaming: SketchMeta?
    @State private var draftTitle = ""
    @State private var showSettings = false

    private let columns = [GridItem(.adaptive(minimum: 210, maximum: 300), spacing: 22)]

    var body: some View {
        ZStack {
            Theme.desk.ignoresSafeArea()

            ScrollView {
                LazyVGrid(columns: columns, spacing: 24) {
                    NewSketchCard { open = sketches.create() }

                    ForEach(sketches.sketches) { meta in
                        SketchCard(meta: meta, thumbnail: sketches.thumbnailURL(meta.id))
                            .onTapGesture { open = meta }
                            .contextMenu {
                                Button {
                                    draftTitle = meta.title
                                    renaming = meta
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                Button(role: .destructive) {
                                    sketches.delete(meta.id)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
                .padding(24)
            }
            .safeAreaInset(edge: .top) { header }
        }
        .statusBarHidden(true)
        .sheet(isPresented: $showSettings) {
            SettingsSheet { showSettings = false }
                .environmentObject(store)
        }
        .alert("Rename sketch", isPresented: .constant(renaming != nil)) {
            TextField("Title", text: $draftTitle)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Save") {
                if let renaming { sketches.rename(renaming.id, to: draftTitle) }
                renaming = nil
            }
        }
    }

    private var header: some View {
        HStack {
            Wordmark()

            Text("\(sketches.sketches.count)")
                .font(.system(size: 13))
                .foregroundStyle(Theme.inkMuted)

            Spacer()

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 40, height: 34)
                    .foregroundStyle(Theme.ink)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")

            Button {
                open = sketches.create()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 40, height: 34)
                    .background(Capsule().fill(Theme.ink))
                    .foregroundStyle(Theme.panel)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New sketch")
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 16)
        .background(Theme.desk.opacity(0.96))
    }
}

private struct NewSketchCard: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1.5, dash: [7, 6]))
                    .aspectRatio(3 / 4, contentMode: .fit)
                    .overlay(
                        Image(systemName: "plus")
                            .font(.system(size: 26, weight: .light))
                            .foregroundStyle(Theme.inkMuted)
                    )

                Text("New sketch")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.inkMuted)

                Text(" ")
                    .font(.system(size: 11))
            }
        }
        .buttonStyle(.plain)
    }
}

private struct SketchCard: View {
    let meta: SketchMeta
    let thumbnail: URL

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.paper)

                // Loaded straight off disk; a missing file just leaves blank paper.
                if let image = UIImage(contentsOfFile: thumbnail.path) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
            }
            .aspectRatio(3 / 4, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.12), radius: 12, y: 5)

            Text(meta.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)

            Text(meta.updatedAt.formatted(.relative(presentation: .named)))
                .font(.system(size: 11))
                .foregroundStyle(Theme.inkMuted)
        }
        .contentShape(Rectangle())
    }
}
