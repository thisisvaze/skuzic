import CoreGraphics
import Foundation

/// What the eyes compose from, shared with the web build: `src/vision/palette.json`
/// (vibes, moods, instruments) and `palette-vectors.json` (their SigLIP 2 text
/// vectors, made by scripts/embed-palette.py). Both files are linked into the
/// app bundle rather than copied, so the two apps can't drift apart.
///
/// The logic is a port of `src/vision/eyes.ts`; see there for why it is shaped
/// this way (layered prompts, chosen by listening test).
struct Palette: Decodable {
    struct Mood: Decodable, Equatable {
        let id: String
        let label: String
        let prompt: String
        let density: Double
        let brightness: Double
        let tags: [String]
    }

    struct Instrument: Decodable, Equatable {
        let id: String
        let label: String
        let prompt: String
        let tags: [String]
    }

    /// Where a session starts: the genre the band plays in, the instruments it
    /// opens with, and the only instruments a drawing may bring in.
    struct Vibe: Decodable, Equatable, Identifiable {
        let id: String
        let name: String
        let blurb: String
        let ground: [String: String]
        let start: [String]
        let instruments: [String]
        let bpm: Int
        let drums: Bool
    }

    let vibes: [Vibe]
    let moodWeight: [String: Double]
    let moods: [Mood]
    let instruments: [Instrument]
}

struct PaletteVectors: Decodable {
    struct Entry: Decodable {
        let tags: [String]
        let vector: [Float]
    }

    let scale: Float
    let moods: [String: Entry]
    let instruments: [String: Entry]
}

struct Ranked<Item> {
    let item: Item
    /// Share of belief across its list, 0...1.
    let p: Double
}

extension Ranked: Equatable where Item: Equatable {}

/// A stroke as the eyes group it, in page points. PencilKit's eraser edits
/// strokes in place, so unlike the web there are no eraser marks to track.
struct Mark {
    /// Unique per stroke, and changed whenever the eraser trims it.
    let id: String
    let color: String
    let points: [CGPoint]
}

/// Strokes that belong together: one thing on the page, read from its own
/// crop. The key changes whenever its strokes do, which is when it needs
/// reading again.
struct Figure: Equatable {
    let key: String
    let box: CGRect
    /// How many strokes make it.
    let strokes: Int
}

/// A figure and what SigLIP made of it.
struct Seen {
    let figure: Figure
    /// Its unit-length SigLIP embedding.
    let image: [Float]
    let moods: [Ranked<Palette.Mood>]
}

/// What the eyes need from the canvas for one read.
struct Page {
    let marks: [Mark]
    let size: CGSize
    /// The whole sheet, for the ink reader.
    let image: CGImage
    /// A square of the page around a figure, as the eyes read it.
    let crop: (CGRect) -> CGImage?
}

struct Reading {
    /// The page's things: every figure's reading weighted by its size, best first.
    let moods: [Ranked<Palette.Mood>]
    let instruments: [Ranked<Palette.Instrument>]
    /// Whether any figure reads clearly as something. The intro waits for one.
    let sure: Bool
}

/// What the music plays: the page's main things by share, the lead first, and
/// one or two instruments.
struct Mix: Equatable {
    let moods: [Ranked<Palette.Mood>]
    let instruments: [Palette.Instrument]
}

/// The palette plus the choices made from it. The iPad plays Lyria only, so the
/// per-engine balances always read the "lyria" entries.
struct PaletteBook {
    let palette: Palette
    let vectors: PaletteVectors

    /// How close, as a share of the page diagonal, a stroke in the same ink
    /// must come to the figure being drawn to join it; a new ink always starts
    /// a new figure.
    static let join = 0.1
    /// Up to three things play at once. One joins at `enter`, or by beating the
    /// weakest playing thing by `swap` once three play, and stays until it falls
    /// under `leave`, so the music settles rather than chasing every stroke.
    static let mixSize = 3
    static let enter = 0.12
    static let leave = 0.08
    static let swap = 0.05
    /// How sure SigLIP must be of some figure before the intro gives way.
    static let minBelief = 0.4
    /// Moods that name the marks rather than a thing. The first stroke of nearly
    /// anything reads as one of these, and a lone line reads as squiggles however
    /// long it is, so they count half: what the page clearly shows leads.
    static let marks: Set<String> = ["energy", "dots", "spiral", "writing"]
    /// The figure being drawn has no say until it reads clearly as a thing or has
    /// this many strokes, or each new object would open on squiggles.
    static let settle = 3
    /// Instruments split belief ten ways, so they need less of it to win a seat.
    static let instrumentBelief = 0.25
    static let instrumentMargin = 0.12
    /// The lead and the colour instrument, under a style at 1.0.
    static let instrumentWeights = [0.6, 0.4]
    /// No layer plays quieter than this; under it a prompt barely registers.
    static let minVolume = 0.15
    static let engine = "lyria"

