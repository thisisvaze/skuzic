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
    /// Share of SigLIP's belief across its list, 0...1.
    let p: Double
}

struct Reading {
    let moods: [Ranked<Palette.Mood>]
    let instruments: [Ranked<Palette.Instrument>]
}

/// What the band plays: a mood and one or two instruments, the lead first.
struct Mix: Equatable {
    let mood: Palette.Mood
    let instruments: [Palette.Instrument]
}

/// The palette plus the choices made from it. The iPad plays Lyria only, so the
/// per-engine balances always read the "lyria" entries.
struct PaletteBook {
    let palette: Palette
    let vectors: PaletteVectors

    /// How sure SigLIP must be, and by how much it must prefer a new mood over
    /// the playing one, before the band changes.
    static let minBelief = 0.4
    static let switchMargin = 0.15
    /// Instruments split belief ten ways, so they need less of it to win a seat.
    static let instrumentBelief = 0.25
    static let instrumentMargin = 0.12
    /// The lead and the colour instrument, under a style at 1.0.
    static let instrumentWeights = [0.6, 0.4]
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
        Mix(mood: introMood, instruments: vibe.start.compactMap(instrument))
    }

    func isIntro(_ mix: Mix) -> Bool { mix.mood == introMood }

    /// Softmax over scaled cosine similarity, best first.
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

    func readPage(_ image: [Float], vibe: Palette.Vibe) -> Reading {
        Reading(
            moods: rank(readableMoods, id: \.id, table: vectors.moods, image: image),
            // Only the vibe's own instruments compete, so a string quartet never grows a kalimba.
            instruments: rank(palette.instruments.filter { vibe.instruments.contains($0.id) },
                              id: \.id, table: vectors.instruments, image: image))
    }

    /// The mood to switch to, or nil to keep what is playing.
    func chooseMood(_ ranked: [Ranked<Palette.Mood>], playing: String?) -> Palette.Mood? {
        guard let best = ranked.first else { return nil }
        let current = ranked.first { $0.item.id == playing }?.p ?? 0
        return best.p >= Self.minBelief && best.p - current >= Self.switchMargin ? best.item : nil
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
    /// first reading starts the vibe's opening; after that an unsure page holds.
    func nextMix(_ reading: Reading, playing: Mix?, vibe: Palette.Vibe) -> Mix? {
        let mood = chooseMood(reading.moods, playing: playing?.mood.id)
        guard let playing else {
            return mood.map { Mix(mood: $0, instruments: chooseInstruments(reading.instruments, playing: [])) }
                ?? introMix(vibe)
        }
        if isIntro(playing), mood == nil { return nil }
        let instruments = chooseInstruments(
            reading.instruments, playing: isIntro(playing) ? [] : playing.instruments.map(\.id))
        let next = Mix(mood: mood ?? playing.mood, instruments: instruments)
        return next == playing ? nil : next
    }

    static func origin(of mix: Mix) -> String { "drawing read as \(mix.mood.label)" }

    /// Whether the tracks playing are still the eyes' own, not rewritten by Gemini.
    static func eyesOwn(_ tracks: [Track], _ mix: Mix) -> Bool {
        tracks.allSatisfy { $0.origin == origin(of: mix) }
    }

    /// The mix as tracks. Layers whose prompt doesn't change play straight
    /// through, since the mixer keys on prompt text.
    func mixActions(_ mix: Mix, config: ConfigPatch, vibe: Palette.Vibe) -> [Action] {
        let origin = Self.origin(of: mix)
        var actions: [Action] = [
            .clearTracks,
            .addTrack(label: "Style", prompt: vibe.ground[Self.engine] ?? "", volume: 1, origin: origin),
            .addTrack(label: "Mood", prompt: mix.mood.prompt,
                      volume: palette.moodWeight[Self.engine] ?? 0.45, origin: origin),
        ]
        for (i, inst) in mix.instruments.prefix(2).enumerated() {
            actions.append(.addTrack(label: inst.label, prompt: inst.prompt,
                                     volume: Self.instrumentWeights[i], origin: origin))
        }
        if !config.isEmpty { actions.append(.setConfig(config)) }
        return actions
    }
}
