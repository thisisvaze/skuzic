import SwiftUI

/// Procreate's gallery: everything you've drawn, newest first, with a new-sketch
/// tile leading. Tapping a card opens the editor and resumes its music.
struct GalleryView: View {
    @EnvironmentObject private var sketches: SketchStore
    @Binding var open: SketchMeta?

    @State private var renaming: SketchMeta?
    @State private var draftTitle = ""

    private let columns = [GridItem(.adaptive(minimum: 210, maximum: 300), spacing: 22)]

    var body: some View {
        ZStack {
            Theme.workspace.ignoresSafeArea()

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
            Text("skuzic")
                .font(.system(size: 20, weight: .semibold))

            Text("\(sketches.sketches.count)")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.35))

            Spacer()

            Button {
                open = sketches.create()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 40, height: 34)
                    .background(Capsule().fill(.white))
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New sketch")
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 16)
        .background(Theme.workspace.opacity(0.96))
    }
}

private struct NewSketchCard: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(
                        .white.opacity(0.18), style: StrokeStyle(lineWidth: 1.5, dash: [7, 6])
                    )
                    .aspectRatio(3 / 4, contentMode: .fit)
                    .overlay(
                        Image(systemName: "plus")
                            .font(.system(size: 26, weight: .light))
                            .foregroundStyle(.white.opacity(0.5))
                    )

                Text("New sketch")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.6))

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
                    .stroke(.white.opacity(0.1), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.35), radius: 12, y: 5)

            Text(meta.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)

            Text(meta.updatedAt.formatted(.relative(presentation: .named)))
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.35))
        }
        .contentShape(Rectangle())
    }
}