    init(palette: Data, vectors: Data) throws {
        self.palette = try JSONDecoder().decode(Palette.self, from: palette)
        self.vectors = try JSONDecoder().decode(PaletteVectors.self, from: vectors)
    }

    /// The bundled palette, or nil if the files didn't make it into the build.
    static let shared: PaletteBook? = {
        guard let p = Bundle.main.url(forResource: "palette", withExtension: "json"),
              let v = Bundle.main.url(forResource: "palette-vectors", withExtension: "json"),
              let pd = try? Data(contentsOf: p), let vd = try? Data(contentsOf: v)
        else { return nil }
        return try? PaletteBook(palette: pd, vectors: vd)
    }()

    /// The intro mood has no tags and never competes in a reading.
    var introMood: Palette.Mood { palette.moods[0] }
    /// "Just draw": silence until the first mark, then the drawing picks the sound.
    var defaultVibe: Palette.Vibe { palette.vibes[0] }
    private var readableMoods: [Palette.Mood] { palette.moods.filter { !$0.tags.isEmpty } }

    func vibe(_ id: String) -> Palette.Vibe {
        palette.vibes.first { $0.id == id } ?? defaultVibe
    }

    func instrument(_ id: String) -> Palette.Instrument? {
        palette.instruments.first { $0.id == id }
    }

    /// What an empty page plays, and what first marks play until SigLIP is sure what they are.
    func introMix(_ vibe: Palette.Vibe) -> Mix {
        Mix(moods: [Ranked(item: introMood, p: 1)], instruments: vibe.start.compactMap(instrument))
    }

    func isIntro(_ mix: Mix) -> Bool { mix.moods.first?.item == introMood }

    /// Softmax over scaled similarity, best first.
    private func rank<Item>(_ items: [Item], id: (Item) -> String,
                            table: [String: PaletteVectors.Entry], image: [Float]) -> [Ranked<Item>] {
        let logits: [Double] = items.map { item in
            guard let v = table[id(item)]?.vector, v.count == image.count else { return -.infinity }
            var dot: Float = 0
            for i in 0..<v.count { dot += v[i] * image[i] }
            return Double(vectors.scale * dot)
        }
        guard let top = logits.max(), top.isFinite else { return [] }
        let weights = logits.map { exp($0 - top) }
        let sum = weights.reduce(0, +)
        return zip(items, weights).map { Ranked(item: $0, p: $1 / sum) }.sorted { $0.p > $1.p }
    }

    private static func box(of points: [CGPoint]) -> CGRect {
        let xs = points.map(\.x), ys = points.map(\.y)
        let x0 = xs.min() ?? 0, y0 = ys.min() ?? 0
        return CGRect(x: x0, y: y0, width: (xs.max() ?? 0) - x0, height: (ys.max() ?? 0) - y0)
    }

    /// Whether two boxes come within `gap` of each other. Plain comparisons, since
    /// CGRect treats a flat box (a straight line's) as empty.
    private static func within(_ a: CGRect, _ b: CGRect, _ gap: CGFloat) -> Bool {
        a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY
    }

    /// Whether any point of `a` comes within `reach` of any point of `b`.
    private static func near(_ a: [CGPoint], _ b: [CGPoint], _ reach: CGFloat) -> Bool {
        let r2 = reach * reach
        for i in stride(from: 0, to: a.count, by: 3) {
            for j in stride(from: 0, to: b.count, by: 3) {
                let dx = a[i].x - b[j].x, dy = a[i].y - b[j].y
                if dx * dx + dy * dy <= r2 { return true }
            }
        }
        return false
    }

