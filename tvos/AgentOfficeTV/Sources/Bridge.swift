import Foundation
import JavaScriptCore

/// The web viewer's own placement logic (office-bridge.js), run in JavaScriptCore. The app starts on the copy it last
/// downloaded from the office's site (or the one built in), and `reload` swaps in a newer one while running.
final class Bridge {
    /// The AO API this app speaks (entry.js AO.api): a downloaded bundle with another number is ignored.
    static let api = 2
    private var context: JSContext
    private var ao: JSValue
    /// The source now running, to tell a new download from the same one.
    private(set) var source: String

    init() throws {
        if let cached = try? String(contentsOf: Self.cacheURL, encoding: .utf8), let (ctx, ao) = try? Self.load(cached, name: "downloaded office-bridge.js") {
            (context, self.ao, source) = (ctx, ao, cached)
            return
        }
        guard let url = Bundle.main.url(forResource: "office-bridge", withExtension: "js") else {
            throw BridgeError.missing("office-bridge.js is not in the app bundle (run tvos/build-bridge.sh)")
        }
        let code = try String(contentsOf: url, encoding: .utf8)
        (context, ao) = try Self.load(code, name: "office-bridge.js")
        source = code
    }

    /// Runs `code` in a fresh context and checks it speaks our API.
    private static func load(_ code: String, name: String) throws -> (JSContext, JSValue) {
        guard let ctx = JSContext() else { throw BridgeError.missing("JavaScriptCore would not start") }
        var thrown: String?
        ctx.exceptionHandler = { _, e in thrown = e?.toString() }
        ctx.evaluateScript(code, withSourceURL: URL(string: "office-bridge.js"))
        if let thrown { throw BridgeError.script("loading \(name): \(thrown)") }
        guard let ao = ctx.objectForKeyedSubscript("AO"), !ao.isUndefined else { throw BridgeError.missing("\(name) did not define AO") }
        let api = ao.objectForKeyedSubscript("api")?.toInt32() ?? 0
        guard api == Self.api else { throw BridgeError.script("\(name) speaks AO api \(api), this app speaks \(Self.api)") }
        return (ctx, ao)
    }

    private static var cacheURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("office-bridge.js")
    }

    /// Swaps in a downloaded bundle and keeps it for the next launch. Its state starts empty: feed it a snapshot next.
    /// Throws (and keeps the running one) if it doesn't load or speaks another API.
    func reload(_ code: String) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        let (ctx, ao) = try Self.load(code, name: "downloaded office-bridge.js")
        (context, self.ao, source) = (ctx, ao, code)
        try code.write(to: Self.cacheURL, atomically: true, encoding: .utf8)
    }

    /// Feeds one WebSocket frame; returns its type ("snapshot", "agent", …).
    func frame(_ text: String) throws -> String {
        try call("frame", [text]).toString()
    }

    /// The scene for this moment, or nil before the first snapshot.
    func scene(now: Date = Date()) throws -> OfficeScene? {
        let time = ProcessInfo.processInfo.environment["AO_TIME"] ?? ""
        let json = try call("scene", [now.timeIntervalSince1970 * 1000, time]).toString() ?? "null"
        return try JSONDecoder().decode(OfficeScene?.self, from: Data(json.utf8))
    }

    /// screen.js's paint ops for one agent's desk monitor.
    func screen(_ agentId: String) throws -> ScreenSpec {
        let json = try call("screen", [agentId]).toString() ?? "null"
        return try JSONDecoder().decode(ScreenSpec.self, from: Data(json.utf8))
    }

    /// radio.js: the station after `id` (nil = off), or nil for off.
    func nextStation(after id: String?) throws -> RadioStation? {
        let json = try call("nextStation", [id ?? ""]).toString() ?? "null"
        return try JSONDecoder().decode(RadioStation?.self, from: Data(json.utf8))
    }

    /// sound-plan.js cues the frames produced since the last call, past its rate limits.
    func cues(now: Date = Date()) throws -> [SoundCue] {
        let json = try call("cues", [now.timeIntervalSince1970 * 1000]).toString() ?? "[]"
        return try JSONDecoder().decode([SoundCue].self, from: Data(json.utf8))
    }

    /// The web's A* walk between two floor points.
    func route(from: (Double, Double), to: (Double, Double)) throws -> [(Double, Double)] {
        let json = try call("route", [from.0, from.1, to.0, to.1]).toString() ?? "[]"
        return try JSONDecoder().decode([[Double]].self, from: Data(json.utf8)).map { ($0[0], $0[1]) }
    }

    /// limbAngles() for each (pose, phase) at clock t.
    func limbs(_ poses: [(pose: String, phase: Double)], t: Double) throws -> [LimbAngles] {
        let input = try JSONSerialization.data(withJSONObject: poses.map { ["pose": $0.pose, "phase": $0.phase] })
        let json = try call("limbs", [String(decoding: input, as: UTF8.self), t]).toString() ?? "[]"
        return try JSONDecoder().decode([LimbAngles].self, from: Data(json.utf8))
    }

    /// voxel.js's merged mesh for a box list.
    func mesh(_ boxes: [OfficeScene.Box], ao: Bool = true, floorY: Double = 0) throws -> MeshData {
        let input = String(decoding: try JSONEncoder().encode(boxes), as: UTF8.self)
        let json = try call("mesh", [input, ao, floorY]).toString() ?? "null"
        return try JSONDecoder().decode(MeshData.self, from: Data(json.utf8))
    }

    /// A textures.js voxel texture by name ("grain", "grass", "plinth", "rug", "floor" + material, "wall" + material).
    func texture(_ name: String, _ arg: String? = nil) throws -> TextureData {
        let json = try call("texture", [name, arg ?? NSNull()]).toString() ?? "null"
        return try JSONDecoder().decode(TextureData.self, from: Data(json.utf8))
    }

    /// room.js's shell for a grid.
    func room(_ g: OfficeScene.Grid) throws -> RoomPlan {
        let json = try call("room", [g.w, g.d]).toString() ?? "null"
        return try JSONDecoder().decode(RoomPlan.self, from: Data(json.utf8))
    }

    struct LabelRect: Encodable { let id: String; let x, y, w, h, depth: Double; let status: String; let selected, speaking, kept: Bool }

    /// The web overlay's cullLabels(): which labels stay visible.
    func cull(_ rects: [LabelRect]) throws -> Set<String> {
        let input = String(decoding: try JSONEncoder().encode(rects), as: UTF8.self)
        let json = try call("cull", [input]).toString() ?? "[]"
        return Set(try JSONDecoder().decode([String].self, from: Data(json.utf8)))
    }

    private func call(_ name: String, _ args: [Any]) throws -> JSValue {
        var thrown: String?
        context.exceptionHandler = { _, e in thrown = e?.toString() }
        let v = ao.invokeMethod(name, withArguments: args)
        if let thrown { throw BridgeError.script("AO.\(name): \(thrown)") }
        guard let v else { throw BridgeError.script("AO.\(name) returned nothing") }
        return v
    }
}

enum BridgeError: LocalizedError {
    case missing(String), script(String)
    var errorDescription: String? {
        switch self { case .missing(let m), .script(let m): return m }
    }
}
