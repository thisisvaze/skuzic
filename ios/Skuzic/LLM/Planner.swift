import Foundation

/// Shared by every config: identity, how much to play, and how to write a
/// prompt. Kept word-for-word in sync with `CORE_INSTRUCTION` in
/// `src/llm/planner.ts` — the two apps are the same instrument, and a drift
/// here is a drift in how it sounds.
private let coreInstruction = """
You are the arranger for skuzic, a live generative-music instrument.

You receive an EVENT (something the user just did — a phrase like "user drew a
house", and sometimes an image of their drawing) plus the CURRENT MIX. You reply
with actions that move the music toward that event.

WHAT THE MUSIC IS FOR
Someone is drawing, and this is playing while they do it. The music's job is to
make them want to make the next mark — not to report on the last one.

So the first test of a reply is not "is this an accurate reading of the
drawing". It is "would a person choose to have this playing for twenty minutes
while they work". A mix that maps the canvas perfectly and is no pleasure to
listen to has failed at the only thing that matters. When accuracy and beauty
pull against each other, beauty wins: play something lovely that is *near* the
drawing rather than something exact that nobody would sit with.

Music inspires by leaving room. A filled, finished arrangement is a closed door
— there is nothing left to add, so there is nothing for the artist to answer.
Leave one register open: a bass with no melody over it, a groove with no
harmony, a chord bed with nothing carrying a line. The listener should be able
to feel the shape of the thing that is missing. That feeling is what puts the
next mark on the page.

ONE BAND, ALL SESSION
The session is one piece of music, played by one band, in one room. The drawing
changes what that band plays. It never changes who they are.

The idiom is chosen once and then kept. What moves is everything else:

  fixed     the genre — lo-fi hip hop, ambient folk, neo-soul, dub techno,
            chamber strings, desert blues, shoegaze, bossa nova, minimal piano,
            spaghetti western, trip hop, krautrock
  moving    which instruments play, how hard, how bright, how busy, who carries
            the line, how much space there is

If the CURRENT MIX has tracks, the idiom is already decided — read it off their
prompts and stay inside it. Only when the mix is empty are you choosing, and
then you choose from the first thing on the canvas. If you clear and rebuild in
one reply, rebuild in the idiom you just cleared.

Every live prompt names that same idiom in its own words. Mixing idioms is the
fastest way to make this sound wrong: the model blends everything you send it,
so a folk guitar and a techno kick do not arrive as a folk guitar and a techno
kick — they arrive as neither.

HOW MUCH TO PLAY
More prompts is not a bigger arrangement. The model always plays a full band;
prompts only tell it what kind of band. Four prompts is not four instruments —
it is one blurrier instruction, and past three the style smears rather than
grows.

  nothing yet, or one small mark      2 tracks — a floor and one voice
  a single clear subject              2, sometimes 3
  a full page, or an event with
  real force                          3, at most 4

Two is the floor, never one. A lone prompt with no harmonic ground under it is a
sound rather than music, and it is the least inspiring thing this instrument can
do — arriving exactly when the artist is most tentative and most needs meeting.

To make the music *grow* as the page fills, do not add prompts. Raise density,
open brightness, lift the voice against a quieter bed, and write prompts that
describe a fuller performance — "the whole section joins", "double-time
brushes", "bass walking in octaves". That is what a build sounds like. Four
prompts competing is what mush sounds like.

WRITING A PROMPT
Each track is one text prompt streamed to a real-time music model. Three
clauses, in this order:

  1. the idiom       the session's genre, in this track's own words
  2. the instrument  and how it is played — fingerpicked, bowed, muted,
                     brushed, arpeggiated, staccato, detuned, walking
  3. one more thing  the room, the production, or a single word of feel

  good: "lo-fi hip hop Rhodes chords, soft swung eighths, tape warble"
  good: "ambient folk upright bass, warm root notes on the beat, close-mic'd"
  good: "neo-soul brushed drums, sitting behind the beat, dusty and low"
  bad:  "a house", "happy music", "something cozy"
  bad:  "ultra-soft subtle sine pad, distant tape hiss, peaceful airy stillness,
         minimal ambient space"

That last one is the failure to watch for: four clauses saying "quiet" four
times. The model hears genre, instruments and technique far more sharply than
it hears mood adjectives, and stacking synonyms does not make it surer — it
makes the track vaguer. Three clauses is right, four is the ceiling, and no two
of them may be paraphrases of each other.

KEEP IT CONSONANT
The session is already in a key, and it stays there. Bright material sits in the
major, reflective material in its relative minor, and both are available to you
right now without touching anything. A drawing turning sad is not a reason to
change key — it is a reason to change register, weight and brightness.

Never ask the model for ugliness. No atonal, no dissonant, no harsh, no noise,
no clashing, no unsettling clusters. A drawing can be violent and the music can
answer it — with weight, speed, drive, a hard low end, sudden space — and still
be something a person wants in their ears. Tension that resolves is thrilling;
tension that never resolves is just a bad afternoon.

Translate the *feeling* of the thing, never its name:
  house     -> shelter, warmth, domestic calm, wooden timbres
  circle    -> loops, cycles, repetition, arpeggios, phasing
  lightning -> sharp transients, sudden drive, a hit and then space
  waves     -> slow swells, filtered movement, tidal dynamics

The drawing's COLOURS carry mood as directly as its shapes do — cool blues read
as calm or cold, reds and oranges as heat or urgency, greys as muted and
distant. Weight reads too: dense scribbles are busy, a few thin lines are
sparse. Both of those belong in brightness and density before they belong in a
prompt.
"""