    /// The page's strokes, in drawing order, as figures.
    func figures(_ marks: [Mark], page: CGSize) -> [Figure] {
        let reach = CGFloat(Self.join) * hypot(page.width, page.height)
        var groups: [(ids: [String], color: String, points: [CGPoint], box: CGRect)] = []
        for mark in marks where !mark.points.isEmpty {
            let box = Self.box(of: mark.points)
            if let last = groups.last, last.color == mark.color,
               Self.within(box, last.box, reach), Self.near(mark.points, last.points, reach) {
                groups[groups.count - 1].ids.append(mark.id)
                groups[groups.count - 1].points += mark.points
                groups[groups.count - 1].box = last.box.union(box)
            } else {
                groups.append((ids: [mark.id], color: mark.color, points: mark.points, box: box))
            }
        }
        return groups.map { Figure(key: $0.ids.joined(separator: " "), box: $0.box, strokes: $0.ids.count) }
    }

    /// What one figure looks like, from its crop's embedding.
    func readFigure(_ image: [Float]) -> [Ranked<Palette.Mood>] {
        rank(readableMoods, id: \.id, table: vectors.moods, image: image)
    }

    /// A figure counts by the square root of its area: a mountain range leads, a sun still shows.
    private static func size(of figure: Figure) -> Double {
        (max(figure.box.width, 8) * max(figure.box.height, 8)).squareRoot()
    }

    /// The page's things: every figure's reading, weighted by its size, as shares.
    /// Marks count half, and only from a figure they lead, never as a runner-up
    /// guess about a figure that reads as something else.
    func scene(_ seen: [Seen]) -> [Ranked<Palette.Mood>] {
        var weights: [String: Double] = [:]
        var moods: [String: Palette.Mood] = [:]
        var total = 0.0
        for s in seen {
            let size = Self.size(of: s.figure)
            for (k, r) in s.moods.enumerated() {
                let w = size * r.p * (Self.marks.contains(r.item.id) ? (k == 0 ? 0.5 : 0) : 1)
                weights[r.item.id, default: 0] += w
                moods[r.item.id] = r.item
                total += w
            }
        }
        guard total > 0 else { return [] }
        return weights.compactMap { id, w in moods[id].map { Ranked(item: $0, p: w / total) } }
            .sorted { $0.p > $1.p }
    }

    /// The whole page as one embedding, its figures' own weighted the same way.
    private func gist(_ seen: [Seen]) -> [Float] {
        var gist = [Float](repeating: 0, count: seen.first?.image.count ?? 0)
        for s in seen {
            let size = Float(Self.size(of: s.figure))
            for i in gist.indices { gist[i] += size * s.image[i] }
        }
        let norm = sqrt(gist.reduce(0) { $0 + $1 * $1 })
        return norm > 0 ? gist.map { $0 / norm } : gist
    }

    /// Whether a figure has a say: any finished one does, the one being drawn once it has settled.
    private static func settled(_ s: Seen, drawing: Bool) -> Bool {
        guard drawing, s.figure.strokes < settle, let top = s.moods.first else { return true }
        return top.p >= minBelief && !marks.contains(top.item.id)
    }

    /// The page as the music needs it: its things, the instruments it suggests,
    /// and whether anything on it is clear. `seen` is in drawing order, so the
    /// last figure is the one being drawn.
    func readScene(_ seen: [Seen], vibe: Palette.Vibe) -> Reading {
        let counted = seen.enumerated().filter { Self.settled($0.element, drawing: $0.offset == seen.count - 1) }.map(\.element)
        return Reading(
            moods: scene(counted),
            // Only the vibe's own instruments compete, so a string quartet never grows a kalimba.
            instruments: counted.isEmpty ? [] : rank(palette.instruments.filter { vibe.instruments.contains($0.id) },
                                                     id: \.id, table: vectors.instruments, image: gist(counted)),
            sure: counted.contains { ($0.moods.first?.p ?? 0) >= Self.minBelief })
    }

    /// The things to play, by their share among themselves. Playing ones keep
    /// their seats while they hold `leave`; a newcomer needs `enter`, and a free
    /// seat or a clear lead over the weakest seat.
    func chooseMoods(_ scene: [Ranked<Palette.Mood>], playing: [Palette.Mood]) -> [Ranked<Palette.Mood>] {
        func share(_ m: Palette.Mood) -> Double { scene.first { $0.item == m }?.p ?? 0 }
        var seats = playing.filter { share($0) >= Self.leave }
        for r in scene {
            if r.p < Self.enter { break }
            if seats.contains(r.item) { continue }
            if seats.count < Self.mixSize {
                seats.append(r.item)
                continue
            }
            if let weakest = seats.min(by: { share($0) < share($1) }), r.p - share(weakest) >= Self.swap,
               let at = seats.firstIndex(of: weakest) {
                seats[at] = r.item
            }
        }
        let total = seats.reduce(0) { $0 + share($1) }
        return seats.map { Ranked(item: $0, p: share($0) / total) }.sorted { $0.p > $1.p }
    }

