import Foundation

/// Sample counts belong to one run of the player. A stop/reset creates a new
/// generation, so completions from discarded buffers cannot drain a new run.
struct PlaybackTimeline {
    enum Phase: String { case stopped, buffering, playing, paused }
    struct Ticket: Equatable {
        let generation: UInt64
        let id: UInt64
        let frames: Int64
    }

    let sampleRate: Double
    let startupSeconds: Double
    let capacitySeconds: Double
    private(set) var phase: Phase = .stopped
    private(set) var generation: UInt64 = 0
    private(set) var targetSeconds: Double
    private(set) var underruns = 0
    private(set) var scheduledFrames: Int64 = 0
    private var completedFrames: Int64 = 0
    private var nextID: UInt64 = 0
    private var tickets: [Ticket] = []

    init(sampleRate: Double = 48_000, startupSeconds: Double = 4,
         capacitySeconds: Double = 20) {
        self.sampleRate = sampleRate
        self.startupSeconds = startupSeconds
        self.targetSeconds = startupSeconds
        self.capacitySeconds = capacitySeconds
    }

    var canStart: Bool {
        phase == .buffering && remainingSeconds() >= targetSeconds
    }

    mutating func clear(to phase: Phase, resetTarget: Bool = false) {
        generation &+= 1
        self.phase = phase
        tickets.removeAll(keepingCapacity: true)
        scheduledFrames = 0
        completedFrames = 0
        if resetTarget { targetSeconds = startupSeconds }
    }

    mutating func append(frames: Int64) -> Ticket? {
        guard phase == .buffering || phase == .playing, frames > 0,
              Double(tickets.reduce(0) { $0 + $1.frames } + frames) / sampleRate <= capacitySeconds
        else { return nil }
        nextID &+= 1
        let ticket = Ticket(generation: generation, id: nextID, frames: frames)
        tickets.append(ticket)
        scheduledFrames += frames
        return ticket
    }

    mutating func beginPlayback() -> Bool {
        guard canStart else { return false }
        phase = .playing
        return true
    }

    /// Returns true exactly once when the last audible buffer finishes.
    mutating func complete(_ ticket: Ticket) -> Bool {
        guard ticket.generation == generation,
              let index = tickets.firstIndex(of: ticket) else { return false }
        completedFrames += tickets.remove(at: index).frames
        guard phase == .playing, tickets.isEmpty else { return false }
        underruns += 1
        targetSeconds = min(8, targetSeconds + 2)
        clear(to: .buffering)
        return true
    }

    func remainingSeconds(playhead: Int64? = nil) -> Double {
        let consumed = phase == .playing
            ? max(completedFrames, playhead ?? completedFrames) : completedFrames
        return max(0, Double(scheduledFrames - consumed) / sampleRate)
    }
}
