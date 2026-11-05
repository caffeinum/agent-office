import Foundation
import JavaScriptCore

/// The web viewer's own placement logic (office-bridge.js), run in JavaScriptCore.
final class Bridge {
    private let context: JSContext
    private let ao: JSValue

    init() throws {
        guard let url = Bundle.main.url(forResource: "office-bridge", withExtension: "js") else {
            throw BridgeError.missing("office-bridge.js is not in the app bundle (run tvos/build-bridge.sh)")
        }
        guard let ctx = JSContext() else { throw BridgeError.missing("JavaScriptCore would not start") }
        var thrown: String?
        ctx.exceptionHandler = { _, e in thrown = e?.toString() }
        ctx.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
        if let thrown { throw BridgeError.script("loading office-bridge.js: \(thrown)") }
        guard let ao = ctx.objectForKeyedSubscript("AO"), !ao.isUndefined else { throw BridgeError.missing("office-bridge.js did not define AO") }
        context = ctx
        self.ao = ao
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