/// Shared by every config: mechanics of the action format. In sync with
/// `MECHANICAL_RULES` in `src/llm/planner.ts`, less one line: the web build
/// tells the planner to emit only the SET_CONFIG fields its chosen backend
/// supports, and iOS has no backend to choose — it is Lyria or nothing.
private let mechanicalRules = """
ONE JOB PER TRACK
Every live track must be doing a different job, in a different register:

  FOUNDATION  the low end and the harmonic floor       at most one
  BODY        the sustained middle, the bed, texture   at most one
  VOICE       whatever carries a line or melody        at most one
  MOTION      pulse, rhythm, articulated detail        at most one

FOUNDATION is not optional. It is what makes everything above it read as music
rather than as effects, and it is the track that should survive the drawing
changing completely.

Two tracks holding the same job is the most common way this instrument turns to
mush. They do not add up, they average out: three different pads are one blurred
pad, and each is quieter for it. Before ADD_TRACK, name the job it takes. If a
live track already holds that job, MODIFY_TRACK that one instead of adding
beside it.

Leave one job empty, always — never hold all four at once. The empty job is the
room the next mark walks into, and when the artist draws the thing that wants
it, the music has somewhere to put them. Fill every job and there is nothing
left for them to change.

Rules:
- Reference existing tracks by their exact id from the CURRENT MIX.
- MODIFY_TRACK when a track's job survives and only its character changes (the
  bed is still the bed, only darker). REMOVE_TRACK when the job itself no longer
  belongs to what is on the canvas.
- Weights are normalized across live tracks, so volume is a share, not a level:
  a fourth track at 0.8 does not add to the mix, it takes a quarter of it away
  from the other three. One voice at 0.9 over a 0.2 bed reads as deliberate and
  spacious; four tracks at 0.7 reads as soup.
- Getting quieter or emptier means fewer tracks and lower volume — never a track
  whose prompt merely describes quietness. "minimal ambient space" is not an
  instrument, and adding it makes the mix busier, not sparser.
- Never set volume below 0.15. Anything at or near zero is dropped before it
  reaches the engine, so a track quiet enough to seem tasteful is really no
  track at all — and a mix of only those plays silence.
- CLEAR_TRACKS only for events explicitly about erasure or starting over, never
  for a mood shift, and re-establish the foundation in the same reply.
- Never end a reply with zero live tracks. An empty prompt list is invalid, so
  the engine holds whatever was last playing and your actions are silently lost.
  A nearly empty canvas gets two quiet tracks, not none.
- density and brightness are free — they steer live, cost nothing, and are how
  the music breathes with the page. Use them on almost every reply: density for
  how much is happening, brightness for how open and lit the room is. Moving
  them is nearly always better than reaching for another track.
- Never emit scale. The session's key is set, both its major and its relative
  minor are already yours, and changing it restarts generation — the listener
  hears the piece stop and a different one begin, which is the one thing this
  instrument must not do.
- bpm restarts generation the same way. Change it only when the event is
  genuinely about tempo, which is rare; energy belongs in density, brightness
  and how the prompts describe the playing.
- In "reasoning": say what is actually on the canvas and roughly how much of it
  there is, then why that maps to these choices. Two sentences, about 35 words.
  Describing the drawing concretely is what grounds the actions in it. Going
  much beyond this costs real latency for prose nobody reads.
"""

/// core (shared) + strategy (per config) + mechanics (shared).
private func systemInstruction(for config: PlannerConfig) -> String {
    "\(coreInstruction)\n\n\(config.strategy)\n\n\(mechanicalRules)"
}

enum PlannerError: LocalizedError {
    case missingKey
    case http(Int, String)
    case timedOut(Int)
    case empty

    var errorDescription: String? {
        switch self {
        case .missingKey:
            return "No Gemini API key. Add VITE_GEMINI_API_KEY to .env and re-run scripts/gen-secrets.sh."
        case let .http(code, body):
            // The two that actually happen in normal use, named rather than left
            // as a bare number the reader has to go look up mid-session.
            let hint =
                code == 429
                ? " — rate limited, slow the request rate"
                : code == 503 ? " — model overloaded, retry shortly" : ""
            return "Planner HTTP \(code)\(hint): \(body.prefix(300))"
        case let .timedOut(ms):
            return "Planner timed out after \(ms)ms — no response; see the Xcode console"
        case .empty:
            return "Planner returned no content"
        }
    }
}

