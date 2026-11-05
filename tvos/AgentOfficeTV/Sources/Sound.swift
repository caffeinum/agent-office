import AVFoundation

/// One sound-plan.js cue: join / leave {agent}, place / break {x, z}, ding {agent}, babble {agent, voice, syllables, question}.
struct SoundCue: Decodable {
    let sound: String
    let agent: String?
    let x: Double?
    let z: Double?
    let voice: Int?
    let syllables: Int?
    let question: Bool?
}

/// The web's sound.js recipes, synthesized here into buffers and played on AVAudioEngine: chunky, short, blocky foley
/// (thunks, crunches, pops, blip-babble), all generated, no recorded assets. Up to `maxVoices` at once, panned.
final class SoundPlayer {
    private let engine = AVAudioEngine()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
    private var voices: [AVAudioPlayerNode] = []
    private var cache: [String: AVAudioPCMBuffer] = [:]
    private static let maxVoices = 6
    private static let master: Float = Float(ProcessInfo.processInfo.environment["AO_VOLUME"] ?? "0.32") ?? 0.32
    private static let gain: [String: Float] = ["place": 0.8, "break": 0.7, "join": 0.6, "leave": 0.55, "ding": 0.5, "babble": 0.55]
    private static let length: [String: Double] = ["place": 0.15, "break": 0.25, "join": 0.15, "leave": 0.2, "ding": 0.45, "babble": 0.65]

    init() throws {
        try AVAudioSession.sharedInstance().setCategory(.ambient)
        for _ in 0..<Self.maxVoices {
            let n = AVAudioPlayerNode()
            engine.attach(n)
            engine.connect(n, to: engine.mainMixerNode, format: format)
            voices.append(n)
        }
        try engine.start()
    }

    /// Plays cues; `pan` maps a cue to -1 (left) … 1 (right) of the screen.
    func play(_ cues: [SoundCue], pan: (SoundCue) -> Float) {
        for cue in cues {
            guard let v = voices.first(where: { !$0.isPlaying }) else { return }
            guard Self.gain[cue.sound] != nil else { preconditionFailure("no sound recipe for \(cue.sound)") }
            v.pan = max(-1, min(1, pan(cue)))
            v.scheduleBuffer(buffer(cue)) { [weak v] in DispatchQueue.main.async { v?.stop() } }
            v.play()
        }
    }

    private func buffer(_ cue: SoundCue) -> AVAudioPCMBuffer {
        // babble is different every time; the rest are cached
        if cue.sound != "babble", let b = cache[cue.sound] { return b }
        var s = Synth(seconds: Self.length[cue.sound]! + 0.1)
        switch cue.sound {
        case "place":
            s.tone(0, .sine, 150, 70, 0.09, 0.9)
            s.burst(0, 900 + .random(in: 0...300), 3, 0.06, 0.7)
        case "break":
            for i in 0..<4 { s.burst(Double(i) * 0.045, 1400 - Double(i) * 220 + .random(in: 0...150), 2.2, 0.05, 0.8 - Double(i) * 0.15) }
        case "join":
            s.tone(0, .square, 330, 880, 0.11, 0.35)
            s.burst(0, 2400, 5, 0.02, 0.4)
        case "leave":
            s.burst(0, 700, 4, 0.04, 0.6)
            s.tone(0.05, .square, 700, 260, 0.13, 0.3)
        case "ding":
            s.tone(0, .triangle, 1318.5, 1318.5, 0.18, 0.5)
            s.tone(0.16, .triangle, 1046.5, 1046.5, 0.26, 0.5)
        default: // babble: blips at the agent's own pitch, falling at the end (rising for a question)
            let base = 200 + Double((cue.voice ?? 0) % 220), n = max(1, cue.syllables ?? 1), q = cue.question ?? false
            for i in 0..<n {
                let last = i == n - 1
                let semis = Double.random(in: -2...2) + (last ? (q ? 4 : -3) : 0)
                let f = base * pow(2, semis / 12)
                s.tone(Double(i) * 0.075, i % 2 == 1 ? .triangle : .square, f, f * (last && q ? 1.12 : 0.97), 0.06, 0.28)
            }
        }
        let b = s.buffer(format: format, gain: Self.gain[cue.sound]! * Self.master)
        if cue.sound != "babble" { cache[cue.sound] = b }
        return b
    }
}

/// A tiny offline mixer for the recipes: exponential pitch sweeps and band-passed noise bursts with WebAudio-like
/// envelopes (exponential attack to the peak, then decay to silence).
private struct Synth {
    enum Wave { case sine, square, triangle }
    static let rate = 44_100.0
    var out: [Float]

    init(seconds: Double) { out = Array(repeating: 0, count: Int(seconds * Self.rate)) }

    private func env(_ t: Double, peak: Double, attack: Double, decay: Double) -> Double {
        let lo = 0.0001
        if t < 0 { return 0 }
        if t < attack { return lo * pow(peak / lo, t / attack) }
        if t < attack + decay { return peak * pow(lo / peak, (t - attack) / decay) }
        return 0
    }

    mutating func tone(_ t0: Double, _ wave: Wave, _ f0: Double, _ f1: Double, _ dur: Double, _ peak: Double) {
        var phase = 0.0
        let start = Int(t0 * Self.rate), end = min(out.count, Int((t0 + dur + 0.05) * Self.rate))
        guard start < end else { return }
        for i in start..<end {
            let t = Double(i - start) / Self.rate
            let f = f0 * pow(f1 / f0, min(1, t / dur))
            phase += f / Self.rate
            let p = phase - floor(phase)
            let v: Double = switch wave {
            case .sine: sin(2 * .pi * p)
            case .square: p < 0.5 ? 1 : -1
            case .triangle: 1 - 4 * abs(p - 0.5)
            }
            out[i] += Float(v * env(t, peak: peak, attack: 0.005, decay: dur))
        }
    }

    mutating func burst(_ t0: Double, _ freq: Double, _ q: Double, _ dur: Double, _ peak: Double) {
        // RBJ band-pass (constant 0 dB peak gain), like a BiquadFilterNode "bandpass"
        let w = 2 * .pi * freq / Self.rate, alpha = sin(w) / (2 * q), a0 = 1 + alpha
        let b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * cos(w) / a0, a2 = (1 - alpha) / a0
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
        let start = Int(t0 * Self.rate), end = min(out.count, Int((t0 + dur + 0.05) * Self.rate))
        guard start < end else { return }
        for i in start..<end {
            let x = Double.random(in: -1...1)
            let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x; y2 = y1; y1 = y
            out[i] += Float(y * env(Double(i - start) / Self.rate, peak: peak, attack: 0.003, decay: dur))
        }
    }

    func buffer(format: AVAudioFormat, gain: Float) -> AVAudioPCMBuffer {
        let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(out.count))!
        b.frameLength = AVAudioFrameCount(out.count)
        let ch = b.floatChannelData![0]
        for i in 0..<out.count { ch[i] = out[i] * gain }
        return b
    }
}