    /// Each playing instrument keeps its seat unless another clearly beats the
    /// weaker of the two, so one swaps at a time and the other carries the music.
    func chooseInstruments(_ ranked: [Ranked<Palette.Instrument>], playing: [String]) -> [Palette.Instrument] {
        func belief(_ id: String) -> Double { ranked.first { $0.item.id == id }?.p ?? 0 }
        var seats = playing.filter { id in ranked.contains { $0.item.id == id } }
        if seats.isEmpty { return ranked.prefix(2).map(\.item) }
        seats.sort { belief($0) > belief($1) }
        if let challenger = ranked.first(where: { !seats.contains($0.item.id) }),
           let weakest = seats.last,
           challenger.p >= Self.instrumentBelief,
           challenger.p - belief(weakest) >= Self.instrumentMargin {
            seats[seats.count - 1] = challenger.item.id
        }
        return seats.sorted { belief($0) > belief($1) }.compactMap(instrument)
    }

    /// The next mix for this reading, or nil to keep what is playing. An unsure
    /// first reading starts the vibe's opening; after that the intro waits for a
    /// figure SigLIP is sure of, and the music changes only when what it plays does.
    func nextMix(_ reading: Reading, playing: Mix?, vibe: Palette.Vibe) -> Mix? {
        let intro = playing.map(isIntro) ?? true
        let moods = chooseMoods(reading.moods, playing: intro ? [] : playing?.moods.map(\.item) ?? [])
        let ready = !moods.isEmpty && (!intro || reading.sure)
        guard let playing else {
            return ready ? Mix(moods: moods, instruments: chooseInstruments(reading.instruments, playing: []))
                : introMix(vibe)
        }
        guard ready else { return nil }
        let instruments = chooseInstruments(
            reading.instruments, playing: intro ? [] : playing.instruments.map(\.id))
        let same = !intro && moods.map(\.item) == playing.moods.map(\.item) && instruments == playing.instruments
        return same ? nil : Mix(moods: moods, instruments: instruments)
    }

    /// What the music is playing, in words: "mountains, trees and bicycle".
    static func title(_ mix: Mix) -> String {
        let names = mix.moods.map(\.item.label)
        guard let last = names.last, names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + last
    }

    /// The mix's base energy and brightness, each thing pulling by its share.
    static func feel(_ mix: Mix) -> (density: Double, brightness: Double) {
        (mix.moods.reduce(0) { $0 + $1.p * $1.item.density },
         mix.moods.reduce(0) { $0 + $1.p * $1.item.brightness })
    }

    static func origin(of mix: Mix) -> String { "drawing read as \(title(mix))" }

    /// Whether the tracks playing are still the eyes' own, not rewritten by Gemini.
    static func eyesOwn(_ tracks: [Track], _ mix: Mix) -> Bool {
        tracks.allSatisfy { $0.origin == origin(of: mix) }
    }

    /// The mix as tracks. The page's things share the mood's measured weight,
    /// so a busy page keeps the balance the listening test chose. Layers whose
    /// prompt doesn't change play straight through, since the mixer keys on
    /// prompt text.
    func mixActions(_ mix: Mix, config: ConfigPatch, vibe: Palette.Vibe) -> [Action] {
        let origin = Self.origin(of: mix)
        let weight = palette.moodWeight[Self.engine] ?? 0.45
        var actions: [Action] = [
            .clearTracks,
            .addTrack(label: "Style", prompt: vibe.ground[Self.engine] ?? "", volume: 1, origin: origin),
        ]
        for r in mix.moods {
            actions.append(.addTrack(label: isIntro(mix) ? "Mood" : r.item.label, prompt: r.item.prompt,
                                     volume: max(Self.minVolume, (weight * r.p * 100).rounded() / 100),
                                     origin: origin))
        }
        for (i, inst) in mix.instruments.prefix(2).enumerated() {
            actions.append(.addTrack(label: inst.label, prompt: inst.prompt,
                                     volume: Self.instrumentWeights[i], origin: origin))
        }
        if !config.isEmpty { actions.append(.setConfig(config)) }
        return actions
    }
}