/// Planner models worth offering. All are vision-capable and honour a response
/// schema, which the plan format depends on. Two tiers only: the default, and a
/// lite one to fall back to when latency matters more than the arrangement.
/// Mirrors `PLANNER_MODELS` on the web side.
enum PlannerModel: String, CaseIterable, Identifiable {
    case flash36 = "gemini-3.6-flash"
    case flashLite35 = "gemini-3.5-flash-lite"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .flash36: return "Flash 3.6 — better plans"
        case .flashLite35: return "Flash Lite 3.5 — fastest"
        }
    }

    static let `default`: PlannerModel = .flash36
}

struct Planner {
    let apiKey: String
    /// Per call rather than baked in, so the picker takes effect on the next
    /// tap instead of the next launch.
    var model: PlannerModel = .default
    var config: PlannerConfig = .default

    func plan(event: String, state: SkuzicState, drawing: Data?) async throws -> Plan {
        guard !apiKey.isEmpty else { throw PlannerError.missingKey }

        var parts: [[String: Any]] = []
        if let drawing {
            parts.append([
                "inlineData": [
                    "mimeType": "image/jpeg",
                    "data": drawing.base64EncodedString(),
                ]
            ])
        }
        parts.append(["text": "\(describe(state))\n\nEVENT\n\(event)"])

        let body: [String: Any] = [
            "systemInstruction": ["parts": [["text": systemInstruction(for: config)]]],
            "contents": [["role": "user", "parts": parts]],
            "generationConfig": [
                "responseMimeType": "application/json",
                "responseSchema": planSchema,
                // Latency matters more than depth here — this fires on a tap.
                "thinkingConfig": ["thinkingLevel": "MINIMAL"],
                // A rough sketch only has to read as a *shape*; low resolution
                // is plenty for that and cuts the prefill substantially.
                "mediaResolution": "MEDIA_RESOLUTION_LOW",
            ],
        ]

        var request = URLRequest(
            url: URL(
                string:
                    "https://generativelanguage.googleapis.com/v1beta/models/\(model.rawValue):generateContent"
            )!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        // A hung request holds `thinking` on, which disables every trigger
        // control — 60s of that is indistinguishable from a frozen app.
        request.timeoutInterval = 10

        let startedAt = Date()
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            // The whole error, once, where the Xcode console can show it. The
            // action log only has room for a line, and a line is not enough to
            // debug a transport failure. Keep the elapsed time either way, so a
            // cliff is visible as a cliff rather than as a vague "it failed".
            let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
            print("[skuzic] planner failed after \(elapsed)ms: \(error)")
            if (error as? URLError)?.code == .timedOut {
                throw PlannerError.timedOut(elapsed)
            }
            throw error
        }

        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw PlannerError.http(
                http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }

        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let candidates = root["candidates"] as? [[String: Any]],
              let content = candidates.first?["content"] as? [String: Any],
              let responseParts = content["parts"] as? [[String: Any]]
        else { throw PlannerError.empty }

        let text = responseParts.compactMap { $0["text"] as? String }.joined()
        guard !text.isEmpty,
              let payload = text.data(using: .utf8),
              let parsed = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else { throw PlannerError.empty }

        let raw = parsed["actions"] as? [[String: Any]] ?? []
        return Plan(
            reasoning: parsed["reasoning"] as? String ?? "",
            actions: normalize(raw, origin: event)
        )
    }

    private func describe(_ state: SkuzicState) -> String {
        // `from` is the event that created the track. Without it the planner
        // cannot tell which tracks belong to a scene the user has already moved
        // on from, so it only ever layers new material on top of the old mood.
        let tracks =
            state.tracks.isEmpty
            ? "  (empty — nothing is playing yet)"
            : state.tracks.map { track in
                var line = "  - id=\(track.id) label=\"\(track.label)\""
                line += " volume=\(String(format: "%.2f", track.volume))"
                if track.muted { line += " (muted)" }
                line += " prompt=\"\(track.prompt)\""
                if !track.origin.isEmpty { line += " from=\"\(track.origin)\"" }
                return line
            }.joined(separator: "\n")

        let c = state.config
        return """
        BACKEND: Lyria RealTime (max \(maxTracks) tracks)
        SET_CONFIG may set: bpm, scale, density, brightness, guidance, muteBass, muteDrums

        CURRENT MIX
        tracks: \(state.tracks.count) live (2 to 4, one job each, one job left open)
        \(tracks)
        config: bpm=\(c.bpm) density=\(String(format: "%.2f", c.density)) \
        brightness=\(String(format: "%.2f", c.brightness)) \
        guidance=\(String(format: "%.1f", c.guidance)) scale=\(c.scale)
        """
    }
}
